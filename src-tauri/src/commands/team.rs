use super::*;

/* ---------------- 团队仓库（docs/协同编辑.md §22.3） ----------------
团队仓库 = 开了 git 同步、几个账号都有权限的仓库。仓库标记里的 team、设备名单 .odea/devices
在 vault/team.rs；托管方的协作者接口在 sync/provider.rs。这里接起来：
- 打开团队仓库时把这台设备写进名单（register_device，随下一轮同步推上去）
- 邀请成员：标成团队仓库、在托管方那边拉他当协作者、给一个 odea://vault/ 链接
- 成员：名单里的设备按账号合起来，再对上托管方那边谁有权限
- 启动器里接受别人发来的邀请 */

/// 这个仓库同步的托管方、账号和仓库（`owner/name`）。没开同步是 None
fn sync_target(root: &std::path::Path) -> Option<(Provider, String, String)> {
    let repo = SyncRepo::open(root).ok().flatten()?;
    let provider = Provider::parse(&repo.config_get(PROVIDER_KEY)?)?;
    let login = repo.config_get(LOGIN_KEY).filter(|login| !login.is_empty())?;
    let remote = crate::sync::engine::display_remote(&repo.remote_url()?);
    let full_name = remote.split_once('/')?.1.to_string();
    Some((provider, login, full_name))
}

/// 团队仓库：把这台设备写进名单（自己那一行没有、名字变了才写）。随下一轮同步推上去
fn register_device(data_dir: &std::path::Path, root: &std::path::Path) -> Result<bool> {
    if crate::vault::team::team_id(root).is_none() {
        return Ok(false);
    }
    let Some((provider, login, _)) = sync_target(root) else {
        return Ok(false);
    };
    let own = crate::vault::team::Device {
        key: collab::id_text(team_key(data_dir).public().as_bytes()),
        account: provider.account_key(&login),
        updated: crate::db::now_ms(),
        name: crate::sync::engine::this_device(),
    };
    crate::vault::team::put_own(root, &own)
}

/// 打开仓库时（start_services）在后台做：读钥匙串、读写名单都不该挡着窗口
pub(in crate::commands) fn spawn_register_device(data_dir: &std::path::Path, ws: &Arc<Workspace>) {
    let (data_dir, root, sync) = (data_dir.to_path_buf(), ws.root(), ws.sync.clone());
    tauri::async_runtime::spawn_blocking(move || match register_device(&data_dir, &root) {
        Ok(true) => sync.poke(),
        Ok(false) => {}
        Err(error) => eprintln!("团队仓库：设备名单写不进去：{error}"),
    });
}

/// 发给成员的链接：点开在启动器里拉一份（workspace.rs 的 vault_link）
fn vault_link(provider: Provider, full_name: &str) -> String {
    format!("odea://vault/{}/{full_name}", provider.key())
}

/// 这个仓库的成员：名单里的设备按账号合起来，对上托管方那边谁有权限
#[tauri::command]
#[specta::specta]
pub async fn team_info(ws: Ws, state: State<'_, AppState>) -> Result<TeamInfo> {
    let root = ws.root();
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let team = crate::vault::team::team_id(&root).is_some();
        let target = sync_target(&root);
        let devices = crate::vault::team::read(&root);
        let mine = collab::id_text(team_key(&data_dir).public().as_bytes());
        let mut info = TeamInfo {
            team,
            provider: target.as_ref().map(|(provider, ..)| provider.key().to_string()),
            repo: target.as_ref().map(|(.., full_name)| full_name.clone()),
            me: target.as_ref().map(|(_, login, _)| login.clone()),
            ..TeamInfo::default()
        };
        let Some((provider, login, full_name)) = target else {
            return Ok(info);
        };
        // 托管方那边：谁能推、谁的邀请还没接受。问不到也照样给名单里的
        let remote = with_token(&data_dir, provider, |http, token| {
            Ok((
                provider.collaborators(http, token, &full_name)?,
                provider.pending_invites(http, token, &full_name)?,
            ))
        });
        let (members, invited) = match remote {
            Ok((members, invited)) => (Some(members), invited.into_iter().map(|(_, login)| login).collect()),
            Err(error) => {
                info.remote_error = Some(error.to_string());
                (None, Vec::new())
            }
        };
        let mut people: Vec<TeamPerson> = Vec::new();
        for device in &devices {
            let Some((host, who)) = crate::vault::team::split_account(&device.account) else { continue };
            if host != provider.key() {
                continue;
            }
            let index = person_index(&mut people, who, &login);
            people[index].devices.push(TeamDevice {
                name: device.name.clone(),
                updated: device.updated,
                this: device.key == mine,
            });
        }
        for who in members.iter().flatten() {
            let index = person_index(&mut people, who, &login);
            people[index].access = TeamAccess::Member;
        }
        for who in &invited {
            let index = person_index(&mut people, who, &login);
            people[index].access = TeamAccess::Invited;
        }
        if members.is_some() {
            for p in people.iter_mut().filter(|p| p.access == TeamAccess::Unknown) {
                p.access = TeamAccess::Gone;
            }
        }
        for p in &mut people {
            p.devices.sort_by_key(|device| std::cmp::Reverse(device.updated));
        }
        // 我在最前，接着是有权限的、等接受的、移出了的
        let rank = |p: &TeamPerson| (!p.me, p.access != TeamAccess::Member, p.access != TeamAccess::Invited);
        people.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.login.to_lowercase().cmp(&b.login.to_lowercase())));
        info.people = people;
        Ok(info)
    })
    .await
}

