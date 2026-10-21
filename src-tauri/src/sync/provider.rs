/* ============================================================
GitHub / Gitee 的接口（技术方案 §5.9.4）：登录、令牌续期、查账号、列出 / 新建仓库；
团队仓库（docs/协同编辑.md §22.3）的协作者：邀请、列出、移出，在 Odea 里接受别人的邀请。
Gitee 的协作者接口还没用真实账号验过：只列出，邀请、移出先让用户去网页上做

- GitHub 用 OAuth App 的设备码登录：应用里只有 client_id（不是机密），没有 client secret。
  2026-08 起新注册的 OAuth App 默认令牌 8 小时过期、另给刷新令牌；设备码来的令牌续期
  也不需要 secret
- Gitee 第一版用私人令牌（用户在 Gitee 设置里生成、粘贴进来）。它的 OAuth 只有授权码一种、
  回调地址要完全一致、client_secret 只能随应用分发，而且 OAuth 令牌能不能当 git 密码
  还没验证过 —— 先不做
- git 推拉时：用户名 = 账号 login，密码 = 令牌
- HTTP 用 ureq，TLS 走系统的（Windows SChannel、macOS Security）。代理由调用方找好传进来
  （proxy.rs）。错误和 git 那边一样分三类：要登录（401）/ 连不上 / 云端拒绝
============================================================ */

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::repo::{SyncError, SyncResult};
use super::secret::Token;

/// GitHub OAuth App「Odea」的 client_id（2026-10-07 以 OnTheWay 的名字注册，开了 Device Flow 和令牌过期；
/// 改名只改 App 的名字，client_id 不变）
pub const GITHUB_CLIENT_ID: &str = "Ov23lieFMfGc95fA5QQs";

/// 开发时可以用环境变量 `ODEA_GITHUB_CLIENT_ID` 换成别的 App
pub fn github_client_id() -> String {
    std::env::var("ODEA_GITHUB_CLIENT_ID")
        .ok()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| GITHUB_CLIENT_ID.to_string())
}

const GITHUB_API: &str = "https://api.github.com";
const GITEE_API: &str = "https://gitee.com/api/v5";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    GitHub,
    Gitee,
}

impl Provider {
    pub fn parse(key: &str) -> Option<Self> {
        match key {
            "github" => Some(Provider::GitHub),
            "gitee" => Some(Provider::Gitee),
            _ => None,
        }
    }

