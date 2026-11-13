use super::*;

/* ---------------- 附近（设计 §8.3） ---------------- */

/// 开始看同一个网络里谁在分享（加入对话框开着时）。列表从 CollabEvent 的 nearby 里出来
#[tauri::command]
#[specta::specta]
pub async fn collab_nearby_start<R: Runtime>(app: AppHandle<R>, caller: Caller, state: State<'_, AppState>) -> Result<()> {
    *state.collab.nearby_owner.lock().unwrap() = Some(caller.label.clone());
    if state.collab.nearby.lock().unwrap().is_some() {
        return Ok(());
    }
    let label = caller.label.clone();
    let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel::<collab::Event>();
    let nearby = collab::nearby::Nearby::start(events).await.map_err(AppError::Io)?;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            if let collab::Event::Control(control) = event {
                let _ = (CollabEvent { session: None, control }).emit_to(&app, label.as_str());
            }
        }
    });
    let old = state.collab.nearby.lock().unwrap().replace(nearby);
    if let Some(old) = old {
        old.stop().await;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn collab_nearby_stop(state: State<'_, AppState>) -> Result<()> {
    let nearby = state.collab.nearby.lock().unwrap().take();
    if let Some(nearby) = nearby {
        nearby.stop().await;
    }
    Ok(())
}

/// 点了「附近」列表里的一位：不用链接，请求加入（主持人照样确认）
#[tauri::command]
#[specta::specta]
pub async fn collab_join_nearby<R: Runtime>(
    app: AppHandle<R>,
    caller: Caller,
    state: State<'_, AppState>,
    session: u16,
    id: String,
) -> Result<()> {
    let nearby = state.collab.nearby.lock().unwrap().take();
    let Some(nearby) = nearby else {
        return Err(AppError::Invalid("「附近」列表已经关了，再打开一次".into()));
    };
    let invite = nearby.invite(&id);
    nearby.stop().await;
    let invite = invite.ok_or_else(|| AppError::NotFound("对方已经不在分享了".into()))?;
    join_with(app, &state, &caller.label, session, invite, true, false, None).await
}

/// 「附近」进来一位、我主持着好几个（NearbyKnock）：让他进哪一个（session 是会话号，空 = 拒绝），给什么权限
#[tauri::command]
#[specta::specta]
pub async fn collab_answer_nearby(
    caller: Caller,
    state: State<'_, AppState>,
    request: u32,
    session: Option<u16>,
    permission: Permission,
) -> Result<bool> {
    let node = state.collab.node.lock().await.clone();
    let Some(node) = node else { return Ok(false) };
    let choice = session
        .and_then(|session| state.collab.host(&caller.label, session, |host| host.session()))
        .map(|id| (id, permission));
    Ok(node.answer_nearby(request, choice))
}
