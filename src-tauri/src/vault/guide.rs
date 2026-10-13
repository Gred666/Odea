/* ============================================================
内置的使用指南（欢迎、语法全览）：新仓库里放一份，之后由应用管着它的新旧。

正文在前端的 src/content/guide/ 里（浏览器预览的 mock 读同一份），这里编进程序。
写进仓库的就是普通笔记，用户能改、能删、能挪，只多两处记号：

- id 以 `guide-<名字>-` 开头：启动时只读这几篇的文件，不用把每篇笔记都读一遍
- 属性块里一行 `ontheway-guide: <名字> <应用版本> <指纹>`：上一次给这一篇的是哪个版本的
  应用带的指南、那一版正文的指纹（勾选框一律按没勾算 —— 勾掉清单上的事不算改过指南）

应用升级以后（refresh，启动时跑一次）：
- 正文的指纹和记下的一样（没改过）→ 换成这一版带的，勾过的框照勾
- 不一样（改过）→ 不动；前端在那一篇上问用户换不换（pending / settle）
- 记下的版本比这个应用还新（别的设备装了新版、同步过来的）→ 不动，不降级
- 删了 → 什么也不做；命令面板「使用指南」会重新放一篇（open）
两台设备各自升级时写出的内容一字不差，同步时不会撞车。
============================================================ */

use std::collections::HashSet;
use std::path::Path;

use crate::db::{new_id, now_ms};
use crate::domain::model::GuideUpdate;
use crate::error::{AppError, Result};

use super::frontmatter::{self, FrontMatter};
use super::index::{self, DocRow};
use super::{fsio, layout, Vault, VaultChange};

pub struct Guide {
    pub name: &'static str,
    pub title: &'static str,
    /// 新放进去的时候置不置顶（欢迎那篇置顶，排在列表最上面）
    pub pinned: bool,
    pub body: &'static str,
}

pub const GUIDES: [Guide; 2] = [
    Guide {
        name: "welcome",
        title: "欢迎使用 OnTheWay",
        pinned: true,
        body: include_str!("../../../src/content/guide/welcome.md"),
    },
    Guide {
        name: "syntax",
        title: "语法全览",
        pinned: false,
        body: include_str!("../../../src/content/guide/syntax.md"),
    },
];

const MARK_KEY: &str = "ontheway-guide:";
const VERSION: &str = env!("CARGO_PKG_VERSION");

fn id_prefix(name: &str) -> String {
    format!("guide-{name}-")
}

fn guide_named(name: &str) -> Result<&'static Guide> {
    GUIDES
        .iter()
        .find(|guide| guide.name == name)
        .ok_or_else(|| AppError::Invalid(format!("没有叫 {name} 的使用指南")))
}

/// 这篇笔记是哪一份指南（看 id 的前缀）
fn guide_of(row: &DocRow) -> Option<&'static Guide> {
    GUIDES.iter().find(|guide| row.id.starts_with(&id_prefix(guide.name)))
}

/* ---------------- 正文 ---------------- */

/// 任务行的勾选框：框里那个字符的位置、勾没勾。不是任务行返回 None
fn task_box(line: &str) -> Option<(usize, bool)> {
    let indent = line.len() - line.trim_start().len();
    let rest = line[indent..].as_bytes();
    if !matches!(rest.first(), Some(b'-' | b'*' | b'+')) || rest.get(1..3) != Some(b" [".as_slice()) {
        return None;
    }
    if rest.get(4) != Some(&b']') {
        return None;
    }
    match rest.get(3) {
        Some(b' ') => Some((indent + 3, false)),
        Some(b'x' | b'X') => Some((indent + 3, true)),
        _ => None,
    }
}

/// 任务行勾选框后面的那件事
fn task_text(line: &str, mark: usize) -> &str {
    line.get(mark + 2..).unwrap_or("").trim()
}

/// 正文的指纹：勾选框一律按没勾算
pub fn fingerprint(body: &str) -> String {
    let lines: Vec<String> = body
        .trim_end()
        .split('\n')
        .map(|line| match task_box(line) {
            Some((mark, true)) => format!("{} {}", &line[..mark], &line[mark + 1..]),
            _ => line.to_string(),
        })
        .collect();
    fsio::fingerprint(&lines.join("\n"))
}

