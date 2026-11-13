use super::*;

/* ---------------- 协作中继（设计 §6.4） ---------------- */

#[tauri::command]
#[specta::specta]
pub async fn collab_relays(state: State<'_, AppState>) -> Result<Vec<RelayInfo>> {
    let data_dir = state.data_dir.clone();
    blocking(move || Ok(relay_infos(&data_dir))).await
}

/// 中继码里是哪一台（添加之前给用户看一眼、确认）
#[tauri::command]
#[specta::specta]
pub async fn collab_relay_inspect(code: String) -> Result<RelayInfo> {
    let relay = Relay::parse_code(&code).map_err(|error| AppError::Invalid(error.to_string()))?;
    Ok(RelayInfo::of(&relay))
}

/// 添加中继：粘的中继码（code），或者手填的地址、令牌、指纹、名字
#[tauri::command]
#[specta::specta]
pub async fn collab_relay_add(
    state: State<'_, AppState>,
    code: Option<String>,
    url: Option<String>,
    token: Option<String>,
    fingerprint: Option<String>,
    name: Option<String>,
) -> Result<Vec<RelayInfo>> {
    let relay = match code {
        Some(code) => Relay::parse_code(&code).map_err(|error| AppError::Invalid(error.to_string()))?,
        None => Relay::new(url.as_deref().unwrap_or_default(), token, fingerprint.as_deref(), name)
            .map_err(|error| AppError::Invalid(error.to_string()))?,
    };
    let data_dir = state.data_dir.clone();
    let added = relay.clone();
    let infos = blocking(move || {
        save_relay(&data_dir, &relay)?;
        Ok(relay_infos(&data_dir))
    })
    .await?;
    // 团队端点、协作端点开着：当场接上这台（不用重开）
    if let Some(net) = state.team.net() {
        net.add_relay(added.clone()).await;
    }
    let node = state.collab.node.lock().await.clone();
    if let Some(node) = node {
        node.add_relay(added).await;
    }
    Ok(infos)
}

#[tauri::command]
#[specta::specta]
pub async fn collab_relay_remove(state: State<'_, AppState>, url: String) -> Result<Vec<RelayInfo>> {
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let mut config = boot::Config::load(&data_dir);
        config.collab_relays.retain(|item| item.url != url);
        config.save(&data_dir).map_err(|error| AppError::Io(error.to_string()))?;
        let _ = crate::sync::secret::remove(&format!("{RELAY_TOKEN}{url}"));
        Ok(relay_infos(&data_dir))
    })
    .await
}

/// 这台中继的中继码（带令牌）：发给团队里的其他人
#[tauri::command]
#[specta::specta]
pub async fn collab_relay_code(state: State<'_, AppState>, url: String) -> Result<String> {
    let data_dir = state.data_dir.clone();
    blocking(move || {
        load_relays(&data_dir)
            .into_iter()
            .find(|relay| relay.url == url)
            .map(|relay| relay.to_code())
            .ok_or_else(|| AppError::NotFound("这台中继已经删掉了".into()))
    })
    .await
}

/// 测试一台中继：连一下，报延迟、令牌对不对、UDP 7842 通不通（最多等八秒）
#[tauri::command]
#[specta::specta]
pub async fn collab_relay_test(state: State<'_, AppState>, url: String) -> Result<RelayCheck> {
    let data_dir = state.data_dir.clone();
    let relay = blocking(move || {
        load_relays(&data_dir)
            .into_iter()
            .find(|relay| relay.url == url)
            .ok_or_else(|| AppError::NotFound("这台中继已经删掉了".into()))
    })
    .await?;
    Ok(collab::relays::check(&relay, Duration::from_secs(8)).await)
}

/// 主持人回答加入请求：allow 是给的权限，None 是拒绝
#[tauri::command]
#[specta::specta]
pub async fn collab_answer(
    caller: Caller,
    state: State<'_, AppState>,
    session: u16,
    request: u32,
    allow: Option<Permission>,
) -> Result<bool> {
    let decision = allow.map_or(Decision::Reject, Decision::Allow);
    Ok(state.collab.host(&caller.label, session, |host| host.answer(request, decision)).unwrap_or(false))
}

#[tauri::command]
#[specta::specta]
pub async fn collab_set_permission(
    caller: Caller,
    state: State<'_, AppState>,
    session: u16,
    member: u16,
    permission: Permission,
) -> Result<()> {
    let changed = state
        .collab
        .host(&caller.label, session, |host| {
            host.set_permission(member, permission);
            host.members().into_iter().find(|item| item.member == member)
        })
        .flatten();
    // 记住过的人：以后进来也按改过的权限
    if let Some(changed) = changed {
        let data_dir = state.data_dir.clone();
        blocking(move || {
            update_trusted(&data_dir, |list| {
                if let Some(peer) = list.iter_mut().find(|peer| peer.id == changed.id) {
                    peer.edit = permission == Permission::Edit;
                }
            })
        })
        .await?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn collab_kick(caller: Caller, state: State<'_, AppState>, session: u16, member: u16) -> Result<()> {
    let kicked = state.collab.host(&caller.label, session, |host| host.kick(member)).flatten();
    // 移出了就不再记住（Host 那边已经忘了）
    if let Some(id) = kicked {
        let id = collab::id_text(&id);
        let data_dir = state.data_dir.clone();
        blocking(move || update_trusted(&data_dir, |list| list.retain(|peer| peer.id != id))).await?;
    }
    Ok(())
}