/// people 里这个账号的那一位，没有就加上
fn person_index(people: &mut Vec<TeamPerson>, who: &str, me: &str) -> usize {
    if let Some(index) = people.iter().position(|person| person.login.eq_ignore_ascii_case(who)) {
        return index;
    }
    people.push(TeamPerson {
        login: who.to_string(),
        me: who.eq_ignore_ascii_case(me),
        devices: Vec::new(),
        access: TeamAccess::Unknown,
    });
    people.len() - 1
}

/// 邀请成员：在托管方那边拉他当协作者（GitHub 发一封邀请），标成团队仓库、把这台设备写进名单，
/// 返回发给他的链接
#[tauri::command]
#[specta::specta]
pub async fn team_invite(ws: Ws, state: State<'_, AppState>, login: String) -> Result<TeamInvite> {
    let root = ws.root();
    let data_dir = state.data_dir.clone();
    let sync = ws.sync.clone();
    let login = login.trim().trim_start_matches('@').to_string();
    if login.is_empty() {
        return Err(AppError::Invalid("填对方在 GitHub 上的用户名".into()));
    }
    blocking(move || {
        let Some((provider, me, full_name)) = sync_target(&root) else {
            return Err(AppError::Invalid(
                "这个仓库还没开启同步。团队仓库靠同步在成员之间传改动：先开启同步（命令面板「开启同步…」）".into(),
            ));
        };
        if login.eq_ignore_ascii_case(&me) {
            return Err(AppError::Invalid("这是你自己的账号。填对方的用户名".into()));
        }
        let invited = with_token(&data_dir, provider, |http, token| provider.invite(http, token, &full_name, &login))?;
        crate::vault::team::mark_team(&root)?;
        register_device(&data_dir, &root)?;
        sync.poke();
        Ok(TeamInvite {
            link: vault_link(provider, &full_name),
            already: invited == crate::sync::provider::Invited::Already,
        })
    })
    .await
}

/// 移出成员：托管方那边去掉他的权限（还没接受的邀请撤回），名单里他的设备也去掉
#[tauri::command]
#[specta::specta]
pub async fn team_remove(ws: Ws, state: State<'_, AppState>, login: String) -> Result<()> {
    let root = ws.root();
    let data_dir = state.data_dir.clone();
    let sync = ws.sync.clone();
    blocking(move || {
        let (provider, me, full_name) =
            sync_target(&root).ok_or_else(|| AppError::Invalid("这个仓库没开同步".into()))?;
        if login.eq_ignore_ascii_case(&me) {
            return Err(AppError::Invalid("不能把自己移出去".into()));
        }
        with_token(&data_dir, provider, |http, token| provider.remove_member(http, token, &full_name, &login))?;
        if crate::vault::team::remove_account(&root, &provider.account_key(&login))? > 0 {
            sync.poke();
        }
        Ok(())
    })
    .await
}

