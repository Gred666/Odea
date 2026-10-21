//! 共享仓库的多设备测试（docs/协同编辑.md §20.11 P10.3.3 那一行）：同一个进程里起两三台「设备」——
//! 各自一个仓库文件夹、一个真的 iroh 端点（走本机回环、不开 mDNS），从建、邀请、加入，到各自离线
//! 改了再合、外部程序改文件、前端那份改、改树、附件、移出，整个走一遍。
//! 文件监听在测试里不跑：外部程序改了文件以后手动调它会调的 rescan_paths_and_announce。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::{SecretKey, TransportAddr};
use loro::{ExportMode, LoroDoc};

use super::*;
use crate::vault::{fsio, layout, Vault};

#[derive(Default)]
struct Recorder {
    updates: Mutex<Vec<(String, Vec<u8>)>>,
    changed: AtomicUsize,
}

impl Sink for Recorder {
    fn doc_update(&self, doc: &str, bytes: &[u8]) {
        self.updates.lock().unwrap().push((doc.to_string(), bytes.to_vec()));
    }
    fn cursor(&self, _doc: &str, _from: &str, _payload: &[u8]) {}
    fn changed(&self) {
        self.changed.fetch_add(1, Ordering::SeqCst);
    }
}

struct Device {
    dir: tempfile::TempDir,
    vault: Arc<Mutex<Vault>>,
    key: SecretKey,
    sink: Arc<Recorder>,
    share: Option<Share>,
    name: &'static str,
}

impl Device {
    /// 一个新建的逻辑目录仓库（启动器新建的那种：日程开着、笔记平放在根上）
    fn fresh(name: &'static str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        fsio::write_atomic(
            &fsio::abs(dir.path(), layout::VAULT_MARKER),
            &serde_json::to_string(&layout::new_marker(true, true, 0)).unwrap(),
        )
        .unwrap();
        Self::open(dir, name)
    }

    /// 拿着邀请链接加入：空文件夹里摆好，再打开
    fn joining(name: &'static str, invite: &ShareInvite) -> Self {
        let dir = tempfile::tempdir().unwrap();
        prepare_join(dir.path(), invite, &invite.to_link()).unwrap();
        Self::open(dir, name)
    }

    fn open(dir: tempfile::TempDir, name: &'static str) -> Self {
        let vault = Arc::new(Mutex::new(Vault::open_in_memory(dir.path())));
        Self {
            dir,
            vault,
            key: SecretKey::generate(),
            sink: Arc::new(Recorder::default()),
            share: None,
            name,
        }
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn options(&self) -> ShareOptions {
        ShareOptions {
            key: self.key.clone(),
            name: self.name.to_string(),
            relays: Vec::new(),
            mdns: false,
        }
    }

    async fn create(&mut self) {
        let sink: Arc<dyn Sink> = self.sink.clone();
        let share = Share::create(self.vault.clone(), self.root(), "团队笔记", self.options(), sink)
            .await
            .unwrap();
        self.share = Some(share);
    }

    async fn start(&mut self) {
        let sink: Arc<dyn Sink> = self.sink.clone();
        let share = Share::open(self.vault.clone(), self.root(), self.options(), sink).await.unwrap();
        self.share = Some(share);
    }

    async fn stop(&mut self) {
        if let Some(share) = self.share.take() {
            share.close().await;
        }
    }

    fn share(&self) -> &Share {
        self.share.as_ref().unwrap()
    }

    /// 邀请链接，地址换成本机回环（测试里不开 mDNS，网卡地址也不一定通）
    fn invite(&self) -> ShareInvite {
        let mut invite = ShareInvite::parse(&self.share().invite_link().unwrap()).unwrap();
        invite.addrs = loopback(self.share());
        invite
    }

    fn vault<T>(&self, f: impl FnOnce(&mut Vault) -> T) -> T {
        f(&mut self.vault.lock().unwrap())
    }

    /// 标题 → 正文
    fn notes(&self) -> HashMap<String, String> {
        self.vault(|vault| {
            vault
                .note_list(false)
                .unwrap()
                .into_iter()
                .map(|summary| {
                    let note = vault.note_get(&summary.id).unwrap();
                    (note.title, note.content_md)
                })
                .collect()
        })
    }

    fn note_id(&self, title: &str) -> Option<String> {
        self.vault(|vault| {
            vault
                .note_list(false)
                .unwrap()
                .into_iter()
                .find(|note| note.title == title)
                .map(|note| note.id)
        })
    }

    fn rel_of(&self, id: &str) -> String {
        self.vault(|vault| vault.note_get(id).unwrap().rel_path)
    }

    /// 别的程序改了文件（文件监听会调的那一句）
    fn edit_file(&self, rel: &str, text: &str) {
        fsio::write_atomic(&fsio::abs(self.root(), rel), text).unwrap();
        self.vault(|vault| vault.rescan_paths_and_announce(&[rel.to_string()]).unwrap());
    }

    /// 树上每一篇（按标题）在哪个文件夹
    fn placements(&self) -> HashMap<String, String> {
        self.vault(|vault| {
            let titles: HashMap<String, String> = vault
                .note_list(false)
                .unwrap()
                .into_iter()
                .map(|note| (note.id, note.title))
                .collect();
            let nodes = vault.tree_view().unwrap();
            let name_of = |id: &str| {
                nodes
                    .iter()
                    .find(|node| node.id == id)
                    .and_then(|node| node.name.clone())
                    .unwrap_or_default()
            };
            nodes
                .iter()
                .filter_map(|node| {
                    let title = titles.get(node.note.as_ref()?)?;
                    Some((title.clone(), if node.parent == "." { String::new() } else { name_of(&node.parent) }))
                })
                .collect()
        })
    }
}