/// 换成新版时，旧版里勾掉的事在新版里照样勾上（按那件事的文字认）
fn carry_checks(old: &str, new: &str) -> String {
    let done: HashSet<&str> = old
        .split('\n')
        .filter_map(|line| match task_box(line) {
            Some((mark, true)) => Some(task_text(line, mark)),
            _ => None,
        })
        .collect();
    new.split('\n')
        .map(|line| match task_box(line) {
            Some((mark, false)) if done.contains(task_text(line, mark)) => {
                format!("{}x{}", &line[..mark], &line[mark + 1..])
            }
            _ => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/* ---------------- 属性块里的记号 ---------------- */

struct Mark {
    name: String,
    /// 写这一行的应用版本；认不出来（别人手改坏了）时是 None，按旧的算
    version: Option<(u64, u64, u64)>,
    hash: String,
}

/// `0.1.0`、`1.2.3-beta` → (主, 次, 修订)。启动时认「是不是刚升级过」也用它（boot::note_version）
pub(crate) fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

fn parse_mark(meta: &FrontMatter) -> Option<Mark> {
    let line = meta.extra.iter().find_map(|line| line.strip_prefix(MARK_KEY))?;
    let mut parts = line.split_whitespace();
    Some(Mark {
        name: parts.next()?.to_string(),
        version: parts.next().and_then(parse_version),
        hash: parts.next()?.to_string(),
    })
}

/// 记下：这一篇现在是这个版本的应用带的这一版指南
fn set_mark(meta: &mut FrontMatter, name: &str, hash: &str) {
    let line = format!("{MARK_KEY} {name} {VERSION} {hash}");
    match meta.extra.iter_mut().find(|item| item.starts_with(MARK_KEY)) {
        Some(item) => *item = line,
        None => meta.extra.push(line),
    }
}

/// 记下的那一版和这个应用带的不一样，而且不是更新的应用写的
fn outdated(mark: &Mark, shipped: &str) -> bool {
    let current = parse_version(VERSION);
    mark.hash != shipped && mark.version.is_none_or(|version| Some(version) <= current)
}

/// 一篇新放进去的指南的文件内容
fn new_file(guide: &Guide, id: &str, created: i64) -> String {
    let mut meta = FrontMatter {
        id: Some(id.to_string()),
        created: Some(created),
        pinned: guide.pinned,
        ..FrontMatter::default()
    };
    set_mark(&mut meta, guide.name, &fingerprint(guide.body));
    frontmatter::render(&meta, guide.body)
}

/// 新仓库：每份指南放一篇（seed::write 调，这时候还没有索引）
pub fn write_all(root: &Path) -> Result<()> {
    let created = now_ms();
    for guide in &GUIDES {
        let stem = layout::file_stem_for_title(guide.title);
        let rel = fsio::unique_rel(root, layout::NOTES_DIR, &stem, None);
        let id = format!("{}{}", id_prefix(guide.name), new_id());
        fsio::write_atomic(&fsio::abs(root, &rel), &new_file(guide, &id, created))?;
    }
    Ok(())
}

/* ---------------- 仓库里的指南 ---------------- */

struct GuideNote {
    row: DocRow,
    guide: &'static Guide,
    meta: FrontMatter,
    body: String,
    mark: Mark,
}

impl Vault {
    /// 仓库里带着记号的指南（笔记和归档里都算）
    fn guide_notes(&self) -> Result<Vec<GuideNote>> {
        let mut out = Vec::new();
        for archived in [false, true] {
            for row in index::notes(&self.db, archived)? {
                let Some(guide) = guide_of(&row) else { continue };
                let Some(text) = self.read(&row.rel_path)? else { continue };
                let (meta, body) = frontmatter::split(&text);
                let Some(mark) = parse_mark(&meta).filter(|mark| mark.name == guide.name) else {
                    continue;
                };
                out.push(GuideNote { row, guide, meta, body, mark });
            }
        }
        Ok(out)
    }

    /// 启动时：用户没改过的指南换成这个版本的应用带的。返回换了几篇
    pub fn guide_refresh(&mut self) -> Result<usize> {
        let mut updated = 0;
        for note in self.guide_notes()? {
            let shipped = fingerprint(note.guide.body);
            if !outdated(&note.mark, &shipped) || fingerprint(&note.body) != note.mark.hash {
                continue;
            }
            let mut meta = note.meta;
            set_mark(&mut meta, note.guide.name, &shipped);
            let body = carry_checks(&note.body, note.guide.body);
            let mut change = VaultChange::default();
            let saved =
                self.write_and_index(&note.row.rel_path, &frontmatter::render(&meta, &body), &mut change)?;
            self.log.record("note", &saved.id, "updated");
            self.announce(change);
            updated += 1;
        }
        Ok(updated)
    }

    /// 用户改过、而这个版本的应用带着新版的指南：前端在那一篇上问用户换不换
    pub fn guide_pending(&self) -> Result<Vec<GuideUpdate>> {
        Ok(self
            .guide_notes()?
            .into_iter()
            .filter(|note| {
                outdated(&note.mark, &fingerprint(note.guide.body))
                    && fingerprint(&note.body) != note.mark.hash
            })
            .map(|note| GuideUpdate {
                id: note.row.id,
                name: note.guide.name.to_string(),
                body: note.guide.body.to_string(),
            })
            .collect())
    }

    /// 用户看过新版了（换上了，或者留着自己的）：记下这一版，到下一次升级前不再问。
    /// 换上新版的话，前端先存正文再调这里 —— 记下的指纹和正文对得上，以后又能自动跟着升级
    pub fn guide_settle(&mut self, id: &str) -> Result<()> {
        let row = self.note_row(id)?;
        let guide = guide_of(&row)
            .ok_or_else(|| AppError::Invalid(format!("{id} 不是使用指南")))?;
        let shipped = fingerprint(guide.body);
        let (_, change) = self.rewrite_note_meta(&row, None, |meta| set_mark(meta, guide.name, &shipped))?;
        self.announce(change);
        Ok(())
    }

    /// 命令面板「使用指南」：返回那一篇的 id；删掉了就照这个版本重新放一篇
    pub fn guide_open(&mut self, name: &str) -> Result<String> {
        let guide = guide_named(name)?;
        let prefix = id_prefix(name);
        for archived in [false, true] {
            if let Some(row) = index::notes(&self.db, archived)?
                .into_iter()
                .find(|row| row.id.starts_with(&prefix))
            {
                return Ok(row.id);
            }
        }
        let stem = layout::file_stem_for_title(guide.title);
        let rel = fsio::unique_rel(&self.root, layout::NOTES_DIR, &stem, None);
        let id = format!("{prefix}{}", new_id());
        let mut change = VaultChange::default();
        let row = self.write_and_index(&rel, &new_file(guide, &id, now_ms()), &mut change)?;
        self.log.record("note", &row.id, "created");
        self.announce(change.without(&row));
        Ok(row.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(dir: &Path) -> Vault {
        Vault::open_in_memory(dir)
    }

    /// 把仓库里那篇指南的文件改成「旧版应用写的」：正文换成 old，记号记 old 的指纹和旧版本号
    fn age(vault: &mut Vault, name: &str, old: &str, version: &str) -> String {
        let id = vault.guide_open(name).unwrap();
        let row = vault.note_row(&id).unwrap();
        let (mut meta, _) = frontmatter::split(&vault.read(&row.rel_path).unwrap().unwrap());
        let line = format!("{MARK_KEY} {name} {version} {}", fingerprint(old));
        for item in meta.extra.iter_mut().filter(|item| item.starts_with(MARK_KEY)) {
            *item = line.clone();
        }
        let mut change = VaultChange::default();
        vault
            .write_and_index(&row.rel_path, &frontmatter::render(&meta, old), &mut change)
            .unwrap();
        id
    }

    fn mark_of(vault: &Vault, id: &str) -> Mark {
        let row = vault.note_row(id).unwrap();
        let (meta, _) = frontmatter::split(&vault.read(&row.rel_path).unwrap().unwrap());
        parse_mark(&meta).unwrap()
    }

    #[test]
    fn a_new_vault_gets_every_guide_up_to_date() {
        let dir = tempfile::tempdir().unwrap();
        write_all(dir.path()).unwrap();
        let mut vault = open(dir.path());

        let notes = vault.note_list_full(false).unwrap();
        assert_eq!(notes.len(), GUIDES.len());
        assert_eq!(notes[0].title, "欢迎使用 OnTheWay", "欢迎那篇置顶");
        assert!(notes[0].is_pinned);
        assert!(notes.iter().any(|note| note.title == "语法全览"));
        assert_eq!(vault.guide_refresh().unwrap(), 0);
        assert!(vault.guide_pending().unwrap().is_empty());
    }

    #[test]
    fn an_untouched_old_guide_is_replaced_and_keeps_its_ticks() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = open(dir.path());
        // 新版里也有的那一条，用户在旧版里勾过（勾选不算改过：指纹按没勾算）
        let new_first_task = GUIDES[0]
            .body
            .split('\n')
            .find_map(|line| task_box(line).map(|(mark, _)| task_text(line, mark).to_string()))
            .unwrap();
        let old = format!("旧版的说明\n\n- [x] {new_first_task}\n- [ ] 旧版才有的一条\n");
        let id = age(&mut vault, "welcome", &old, "0.0.1");

        assert_eq!(vault.guide_refresh().unwrap(), 1);
        let note = vault.note_get(&id).unwrap();
        assert!(note.content_md.contains(&format!("- [x] {new_first_task}")), "勾过的照勾");
        assert!(!note.content_md.contains("旧版才有的一条"));
        assert_eq!(mark_of(&vault, &id).hash, fingerprint(GUIDES[0].body));
        assert!(vault.note_get(&id).unwrap().is_pinned, "置顶这些属性留着");
        // 再启动一次：已经是新版了
        assert_eq!(vault.guide_refresh().unwrap(), 0);
    }

    #[test]
    fn an_edited_old_guide_is_left_alone_until_the_user_decides() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = open(dir.path());
        let id = age(&mut vault, "welcome", "旧版的说明\n", "0.0.1");
        let note = vault.note_get(&id).unwrap();
        vault.note_update(&id, &note.title, "旧版的说明\n\n我自己加的一段\n").unwrap();

        assert_eq!(vault.guide_refresh().unwrap(), 0);
        assert!(vault.note_get(&id).unwrap().content_md.contains("我自己加的一段"));
        let pending = vault.guide_pending().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, id);
        assert_eq!(pending[0].body, GUIDES[0].body);

        // 留着自己的：不再问，正文不动
        vault.guide_settle(&id).unwrap();
        assert!(vault.guide_pending().unwrap().is_empty());
        assert!(vault.note_get(&id).unwrap().content_md.contains("我自己加的一段"));
        assert_eq!(vault.guide_refresh().unwrap(), 0);
    }

    #[test]
    fn taking_the_new_version_lets_later_upgrades_happen_by_themselves() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = open(dir.path());
        let id = age(&mut vault, "welcome", "旧版的说明\n", "0.0.1");
        let note = vault.note_get(&id).unwrap();
        vault.note_update(&id, &note.title, "改过的旧版\n").unwrap();

        // 前端：先存新版的正文，再 settle
        vault.note_update(&id, &note.title, GUIDES[0].body).unwrap();
        vault.guide_settle(&id).unwrap();
        let mark = mark_of(&vault, &id);
        assert_eq!(mark.hash, fingerprint(&vault.note_get(&id).unwrap().content_md));
        assert!(vault.guide_pending().unwrap().is_empty());
    }

    #[test]
    fn a_guide_written_by_a_newer_app_is_not_downgraded() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = open(dir.path());
        let id = age(&mut vault, "welcome", "下一版应用带的说明\n", "999.0.0");

        assert_eq!(vault.guide_refresh().unwrap(), 0);
        assert!(vault.guide_pending().unwrap().is_empty());
        assert_eq!(vault.note_get(&id).unwrap().content_md, "下一版应用带的说明\n");
    }

    #[test]
    fn a_deleted_guide_stays_gone_until_asked_for() {
        let dir = tempfile::tempdir().unwrap();
        write_all(dir.path()).unwrap();
        let mut vault = open(dir.path());
        let id = vault.guide_open("welcome").unwrap();
        vault.note_delete(&id).unwrap();

        assert_eq!(vault.guide_refresh().unwrap(), 0);
        assert!(vault.note_list_full(false).unwrap().iter().all(|note| note.id != id));

        // 命令面板「使用指南」：照这个版本重新放一篇
        let again = vault.guide_open("welcome").unwrap();
        assert_ne!(again, id);
        assert_eq!(vault.note_get(&again).unwrap().content_md, GUIDES[0].body);
        assert_eq!(vault.guide_open("welcome").unwrap(), again, "有了就打开它，不再放第二篇");
    }

    #[test]
    fn two_devices_upgrading_write_the_same_bytes() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let mut first = open(a.path());
        let id = age(&mut first, "welcome", "旧版的说明\n- [x] 旧的一条\n", "0.0.1");
        let rel = first.note_row(&id).unwrap().rel_path;
        // 另一台设备上是同一个文件
        let text = first.read(&rel).unwrap().unwrap();
        fsio::write_atomic(&fsio::abs(b.path(), &rel), &text).unwrap();
        let mut second = open(b.path());

        first.guide_refresh().unwrap();
        second.guide_refresh().unwrap();
        assert_eq!(first.read(&rel).unwrap(), second.read(&rel).unwrap());
    }

    #[test]
    fn ticking_a_box_does_not_count_as_editing() {
        let body = "说明\n- [ ] 第一件\n  - [X] 第二件\n";
        assert_eq!(fingerprint(body), fingerprint(&body.replace("[ ]", "[x]").replace("[X]", "[ ]")));
        assert_ne!(fingerprint(body), fingerprint("说明\n- [ ] 第一件改了\n"));
    }

    #[test]
    fn reads_the_version_it_was_written_with() {
        assert_eq!(parse_version("0.1.0"), Some((0, 1, 0)));
        assert_eq!(parse_version("1.12.3-beta.2"), Some((1, 12, 3)));
        assert_eq!(parse_version("坏了"), None);
    }
}
