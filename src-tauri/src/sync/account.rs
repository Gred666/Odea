/* ============================================================
账号（技术方案 §5.9.4）：登录、拿一个能用的令牌、退出。不依赖 tauri。

- 令牌在钥匙串里（secret.rs）；登录过哪些账号（每个托管方一个）记在应用配置里，
  同步配置（这个仓库用哪个账号）在仓库的 .git/config 里
- GitHub 的令牌 8 小时过期：离到期不到 10 分钟、或者推拉时被拒了，先用刷新令牌换一对新的；
  刷新也被拒（半年没用、被撤销）才要重新登录
- 设备码登录要等用户在浏览器里确认：wait_github 按 GitHub 给的间隔去问，可以取消
============================================================ */

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::provider::{DeviceCode, DevicePoll, Http, Provider};
use super::repo::{SyncError, SyncResult};
use super::secret::{self, Token};

/// 离到期不到这么久就先续
const REFRESH_AHEAD_MS: i64 = 10 * 60 * 1000;

/// 一个能用的访问令牌。`rejected` = 刚才用它被云端拒了（401）：GitHub 的就续一次，
/// 续不了 / Gitee 的私人令牌就是登录失效
pub fn access_token(
    provider: Provider,
    login: &str,
    http: impl FnOnce() -> SyncResult<Http>,
    rejected: bool,
) -> SyncResult<String> {
    access_token_with(provider, login, rejected, |refresh| http()?.github_refresh(refresh))
}

fn access_token_with(
    provider: Provider,
    login: &str,
    rejected: bool,
    refresh_with: impl FnOnce(&str) -> SyncResult<Token>,
) -> SyncResult<String> {
    let key = provider.account_key(login);
    let token = secret::load(&key)?.ok_or(SyncError::Auth)?;
    if !rejected && !expiring(&token) {
        return Ok(token.access);
    }
    // 续期一个一个来：GitHub 的刷新令牌用一次就作废（连同旧的访问令牌）。几个仓库的同步线程
    // 同时发现要续（应用一起来、几个窗口一起恢复时令牌都过期了），拿同一个刷新令牌去换，
    // 后到的被拒成「登录失效」
    static REFRESHING: Mutex<()> = Mutex::new(());
    let _refreshing = REFRESHING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let token = match secret::load(&key)?.ok_or(SyncError::Auth)? {
        // 等锁的时候别人续好了：用他换来的
        current if current.access != token.access && !expiring(&current) => return Ok(current.access),
        current => current,
    };
    let Some(refresh) = token.refresh.clone() else {
        return Err(SyncError::Auth);
    };
    let fresh = refresh_with(&refresh)?;
    // 回复里没带新的刷新令牌就接着用旧的
    let fresh = Token { refresh: fresh.refresh.or(Some(refresh)), ..fresh };
    secret::save(&key, &fresh)?;
    Ok(fresh.access)
}

fn expiring(token: &Token) -> bool {
    token
        .expires_at
        .is_some_and(|at| at - chrono::Utc::now().timestamp_millis() < REFRESH_AHEAD_MS)
}

/// 正在进行的 GitHub 设备码登录
pub struct PendingLogin {
    code: DeviceCode,
    started: Instant,
    cancelled: Arc<AtomicBool>,
}

