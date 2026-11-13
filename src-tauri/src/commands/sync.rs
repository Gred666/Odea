use super::*;

/* ---------------- 同步（技术方案 §5.9） ---------------- */

/// 同步状态变了
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct SyncStatusChanged(pub SyncStatus);

/// 同步要告诉用户的一句话：冲突副本、超限的文件没同步、仓库快满了
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct SyncNotice(pub String);

/// 同步线程往外发东西的口子：状态、提示（只发给这个仓库的窗口），和每轮要的令牌与代理
pub fn sync_hooks<R: Runtime>(app: AppHandle<R>, label: String, data_dir: PathBuf) -> Hooks {
    let (status_app, status_label) = (app.clone(), label.clone());
    Hooks {
        status: Arc::new(move |status| {
            if let Err(error) = SyncStatusChanged(status.clone()).emit_to(&status_app, status_label.as_str()) {
                eprintln!("通知前端失败: {error}");
            }
        }),
        notice: Arc::new(move |text| {
            if let Err(error) = SyncNotice(text).emit_to(&app, label.as_str()) {
                eprintln!("通知前端失败: {error}");
            }
        }),
        net: Arc::new(move |repo, rejected| net_for(&data_dir, repo, rejected)),
    }
}

/// 这个仓库连云端用的令牌和代理。`rejected` = 刚才被云端拒了，GitHub 的令牌先续一次
fn net_for(data_dir: &std::path::Path, repo: &SyncRepo, rejected: bool) -> SyncResult<Net> {
    let proxy = proxy::resolve(boot::Config::load(data_dir).sync_proxy.as_deref());
    let provider = repo
        .config_get(PROVIDER_KEY)
        .as_deref()
        .and_then(Provider::parse);
    let credentials = match (provider, repo.config_get(LOGIN_KEY)) {
        (Some(provider), Some(login)) => {
            let token = account::access_token(
                provider,
                &login,
                || Http::new(proxy.as_deref()),
                rejected,
            )?;
            Some((login, token))
        }
        // 没登录的远端（比如本机的一个裸仓库）
        _ => None,
    };
    Ok(Net { credentials, proxy })
}

/// 文件监听每处理完一批就戳一下同步线程
pub fn sync_poke(hub: &Arc<SyncHub>) -> watch::OnBatch {
    let hub = hub.clone();
    Arc::new(move || hub.poke())
}

pub(crate) fn sync_http(data_dir: &std::path::Path) -> SyncResult<Http> {
    Http::new(proxy::resolve(boot::Config::load(data_dir).sync_proxy.as_deref()).as_deref())
}

pub(crate) fn provider_of(key: &str) -> Result<Provider> {
    Provider::parse(key).ok_or_else(|| AppError::Invalid(format!("不认识的托管方: {key}")))
}

/// 这个托管方登录的是哪个账号
pub(crate) fn login_of(data_dir: &std::path::Path, provider: Provider) -> Result<String> {
    boot::Config::load(data_dir)
        .sync_accounts
        .get(provider.key())
        .cloned()
        .ok_or_else(|| AppError::Invalid("还没登录".into()))
}

/// 用这个托管方的账号调一次接口：令牌快过期先续；被拒了续一次再试
pub(in crate::commands) fn with_token<T>(
    data_dir: &std::path::Path,
    provider: Provider,
    call: impl Fn(&Http, &str) -> SyncResult<T>,
) -> Result<T> {
    let login = login_of(data_dir, provider)?;
    let http = sync_http(data_dir)?;
    let token = account::access_token(provider, &login, || sync_http(data_dir), false)?;
    match call(&http, &token) {
        Err(SyncError::Auth) => {
            let token = account::access_token(provider, &login, || sync_http(data_dir), true)?;
            Ok(call(&http, &token)?)
        }
        other => Ok(other?),
    }
}

fn remember_account(
    data_dir: &std::path::Path,
    provider: Provider,
    login: String,
) -> Result<SyncAccount> {
    let mut config = boot::Config::load(data_dir);
    config
        .sync_accounts
        .insert(provider.key().to_string(), login.clone());
    config.save(data_dir)?;
    Ok(SyncAccount { provider: provider.key().to_string(), login })
}

