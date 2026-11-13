use super::*;

/* ---------------- 落盘、继续上次的协作（设计 §3、§25.2） ---------------- */

/// 上次没正常结束的几次协作（主持的、做客的，一次一条）
#[tauri::command]
#[specta::specta]
pub async fn collab_resume_info(caller: Caller, state: State<'_, AppState>) -> Result<CollabResume> {
    let data_dir = state.data_dir.clone();
    // 正在用的（已经接着来了）不算
    let active: std::collections::HashSet<PathBuf> =
        state.collab.sessions.lock().unwrap().values().map(|found| found.dir.clone()).collect();
    // 几个仓库窗口同时开着：主持的那一次只在那篇笔记所在的仓库里问（访客窗口没有仓库，不问）；
    // 做客的只问第一个来问的窗口
    let vault = caller.workspace.as_ref().map(|workspace| workspace.vault.clone());
    let hub = state.collab.clone();
    blocking(move || {
        let base = collab_dir(&data_dir);
        // 一篇的：那篇笔记在这个仓库里才问；文件夹、整个仓库的：在有仓库的窗口里问
        let here = |note: &str| {
            vault.as_ref().is_some_and(|vault| note.is_empty() || vault.lock().is_ok_and(|vault| vault.note_get(note).is_ok()))
        };
        let hosts = collab_record::hosts_left(&base)
            .into_iter()
            .filter(|(dir, record)| !active.contains(dir) && here(&record.note))
            .map(|(dir, record)| HostResume {
                key: collab_record::dir_key(&dir),
                note: record.note,
                scope: record.scope,
                title: record.title,
                guests: record.approved.len() as u32,
                saved_at: record.saved_at as f64,
            })
            .collect();
        let mut offered = hub.guest_resume_offered.lock().unwrap();
        let guests: Vec<GuestResume> = collab_record::guests_left(&base)
            .into_iter()
            .filter(|(dir, _)| !active.contains(dir) && !offered.contains(&collab_record::dir_key(dir)))
            .map(|(dir, record)| GuestResume {
                key: collab_record::dir_key(&dir),
                title: record.title,
                host_name: record.host_name,
                saved_at: record.saved_at as f64,
            })
            .collect();
        offered.extend(guests.iter().map(|guest| guest.key.clone()));
        Ok(CollabResume { hosts, guests })
    })
    .await
}

/// 访客：继续上次没正常结束的那一次做客（前端先读走了落盘的状态，用它建好了会话）
#[tauri::command]
#[specta::specta]
pub async fn collab_rejoin<R: Runtime>(
    app: AppHandle<R>,
    caller: Caller,
    state: State<'_, AppState>,
    session: u16,
    key: String,
) -> Result<()> {
    let dir = collab_record::guest_dir(&collab_dir(&state.data_dir), &key);
    let record = blocking(move || Ok(collab_record::guest_left(&dir))).await?;
    let record = record.ok_or_else(|| AppError::NotFound("上次做客的记录已经没了".into()))?;
    let invite = Invite::parse(&record.link).map_err(|error| AppError::Invalid(error.to_string()))?;
    join_with(app, &state, &caller.label, session, invite, record.nearby, record.direct_only, Some(key)).await
}

/// 落盘的那一次在哪（host：主持的，否则做客的）
fn resume_dir(data_dir: &std::path::Path, host: bool, key: &str) -> PathBuf {
    let base = collab_dir(data_dir);
    if host {
        base.join("host").join(key)
    } else {
        collab_record::guest_dir(&base, key)
    }
}

/// 不接着来了：落盘的那一次删掉
#[tauri::command]
#[specta::specta]
pub async fn collab_discard_resume(state: State<'_, AppState>, host: bool, key: String) -> Result<()> {
    let dir = resume_dir(&state.data_dir, host, &key);
    blocking(move || {
        collab_record::remove_session(&dir);
        Ok(())
    })
    .await
}

/// 落盘的那一次里这一篇的状态（不经 tauri-specta：原始字节）。host = 主持的，否则做客的
#[tauri::command]
pub fn collab_resume_state(
    state: State<'_, AppState>,
    host: bool,
    key: String,
    doc: String,
) -> std::result::Result<tauri::ipc::Response, String> {
    let role = if host { Role::Host } else { Role::Guest };
    collab_record::load_state(&resume_dir(&state.data_dir, host, &key), role, &doc)
        .map(tauri::ipc::Response::new)
        .ok_or_else(|| "上次协作的状态已经没了".to_string())
}

/// 上次那一次做客时开着的那几篇（重新加入时照样开）
#[tauri::command]
#[specta::specta]
pub async fn collab_resume_docs(state: State<'_, AppState>, key: String) -> Result<Vec<String>> {
    let dir = resume_dir(&state.data_dir, false, &key);
    blocking(move || {
        Ok(collab_record::guest_left(&dir)
            .map(|record| record.docs)
            .filter(|docs| !docs.is_empty())
            .unwrap_or_else(|| collab_record::saved_docs(&dir, Role::Guest)))
    })
    .await
}