    /// 写在 .git/config、配置文件、钥匙串键里的名字
    pub fn key(self) -> &'static str {
        match self {
            Provider::GitHub => "github",
            Provider::Gitee => "gitee",
        }
    }

    /// 钥匙串里这个账号的键：`github:<login>`
    pub fn account_key(self, login: &str) -> String {
        format!("{}:{login}", self.key())
    }

    /// 这个令牌是谁的（顺便验证令牌能用）
    pub fn login_of(self, http: &Http, token: &str) -> SyncResult<String> {
        #[derive(Deserialize)]
        struct User {
            login: String,
        }
        let user: User = match self {
            Provider::GitHub => http.github_get(token, "/user")?,
            Provider::Gitee => http.gitee_get(token, "/user", &[])?,
        };
        Ok(user.login)
    }

    /// 这个账号能推的仓库：自己的、别人拉我当协作者的、组织的。最近更新的在前（只取第一页，100 个）
    pub fn repos(self, http: &Http, token: &str) -> SyncResult<Vec<RemoteRepo>> {
        match self {
            Provider::GitHub => {
                let repos: Vec<GitHubRepo> = http.github_get(
                    token,
                    "/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100",
                )?;
                Ok(repos.into_iter().map(RemoteRepo::from).collect())
            }
            Provider::Gitee => {
                let repos: Vec<GiteeRepo> = http.gitee_get(
                    token,
                    "/user/repos",
                    &[("type", "all"), ("sort", "updated"), ("per_page", "100")],
                )?;
                Ok(repos.into_iter().map(RemoteRepo::from).collect())
            }
        }
    }

    /// 把 login 拉成这个仓库的协作者（能推）。GitHub 给他发一封邀请，他接受了才算
    pub fn invite(self, http: &Http, token: &str, full_name: &str, login: &str) -> SyncResult<Invited> {
        match self {
            Provider::GitHub => {
                let url = format!("{GITHUB_API}/repos/{}/collaborators/{}", repo_path(full_name)?, segment(login)?);
                let request = http
                    .github(http.agent.put(url), token)
                    .send_json(serde_json::json!({ "permission": "push" }));
                // 201：发了邀请；204：他本来就有权限（已经是协作者、组织成员）
                Ok(match read_status(request)? {
                    (204, _) => Invited::Already,
                    _ => Invited::Sent,
                })
            }
            Provider::Gitee => Err(SyncError::Remote(GITEE_MEMBERS.into())),
        }
    }

    /// 这个仓库现在有谁（能推的协作者，含主人）
    pub fn collaborators(self, http: &Http, token: &str, full_name: &str) -> SyncResult<Vec<String>> {
        let path = format!("/repos/{}/collaborators", repo_path(full_name)?);
        let users: Vec<Owner> = match self {
            Provider::GitHub => http.github_get(token, &format!("{path}?per_page=100"))?,
            Provider::Gitee => http.gitee_get(token, &path, &[("per_page", "100")])?,
        };
        Ok(users.into_iter().map(|user| user.login).collect())
    }

    /// 发出去、对方还没接受的邀请：(邀请 id, 被邀请的 login)。Gitee 没有这一步
    pub fn pending_invites(self, http: &Http, token: &str, full_name: &str) -> SyncResult<Vec<(u64, String)>> {
        match self {
            Provider::GitHub => {
                let invitations: Vec<GitHubInvitation> =
                    http.github_get(token, &format!("/repos/{}/invitations?per_page=100", repo_path(full_name)?))?;
                Ok(invitations
                    .into_iter()
                    .filter_map(|invitation| Some((invitation.id, invitation.invitee?.login)))
                    .collect())
            }
            Provider::Gitee => Ok(Vec::new()),
        }
    }

    /// 去掉 login 的权限：还没接受邀请就撤回邀请，是协作者就移出
    pub fn remove_member(self, http: &Http, token: &str, full_name: &str, login: &str) -> SyncResult<()> {
        match self {
            Provider::GitHub => {
                let repo = repo_path(full_name)?;
                for (id, invitee) in self.pending_invites(http, token, full_name)? {
                    if invitee.eq_ignore_ascii_case(login) {
                        let url = format!("{GITHUB_API}/repos/{repo}/invitations/{id}");
                        read_status(http.github(http.agent.delete(url), token).call())?;
                    }
                }
                let url = format!("{GITHUB_API}/repos/{repo}/collaborators/{}", segment(login)?);
                match read_status(http.github(http.agent.delete(url), token).call()) {
                    // 他本来就不是协作者（只有一封刚撤回的邀请）
                    Err(SyncError::Remote(message)) if message.contains("Not Found") => Ok(()),
                    other => other.map(|_| ()),
                }
            }
            Provider::Gitee => Err(SyncError::Remote(GITEE_MEMBERS.into())),
        }
    }

    /// 别人发给我、我还没接受的邀请
    pub fn my_invitations(self, http: &Http, token: &str) -> SyncResult<Vec<RepoInvitation>> {
        match self {
            Provider::GitHub => {
                let invitations: Vec<GitHubInvitation> =
                    http.github_get(token, "/user/repository_invitations?per_page=100")?;
                Ok(invitations.into_iter().filter_map(RepoInvitation::from_github).collect())
            }
            Provider::Gitee => Ok(Vec::new()),
        }
    }

    pub fn accept_invitation(self, http: &Http, token: &str, id: u64) -> SyncResult<()> {
        match self {
            Provider::GitHub => {
                let url = format!("{GITHUB_API}/user/repository_invitations/{id}");
                read_status(http.github(http.agent.patch(url), token).send_empty())?;
                Ok(())
            }
            Provider::Gitee => Err(SyncError::Remote(GITEE_MEMBERS.into())),
        }
    }

    /// 新建一个空的私有仓库
    pub fn create_repo(self, http: &Http, token: &str, name: &str) -> SyncResult<RemoteRepo> {
        match self {
            Provider::GitHub => {
                let body = serde_json::json!({
                    "name": name,
                    "private": true,
                    "auto_init": false,
                    "description": "Odea 笔记",
                });
                let request = http
                    .github(http.agent.post(format!("{GITHUB_API}/user/repos")), token)
                    .send_json(body);
                let repo: GitHubRepo = read_json(request)?;
                Ok(repo.into())
            }
            Provider::Gitee => {
                let request = http.agent.post(format!("{GITEE_API}/user/repos")).send_form([
                    ("access_token", token),
                    ("name", name),
                    ("private", "true"),
                    ("auto_init", "false"),
                    ("description", "Odea 笔记"),
                ]);
                let repo: GiteeRepo = read_json(request)?;
                Ok(repo.into())
            }
        }
    }
}