/// 别人发给我、还没接受的仓库邀请（启动器「从同步仓库拉一份」）
#[tauri::command]
#[specta::specta]
pub async fn sync_invitations(state: State<'_, AppState>, provider: String) -> Result<Vec<SyncInvitation>> {
    let provider = provider_of(&provider)?;
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let invitations = with_token(&data_dir, provider, |http, token| provider.my_invitations(http, token))?;
        Ok(invitations
            .into_iter()
            .map(|invitation| SyncInvitation {
                id: invitation.id.to_string(),
                repo: remote_info(invitation.repo),
                inviter: invitation.inviter,
            })
            .collect())
    })
    .await
}

/// 接受一个仓库邀请（接受了才拉得下来）
#[tauri::command]
#[specta::specta]
pub async fn sync_accept_invitation(state: State<'_, AppState>, provider: String, id: String) -> Result<()> {
    let provider = provider_of(&provider)?;
    let id: u64 = id.parse().map_err(|_| AppError::Invalid("邀请的 id 不对".into()))?;
    let data_dir = state.data_dir.clone();
    blocking(move || with_token(&data_dir, provider, |http, token| provider.accept_invitation(http, token, id))).await
}

/* ---------------- 团队：成员之间自动连上（docs/协同编辑.md §22.4） ----------------
一个应用一个团队端点（team/mod.rs 的 TeamNet），团队仓库的窗口起来时登记（team_start），关了退出。
谁当主持人、什么时候开哪一篇由前端按 Presence 定；这里只把命令转过去，事件、字节发给登记它的窗口：
- 谁在线、开着哪几篇变了、一篇的流断了：tauri-specta 的事件 TeamChanged
- 文档的字节：和协作一样的管道帧，经 team_pipe 登记的 Channel 推给前端，前端经 team_send 发
  （PIPE_UPDATE / CURSOR / SYNC_REPLY / SYNC_VECTOR，成员号是这台设备在团队里的编号） */

#[derive(Default)]
pub struct TeamHub {
    net: Mutex<Option<Arc<crate::team::TeamNet>>>,
    /// 起端点要两三秒：两个窗口同时起来时只起一个
    starting: tokio::sync::Mutex<()>,
    /// 窗口标签 → 它登记的团队 id
    pub(in crate::commands) windows: Mutex<std::collections::HashMap<String, String>>,
    pipes: Mutex<std::collections::HashMap<String, Channel<InvokeResponseBody>>>,
}

impl TeamHub {
    pub(in crate::commands) fn net(&self) -> Option<Arc<crate::team::TeamNet>> {
        self.net.lock().unwrap().clone()
    }

    fn team_of(&self, label: &str) -> Option<String> {
        self.windows.lock().unwrap().get(label).cloned()
    }
}

