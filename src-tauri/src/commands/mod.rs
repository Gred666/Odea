use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use tauri_specta::Event;

use crate::boot;
use crate::collab::record::{self as collab_record, GuestRecord, Role};
use crate::collab::{
    self, AttachReply, Callback, Decision, Guest, GuestOptions, Host, HostOptions, Invite, MemberInfo, Node,
    NodeOptions, Permission, Reach, Relay, RelayCheck, SyncKind, TrustedPeer,
};
use crate::domain::model::*;
use crate::error::{AppError, Result};
use crate::keep::{self, GuestCopy};
use crate::state::{AppState, Caller, Workspace, Ws};
use crate::sync::account::{self, PendingLogin};
use crate::sync::engine::{Hooks, SyncHub, LOGIN_KEY, PROVIDER_KEY};
use crate::sync::provider::{Http, Provider, RemoteRepo};
use crate::sync::proxy;
use crate::sync::repo::{Net, SyncError, SyncRepo, SyncResult};
use crate::sync::setup;
use crate::vault::{fsio, layout, watch, Announce, Backlog, Vault};

/* ============================================================
命令层：只做参数校验和调用，读写全在 vault/。

每个命令都在阻塞线程池里拿仓库的锁执行 —— 文件读写和 SQLite 都是同步的，
直接在 tokio 的 worker 上跑会拖住整个运行时。
============================================================ */

/// 仓库里别处发生的变化（外部程序改了文件、勾任务改了别的文档），前端据此刷新
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultChanged(pub VaultChange);

/// 只发给这个仓库的窗口：别的窗口收到会去刷新根本不在它那里的笔记
pub fn announcer<R: Runtime>(app: AppHandle<R>, label: String) -> Announce {
    Arc::new(move |change| {
        if let Err(error) = VaultChanged(change).emit_to(&app, label.as_str()) {
            eprintln!("通知前端失败: {error}");
        }
    })
}

pub(crate) async fn blocking<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("任务panic: {e}")))?
}

/// 在阻塞线程池里拿这个窗口的仓库的锁做事（插件的命令也用它，plugins/journal/commands.rs）
pub(crate) async fn with_vault<T, F>(ws: &Workspace, f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&mut Vault) -> Result<T> + Send + 'static,
{
    let vault = ws.vault.clone();
    blocking(move || {
        let mut vault = vault
            .lock()
            .map_err(|_| AppError::Internal("仓库锁坏了".into()))?;
        f(&mut vault)
    })
    .await
}

// 按分节拆成几个文件（docs/1110审查与研究.md §6.2）。命令都在这里转出去：lib.rs、别的模块照旧写
// commands::xxx（Tauri 和 specta 的宏会在定义命令的模块里 pub use 它们生成的隐藏宏，跟着一起转出）。
// 子模块之间要用的私有项写成 pub(in crate::commands)，出了 commands 还是看不见
mod collaboration;
mod notes;
mod sync;
mod team;
mod vault_ops;

pub use collaboration::*;
pub use notes::*;
pub use sync::*;
pub use team::*;
pub use vault_ops::*;
