/* ============================================================
主持人发给一位访客的文档流（docs/协同编辑.md §5.4「慢的人合包」）。

一位访客那边慢（网络差、电脑卡），QUIC 的流量控制把写手堵住，要发给他的更新在队列里越排越长。
设计里是把排着的更新合成一包再发；Rust 侧没有 CRDT（§5.5），合不了。换个做法，
效果一样：

- 排着的超过 LAG_FRAMES 帧或 LAG_BYTES 字节，就把排着的更新（Update、Sync2）整个丢掉，换成一个
  Resync 帧。访客收到 Resync 就重新发一次 Sync1（他的状态向量），主持人的前端照它回一份 Sync2 ——
  正好是他缺的全部，一包
- 从丢掉到收到他的 Sync1 之间，新来的更新也不排了（反正那份 Sync2 里都有）
- Loro 的更新重复收到没关系、缺了才要命：丢的只能是之后一定会被 Sync2 补上的那些

队列自己管（不是 mpsc），才能把已经排进去的丢掉。写手一次取一帧写；关掉以后把剩下的写完再收尾。
============================================================ */

use std::collections::VecDeque;
use std::sync::Mutex;

use tokio::sync::Notify;

use super::protocol::kind;

/// 排着的超过这么多帧（打字时一个更新包二三十字节，256 帧是好几秒没收）
pub const LAG_FRAMES: usize = 256;
/// 或者排着的 Update 超过这么多字节。Sync2 不算：加入时的快照、补齐用的那一包单帧就可能上 MB，
/// 算进去的话大文档每次补齐都会再判一次积压，补齐 → 丢掉 → 再补齐，没完没了
pub const LAG_BYTES: usize = 1 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pushed {
    Queued,
    /// 正在等他的 Sync1：这个更新不用排了
    Skipped,
    /// 刚刚判定为积压：排着的更新丢掉，换成了 Resync
    Collapsed,
    /// 队列已经关了
    Closed,
}

#[derive(Default)]
struct State {
    frames: VecDeque<(u8, Vec<u8>)>,
    /// 排着的 Update 一共多少字节
    update_bytes: usize,
    resync_pending: bool,
    closed: bool,
}

#[derive(Default)]
pub struct DocQueue {
    state: Mutex<State>,
    notify: Notify,
}

/// 会被之后的 Sync2 补上的帧：积压时可以丢
fn droppable(frame_kind: u8) -> bool {
    matches!(frame_kind, kind::UPDATE | kind::SYNC2)
}

impl DocQueue {
    pub fn push(&self, frame_kind: u8, bytes: Vec<u8>) -> Pushed {
        let pushed = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Pushed::Closed;
            }
            if state.resync_pending && droppable(frame_kind) {
                return Pushed::Skipped;
            }
            if frame_kind == kind::UPDATE {
                state.update_bytes += bytes.len();
            }
            state.frames.push_back((frame_kind, bytes));
            if state.frames.len() > LAG_FRAMES || state.update_bytes > LAG_BYTES {
                state
                    .frames
                    .retain(|(frame_kind, _)| !droppable(*frame_kind));
                state.frames.push_back((kind::RESYNC, Vec::new()));
                state.update_bytes = 0;
                state.resync_pending = true;
                Pushed::Collapsed
            } else {
                Pushed::Queued
            }
        };
        self.notify.notify_one();
        pushed
    }

    /// 他发来了 Sync1（不管是不是因为 Resync）：之后的更新照常排
    pub fn resynced(&self) {
        self.state.lock().unwrap().resync_pending = false;
    }

    /// 不再收新的；排着的写完写手就收尾
    pub fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.notify.notify_one();
    }

    /// 取一帧；关了而且排空了是 None
    pub async fn pop(&self) -> Option<(u8, Vec<u8>)> {
        loop {
            // 先登记再看队列：push 在两者之间发的通知不会漏
            let notified = self.notify.notified();
            {
                let mut state = self.state.lock().unwrap();
                if let Some(frame) = state.frames.pop_front() {
                    if frame.0 == kind::UPDATE {
                        state.update_bytes -= frame.1.len();
                    }
                    return Some(frame);
                }
                if state.closed {
                    return None;
                }
            }
            notified.await;
        }
    }

    #[cfg(test)]
    pub fn snapshot(&self) -> (Vec<u8>, usize, bool) {
        let state = self.state.lock().unwrap();
        (
            state
                .frames
                .iter()
                .map(|(frame_kind, _)| *frame_kind)
                .collect(),
            state.update_bytes,
            state.resync_pending,
        )
    }
}

/// 文档流的写手：从队列里一帧一帧写。队列关了、排空了就把流收尾（最多等半秒对方确认）
pub fn spawn_queue_writer(
    mut send: iroh::endpoint::SendStream,
    queue: std::sync::Arc<DocQueue>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some((frame_kind, bytes)) = queue.pop().await {
            if super::protocol::write_frame(&mut send, frame_kind, &bytes)
                .await
                .is_err()
            {
                queue.close();
                return;
            }
        }
        let _ = send.finish();
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), send.stopped()).await;
    })
}