/// 谁在线变了、一篇的流断了
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TeamControl {
    Peers { peers: Vec<crate::team::TeamPeer> },
    /// 一篇的流断了。做客的：主持人不给（refused）、不主持了、断线；主持的：这位访客走了
    DocClosed { doc: String, member: u16, refused: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct TeamChanged(pub TeamControl);

/// 团队仓库里的我
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamSelf {
    pub team: String,
    /// 设备公钥（十六进制）
    pub id: String,
    /// 我在管道帧里的编号
    pub member: u16,
    pub name: String,
    pub peers: Vec<crate::team::TeamPeer>,
    /// Windows 防火墙（设计 §22.4）：还没问过的话 Windows 马上会弹窗，前端先说一句；挡着的话说怎么改
    pub firewall: collab::firewall::Firewall,
}

/// 团队仓库的窗口起来了：起团队端点（一个应用一个）、登记这个团队。不是团队仓库是 None
/// （登记过的退出：仓库标记被改掉了）
#[tauri::command]
#[specta::specta]
pub async fn team_start<R: Runtime>(app: AppHandle<R>, ws: Ws, state: State<'_, AppState>) -> Result<Option<TeamSelf>> {
    let root = ws.root();
    let data_dir = state.data_dir.clone();
    let prepared = blocking(move || {
        let Some(team) = crate::vault::team::team_id(&root) else { return Ok(None) };
        let account = sync_target(&root)
            .map(|(provider, login, _)| provider.account_key(&login))
            .unwrap_or_default();
        let devices: Vec<crate::team::Device> = crate::vault::team::read(&root)
            .iter()
            .filter_map(crate::team::Device::from_row)
            .collect();
        Ok(Some((
            team,
            account,
            devices,
            root,
            collab_name(&data_dir),
            team_key(&data_dir),
            load_relays(&data_dir),
            collab::firewall::check(),
        )))
    })
    .await?;
    let hub = state.team.clone();
    let Some((team, account, devices, root, name, key, relays, firewall)) = prepared else {
        end_team(&state, &ws.label).await;
        return Ok(None);
    };
    // 起端点、登记都在这把锁里：别的窗口这时候关掉最后一个团队，不会把刚起的端点关了
    let _starting = hub.starting.lock().await;
    let net = match hub.net() {
        Some(net) => net,
        None => {
            let net = crate::team::TeamNet::start(crate::team::TeamOptions {
                key,
                relays,
                mdns: true,
                places_file: Some(collab_dir(&state.data_dir).join("team-places.json")),
            })
            .await
            .map_err(AppError::Io)?;
            let net = Arc::new(net);
            *hub.net.lock().unwrap() = Some(net.clone());
            net
        }
    };
    // 这个窗口之前登记的是别的团队（换了仓库）：先退出那个
    let previous = hub.windows.lock().unwrap().insert(ws.label.clone(), team.clone());
    if let Some(previous) = previous.filter(|previous| *previous != team) {
        net.leave(&previous);
    }
    let (events, receiver) = tokio::sync::mpsc::unbounded_channel();
    net.join(
        crate::team::TeamSpec {
            id: team.clone(),
            name: name.clone(),
            account,
            devices,
            root: Some(root),
        },
        events,
    );
    forward_team(app, hub.clone(), ws.label.clone(), team.clone(), receiver);
    Ok(Some(TeamSelf {
        member: net.my_member(&team),
        id: net.me(),
        peers: net.peers(&team),
        team,
        name,
        firewall,
    }))
}

fn forward_team<R: Runtime>(
    app: AppHandle<R>,
    hub: Arc<TeamHub>,
    label: String,
    team: String,
    mut receiver: tokio::sync::mpsc::UnboundedReceiver<crate::team::TeamEvent>,
) {
    use crate::team::TeamEvent;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            let (kind, member, doc, bytes) = match event {
                TeamEvent::Peers => {
                    let peers = hub.net().map(|net| net.peers(&team)).unwrap_or_default();
                    let _ = TeamChanged(TeamControl::Peers { peers }).emit_to(&app, label.as_str());
                    continue;
                }
                TeamEvent::DocClosed { doc, member, refused } => {
                    let _ = TeamChanged(TeamControl::DocClosed { doc, member, refused }).emit_to(&app, label.as_str());
                    continue;
                }
                TeamEvent::Update { from, doc, bytes } => (PIPE_UPDATE, from, doc, bytes),
                TeamEvent::Cursor { from, doc, bytes } => (PIPE_CURSOR, from, doc, bytes),
                TeamEvent::SyncRequest { from, doc, vector } => (PIPE_SYNC_REPLY, from, doc, vector),
                TeamEvent::SyncStart { with, doc } => (PIPE_SYNC_VECTOR, with, doc, Vec::new()),
            };
            // 帧格式和协作的一样，会话号填 0（团队用不着）
            let frame = pipe_frame(kind, 0, member, &doc, &bytes);
            if let Some(pipe) = hub.pipes.lock().unwrap().get(&label) {
                let _ = pipe.send(InvokeResponseBody::Raw(frame));
            }
        }
    });
}

/// 窗口关了、换了仓库、不再是团队仓库：退出这个团队；一个团队都不剩了就关端点
pub async fn end_team(state: &AppState, label: &str) {
    let hub = &state.team;
    hub.pipes.lock().unwrap().remove(label);
    let Some(team) = hub.windows.lock().unwrap().remove(label) else { return };
    let Some(net) = hub.net() else { return };
    net.leave(&team);
    let _starting = hub.starting.lock().await;
    if net.is_idle() {
        *hub.net.lock().unwrap() = None;
        net.stop().await;
    }
}

