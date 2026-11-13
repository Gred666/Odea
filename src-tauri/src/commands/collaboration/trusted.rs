use super::*;

/* ---------------- 记住的人（设计 §8.2） ---------------- */

pub(in crate::commands) fn load_trusted(data_dir: &std::path::Path) -> Vec<TrustedPeer> {
    boot::Config::load(data_dir)
        .collab_trusted
        .into_iter()
        .filter(|saved| collab_record::hex_array::<32>(&saved.id).is_some())
        .map(|saved| TrustedPeer {
            id: saved.id,
            name: saved.name,
            permission: if saved.edit { Permission::Edit } else { Permission::Read },
        })
        .collect()
}

/// 改 config.json 里记住的人，返回改完的整张表
pub(in crate::commands) fn update_trusted(
    data_dir: &std::path::Path,
    change: impl FnOnce(&mut Vec<boot::SavedPeer>),
) -> Result<Vec<TrustedPeer>> {
    let mut config = boot::Config::load(data_dir);
    change(&mut config.collab_trusted);
    config.save(data_dir).map_err(|error| AppError::Io(error.to_string()))?;
    Ok(load_trusted(data_dir))
}

/// 主持人记住的人
#[tauri::command]
#[specta::specta]
pub async fn collab_trusted(state: State<'_, AppState>) -> Result<Vec<TrustedPeer>> {
    let data_dir = state.data_dir.clone();
    blocking(move || Ok(load_trusted(&data_dir))).await
}

/// 每个在主持的会话
fn each_host(hub: &CollabHub, mut use_it: impl FnMut(&Host)) {
    for found in hub.sessions.lock().unwrap().values() {
        if let Active::Host(host) = &found.active {
            use_it(host);
        }
    }
}

/// 记住一个人：下次拿着链接或者从「附近」进来不问，按这个权限进来（每个在主持的会话都算）。返回整张表
#[tauri::command]
#[specta::specta]
pub async fn collab_remember(
    state: State<'_, AppState>,
    id: String,
    name: String,
    permission: Permission,
) -> Result<Vec<TrustedPeer>> {
    let key: [u8; 32] = collab_record::hex_array(&id).ok_or_else(|| AppError::Invalid("不是设备公钥".into()))?;
    each_host(&state.collab, |host| host.trust(key, permission));
    let data_dir = state.data_dir.clone();
    blocking(move || {
        update_trusted(&data_dir, |list| {
            list.retain(|peer| peer.id != id);
            list.push(boot::SavedPeer {
                id,
                name: collab::clean_name(&name),
                edit: permission == Permission::Edit,
            });
        })
    })
    .await
}

/// 不再记住：下次进来照样问。返回整张表
#[tauri::command]
#[specta::specta]
pub async fn collab_forget(state: State<'_, AppState>, id: String) -> Result<Vec<TrustedPeer>> {
    if let Some(key) = collab_record::hex_array::<32>(&id) {
        each_host(&state.collab, |host| host.forget(&key));
    }
    let data_dir = state.data_dir.clone();
    blocking(move || update_trusted(&data_dir, |list| list.retain(|peer| peer.id != id))).await
}
