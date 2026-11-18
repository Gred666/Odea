/* ============================================================
单篇文档的历史版本（技术方案 §5.9.11）：同步用的 git 仓库里，每次改过这篇的提交就是一版。

- 笔记改标题会改文件名，挪文件夹、归档会挪位置，所以不只按路径找：在某次提交的上一版里
  找不到它时，看这次提交删掉的文件里哪个属性块里的 id 一样 —— 那就是它原来的路径，再往前
  就按那个路径找。拿 id 核对也防住了「旧路径后来被另一篇占了」。
  某一天、目标的路径由日期定，不会变，按路径找就行（id 传 None）。
- 两台设备各改各的再合并：两边的提交都在历史里，各算一版；合并出来的内容和两边都不一样时，
  合并提交也算一版。
- 只读：不碰工作区和索引。另开一个 Repository，不和同步线程抢。
============================================================ */

use std::collections::HashMap;
use std::path::Path;

use git2::{Delta, ErrorCode, ObjectType, Oid, Repository, Sort, Tree};

use super::repo::SyncResult;
use crate::vault::{frontmatter, layout};

/// 最多往回看这么多个提交。停笔一分钟提交一次，几万个提交够看好几年
const MAX_COMMITS: usize = 50_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    /// 这一版文件内容的对象 id
    pub blob: Oid,
    /// 提交时间，UTC 毫秒
    pub time: i64,
    /// 提交署名
    pub author: String,
    /// 这一版在仓库里的路径
    pub path: String,
}

#[derive(Debug, Default)]
pub struct History {
    /// 新的在前
    pub versions: Vec<Version>,
    /// 超过 limit 的更早的版本还有
    pub more: bool,
}

/// `rel` 这篇（笔记再给上属性块里的 id）最近的 limit 个版本。仓库还没有提交时是空的
pub fn versions(root: &Path, rel: &str, id: Option<&str>, limit: usize) -> SyncResult<History> {
    let repo = Repository::open(root)?;
    let head = match repo.head() {
        Ok(head) => head.peel_to_commit()?,
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            return Ok(History::default())
        }
        Err(error) => return Err(error.into()),
    };
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    walk.push(head.id())?;

    let mut finder = Finder { repo: &repo, id, paths: vec![rel.to_string()], ids: HashMap::new() };
    let mut history = History::default();
    for oid in walk.take(MAX_COMMITS) {
        let commit = repo.find_commit(oid?)?;
        let tree = commit.tree()?;
        let Some((blob, path)) = finder.find(&tree)? else {
            continue;
        };
        // 上一版（合并提交是任何一边）和这一版一样，就不是这次提交改的
        let mut unchanged = false;
        for parent in commit.parents() {
            let before = parent.tree()?;
            let found = match finder.find(&before)? {
                Some(found) => Some(found),
                None => finder.moved_from(&before, &tree)?,
            };
            if found.is_some_and(|(theirs, _)| theirs == blob) {
                unchanged = true;
                break;
            }
        }
        if unchanged {
            continue;
        }
        if history.versions.len() == limit {
            history.more = true;
            break;
        }
        history.versions.push(Version {
            blob,
            time: commit.time().seconds() * 1000,
            author: commit.author().name().unwrap_or_default().to_string(),
            path,
        });
    }
    Ok(history)
}

/// 一版的全文（带属性块）
pub fn text(root: &Path, blob: &str) -> SyncResult<String> {
    let repo = Repository::open(root)?;
    let blob = repo.find_blob(Oid::from_str(blob)?)?;
    Ok(String::from_utf8_lossy(blob.content()).into_owned())
}

/// 一版的标题：属性块里写了就用它，没写就是文件名
pub fn title_of(text: &str, path: &str) -> String {
    let (meta, _) = frontmatter::split(text);
    meta.title.unwrap_or_else(|| layout::stem_of(path).to_string())
}

struct Finder<'r> {
    repo: &'r Repository,
    /// 笔记的 id；某一天、目标是 None
    id: Option<&'r str>,
    /// 它住过的路径，现在的在前
    paths: Vec<String>,
    /// 读过的 .md 属性块里的 id（按对象 id 缓存：大多数提交里这篇的内容都一样）
    ids: HashMap<Oid, Option<String>>,
}