pub(in crate::commands) fn remote_info(repo: RemoteRepo) -> SyncRemoteRepo {
    SyncRemoteRepo {
        full_name: repo.full_name,
        clone_url: repo.clone_url,
        private: repo.private,
        updated_at: repo.updated_at,
        owner: repo.owner,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn sync_status(ws: Ws) -> Result<SyncStatus> {
    Ok(ws.sync.status())
}

/// 立即同步一轮。没开同步返回 false
#[tauri::command]
#[specta::specta]
pub async fn sync_now(ws: Ws) -> Result<bool> {
    Ok(ws.sync.sync_now())
}

/// 登录过、钥匙串里还有令牌的同步账号
#[tauri::command]
#[specta::specta]
pub async fn sync_accounts(state: State<'_, AppState>) -> Result<Vec<SyncAccount>> {
    let data_dir = state.data_dir.clone();
    blocking(move || {
        Ok(boot::Config::load(&data_dir)
            .sync_accounts
            .iter()
            .filter_map(|(key, login)| {
                let provider = Provider::parse(key)?;
                account::has_token(provider, login).then(|| SyncAccount {
                    provider: key.clone(),
                    login: login.clone(),
                })
            })
            .collect())
    })
    .await
}

/// GitHub 设备码登录第一步：领一个码给用户看。接着调 sync_github_login_wait 等用户确认
#[tauri::command]
#[specta::specta]
pub async fn sync_github_login_start(state: State<'_, AppState>) -> Result<SyncDeviceCode> {
    let data_dir = state.data_dir.clone();
    let pending = blocking(move || Ok(PendingLogin::start(&sync_http(&data_dir)?)?)).await?;
    let code = pending.code();
    let shown = SyncDeviceCode {
        user_code: code.user_code.clone(),
        verification_uri: code.verification_uri.clone(),
        expires_in: code.expires_in as u32,
    };
    state
        .sync_login
        .lock()
        .map_err(|_| AppError::Internal("登录状态锁坏了".into()))?
        .put(pending);
    Ok(shown)
}

/// 等用户在浏览器里确认（sync_login_cancel 能叫停）。成功后令牌进钥匙串，返回账号
#[tauri::command]
#[specta::specta]
pub async fn sync_github_login_wait(state: State<'_, AppState>) -> Result<SyncAccount> {
    let pending = state
        .sync_login
        .lock()
        .map_err(|_| AppError::Internal("登录状态锁坏了".into()))?
        .take()
        .ok_or_else(|| AppError::Invalid("没有正在进行的登录".into()))?;
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let login = pending.wait(&sync_http(&data_dir)?)?;
        remember_account(&data_dir, Provider::GitHub, login)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn sync_login_cancel(state: State<'_, AppState>) -> Result<()> {
    state
        .sync_login
        .lock()
        .map_err(|_| AppError::Internal("登录状态锁坏了".into()))?
        .cancel();
    Ok(())
}

/// Gitee：用私人令牌登录（先问一下令牌是谁的，顺便验证能用）
#[tauri::command]
#[specta::specta]
pub async fn sync_gitee_login(state: State<'_, AppState>, token: String) -> Result<SyncAccount> {
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let login = account::login_gitee(&sync_http(&data_dir)?, &token)?;
        remember_account(&data_dir, Provider::Gitee, login)
    })
    .await
}

/// 退出这个托管方的账号：删掉钥匙串里的令牌
#[tauri::command]
#[specta::specta]
pub async fn sync_logout(state: State<'_, AppState>, provider: String) -> Result<()> {
    let provider = provider_of(&provider)?;
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let mut config = boot::Config::load(&data_dir);
        if let Some(login) = config.sync_accounts.remove(provider.key()) {
            account::logout(provider, &login)?;
            config.save(&data_dir)?;
        }
        Ok(())
    })
    .await
}

/// 这个账号自己的仓库，最近更新的在前
#[tauri::command]
#[specta::specta]
pub async fn sync_repos(state: State<'_, AppState>, provider: String) -> Result<Vec<SyncRemoteRepo>> {
    let provider = provider_of(&provider)?;
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let repos = with_token(&data_dir, provider, |http, token| provider.repos(http, token))?;
        Ok(repos.into_iter().map(remote_info).collect())
    })
    .await
}

/// 新建一个空的私有仓库
#[tauri::command]
#[specta::specta]
pub async fn sync_create_repo(
    state: State<'_, AppState>,
    provider: String,
    name: String,
) -> Result<SyncRemoteRepo> {
    let provider = provider_of(&provider)?;
    let name = name.trim().to_string();
    let valid = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !valid {
        return Err(AppError::Invalid(
            "仓库名只能用英文字母、数字和 - _ .".into(),
        ));
    }
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let repo = with_token(&data_dir, provider, |http, token| {
            provider.create_repo(http, token, &name)
        })?;
        Ok(remote_info(repo))
    })
    .await
}

/// 同步用的代理：用户填的，和实际在用的
#[tauri::command]
#[specta::specta]
pub async fn sync_proxy(state: State<'_, AppState>) -> Result<SyncProxy> {
    let configured = boot::Config::load(&state.data_dir).sync_proxy;
    let effective = proxy::resolve(configured.as_deref());
    Ok(SyncProxy { configured, effective })
}

/// 填一个代理（空的 = 不填，按环境变量、系统代理找）
#[tauri::command]
#[specta::specta]
pub async fn sync_set_proxy(state: State<'_, AppState>, proxy: Option<String>) -> Result<SyncProxy> {
    let configured = proxy.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    let mut config = boot::Config::load(&state.data_dir);
    config.sync_proxy = configured.clone();
    config.save(&state.data_dir)?;
    let effective = proxy::resolve(configured.as_deref());
    Ok(SyncProxy { configured, effective })
}