fn loopback(share: &Share) -> Vec<std::net::SocketAddr> {
    share
        .addr()
        .addrs
        .into_iter()
        .filter_map(|addr| match addr {
            TransportAddr::Ip(ip) => Some(ip),
            _ => None,
        })
        .collect()
}

async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    for _ in 0..600 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("等不到：{what}");
}

/// A 建共享、B 拿着链接加入、A 同意
async fn pair() -> (Device, Device) {
    let mut a = Device::fresh("甲");
    a.vault(|vault| {
        vault.folder_create("", "工作").unwrap();
        vault.note_create_in("工作", "周报", "第一行\n第二行\n").unwrap();
        vault.note_create("想法", "随手记").unwrap();
    });
    a.create().await;
    let mut b = Device::joining("乙", &a.invite());
    b.start().await;
    eventually("甲那边出现加入请求", || !a.share().info().requests.is_empty()).await;
    let request = a.share().info().requests[0].clone();
    assert_eq!(request.name, "乙");
    assert!(a.share().answer(request.request, Some(Role::Edit)));
    eventually("乙同步到甲的笔记", || {
        b.notes().get("周报").map(String::as_str) == Some("第一行\n第二行\n")
            && b.notes().get("想法").map(String::as_str) == Some("随手记")
    })
    .await;
    (a, b)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn joining_brings_the_whole_vault_and_edits_flow_both_ways() {
    let (a, b) = pair().await;
    // 加入以后：角色、在线、树上的位置都对
    let info = b.share().info();
    assert_eq!(info.state, ShareState::Ready);
    assert_eq!(info.role, Some(Role::Edit));
    assert_eq!(info.members.len(), 2);
    eventually("乙的树上周报在「工作」里", || b.placements().get("周报").map(String::as_str) == Some("工作")).await;

    // 乙在编辑器里改（前端那份 Loro 副本 → push）
    let id = b.note_id("周报").unwrap();
    let (snapshot, peer) = b.share().open_doc(&id).await.unwrap();
    let front = LoroDoc::new();
    front.set_peer_id(peer).unwrap();
    front.import(&snapshot).unwrap();
    let before = front.oplog_vv();
    front.get_text(replica::BODY).insert(3, "（乙改）").unwrap();
    front.commit();
    b.share().push(&id, &front.export(ExportMode::updates(&before)).unwrap()).unwrap();
    eventually("甲的磁盘上有乙改的", || a.notes()["周报"] == "第一行（乙改）\n第二行\n").await;
    eventually("乙自己的磁盘上也写了", || b.notes()["周报"] == "第一行（乙改）\n第二行\n").await;

    // 甲那边别的程序改了文件：乙那边编辑器开着这一篇，改动推给前端
    let rel = a.rel_of(&id);
    let text = std::fs::read_to_string(fsio::abs(a.root(), &rel)).unwrap();
    a.edit_file(&rel, &text.replace("第二行", "第二行（外部）"));
    eventually("乙收到外部程序的改动", || b.notes()["周报"] == "第一行（乙改）\n第二行（外部）\n").await;
    eventually("推给了乙的前端", || {
        let updates = b.sink.updates.lock().unwrap().clone();
        for (doc, bytes) in updates.iter().filter(|(doc, _)| *doc == id) {
            let _ = doc;
            front.import(bytes).unwrap();
        }
        front.get_text(replica::BODY).to_string() == "第一行（乙改）\n第二行（外部）\n"
    })
    .await;

    // 今天还没写过：乙在编辑器里写（前端那份推过来）→ 两边都有了这一天的文件
    let today = "day-2026-10-21";
    let (snapshot, peer) = b.share().open_doc(today).await.unwrap();
    let day = LoroDoc::new();
    day.set_peer_id(peer).unwrap();
    day.import(&snapshot).unwrap();
    let before = day.oplog_vv();
    day.get_text(replica::BODY).insert(0, "- [ ] 开会").unwrap();
    day.commit();
    b.share().push(today, &day.export(ExportMode::updates(&before)).unwrap()).unwrap();
    let day_text = |device: &Device| {
        device.vault(|vault| vault.day("2026-10-21", false).map(|day| day.note_md).unwrap_or_default())
    };
    eventually("两边都有了这一天", || day_text(&a) == "- [ ] 开会" && day_text(&b) == "- [ ] 开会").await;

    // 改标题、新建、删：元数据整项跟过去
    let fresh = a.vault(|vault| vault.note_create("新的一篇", "内容").unwrap());
    // 甲的编辑器绑着这一篇的副本：编辑器存盘时交来的（可能落后的）正文不用，只改标题
    a.share().open_doc(&id).await.unwrap();
    a.vault(|vault| vault.note_update(&id, "周报（改名）", "不用的正文").unwrap());
    eventually("乙那边改了名、多了一篇", || {
        let notes = b.notes();
        notes.get("周报（改名）").map(String::as_str) == Some("第一行（乙改）\n第二行（外部）\n")
            && notes.contains_key("新的一篇")
    })
    .await;
    a.vault(|vault| vault.note_delete(&fresh).unwrap());
    eventually("乙那边删进了回收站", || !b.notes().contains_key("新的一篇")).await;
    assert!(b.vault(|vault| vault.share_trashed(&fresh)));

    // 副本没开着的那一篇（共享服务刚起来、前端还不知道是共享仓库时）：编辑器存的正文照常写，再进 CRDT
    let idea = a.note_id("想法").unwrap();
    a.vault(|vault| vault.note_update(&idea, "想法", "编辑器直接存的").unwrap());
    eventually("乙收到编辑器直接存的", || b.notes()["想法"] == "编辑器直接存的").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn offline_edits_on_both_sides_merge_when_they_meet_again() {
    let (mut a, mut b) = pair().await;
    let id = a.note_id("周报").unwrap();
    // 乙关了 Odea；两边各改各的（乙那边是别的编辑器改的）
    b.stop().await;
    let rel_a = a.rel_of(&id);
    let text_a = std::fs::read_to_string(fsio::abs(a.root(), &rel_a)).unwrap();
    a.edit_file(&rel_a, &text_a.replace("第一行", "第一行（甲）"));
    let rel_b = b.rel_of(&id);
    let text_b = std::fs::read_to_string(fsio::abs(b.root(), &rel_b)).unwrap();
    fsio::write_atomic(&fsio::abs(b.root(), &rel_b), &text_b.replace("第二行", "第二行（乙）")).unwrap();
    b.vault(|vault| vault.rescan_and_announce().unwrap());
    // 乙再打开：对上了、两边的改动都在
    b.start().await;
    eventually("两边合成一样的", || {
        a.notes()["周报"] == "第一行（甲）\n第二行（乙）\n" && b.notes()["周报"] == "第一行（甲）\n第二行（乙）\n"
    })
    .await;
    a.stop().await;
    b.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_tree_and_attachments_follow_and_removed_members_are_cut_off() {
    let (a, b) = pair().await;
    // 改树：甲建一个文件夹，把「想法」挪进去
    let id = a.note_id("想法").unwrap();
    a.vault(|vault| {
        vault.folder_create("", "灵感").unwrap();
        vault.note_move(&id, "灵感").unwrap();
    });
    eventually("乙的树跟着变", || b.placements().get("想法").map(String::as_str) == Some("灵感")).await;
    // 乙也动树：两边都看到
    let weekly = b.note_id("周报").unwrap();
    b.vault(|vault| vault.note_move(&weekly, "").unwrap());
    eventually("甲的树跟着变", || a.placements().get("周报").map(String::as_str) == Some("")).await;

    // 附件：甲放进来一张图，乙那边按哈希要过来
    let image = vec![7u8; 300_000];
    fsio::write_atomic_bytes(&fsio::abs(a.root(), "附件/图.png"), &image).unwrap();
    a.share().poke();
    eventually("乙拿到了附件", || {
        std::fs::read(fsio::abs(b.root(), "附件/图.png")).is_ok_and(|bytes| bytes == image)
    })
    .await;

    // 移出乙：乙知道自己被移出了，之后乙的改动甲不收
    let b_id = b.share().me();
    a.share().set_role(&b_id, None).unwrap();
    eventually("乙知道自己被移出了", || b.share().info().state == ShareState::Removed).await;
    eventually("甲那边乙不在线了", || a.share().online() == 0).await;
    let before = a.notes()["周报"].clone();
    let rel = b.rel_of(&weekly);
    let text = std::fs::read_to_string(fsio::abs(b.root(), &rel)).unwrap();
    b.edit_file(&rel, &format!("{text}被移出以后写的\n"));
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(a.notes()["周报"], before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn members_sync_with_each_other_when_the_admin_is_away() {
    let (mut a, b) = pair().await;
    let mut c = Device::joining("丙", &a.invite());
    c.start().await;
    eventually("甲那边出现丙的请求", || !a.share().info().requests.is_empty()).await;
    let request = a.share().info().requests[0].request;
    a.share().answer(request, Some(Role::Read));
    eventually("丙同步到了", || c.notes().contains_key("周报")).await;
    // 成员表传到了乙；乙和丙互相知道在哪（测试里没有 mDNS）
    eventually("乙知道丙", || b.share().info().members.len() == 3).await;
    c.share().learn(&b.share().me(), &b.share().addr());
    b.share().learn(&c.share().me(), &c.share().addr());
    eventually("乙丙连上了", || c.share().online() == 2).await;
    // 甲走了，乙改的照样到丙那里
    a.stop().await;
    eventually("甲走了", || c.share().online() == 1).await;
    let id = b.note_id("想法").unwrap();
    let rel = b.rel_of(&id);
    let text = std::fs::read_to_string(fsio::abs(b.root(), &rel)).unwrap();
    b.edit_file(&rel, &text.replace("随手记", "随手记（乙）"));
    eventually("丙收到乙的改动", || c.notes()["想法"] == "随手记（乙）").await;
    // 丙是只读的：丙那边改了文件，乙不收
    let rel = c.rel_of(&id);
    let text = std::fs::read_to_string(fsio::abs(c.root(), &rel)).unwrap();
    c.edit_file(&rel, &text.replace("随手记（乙）", "随手记（丙）"));
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(b.notes()["想法"], "随手记（乙）");
    assert!(c.share().push(&id, &[]).is_err(), "只读的人前端也推不进来");
}