impl Finder<'_> {
    /// 这棵树里的它：内容的对象 id 和路径
    fn find(&mut self, tree: &Tree) -> SyncResult<Option<(Oid, String)>> {
        for index in 0..self.paths.len() {
            let Ok(entry) = tree.get_path(Path::new(&self.paths[index])) else {
                continue;
            };
            if entry.kind() != Some(ObjectType::Blob) {
                continue;
            }
            if self.is_it(entry.id())? {
                return Ok(Some((entry.id(), self.paths[index].clone())));
            }
        }
        Ok(None)
    }

    /// 上一版里按已知的路径找不到它：这次提交删掉的 .md 里属性块 id 一样的就是它原来的样子
    /// （改了标题、挪了文件夹、归档）。找到了把那个路径记下，往前接着按它找
    fn moved_from(&mut self, before: &Tree, after: &Tree) -> SyncResult<Option<(Oid, String)>> {
        if self.id.is_none() {
            return Ok(None);
        }
        let diff = self.repo.diff_tree_to_tree(Some(before), Some(after), None)?;
        let removed: Vec<(Oid, String)> = diff
            .deltas()
            .filter(|delta| delta.status() == Delta::Deleted)
            .filter_map(|delta| {
                let file = delta.old_file();
                let path = file.path()?.to_str()?.to_string();
                path.to_lowercase().ends_with(".md").then_some((file.id(), path))
            })
            .collect();
        for (blob, path) in removed {
            if self.is_it(blob)? {
                self.paths.push(path.clone());
                return Ok(Some((blob, path)));
            }
        }
        Ok(None)
    }

    fn is_it(&mut self, blob: Oid) -> SyncResult<bool> {
        let Some(id) = self.id else {
            return Ok(true);
        };
        if !self.ids.contains_key(&blob) {
            let found = match self.repo.find_blob(blob) {
                Ok(object) => frontmatter::split(&String::from_utf8_lossy(object.content())).0.id,
                Err(_) => None,
            };
            self.ids.insert(blob, found);
        }
        Ok(self.ids[&blob].as_deref() == Some(id))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::sync::repo::{describe, Author, SyncRepo};

    const LIMIT: u64 = 1024 * 1024;

    struct Repo {
        _dir: tempfile::TempDir,
        root: std::path::PathBuf,
        repo: SyncRepo,
    }

    impl Repo {
        fn new() -> Repo {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("仓库");
            fs::create_dir_all(&root).unwrap();
            let repo = SyncRepo::init(&root).unwrap();
            Repo { _dir: dir, root, repo }
        }

        fn write(&self, rel: &str, text: &str) {
            let path = self.root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }

        fn rename(&self, from: &str, to: &str) {
            let to_path = self.root.join(to);
            fs::create_dir_all(to_path.parent().unwrap()).unwrap();
            fs::rename(self.root.join(from), to_path).unwrap();
        }

        fn commit(&self, device: &str) {
            let author = Author { name: device, email: "test@localhost" };
            self.repo.commit_all(&author, LIMIT, describe).unwrap();
        }

        fn bodies(&self, rel: &str, id: Option<&str>) -> Vec<String> {
            versions(&self.root, rel, id, 100)
                .unwrap()
                .versions
                .iter()
                .map(|version| {
                    let full = text(&self.root, &version.blob.to_string()).unwrap();
                    frontmatter::split(&full).1
                })
                .collect()
        }
    }

    fn note(id: &str, body: &str) -> String {
        format!("---\nid: {id}\n---\n\n{body}")
    }

    #[test]
    fn every_commit_that_changed_the_note_is_a_version() {
        let r = Repo::new();
        r.write("笔记/周报.md", &note("n1", "第一版\n"));
        r.commit("A");
        r.write("笔记/别的.md", "不相干\n");
        r.commit("A");
        r.write("笔记/周报.md", &note("n1", "第二版\n"));
        r.commit("B");

        let history = versions(&r.root, "笔记/周报.md", Some("n1"), 100).unwrap();
        assert_eq!(history.versions.len(), 2, "改别的笔记的那次不算");
        assert_eq!(history.versions[0].author, "B");
        assert!(!history.more);
        assert_eq!(r.bodies("笔记/周报.md", Some("n1")), vec!["第二版\n", "第一版\n"]);
    }

    #[test]
    fn follows_the_note_through_renames_and_moves_by_its_id() {
        let r = Repo::new();
        r.write("笔记/周报.md", &note("n1", "起初\n"));
        r.commit("A");
        // 改了标题，同时改了正文
        r.rename("笔记/周报.md", "笔记/月报.md");
        r.write("笔记/月报.md", &note("n1", "改名的同时改了不少，和原来已经不怎么像了\n"));
        r.commit("A");
        // 挪进文件夹
        r.rename("笔记/月报.md", "笔记/工作/月报.md");
        r.commit("A");
        // 旧名字被另一篇新笔记占了：不能把它当成这篇的历史
        r.write("笔记/周报.md", &note("n2", "另一篇\n"));
        r.commit("A");
        r.write("笔记/工作/月报.md", &note("n1", "最新\n"));
        r.commit("A");

        let history = versions(&r.root, "笔记/工作/月报.md", Some("n1"), 100).unwrap();
        let paths: Vec<&str> = history.versions.iter().map(|v| v.path.as_str()).collect();
        assert_eq!(paths, vec!["笔记/工作/月报.md", "笔记/月报.md", "笔记/周报.md"]);
        assert_eq!(
            r.bodies("笔记/工作/月报.md", Some("n1")),
            vec!["最新\n", "改名的同时改了不少，和原来已经不怎么像了\n", "起初\n"],
            "只挪位置、内容没变的那次不算一版"
        );
        assert_eq!(title_of(&note("n1", "x"), "笔记/月报.md"), "月报");
    }

    #[test]
    fn days_are_found_by_path_and_the_list_is_capped() {
        let r = Repo::new();
        for i in 0..5 {
            r.write("日记/2026/2026-10-07.md", &format!("第 {i} 次\n"));
            r.commit("A");
        }
        let history = versions(&r.root, "日记/2026/2026-10-07.md", None, 3).unwrap();
        assert_eq!(history.versions.len(), 3);
        assert!(history.more);
        assert!(versions(&r.root, "日记/2026/2026-10-08.md", None, 3).unwrap().versions.is_empty());
    }

    #[test]
    fn both_sides_of_a_merge_and_the_merged_result_are_versions() {
        let cloud = tempfile::tempdir().unwrap();
        let url = cloud.path().join("remote.git");
        let mut options = git2::RepositoryInitOptions::new();
        options.bare(true).initial_head(crate::sync::repo::DEFAULT_BRANCH);
        git2::Repository::init_opts(&url, &options).unwrap();
        let url = url.to_string_lossy().replace('\\', "/");
        let net = crate::sync::repo::Net::default();
        let author = |name| Author { name, email: "test@localhost" };

        let a = Repo::new();
        a.repo.set_remote_url(&url).unwrap();
        a.write("笔记/周报.md", &note("n1", "一\n二\n三\n四\n五\n"));
        a.commit("A");
        a.repo.push(&net).unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let b_root = b_dir.path().join("仓库");
        let b = SyncRepo::clone(&url, &b_root, &net).unwrap();

        // A 改第一行，B 改最后一行：能自动合并
        a.write("笔记/周报.md", &note("n1", "一（A）\n二\n三\n四\n五\n"));
        a.commit("A");
        a.repo.push(&net).unwrap();
        fs::write(b_root.join("笔记/周报.md"), note("n1", "一\n二\n三\n四\n五（B）\n")).unwrap();
        b.commit_all(&author("B"), LIMIT, describe).unwrap();
        b.fetch(&net).unwrap();
        assert!(b.merge_fetched(&author("B"), |_| Ok(())).unwrap().merged);

        let history = versions(&b_root, "笔记/周报.md", Some("n1"), 100).unwrap();
        let bodies: Vec<String> = history
            .versions
            .iter()
            .map(|v| frontmatter::split(&text(&b_root, &v.blob.to_string()).unwrap()).1)
            .collect();
        assert_eq!(bodies.len(), 4, "{bodies:?}");
        assert_eq!(bodies[0], "一（A）\n二\n三\n四\n五（B）\n", "合并出来的那一版");
        assert!(bodies.contains(&"一（A）\n二\n三\n四\n五\n".to_string()));
        assert!(bodies.contains(&"一\n二\n三\n四\n五（B）\n".to_string()));
        assert_eq!(bodies[3], "一\n二\n三\n四\n五\n");
    }
}
