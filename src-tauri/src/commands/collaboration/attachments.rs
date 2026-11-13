use super::*;

/* ---------------- 附件（设计 §7.2） ---------------- */

/// 主持人：这一篇正文里引用的附件（正文一变前端就给一份新的）。只有在这里面的访客才要得到。
/// refs 是 None：这一篇不在协作里了（没人开着、收掉了）
#[tauri::command]
#[specta::specta]
pub async fn collab_set_attachment_refs(
    caller: Caller,
    state: State<'_, AppState>,
    session: u16,
    doc: String,
    refs: Option<Vec<AttachmentRef>>,
) -> Result<()> {
    state.collab.with(&caller.label, session, |found| match refs {
        Some(refs) => {
            found.refs.insert(doc, refs.into_iter().map(|item| (item.path, item.vault_path)).collect());
        }
        None => {
            found.refs.remove(&doc);
        }
    });
    Ok(())
}

/// 访客：向主持人要正文里引用的一个附件，缓存下来，返回本机的路径（前端转成 asset 地址显示）
#[tauri::command]
#[specta::specta]
pub async fn collab_fetch_attachment(
    caller: Caller,
    state: State<'_, AppState>,
    session: u16,
    doc: String,
    path: String,
) -> Result<String> {
    let file = fetch_guest_attachment(&caller, &state, session, doc, path).await?;
    Ok(file.to_string_lossy().replace('\\', "/"))
}

/// 访客：`![[说明书.pdf]]` 卡片上的「打开」—— 向主持人要来（同 collab_fetch_attachment），用系统的程序打开。
/// 只开附件那几种扩展名的（vault::is_attachment_name）：主持人那边给什么名字都不会在这台上执行起来
#[tauri::command]
#[specta::specta]
pub async fn collab_open_attachment(
    caller: Caller,
    state: State<'_, AppState>,
    session: u16,
    doc: String,
    path: String,
) -> Result<()> {
    let file = fetch_guest_attachment(&caller, &state, session, doc, path).await?;
    let name = file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    if !crate::vault::is_attachment_name(&name) {
        return Err(AppError::Invalid(format!("不打开这种文件: {name}")));
    }
    blocking(move || {
        tauri_plugin_opener::open_path(&file, None::<&str>).map_err(|error| AppError::Io(format!("打开文件失败: {error}")))
    })
    .await
}

/// 访客：向主持人要一个附件，写进本机的缓存，返回缓存的那个文件
async fn fetch_guest_attachment(
    caller: &Caller,
    state: &AppState,
    session: u16,
    doc: String,
    path: String,
) -> Result<PathBuf> {
    let (attachments, key) = state
        .collab
        .with(&caller.label, session, |found| match &found.active {
            Active::Guest(guest) => Some((guest.attachments(), collab_record::dir_key(&found.dir))),
            Active::Host(_) => None,
        })
        .flatten()
        .ok_or_else(|| AppError::Invalid("现在没有在别人那里做客".into()))?;
    let bytes = attachments.fetch(&doc, &path).await.map_err(AppError::Io)?;
    let dir = attachment_cache(&state.data_dir, &key);
    blocking(move || {
        // 一个路径一个文件夹（按路径算），里面的文件名跟着正文里写的走：「存一份到我的笔记」
        // 按路径存进自己的「附件」时，文件名还是原来那个。扩展名留着：asset 协议按扩展名放行图片
        let digest = ring::digest::digest(&ring::digest::SHA256, path.as_bytes());
        let folder = data_encoding::HEXLOWER.encode(&digest.as_ref()[..12]);
        let file = dir.join(folder).join(collab_record::cached_name(&path));
        collab_record::write_atomic(&file, &bytes).map_err(|error| AppError::Io(error.to_string()))?;
        Ok(file)
    })
    .await
}

/// 访客：粘贴的文件交给主持人存进他的「附件」，返回从那篇引用它的路径（编辑器插进正文）
#[tauri::command]
#[specta::specta]
pub async fn collab_put_attachment(
    caller: Caller,
    state: State<'_, AppState>,
    session: u16,
    doc: String,
    name: String,
    data_base64: String,
) -> Result<Attachment> {
    use base64::Engine;
    let bytes = blocking(move || {
        base64::engine::general_purpose::STANDARD
            .decode(data_base64.trim())
            .map_err(|error| AppError::Invalid(format!("附件内容不是 base64: {error}")))
    })
    .await?;
    put_attachment(&state, &caller.label, session, doc, name, bytes).await
}