fn team_call<T>(ws: &Ws, state: &AppState, f: impl FnOnce(&crate::team::TeamNet, &str) -> T) -> Result<T> {
    let team = state
        .team
        .team_of(&ws.label)
        .ok_or_else(|| AppError::Invalid("这个窗口没登记团队仓库".into()))?;
    let net = state.team.net().ok_or_else(|| AppError::Invalid("团队端点没开着".into()))?;
    Ok(f(&net, &team))
}

/// 我开着哪几篇、主持着哪几篇
#[tauri::command]
#[specta::specta]
pub async fn team_presence(ws: Ws, state: State<'_, AppState>, docs: Vec<crate::team::PresenceDoc>) -> Result<()> {
    team_call(&ws, &state, |net, team| net.set_presence(team, docs))
}

#[tauri::command]
#[specta::specta]
pub async fn team_peers(ws: Ws, state: State<'_, AppState>) -> Result<Vec<crate::team::TeamPeer>> {
    team_call(&ws, &state, |net, team| net.peers(team))
}

/// 开始 / 不再主持一篇
#[tauri::command]
#[specta::specta]
pub async fn team_host(ws: Ws, state: State<'_, AppState>, doc: String, on: bool) -> Result<()> {
    team_call(&ws, &state, |net, team| net.host(team, &doc, on))
}

/// 连这一篇的主持人（编号 member）
#[tauri::command]
#[specta::specta]
pub async fn team_open(ws: Ws, state: State<'_, AppState>, doc: String, member: u16) -> Result<()> {
    team_call(&ws, &state, |net, team| net.open(team, &doc, member))?.map_err(AppError::Invalid)
}

#[tauri::command]
#[specta::specta]
pub async fn team_close(ws: Ws, state: State<'_, AppState>, doc: String) -> Result<()> {
    team_call(&ws, &state, |net, team| net.close(team, &doc))
}

/// 这一篇在 git 里最近一次提交的正文（不含属性块）：加入别人的会话时，本机没提交的改动按它算出来合进去
/// （设计 §22.2 规矩 2）。没开同步、没提交过是 None
#[tauri::command]
#[specta::specta]
pub async fn team_base(ws: Ws, target: DocRef) -> Result<Option<String>> {
    let Ok((root, rel, id)) = with_vault(&ws, move |v| v.history_source(&target)).await else { return Ok(None) };
    blocking(move || {
        if !root.join(".git").exists() {
            return Ok(None);
        }
        let history = crate::sync::history::versions(&root, &rel, id.as_deref(), 1)?;
        let Some(version) = history.versions.first() else { return Ok(None) };
        let text = crate::sync::history::text(&root, &version.blob.to_string())?;
        Ok(Some(crate::vault::frontmatter::split(&text).1))
    })
    .await
}

/// 前端登记接收团队字节的 Channel（不经 tauri-specta）
#[tauri::command]
pub fn team_pipe(window: tauri::WebviewWindow, state: State<'_, AppState>, channel: Channel<InvokeResponseBody>) {
    state.team.pipes.lock().unwrap().insert(window.label().to_string(), channel);
}

/// 前端发出来的团队字节（原始请求体，帧格式和 collab_send 一样）
#[tauri::command]
pub fn team_send(window: tauri::WebviewWindow, state: State<'_, AppState>, request: Request<'_>) -> std::result::Result<(), String> {
    let InvokeBody::Raw(frame) = request.body() else {
        return Err("team_send 要原始字节".into());
    };
    let (kind, _, member, doc, payload) = split_pipe_frame(frame)?;
    let Some(team) = state.team.team_of(window.label()) else { return Ok(()) };
    let Some(net) = state.team.net() else { return Ok(()) };
    match kind {
        PIPE_UPDATE => net.send_update(&team, doc, payload.to_vec()),
        PIPE_CURSOR => net.send_cursor(&team, doc, payload),
        PIPE_SYNC_VECTOR => net.send_sync(&team, member, doc, SyncKind::Vector, payload.to_vec()),
        PIPE_SYNC_REPLY => net.send_sync(&team, member, doc, SyncKind::Reply, payload.to_vec()),
        _ => {}
    }
    Ok(())
}

