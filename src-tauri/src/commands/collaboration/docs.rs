use super::*;

/* ---------------- 一条连接里好几篇（设计 §22.5） ---------------- */

/// 主持人：前端对「访客要开这一篇」（docOpen）的回话。error 为空 = 给
#[tauri::command]
#[specta::specta]
pub async fn collab_doc_answer(
    caller: Caller,
    state: State<'_, AppState>,
    session: u16,
    request: u32,
    error: Option<String>,
) -> Result<bool> {
    Ok(state
        .collab
        .host(&caller.label, session, |host| host.answer_doc(request, error.map_or(Ok(()), Err)))
        .unwrap_or(false))
}

/// 主持人：范围里的树（JSON，前端给什么访客那边就收到什么）
#[tauri::command]
#[specta::specta]
pub async fn collab_set_tree(caller: Caller, state: State<'_, AppState>, session: u16, tree: String) -> Result<()> {
    state.collab.host(&caller.label, session, |host| host.set_tree(tree.into_bytes()));
    Ok(())
}

/// 主持人：访客要的那篇建好了（doc），或者建不了（error）
#[tauri::command]
#[specta::specta]
pub async fn collab_create_answer(
    caller: Caller,
    state: State<'_, AppState>,
    session: u16,
    request: u32,
    doc: Option<String>,
    error: Option<String>,
) -> Result<bool> {
    let result = match doc {
        Some(doc) => Ok(doc),
        None => Err(error.unwrap_or_else(|| "建不了".into())),
    };
    Ok(state.collab.host(&caller.label, session, |host| host.answer_create(request, result)).unwrap_or(false))
}

/// 访客：开一篇（范围里的）。开好了从管道上来 SyncStart；不给是 CollabEvent 的 docRefused
#[tauri::command]
#[specta::specta]
pub async fn collab_open_doc(caller: Caller, state: State<'_, AppState>, session: u16, doc: String) -> Result<()> {
    let dir = state.collab.with(&caller.label, session, |found| {
        if let Active::Guest(guest) = &found.active {
            guest.open_doc(&doc);
        }
        found.dir.clone()
    });
    if let Some(dir) = dir {
        update_guest_record(&dir, move |record| {
            if !record.docs.contains(&doc) {
                record.docs.push(doc);
            }
        });
    }
    Ok(())
}

/// 访客：关掉一篇（主持人那边知道我不看了）
#[tauri::command]
#[specta::specta]
pub async fn collab_close_doc(caller: Caller, state: State<'_, AppState>, session: u16, doc: String) -> Result<()> {
    let dir = state.collab.with(&caller.label, session, |found| {
        if let Active::Guest(guest) = &found.active {
            guest.close_doc(&doc);
        }
        found.dir.clone()
    });
    if let Some(dir) = dir {
        update_guest_record(&dir, move |record| record.docs.retain(|open| open != &doc));
    }
    Ok(())
}

/// 访客：在范围里新建一篇（主持人那边建），返回它的文档 id
#[tauri::command]
#[specta::specta]
pub async fn collab_create_doc(
    caller: Caller,
    state: State<'_, AppState>,
    session: u16,
    folder: String,
    title: String,
) -> Result<String> {
    // 锁不跨 await：拿新建的把手出来，锁外等回话
    let creator = state
        .collab
        .guest(&caller.label, session, Guest::creator)
        .ok_or_else(|| AppError::Invalid("现在没有在别人那里做客".into()))?;
    creator.create(&folder, &title).await.map_err(AppError::Invalid)
}