/// 访客：从系统拖进来的文件（只有路径）
#[tauri::command]
#[specta::specta]
pub async fn collab_put_attachment_path(caller: Caller, state: State<'_, AppState>, session: u16, doc: String, path: String) -> Result<Attachment> {
    let source = PathBuf::from(&path);
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Invalid(format!("不是文件: {path}")))?;
    let bytes = blocking(move || {
        let size = std::fs::metadata(&source)?.len();
        if size > collab::protocol::MAX_ATTACHMENT as u64 {
            return Err(AppError::Invalid(format!("「{}」太大了，附件最多 50 MB", source.display())));
        }
        Ok(std::fs::read(&source)?)
    })
    .await?;
    put_attachment(&state, &caller.label, session, doc, name, bytes).await
}

async fn put_attachment(
    state: &AppState,
    label: &str,
    session: u16,
    doc: String,
    name: String,
    bytes: Vec<u8>,
) -> Result<Attachment> {
    let attachments = state
        .collab
        .guest(label, session, Guest::attachments)
        .ok_or_else(|| AppError::Invalid("现在没有在别人那里做客".into()))?;
    let link = attachments.put(&doc, &name, bytes).await.map_err(AppError::Io)?;
    let file = link.rsplit('/').next().unwrap_or(&link).to_string();
    let ext = std::path::Path::new(&file)
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    Ok(Attachment {
        is_image: crate::vault::IMAGE_EXTENSIONS.contains(&ext.as_str()),
        name: file,
        link,
    })
}

/// 访客连不上主持人时：生成回连链接发给主持人（设计 §8.4）。要等端口映射、中继有个结果，最多五秒
#[tauri::command]
#[specta::specta]
pub async fn collab_callback(caller: Caller, state: State<'_, AppState>, session: u16) -> Result<CollabCallback> {
    // 锁不跨 await：拿一个生成回连链接的把手出来，会话照常留在表里收发
    let maker = state
        .collab
        .guest(&caller.label, session, Guest::callbacks)
        .ok_or_else(|| AppError::Invalid("现在没有在加入协作".into()))?;
    let callback = maker.make().await;
    Ok(CollabCallback { link: callback.link, reach: callback.reach })
}

/// 访客：转发链接（设计 §20.9）。发给连不上主持人、却连得上我的人，他经我加入（主持人照样确认）。
/// 和回连链接一样先看我能不能被连进来
#[tauri::command]
#[specta::specta]
pub async fn collab_forward_link(caller: Caller, state: State<'_, AppState>, session: u16) -> Result<CollabCallback> {
    let maker = state
        .collab
        .guest(&caller.label, session, Guest::callbacks)
        .ok_or_else(|| AppError::Invalid("现在没有在加入协作".into()))?;
    let link = maker.forward_link().await;
    Ok(CollabCallback { link: link.link, reach: link.reach })
}

/// 主持人打开了回连链接：往访客那边拨，返回是哪个会话的（链接里带着会话 id）。
/// 拨的结果从那个会话的 CollabEvent 的 dialBack 里出来
#[tauri::command]
#[specta::specta]
pub async fn collab_dial_back(caller: Caller, state: State<'_, AppState>, link: String) -> Result<u16> {
    let callback = Callback::parse(&link).map_err(|error| AppError::Invalid(error.to_string()))?;
    let sessions = state.collab.sessions.lock().unwrap();
    let mut hosting = false;
    for ((label, session), found) in sessions.iter() {
        let Active::Host(host) = &found.active else { continue };
        if label != &caller.label {
            continue;
        }
        hosting = true;
        if host.session() == callback.session {
            host.dial_back(callback).map_err(AppError::Invalid)?;
            return Ok(*session);
        }
    }
    Err(AppError::Invalid(if hosting {
        "这个回连链接不是现在哪一次协作的（可能是上一次的），让对方用这次的邀请链接再生成一个".into()
    } else {
        "回连链接要在主持协作时打开：先在那篇笔记上「邀请协作」".into()
    }))
}