impl PendingLogin {
    pub fn start(http: &Http) -> SyncResult<Self> {
        Ok(Self {
            code: http.github_device_code()?,
            started: Instant::now(),
            cancelled: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn code(&self) -> &DeviceCode {
        &self.code
    }

    /// 给取消用：另一个命令拿着它，设一下就行
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    /// 等用户在浏览器里确认，存好令牌，返回账号 login
    pub fn wait(self, http: &Http) -> SyncResult<String> {
        let mut interval = Duration::from_secs(self.code.interval.max(1));
        let deadline = self.started + Duration::from_secs(self.code.expires_in);
        loop {
            // 一秒一秒地睡，取消了能马上停
            let wake = Instant::now() + interval;
            while Instant::now() < wake {
                if self.cancelled.load(Ordering::SeqCst) {
                    return Err(SyncError::Local("登录取消了".into()));
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            if Instant::now() > deadline {
                return Err(SyncError::Remote("验证码过期了，重新登录一次".into()));
            }
            match http.github_device_poll(&self.code.device_code)? {
                DevicePoll::Pending => {}
                DevicePoll::SlowDown(seconds) => interval = Duration::from_secs(seconds.max(1)),
                DevicePoll::Expired => {
                    return Err(SyncError::Remote("验证码过期了，重新登录一次".into()))
                }
                DevicePoll::Denied => {
                    return Err(SyncError::Remote("在 GitHub 上没有同意授权".into()))
                }
                DevicePoll::Done(token) => {
                    let login = Provider::GitHub.login_of(http, &token.access)?;
                    secret::save(&Provider::GitHub.account_key(&login), &token)?;
                    return Ok(login);
                }
            }
        }
    }
}

/// 放在 AppState 里的登录槽：开始登录时放进去，等的命令拿走，取消的命令按旗子叫停。
/// 再开始一次新的登录，旧的那次自动取消
#[derive(Default)]
pub struct LoginSlot {
    pending: Option<PendingLogin>,
    cancel: Option<Arc<AtomicBool>>,
}

impl LoginSlot {
    pub fn put(&mut self, login: PendingLogin) {
        self.cancel();
        self.cancel = Some(login.cancel_flag());
        self.pending = Some(login);
    }

    pub fn take(&mut self) -> Option<PendingLogin> {
        self.pending.take()
    }

    pub fn cancel(&mut self) {
        if let Some(flag) = self.cancel.take() {
            flag.store(true, Ordering::SeqCst);
        }
        self.pending = None;
    }
}

/// Gitee：用户粘贴的私人令牌。先问一下它是谁的（顺便验证能用），存好，返回 login
pub fn login_gitee(http: &Http, token: &str) -> SyncResult<String> {
    let token = token.trim();
    if token.is_empty() {
        return Err(SyncError::Local("令牌是空的".into()));
    }
    let login = Provider::Gitee.login_of(http, token).map_err(|error| match error {
        // 刚粘贴的令牌被拒，不是「登录失效」
        SyncError::Auth => SyncError::Remote("令牌不对，或者已经被删掉了。检查一下再粘贴一次".into()),
        other => other,
    })?;
    secret::save(
        &Provider::Gitee.account_key(&login),
        &Token { access: token.to_string(), refresh: None, expires_at: None },
    )?;
    Ok(login)
}

/// 退出：删掉钥匙串里的令牌
pub fn logout(provider: Provider, login: &str) -> SyncResult<()> {
    secret::remove(&provider.account_key(login))
}

/// 钥匙串里还有这个账号的令牌吗
pub fn has_token(provider: Provider, login: &str) -> bool {
    matches!(secret::load(&provider.account_key(login)), Ok(Some(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unreachable_http() -> SyncResult<Http> {
        panic!("不该联网")
    }

    #[test]
    fn a_fresh_token_is_used_as_is() {
        let token = Token {
            access: "ghu_fresh".into(),
            refresh: Some("ghr".into()),
            expires_at: Some(chrono::Utc::now().timestamp_millis() + 3_600_000),
        };
        secret::save("github:fresh", &token).unwrap();
        assert_eq!(
            access_token(Provider::GitHub, "fresh", unreachable_http, false).unwrap(),
            "ghu_fresh"
        );
    }

    #[test]
    fn two_syncs_finding_the_token_expired_at_once_refresh_it_once() {
        // 照 GitHub 的规矩：刷新令牌用一次就作废，换来一对新的。两个仓库的同步线程同时要续，
        // 后到的那个不能拿已经作废的刷新令牌再去换（会被当成「登录失效」）
        let valid = Arc::new(Mutex::new(("ghr_0".to_string(), 0)));
        secret::save(
            "github:twice",
            &Token { access: "ghu_0".into(), refresh: Some("ghr_0".into()), expires_at: Some(0) },
        )
        .unwrap();
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let valid = valid.clone();
                std::thread::spawn(move || {
                    access_token_with(Provider::GitHub, "twice", false, |refresh| {
                        std::thread::sleep(Duration::from_millis(100));
                        let mut valid = valid.lock().unwrap();
                        if valid.0 != refresh {
                            return Err(SyncError::Auth);
                        }
                        valid.1 += 1;
                        valid.0 = format!("ghr_{}", valid.1);
                        Ok(Token {
                            access: format!("ghu_{}", valid.1),
                            refresh: Some(valid.0.clone()),
                            expires_at: Some(chrono::Utc::now().timestamp_millis() + 8 * 3_600_000),
                        })
                    })
                })
            })
            .collect();
        let results: Vec<_> = threads.into_iter().map(|thread| thread.join().unwrap()).collect();
        assert_eq!(results, vec![Ok("ghu_1".to_string()), Ok("ghu_1".to_string())]);
        assert_eq!(valid.lock().unwrap().1, 1, "只续了一次");
        assert_eq!(secret::load("github:twice").unwrap().unwrap().refresh.as_deref(), Some("ghr_1"));
    }

    #[test]
    fn no_token_or_a_rejected_gitee_token_means_login_again() {
        assert_eq!(
            access_token(Provider::Gitee, "nobody", unreachable_http, false).unwrap_err(),
            SyncError::Auth
        );
        secret::save(
            "gitee:me",
            &Token { access: "private".into(), refresh: None, expires_at: None },
        )
        .unwrap();
        assert_eq!(access_token(Provider::Gitee, "me", unreachable_http, false).unwrap(), "private");
        // 私人令牌被拒了：没有刷新令牌可续
        assert_eq!(
            access_token(Provider::Gitee, "me", unreachable_http, true).unwrap_err(),
            SyncError::Auth
        );
        assert!(has_token(Provider::Gitee, "me"));
        logout(Provider::Gitee, "me").unwrap();
        assert!(!has_token(Provider::Gitee, "me"));
    }
}