/// Gitee 的成员管理还没在 Odea 里做（协作者接口没用真实账号验过）
const GITEE_MEMBERS: &str = "Gitee 的仓库请在 Gitee 网页上的「仓库成员管理」里添加、移出成员";

/// 仓库在接口路径里的样子：`owner/name`，两段都只能是字母、数字和 - _ .
fn repo_path(full_name: &str) -> SyncResult<String> {
    let (owner, name) = full_name
        .split_once('/')
        .ok_or_else(|| SyncError::Local(format!("仓库名不对：{full_name}")))?;
    Ok(format!("{}/{}", segment(owner)?, segment(name)?))
}

/// 账号、仓库名放进接口路径之前查一遍：不让 `/`、`?` 之类的混进去
fn segment(part: &str) -> SyncResult<&str> {
    let ok = !part.is_empty()
        && part != "."
        && part != ".."
        && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(part)
    } else {
        Err(SyncError::Local(format!("账号或仓库名里有不认识的字：{part}")))
    }
}

/// 云端的一个仓库
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteRepo {
    /// `owner/name`
    pub full_name: String,
    /// HTTPS 地址，git 用它
    pub clone_url: String,
    pub private: bool,
    pub updated_at: Option<String>,
    /// 主人的 login：不是我的话，这是别人拉我进来的团队仓库
    pub owner: String,
}

#[derive(Debug, Deserialize)]
struct Owner {
    login: String,
}

fn owner_of(owner: Option<Owner>, full_name: &str) -> String {
    owner
        .map(|owner| owner.login)
        .unwrap_or_else(|| full_name.split('/').next().unwrap_or_default().to_string())
}

#[derive(Debug, Deserialize)]
struct GitHubRepo {
    full_name: String,
    clone_url: String,
    private: bool,
    #[serde(default)]
    pushed_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    owner: Option<Owner>,
}

impl From<GitHubRepo> for RemoteRepo {
    fn from(repo: GitHubRepo) -> Self {
        RemoteRepo {
            owner: owner_of(repo.owner, &repo.full_name),
            full_name: repo.full_name,
            clone_url: repo.clone_url,
            private: repo.private,
            updated_at: repo.pushed_at.or(repo.updated_at),
        }
    }
}

/// 邀请：发出去的（invitee 是谁）、收到的（repository 是哪个、inviter 是谁）都是这个样子
#[derive(Debug, Deserialize)]
struct GitHubInvitation {
    id: u64,
    #[serde(default)]
    repository: Option<GitHubRepo>,
    #[serde(default)]
    invitee: Option<Owner>,
    #[serde(default)]
    inviter: Option<Owner>,
}

/// 别人发给我的、还没接受的邀请
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoInvitation {
    pub id: u64,
    pub repo: RemoteRepo,
    /// 谁邀请的（login）
    pub inviter: String,
}

impl RepoInvitation {
    fn from_github(invitation: GitHubInvitation) -> Option<Self> {
        let repo = RemoteRepo::from(invitation.repository?);
        let inviter = invitation.inviter.map(|inviter| inviter.login).unwrap_or_else(|| repo.owner.clone());
        Some(RepoInvitation { id: invitation.id, repo, inviter })
    }
}

/// 拉协作者的结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invited {
    /// 发了邀请，等他接受
    Sent,
    /// 他本来就能推这个仓库
    Already,
}

#[derive(Debug, Deserialize)]
struct GiteeRepo {
    full_name: String,
    html_url: String,
    private: bool,
    #[serde(default)]
    pushed_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    owner: Option<Owner>,
}

impl From<GiteeRepo> for RemoteRepo {
    fn from(repo: GiteeRepo) -> Self {
        // Gitee 的 html_url 有时带 .git、有时不带
        let clone_url = if repo.html_url.ends_with(".git") {
            repo.html_url
        } else {
            format!("{}.git", repo.html_url.trim_end_matches('/'))
        };
        RemoteRepo {
            owner: owner_of(repo.owner, &repo.full_name),
            full_name: repo.full_name,
            clone_url,
            private: repo.private,
            updated_at: repo.pushed_at.or(repo.updated_at),
        }
    }
}

/// GitHub 设备码登录的第一步：给用户看的码，和去哪输入
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// 码多久过期（秒），一般 900
    pub expires_in: u64,
    /// 至少隔多久问一次（秒）
    pub interval: u64,
}