/* ---------------- 团队的中继（docs/协同编辑.md §22.4） ----------------
仓库里的 .odea/relays（vault/team.rs）一行一个中继码，随 git 走。成员打开时没用过、没说过不用的问一句；
用了就存进自己的中继（collab_relays，令牌进钥匙串），团队端点当场接上。自己配的中继可以给团队用（写进去） */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TeamRelayState {
    /// 我也在用（在我自己的中继里）
    Using,
    /// 还没问过
    Ask,
    /// 说过不用
    Declined,
}

/// 团队仓库里写着的一台中继（令牌不出 Rust）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamRelay {
    pub url: String,
    pub name: Option<String>,
    pub host: String,
    pub has_token: bool,
    pub state: TeamRelayState,
}

fn team_relays_of(root: &std::path::Path, data_dir: &std::path::Path) -> Vec<TeamRelay> {
    let mine: Vec<String> = load_relays(data_dir).into_iter().map(|relay| relay.url).collect();
    let declined = boot::Config::load(data_dir).declined_team_relays;
    crate::vault::team::read_relays(root)
        .iter()
        .filter_map(|code| Relay::parse_code(code).ok())
        .map(|relay| TeamRelay {
            state: if mine.contains(&relay.url) {
                TeamRelayState::Using
            } else if declined.contains(&relay.url) {
                TeamRelayState::Declined
            } else {
                TeamRelayState::Ask
            },
            host: relay.host(),
            has_token: relay.token.is_some(),
            name: relay.name.clone(),
            url: relay.url,
        })
        .collect()
}

/// 这个团队仓库里写着的中继
#[tauri::command]
#[specta::specta]
pub async fn team_relays(ws: Ws, state: State<'_, AppState>) -> Result<Vec<TeamRelay>> {
    let (root, data_dir) = (ws.root(), state.data_dir.clone());
    blocking(move || Ok(team_relays_of(&root, &data_dir))).await
}

/// 回答「这个团队仓库用中继 X，要用吗」
#[tauri::command]
#[specta::specta]
pub async fn team_relay_answer(ws: Ws, state: State<'_, AppState>, url: String, accept: bool) -> Result<Vec<TeamRelay>> {
    let (root, data_dir) = (ws.root(), state.data_dir.clone());
    let (relay, relays) = blocking(move || {
        let relay = crate::vault::team::read_relays(&root)
            .iter()
            .filter_map(|code| Relay::parse_code(code).ok())
            .find(|relay| relay.url == url)
            .ok_or_else(|| AppError::NotFound("仓库里已经没有这台中继了".into()))?;
        let mut config = boot::Config::load(&data_dir);
        config.declined_team_relays.retain(|known| *known != relay.url);
        if !accept {
            config.declined_team_relays.push(relay.url.clone());
        }
        config.save(&data_dir).map_err(|error| AppError::Io(error.to_string()))?;
        if accept {
            save_relay(&data_dir, &relay)?;
        }
        Ok((accept.then_some(relay), team_relays_of(&root, &data_dir)))
    })
    .await?;
    if let (Some(relay), Some(net)) = (relay, state.team.net()) {
        net.add_relay(relay).await;
    }
    Ok(relays)
}

/// 我配的一台中继给不给这个团队用（写进 / 拿出仓库里的 .odea/relays，随下一轮同步推上去）
#[tauri::command]
#[specta::specta]
pub async fn team_relay_share(ws: Ws, state: State<'_, AppState>, url: String, share: bool) -> Result<Vec<TeamRelay>> {
    let (root, data_dir, sync) = (ws.root(), state.data_dir.clone(), ws.sync.clone());
    blocking(move || {
        if crate::vault::team::team_id(&root).is_none() {
            return Err(AppError::Invalid("这不是团队仓库".into()));
        }
        let mut codes = crate::vault::team::read_relays(&root);
        let same = |code: &String| Relay::parse_code(code).is_ok_and(|relay| relay.url == url);
        if share {
            let relay = load_relays(&data_dir)
                .into_iter()
                .find(|relay| relay.url == url)
                .ok_or_else(|| AppError::NotFound("没有这台中继".into()))?;
            codes.retain(|code| !same(code));
            codes.push(relay.to_code());
        } else {
            codes.retain(|code| !same(code));
        }
        if crate::vault::team::write_relays(&root, &codes)? {
            sync.poke();
        }
        Ok(team_relays_of(&root, &data_dir))
    })
    .await
}