/// 开启同步前先看一眼云端：在这里接上，还是要 clone 到新文件夹（放在哪）
#[tauri::command]
#[specta::specta]
pub async fn sync_inspect(
    ws: Ws,
    state: State<'_, AppState>,
    provider: String,
    clone_url: String,
) -> Result<SyncPlan> {
    let provider = provider_of(&provider)?;
    let data_dir = state.data_dir.clone();
    let root = with_vault(&ws, |v| Ok(v.root().to_path_buf())).await?;
    blocking(move || {
        let login = login_of(&data_dir, provider)?;
        let token = account::access_token(provider, &login, || sync_http(&data_dir), false)?;
        let net = Net {
            credentials: Some((login, token)),
            proxy: proxy::resolve(boot::Config::load(&data_dir).sync_proxy.as_deref()),
        };
        let reconnect = SyncRepo::open(&root)?
            .and_then(|repo| repo.remote_url())
            .is_some_and(|url| setup::same_remote(&url, &clone_url));
        let connect_here = reconnect || SyncRepo::remote_is_empty(&clone_url, &net)?;
        Ok(SyncPlan {
            connect_here,
            clone_target: (!connect_here)
                .then(|| setup::clone_target(&root).to_string_lossy().into_owned()),
            local_notes: fsio::has_markdown(&root),
        })
    })
    .await
}

/// 开启同步（技术方案 §5.9.7）。云端仓库是空的（或者就是这个仓库以前连过的）：
/// 在现在的仓库上接上，同步线程第一轮把这里的推上去，返回 false。
/// 云端已经有东西：clone 到旁边的新文件夹、换过去（`bring_local` = 把现在仓库里的也拷过去），
/// 返回 true —— 前端整页重载
#[tauri::command]
#[specta::specta]
pub async fn sync_enable<R: Runtime>(
    app: AppHandle<R>,
    ws: Ws,
    state: State<'_, AppState>,
    provider: String,
    clone_url: String,
    bring_local: bool,
) -> Result<bool> {
    let provider = provider_of(&provider)?;
    let data_dir = state.data_dir.clone();
    let root = with_vault(&ws, |v| Ok(v.root().to_path_buf())).await?;
    if let Some(drive) = setup::cloud_drive_of(&root) {
        return Err(AppError::Invalid(format!(
            "笔记文件夹在{drive}的同步目录里。网盘和同步二选一：网盘会来回拷 .git，迟早把它弄坏。先把笔记文件夹换到网盘外面（命令面板「更换笔记文件夹…」）"
        )));
    }
    let login = login_of(&data_dir, provider)?;
    ws.sync.stop();
    let (here, data) = (root.clone(), data_dir.clone());
    let cloned = blocking(move || {
        let token = account::access_token(provider, &login, || sync_http(&data), false)?;
        let net = Net {
            credentials: Some((login.clone(), token)),
            proxy: proxy::resolve(boot::Config::load(&data).sync_proxy.as_deref()),
        };
        let reconnect = SyncRepo::open(&here)?
            .and_then(|repo| repo.remote_url())
            .is_some_and(|url| setup::same_remote(&url, &clone_url));
        if reconnect || SyncRepo::remote_is_empty(&clone_url, &net)? {
            setup::connect_here(&here, provider, &login, &clone_url)?;
            return Ok(None);
        }
        let target = setup::clone_target(&here);
        let repo = SyncRepo::clone(&clone_url, &target, &net)?;
        setup::mark(&repo, provider, &login)?;
        if bring_local {
            setup::bring_local(&here, &target)?;
        }
        Ok(Some(target))
    })
    .await?;

    match cloned {
        Some(target) => {
            switch_vault(&app, &state, &ws.0, target).await?;
            Ok(true)
        }
        None => {
            let (hub, vault, hooks) = (
                ws.sync.clone(),
                ws.vault.clone(),
                sync_hooks(app.clone(), ws.label.clone(), data_dir),
            );
            blocking(move || {
                hub.start(vault, hooks)?;
                // 前端早就 ready 了：第一轮现在就开始，不等那 30 秒
                hub.sync_now();
                Ok(())
            })
            .await?;
            Ok(false)
        }
    }
}

/// 断开同步：不再自动同步，忘掉这个仓库用哪个账号。.git 留着（历史都在，能再连上），账号不退出
#[tauri::command]
#[specta::specta]
pub async fn sync_disable(ws: Ws) -> Result<SyncStatus> {
    ws.sync.stop();
    let root = with_vault(&ws, |v| Ok(v.root().to_path_buf())).await?;
    blocking(move || Ok(setup::disconnect(&root)?)).await?;
    Ok(ws.sync.status())
}