/// 问一次「用户在浏览器里确认了没有」的结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevicePoll {
    Pending,
    /// 问得太勤了：以后至少隔这么多秒
    SlowDown(u64),
    Done(Token),
    Expired,
    Denied,
}

/// GitHub 令牌接口的回复：成功和失败都是 200，看字段
#[derive(Debug, Deserialize)]
struct TokenReply {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<u64>,
}

impl TokenReply {
    fn token(&mut self, now_ms: i64) -> Option<Token> {
        Some(Token {
            access: self.access_token.take()?,
            refresh: self.refresh_token.take(),
            expires_at: self.expires_in.map(|seconds| now_ms + seconds * 1000),
        })
    }

    fn problem(&self) -> String {
        self.error_description
            .clone()
            .or_else(|| self.error.clone())
            .unwrap_or_else(|| "GitHub 没有给令牌".into())
    }
}

fn poll_result(mut reply: TokenReply, now_ms: i64) -> SyncResult<DevicePoll> {
    if let Some(token) = reply.token(now_ms) {
        return Ok(DevicePoll::Done(token));
    }
    match reply.error.as_deref() {
        Some("authorization_pending") => Ok(DevicePoll::Pending),
        Some("slow_down") => Ok(DevicePoll::SlowDown(reply.interval.unwrap_or(10))),
        Some("expired_token") => Ok(DevicePoll::Expired),
        Some("access_denied") => Ok(DevicePoll::Denied),
        _ => Err(SyncError::Remote(reply.problem())),
    }
}

fn refresh_result(mut reply: TokenReply, now_ms: i64) -> SyncResult<Token> {
    if let Some(token) = reply.token(now_ms) {
        return Ok(token);
    }
    match reply.error.as_deref() {
        // 刷新令牌过期了（半年没用）或者被撤销了：只能重新登录
        Some("bad_refresh_token") | Some("unauthorized") => Err(SyncError::Auth),
        _ => Err(SyncError::Remote(reply.problem())),
    }
}

/// 连 GitHub / Gitee 用的 HTTP 客户端
pub struct Http {
    agent: ureq::Agent,
}

impl Http {
    pub fn new(proxy: Option<&str>) -> SyncResult<Self> {
        let proxy = proxy
            .map(ureq::Proxy::new)
            .transpose()
            .map_err(|error| SyncError::Local(format!("代理地址用不了: {error}")))?;
        let config = ureq::Agent::config_builder()
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .provider(ureq::tls::TlsProvider::NativeTls)
                    .build(),
            )
            .proxy(proxy)
            .timeout_global(Some(Duration::from_secs(20)))
            .http_status_as_error(false)
            .user_agent("Odea")
            .build();
        Ok(Self { agent: config.into() })
    }

    pub fn github_device_code(&self) -> SyncResult<DeviceCode> {
        let client_id = github_client_id();
        read_json(
            self.agent
                .post("https://github.com/login/device/code")
                .header("Accept", "application/json")
                .send_form([("client_id", client_id.as_str()), ("scope", "repo")]),
        )
    }

    pub fn github_device_poll(&self, device_code: &str) -> SyncResult<DevicePoll> {
        let client_id = github_client_id();
        let reply: TokenReply = read_json(
            self.agent
                .post("https://github.com/login/oauth/access_token")
                .header("Accept", "application/json")
                .send_form([
                    ("client_id", client_id.as_str()),
                    ("device_code", device_code),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ]),
        )?;
        poll_result(reply, now_ms())
    }

    /// 用刷新令牌换一对新的（设备码来的令牌不需要 client_secret）
    pub fn github_refresh(&self, refresh_token: &str) -> SyncResult<Token> {
        let client_id = github_client_id();
        let reply: TokenReply = read_json(
            self.agent
                .post("https://github.com/login/oauth/access_token")
                .header("Accept", "application/json")
                .send_form([
                    ("client_id", client_id.as_str()),
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh_token),
                ]),
        )?;
        refresh_result(reply, now_ms())
    }

    fn github<B>(&self, request: ureq::RequestBuilder<B>, token: &str) -> ureq::RequestBuilder<B> {
        request
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
    }

    fn github_get<T: DeserializeOwned>(&self, token: &str, path: &str) -> SyncResult<T> {
        read_json(
            self.github(self.agent.get(format!("{GITHUB_API}{path}")), token)
                .call(),
        )
    }

    fn gitee_get<T: DeserializeOwned>(
        &self,
        token: &str,
        path: &str,
        query: &[(&str, &str)],
    ) -> SyncResult<T> {
        let mut request = self
            .agent
            .get(format!("{GITEE_API}{path}"))
            .query("access_token", token);
        for (key, value) in query {
            request = request.query(*key, *value);
        }
        read_json(request.call())
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 读回复：401 = 要登录；不是 2xx = 云端拒绝（带上它说的原因）；连不上 = 网络
fn read_json<T: DeserializeOwned>(
    response: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
) -> SyncResult<T> {
    let (_, text) = read_status(response)?;
    serde_json::from_str(&text)
        .map_err(|error| SyncError::Remote(format!("看不懂云端的回复: {error}")))
}

/// 不用看内容的回复（204 没有正文）：状态码和正文
fn read_status(
    response: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
) -> SyncResult<(u16, String)> {
    let mut response = response.map_err(|error| SyncError::Network(error.to_string()))?;
    let status = response.status().as_u16();
    let text = response
        .body_mut()
        .read_to_string()
        .map_err(|error| SyncError::Network(error.to_string()))?;
    if status == 401 {
        return Err(SyncError::Auth);
    }
    if !(200..300).contains(&status) {
        return Err(SyncError::Remote(
            api_message(&text).unwrap_or_else(|| format!("HTTP {status}")),
        ));
    }
    Ok((status, text))
}

/// 接口报错时说的话：GitHub `{ message, errors: [{ message }] }`，Gitee `{ message }`
fn api_message(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let detail = value
        .get("errors")
        .and_then(|errors| errors.get(0))
        .and_then(|error| error.get("message"))
        .and_then(|message| message.as_str());
    let message = value.get("message").and_then(|message| message.as_str());
    match (message, detail) {
        (Some(message), Some(detail)) => Some(format!("{message}（{detail}）")),
        (Some(message), None) => Some(message.to_string()),
        (None, Some(detail)) => Some(detail.to_string()),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(json: &str) -> TokenReply {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn device_polling_understands_every_answer() {
        let now = 1_000_000;
        assert_eq!(
            poll_result(reply(r#"{"error":"authorization_pending"}"#), now).unwrap(),
            DevicePoll::Pending
        );
        assert_eq!(
            poll_result(reply(r#"{"error":"slow_down","interval":10}"#), now).unwrap(),
            DevicePoll::SlowDown(10)
        );
        assert_eq!(poll_result(reply(r#"{"error":"expired_token"}"#), now).unwrap(), DevicePoll::Expired);
        assert_eq!(poll_result(reply(r#"{"error":"access_denied"}"#), now).unwrap(), DevicePoll::Denied);
        assert!(matches!(
            poll_result(reply(r#"{"error":"incorrect_client_credentials","error_description":"客户端不对"}"#), now),
            Err(SyncError::Remote(message)) if message == "客户端不对"
        ));
        // 会过期的令牌：8 小时 + 刷新令牌
        let done = poll_result(
            reply(r#"{"access_token":"ghu_a","expires_in":28800,"refresh_token":"ghr_b","refresh_token_expires_in":15897600,"token_type":"bearer","scope":"repo"}"#),
            now,
        )
        .unwrap();
        assert_eq!(
            done,
            DevicePoll::Done(Token {
                access: "ghu_a".into(),
                refresh: Some("ghr_b".into()),
                expires_at: Some(now + 28_800_000),
            })
        );
        // 不过期的（App 关了令牌过期）
        let plain = poll_result(reply(r#"{"access_token":"gho_c","token_type":"bearer"}"#), now).unwrap();
        assert_eq!(
            plain,
            DevicePoll::Done(Token { access: "gho_c".into(), refresh: None, expires_at: None })
        );
    }

    #[test]
    fn a_dead_refresh_token_means_logging_in_again() {
        assert_eq!(
            refresh_result(reply(r#"{"error":"bad_refresh_token"}"#), 0).unwrap_err(),
            SyncError::Auth
        );
        let token = refresh_result(reply(r#"{"access_token":"ghu_new","expires_in":60,"refresh_token":"ghr_new"}"#), 5).unwrap();
        assert_eq!(token.expires_at, Some(60_005));
    }

    #[test]
    fn repos_from_both_hosts_get_https_clone_urls() {
        let github: Vec<GitHubRepo> = serde_json::from_str(
            r#"[{"full_name":"me/notes","clone_url":"https://github.com/me/notes.git","private":true,"pushed_at":"2026-10-07T10:00:00Z","size":0,"owner":{"login":"me"}}]"#,
        )
        .unwrap();
        let repo = RemoteRepo::from(github.into_iter().next().unwrap());
        assert_eq!(repo.clone_url, "https://github.com/me/notes.git");
        assert_eq!(repo.updated_at.as_deref(), Some("2026-10-07T10:00:00Z"));

        let gitee: Vec<GiteeRepo> = serde_json::from_str(
            r#"[{"full_name":"me/notes","html_url":"https://gitee.com/me/notes","private":true,"updated_at":"2026-10-07T18:00:00+08:00"},
                {"full_name":"me/other","html_url":"https://gitee.com/me/other.git","private":false}]"#,
        )
        .unwrap();
        let urls: Vec<String> = gitee.into_iter().map(|repo| RemoteRepo::from(repo).clone_url).collect();
        assert_eq!(urls, vec!["https://gitee.com/me/notes.git", "https://gitee.com/me/other.git"]);
    }

    #[test]
    fn repos_know_their_owner_and_invitations_read_back() {
        let github: Vec<GitHubRepo> = serde_json::from_str(
            r#"[{"full_name":"xiaowang/team-notes","clone_url":"https://github.com/xiaowang/team-notes.git","private":true,"owner":{"login":"xiaowang"}},
                {"full_name":"me/notes","clone_url":"https://github.com/me/notes.git","private":true}]"#,
        )
        .unwrap();
        let owners: Vec<String> = github.into_iter().map(|repo| RemoteRepo::from(repo).owner).collect();
        assert_eq!(owners, vec!["xiaowang", "me"]);

        let received: Vec<GitHubInvitation> = serde_json::from_str(
            r#"[{"id":7,"repository":{"full_name":"xiaowang/team-notes","clone_url":"https://github.com/xiaowang/team-notes.git","private":true,"owner":{"login":"xiaowang"}},"inviter":{"login":"xiaowang"},"invitee":{"login":"me"},"permissions":"write"},
                {"id":8}]"#,
        )
        .unwrap();
        let mine: Vec<RepoInvitation> = received.into_iter().filter_map(RepoInvitation::from_github).collect();
        assert_eq!(mine.len(), 1);
        assert_eq!(
            (mine[0].id, mine[0].inviter.as_str(), mine[0].repo.full_name.as_str()),
            (7, "xiaowang", "xiaowang/team-notes")
        );

        assert_eq!(repo_path("me/notes").unwrap(), "me/notes");
        assert!(repo_path("me/..").is_err());
        assert!(repo_path("notes").is_err());
        assert!(segment("a?b").is_err());
    }

    #[test]
    fn api_errors_say_what_went_wrong() {
        assert_eq!(
            api_message(r#"{"message":"Repository creation failed.","errors":[{"resource":"Repository","code":"custom","field":"name","message":"name already exists on this account"}]}"#).as_deref(),
            Some("Repository creation failed.（name already exists on this account）")
        );
        assert_eq!(api_message(r#"{"message":"仓库名已存在"}"#).as_deref(), Some("仓库名已存在"));
        assert_eq!(api_message("<html>"), None);
    }

    /// 真的连一下 GitHub 和 Gitee（要联网，平时不跑）：
    /// cargo test --no-default-features --lib sync::provider -- --ignored
    #[test]
    #[ignore]
    fn talks_to_the_real_services() {
        let http = Http::new(super::super::proxy::resolve(None).as_deref()).unwrap();
        // 设备码：只是领一个码，不登录任何东西，15 分钟后自己作废
        let code = http.github_device_code().unwrap();
        assert!(!code.user_code.is_empty());
        assert_eq!(code.verification_uri, "https://github.com/login/device");
        assert_eq!(
            http.github_device_poll(&code.device_code).unwrap(),
            DevicePoll::Pending
        );
        // 令牌不对：两家都是「要登录」
        assert_eq!(Provider::GitHub.login_of(&http, "not-a-token").unwrap_err(), SyncError::Auth);
        assert_eq!(Provider::Gitee.login_of(&http, "not-a-token").unwrap_err(), SyncError::Auth);
    }

    #[test]
    fn providers_have_stable_keys() {
        assert_eq!(Provider::parse("github"), Some(Provider::GitHub));
        assert_eq!(Provider::parse("gitee"), Some(Provider::Gitee));
        assert_eq!(Provider::parse("gitlab"), None);
        assert_eq!(Provider::Gitee.account_key("me"), "gitee:me");
    }
}
