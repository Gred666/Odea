/* ============================================================
逻辑目录的树（docs/仓库与启动器.md §7）：`.odea/tree`，纯文本，一行一个节点。

    # Odea 逻辑目录 …
    d7k2a1  .       i     folder 交易
    n9x1b2  d7k2a1  i     note 0199f3c2-…
    p3x8c3  d7k2a1  r     file 旧资料/数学建模流程.md
    q1m4d4  .       r     query 近期复盘 | #复盘 updated:30d
    k5w2e5  d7k2a1  j     link note 0199f3d0-…

一行是：节点 id、父节点（`.` 是根）、排序键、内容。

- 笔记按属性块里的 id 引用（note），改名、挪位置都不变。属性块里没写 id 的（别的工具建的、
  资源管理器里扔进来的）按路径引用（file）—— 转成逻辑目录、拖动排序都不用改任何 .md。
  应用改名、挪动这篇的时候属性块里会写上 id，那一行跟着换成 note（Vault::tree_follow）
- 快捷方式（link，docs §7.5 第 1 条）：指向一篇放在别处的笔记（按 id 或者按路径，和上面一样），
  一篇只在一个位置，快捷方式另算、可以有好几个；删快捷方式不删笔记
- 树上的文件夹、智能文件夹（query）用路径称呼（`交易/学习`）：同一层不重名，和真的文件夹一样。
  清单里不存笔记的标题（标题是文件名，存了就要两边对账）
- 排序键是分数索引（key_between，Figma、Linear 用的那种）：插到两项中间不用给后面的重新编号，
  拖一篇只改它自己那一行
- 行按节点 id 排：挪动只改那一行，两台设备各挪各的，git 逐行就合上了。两边动了同一个节点，
  同步时按节点三方合并（merge3），不出冲突副本
- 读进来先理顺（normalize）：解析不了的行跳过；父节点没了的、成环的挪到根上；同一篇被引用了
  两次留一处；同一层重名的加序号。笔记都还在，没被引用的进「未整理」
============================================================ */

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use super::layout;
use crate::error::{AppError, Result};

/// 清单在仓库里的位置
pub const TREE_FILE: &str = ".odea/tree";
/// 清单的文件名（在 .odea/ 里；网盘的冲突副本按它认）
pub const TREE_NAME: &str = "tree";
/// 根节点
pub const ROOT: &str = ".";
/// 前端用来称呼「未整理」的文件夹路径：真的文件夹路径不会以 / 开头
pub const UNSORTED: &str = "/";

const HEADER: &str = "# Odea 逻辑目录（docs/仓库与启动器.md §7）。一行一个节点：节点 id、父节点（. 是根）、\
排序键、内容（folder 名字 / note 笔记 id / file 路径 / query 名字 | 条件 / link note 笔记 id / link file 路径）";

/// 排序键用的数字，按字节序就是大小顺序
const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Item {
    Folder(String),
    /// 属性块里写着的 id
    Note(String),
    /// 仓库里的相对路径：属性块里没写 id 的笔记
    File(String),
    /// 智能文件夹：存下来的筛选条件（vault/query.rs）
    Query { name: String, query: String },
    /// 快捷方式：指向按 id 引用的一篇
    LinkNote(String),
    /// 快捷方式：指向按路径引用的一篇（属性块里没写 id 的）
    LinkFile(String),
}

impl Item {
    /// 文件夹那一栏里的东西（文件夹、智能文件夹）：有名字、有路径
    fn is_branch(&self) -> bool {
        matches!(self, Item::Folder(_) | Item::Query { .. })
    }

    fn name(&self) -> &str {
        match self {
            Item::Folder(name) | Item::Query { name, .. } => name,
            Item::Note(id) | Item::LinkNote(id) => id,
            Item::File(rel) | Item::LinkFile(rel) => rel,
        }
    }

    /// 快捷方式
    pub fn is_link(&self) -> bool {
        matches!(self, Item::LinkNote(_) | Item::LinkFile(_))
    }

    /// 笔记的引用 → 指向它的快捷方式
    pub fn link_to(&self) -> Option<Item> {
        match self {
            Item::Note(id) => Some(Item::LinkNote(id.clone())),
            Item::File(rel) => Some(Item::LinkFile(rel.clone())),
            _ => None,
        }
    }

    fn set_name(&mut self, new: String) {
        match self {
            Item::Folder(name) | Item::Query { name, .. } => *name = new,
            _ => {}
        }
    }

    /// 同一篇笔记的两个引用算一个
    fn ref_key(&self) -> Option<String> {
        match self {
            Item::Note(id) => Some(format!("n:{id}")),
            Item::File(rel) => Some(format!("f:{rel}")),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub parent: String,
    pub key: String,
    pub item: Item,
}

/// 树上一个文件夹 / 智能文件夹，按显示顺序摊平时的一项
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Branch {
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tree {
    nodes: BTreeMap<String, Node>,
}

/* ---------------- 读、写 ---------------- */

impl Tree {
    /// 读清单并理顺。坏掉的行跳过（记一行日志），一篇笔记都不会因此不见：没被引用的进「未整理」
    pub fn parse(text: &str) -> Self {
        let mut tree = Self::parse_raw(text);
        tree.normalize();
        tree
    }

    /// 撤销删除时交回来的那几行（remove_branch 拿掉的）：原样解析，不理顺 —— 它们的父节点不在这几行里
    pub fn parse_fragment(text: &str) -> Self {
        Self::parse_raw(text)
    }

    /// 只解析不理顺：三方合并要拿原样的三份比
    fn parse_raw(text: &str) -> Self {
        let mut tree = Self::default();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            match parse_line(line) {
                // 同一个节点 id 写了两行：留第一行
                Some((id, node)) => {
                    tree.nodes.entry(id).or_insert(node);
                }
                None => eprintln!("逻辑目录里有一行读不懂，跳过: {line}"),
            }
        }
        tree
    }

    pub fn render(&self) -> String {
        let mut out = String::from(HEADER);
        out.push('\n');
        for (id, node) in &self.nodes {
            let (kind, content) = match &node.item {
                Item::Folder(name) => ("folder", name.clone()),
                Item::Note(id) => ("note", id.clone()),
                Item::File(rel) => ("file", rel.clone()),
                Item::Query { name, query } if query.is_empty() => ("query", format!("{name} |")),
                Item::Query { name, query } => ("query", format!("{name} | {query}")),
                Item::LinkNote(id) => ("link", format!("note {id}")),
                Item::LinkFile(rel) => ("link", format!("file {rel}")),
            };
            out.push_str(&format!("{id:<6}  {:<6}  {:<4}  {kind} {content}\n", node.parent, node.key));
        }
        out
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn nodes(&self) -> impl Iterator<Item = (&String, &Node)> {
        self.nodes.iter()
    }
}

fn parse_line(line: &str) -> Option<(String, Node)> {
    let (id, rest) = token(line);
    let (parent, rest) = token(rest);
    let (key, rest) = token(rest);
    let (kind, rest) = token(rest);
    let content = rest.trim();
    if !valid_id(id) || !(parent == ROOT || valid_id(parent)) || content.is_empty() {
        return None;
    }
    let item = match kind {
        "folder" => Item::Folder(layout::folder_name(content)?),
        "note" => Item::Note(content.to_string()),
        "file" => Item::File(content.replace('\\', "/")),
        "query" => {
            let (name, query) = content.split_once('|').unwrap_or((content, content));
            Item::Query {
                name: layout::folder_name(name)?,
                query: query.trim().to_string(),
            }
        }
        "link" => {
            let (kind, target) = token(content);
            let target = target.trim();
            match kind {
                _ if target.is_empty() => return None,
                "note" => Item::LinkNote(target.to_string()),
                "file" => Item::LinkFile(target.replace('\\', "/")),
                _ => return None,
            }
        }
        _ => return None,
    };
    Some((
        id.to_string(),
        Node {
            parent: parent.to_string(),
            key: clean_key(key),
            item,
        },
    ))
}

/// 下一个空白之前的那一段，和剩下的
fn token(text: &str) -> (&str, &str) {
    let text = text.trim_start();
    let end = text.find(char::is_whitespace).unwrap_or(text.len());
    (&text[..end], &text[end..])
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 排序键只收 0-9a-z；结尾的 0 去掉（`a0` 和 `a` 中间插不进东西）。认不出来的给空串，理顺时补一个
fn clean_key(raw: &str) -> String {
    let key = raw.to_ascii_lowercase();
    if !key.bytes().all(|b| DIGITS.contains(&b)) {
        return String::new();
    }
    key.trim_end_matches('0').to_string()
}

/* ---------------- 排序键 ---------------- */

/// 严格夹在 a、b 中间的排序键（None：a 是最前面之前，b 是最后面之后）。键是 36 进制的小数
/// 0.k1k2k3…，按字节序比大小；结尾不会是 0，所以任何一个键前面总还插得进东西。
/// 前端 data/tree.ts 的 keyBetween 是同一套算法，乐观更新算出来的和这里一样
pub fn key_between(a: Option<&str>, b: Option<&str>) -> String {
    midpoint(a.unwrap_or("").as_bytes(), b.map(str::as_bytes))
}

fn midpoint(a: &[u8], b: Option<&[u8]>) -> String {
    if let Some(b) = b {
        // 公共前缀（a 不够长时当后面补了 0）原样留着，在后面那一截里找中点
        let n = b
            .iter()
            .enumerate()
            .take_while(|(i, d)| a.get(*i).copied().unwrap_or(b'0') == **d)
            .count();
        if n > 0 && n < b.len() {
            let rest = a.get(n..).unwrap_or(&[]);
            return format!("{}{}", text(&b[..n]), midpoint(rest, Some(&b[n..])));
        }
    }
    let da = a.first().map_or(0, |d| digit(*d));
    let db = b.and_then(|b| b.first()).map_or(DIGITS.len(), |d| digit(*d));
    if db > da + 1 {
        return text(&[DIGITS[(da + db) / 2]]);
    }
    match b {
        // b 后面还有不是 0 的位：只取它的第一位，比 b 小、比 a 大
        Some(b) if b.len() > 1 => text(&b[..1]),
        _ => format!("{}{}", DIGITS[da] as char, midpoint(a.get(1..).unwrap_or(&[]), None)),
    }
}

fn digit(d: u8) -> usize {
    DIGITS.iter().position(|x| *x == d).unwrap_or(0)
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// 一排排序键（按顺序）：从头生成，间隔均匀
fn spaced_keys(count: usize) -> Vec<String> {
    let mut keys = Vec::with_capacity(count);
    let mut last: Option<String> = None;
    for _ in 0..count {
        let key = key_between(last.as_deref(), None);
        keys.push(key.clone());
        last = Some(key);
    }
    keys
}

/* ---------------- 理顺 ---------------- */

impl Tree {
    fn normalize(&mut self) {
        // 父节点得是一个文件夹（或者根）：没了的、指着笔记 / 智能文件夹的，挪到根上
        let folders: HashSet<String> = self
            .nodes
            .iter()
            .filter(|(_, node)| matches!(node.item, Item::Folder(_)))
            .map(|(id, _)| id.clone())
            .collect();
        for node in self.nodes.values_mut() {
            if node.parent != ROOT && !folders.contains(&node.parent) {
                node.parent = ROOT.into();
            }
        }
        self.break_cycles();
        self.dedupe_refs(|_| false);
        self.dedupe_links();
        self.unique_names();
        self.fill_keys();
    }

    /// 成环的（两台设备把 A、B 互相挪进了对方）：环上 id 最小的那个挪到根上
    fn break_cycles(&mut self) {
        let ids: Vec<String> = self.nodes.keys().cloned().collect();
        for start in ids {
            let mut seen: Vec<String> = Vec::new();
            let mut at = start;
            while at != ROOT {
                if let Some(pos) = seen.iter().position(|id| *id == at) {
                    let cut = seen[pos..].iter().min().cloned().unwrap_or(at);
                    if let Some(node) = self.nodes.get_mut(&cut) {
                        node.parent = ROOT.into();
                    }
                    break;
                }
                let Some(node) = self.nodes.get(&at) else { break };
                seen.push(at);
                at = node.parent.clone();
            }
        }
    }

    /// 同一篇只在一个位置：被引用了好几次的，留 prefer 认的那个（合并时是本机的），否则留 id 最小的
    fn dedupe_refs(&mut self, prefer: impl Fn(&str) -> bool) {
        let mut groups: HashMap<String, Vec<String>> = HashMap::new();
        for (id, node) in &self.nodes {
            if let Some(key) = node.item.ref_key() {
                groups.entry(key).or_default().push(id.clone());
            }
        }
        for ids in groups.into_values().filter(|ids| ids.len() > 1) {
            let keep = ids.iter().find(|id| prefer(id)).unwrap_or(&ids[0]).clone();
            for id in ids.iter().filter(|id| **id != keep) {
                self.nodes.remove(id);
            }
        }
    }

    /// 同一个文件夹里指向同一篇的快捷方式留一个（id 最小的）
    fn dedupe_links(&mut self) {
        let mut seen: HashSet<(String, Item)> = HashSet::new();
        let doubles: Vec<String> = self
            .nodes
            .iter()
            .filter(|(_, node)| node.item.is_link())
            .filter(|(_, node)| !seen.insert((node.parent.clone(), node.item.clone())))
            .map(|(id, _)| id.clone())
            .collect();
        for id in doubles {
            self.nodes.remove(&id);
        }
    }

    /// 同一层的文件夹、智能文件夹不重名（不分大小写，和真的文件夹一样）：后面的加「 2」「 3」
    fn unique_names(&mut self) {
        let mut by_parent: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (id, node) in &self.nodes {
            if node.item.is_branch() {
                by_parent.entry(node.parent.clone()).or_default().push(id.clone());
            }
        }
        for ids in by_parent.into_values() {
            let mut ids = ids;
            ids.sort_by(|a, b| (&self.nodes[a].key, a).cmp(&(&self.nodes[b].key, b)));
            let mut taken: HashSet<String> = HashSet::new();
            for id in ids {
                let name = self.nodes[&id].item.name().to_string();
                let free = free_among(&taken, &name);
                taken.insert(free.to_lowercase());
                if free != name {
                    if let Some(node) = self.nodes.get_mut(&id) {
                        node.item.set_name(free);
                    }
                }
            }
        }
    }

    /// 没有排序键的（别的工具写坏了的）排到同一层最后
    fn fill_keys(&mut self) {
        let missing: Vec<String> = self
            .nodes
            .iter()
            .filter(|(_, node)| node.key.is_empty())
            .map(|(id, _)| id.clone())
            .collect();
        for id in missing {
            let parent = self.nodes[&id].parent.clone();
            let last = self
                .nodes
                .values()
                .filter(|node| node.parent == parent && !node.key.is_empty())
                .map(|node| node.key.clone())
                .max();
            let key = key_between(last.as_deref(), None);
            if let Some(node) = self.nodes.get_mut(&id) {
                node.key = key;
            }
        }
    }
}

/// name 在 taken（小写）里有了就加序号
fn free_among(taken: &HashSet<String>, name: &str) -> String {
    (1..)
        .map(|n| if n == 1 { name.to_string() } else { format!("{name} {n}") })
        .find(|candidate| !taken.contains(&candidate.to_lowercase()))
        .expect("总有一个没被占的")
}

/* ---------------- 查 ---------------- */

impl Tree {
    /// parent 下面的节点，按显示顺序（排序键，一样时按 id）
    fn children(&self, parent: &str, branch: bool) -> Vec<String> {
        let mut ids: Vec<&String> = self
            .nodes
            .iter()
            .filter(|(_, node)| node.parent == parent && node.item.is_branch() == branch)
            .map(|(id, _)| id)
            .collect();
        ids.sort_by(|a, b| (&self.nodes[*a].key, *a).cmp(&(&self.nodes[*b].key, *b)));
        ids.into_iter().cloned().collect()
    }

    /// 文件夹和智能文件夹按显示顺序摊平：父在前、子在后，同一层按排序键
    pub fn branches(&self) -> Vec<Branch> {
        let mut out = Vec::new();
        self.walk(ROOT, "", &mut out);
        out
    }

    fn walk(&self, parent: &str, prefix: &str, out: &mut Vec<Branch>) {
        for id in self.children(parent, true) {
            let path = layout::join(prefix, self.nodes[&id].item.name());
            out.push(Branch { id: id.clone(), path: path.clone() });
            if matches!(self.nodes[&id].item, Item::Folder(_)) {
                self.walk(&id, &path, out);
            }
        }
    }

    /// 文件夹（不含智能文件夹）的路径，按显示顺序
    pub fn folder_paths(&self) -> Vec<String> {
        self.branches()
            .into_iter()
            .filter(|branch| matches!(self.nodes[&branch.id].item, Item::Folder(_)))
            .map(|branch| branch.path)
            .collect()
    }

    /// 路径 → 节点 id（文件夹或智能文件夹）。空串是根
    pub fn find_branch(&self, path: &str) -> Option<String> {
        if path.is_empty() {
            return Some(ROOT.into());
        }
        let mut at = ROOT.to_string();
        for part in path.split('/') {
            let next = self.nodes.iter().find(|(_, node)| {
                node.parent == at && node.item.is_branch() && node.item.name() == part
            })?;
            at = next.0.clone();
        }
        Some(at)
    }

    /// 某个节点的路径（根是空串）
    pub fn path_of(&self, id: &str) -> String {
        let mut parts = Vec::new();
        let mut at = id;
        while at != ROOT {
            let Some(node) = self.nodes.get(at) else { break };
            if node.item.is_branch() {
                parts.push(node.item.name());
            }
            at = &node.parent;
        }
        parts.reverse();
        parts.join("/")
    }

    pub fn get(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    /// 这篇笔记在树上的节点：按 id 引用的，或者按路径引用的
    pub fn find_note(&self, id: &str, rel: &str) -> Option<String> {
        self.nodes
            .iter()
            .find(|(_, node)| match &node.item {
                Item::Note(note) => note == id,
                Item::File(path) => path == rel,
                _ => false,
            })
            .map(|(node_id, _)| node_id.clone())
    }

    /// 按路径引用这篇的节点
    pub fn find_file(&self, rel: &str) -> Option<String> {
        self.nodes
            .iter()
            .find(|(_, node)| matches!(&node.item, Item::File(path) if path == rel))
            .map(|(id, _)| id.clone())
    }

    /// 按 id 引用这篇的节点
    pub fn find_note_id(&self, note: &str) -> Option<String> {
        self.nodes
            .iter()
            .find(|(_, node)| matches!(&node.item, Item::Note(id) if id == note))
            .map(|(id, _)| id.clone())
    }

    /// 智能文件夹的条件；路径不是智能文件夹返回 None
    pub fn query_at(&self, path: &str) -> Option<String> {
        let id = self.find_branch(path)?;
        match &self.nodes.get(&id)?.item {
            Item::Query { query, .. } => Some(query.clone()),
            _ => None,
        }
    }

    /// 文件夹（得是真的文件夹，不是智能文件夹）的节点 id；空串是根
    fn folder_id(&self, path: &str) -> Result<String> {
        let id = self
            .find_branch(path)
            .ok_or_else(|| AppError::NotFound(format!("文件夹「{path}」不在了")))?;
        if id != ROOT && !matches!(self.nodes[&id].item, Item::Folder(_)) {
            return Err(AppError::Invalid(format!("「{path}」是智能文件夹，里面放不了东西")));
        }
        Ok(id)
    }

    fn branch_id(&self, path: &str) -> Result<String> {
        match self.find_branch(path) {
            Some(id) if id != ROOT => Ok(id),
            _ => Err(AppError::NotFound(format!("文件夹「{path}」不在了"))),
        }
    }

    /// 同一层里给名字找一个没被占的（except 是改名时它自己）
    fn free_name(&self, parent: &str, name: &str, except: Option<&str>) -> String {
        let taken: HashSet<String> = self
            .nodes
            .iter()
            .filter(|(id, node)| node.parent == parent && node.item.is_branch() && Some(id.as_str()) != except)
            .map(|(_, node)| node.item.name().to_lowercase())
            .collect();
        free_among(&taken, name)
    }

    fn new_id(&self) -> String {
        loop {
            // UUIDv7 的低 62 位是随机的
            let mut n = (uuid::Uuid::now_v7().as_u128() & ((1u128 << 62) - 1)) as u64;
            let mut id = String::new();
            for _ in 0..6 {
                id.push(DIGITS[(n % 36) as usize] as char);
                n /= 36;
            }
            if !self.nodes.contains_key(&id) {
                return id;
            }
        }
    }

    /// 把 id 放到 parent 这一层（branch 那一组：文件夹那一栏 / 笔记）的 after 后面；after 是 None
    /// 就放在最前面。挪动只改它自己的键；两边的键撞了（两台设备在同一处各插了一个）才把这一组重排一遍
    fn key_after(&mut self, id: &str, parent: &str, branch: bool, after: Option<&str>) -> String {
        let siblings: Vec<String> = self.children(parent, branch).into_iter().filter(|s| s != id).collect();
        let index = match after {
            Some(after) => siblings.iter().position(|s| s == after).map(|i| i + 1).unwrap_or(siblings.len()),
            None => 0,
        };
        let prev = index.checked_sub(1).map(|i| self.nodes[&siblings[i]].key.clone());
        let next = siblings.get(index).map(|s| self.nodes[s].key.clone());
        let ordered = match (&prev, &next) {
            (Some(prev), Some(next)) => prev < next,
            _ => true,
        };
        if ordered {
            return key_between(prev.as_deref(), next.as_deref());
        }
        let mut order = siblings;
        order.insert(index, id.to_string());
        let keys = spaced_keys(order.len());
        let mut mine = String::new();
        for (sibling, key) in order.iter().zip(keys) {
            if sibling == id {
                mine = key;
            } else if let Some(node) = self.nodes.get_mut(sibling) {
                node.key = key;
            }
        }
        mine
    }
}

/* ---------------- 改 ---------------- */

impl Tree {
    /// 在 parent 里新建文件夹，排在这一层最前面（前端就地起名的输入框也在最前面）。返回它的路径
    pub fn add_folder(&mut self, parent: &str, name: &str) -> Result<String> {
        self.add_branch(parent, name, |name| Item::Folder(name))
    }

    /// 新建智能文件夹
    pub fn add_query(&mut self, parent: &str, name: &str, query: &str) -> Result<String> {
        let query = query.trim().to_string();
        self.add_branch(parent, name, move |name| Item::Query { name, query })
    }

    fn add_branch(&mut self, parent: &str, name: &str, item: impl FnOnce(String) -> Item) -> Result<String> {
        let parent = self.folder_id(parent)?;
        let name = layout::folder_name(name).ok_or_else(|| AppError::Invalid("文件夹名不能是空的".into()))?;
        let name = self.free_name(&parent, &name, None);
        let id = self.new_id();
        let key = self.key_after(&id, &parent, true, None);
        self.nodes.insert(id.clone(), Node { parent, key, item: item(name) });
        Ok(self.path_of(&id))
    }

    /// 改名（同一层里重名加序号），只改这一行。返回新路径
    pub fn rename(&mut self, path: &str, name: &str) -> Result<String> {
        let id = self.branch_id(path)?;
        let name = layout::folder_name(name).ok_or_else(|| AppError::Invalid("文件夹名不能是空的".into()))?;
        let parent = self.nodes[&id].parent.clone();
        let name = self.free_name(&parent, &name, Some(&id));
        if let Some(node) = self.nodes.get_mut(&id) {
            node.item.set_name(name);
        }
        Ok(self.path_of(&id))
    }

    /// 改智能文件夹的名字和条件。返回新路径
    pub fn set_query(&mut self, path: &str, name: &str, query: &str) -> Result<String> {
        let id = self.branch_id(path)?;
        if !matches!(self.nodes[&id].item, Item::Query { .. }) {
            return Err(AppError::Invalid(format!("「{path}」不是智能文件夹")));
        }
        let path = self.rename(path, name)?;
        if let Some(Node { item: Item::Query { query: old, .. }, .. }) = self.nodes.get_mut(&id) {
            *old = query.trim().to_string();
        }
        Ok(path)
    }

    /// 挪文件夹 / 智能文件夹：放进 parent，排在 after（同一层的路径）后面，None 是最前面。
    /// 不能挪进它自己或者它底下。返回新路径
    pub fn move_branch(&mut self, path: &str, parent: &str, after: Option<&str>) -> Result<String> {
        let id = self.branch_id(path)?;
        let parent = self.folder_id(parent)?;
        let mut at = parent.clone();
        while at != ROOT {
            if at == id {
                return Err(AppError::Invalid("文件夹不能挪进它自己里面".into()));
            }
            at = self.nodes[&at].parent.clone();
        }
        let after = match after {
            Some(after) => Some(self.branch_id(after)?).filter(|after| self.nodes[after].parent == parent),
            None => None,
        };
        let name = self.nodes[&id].item.name().to_string();
        let name = self.free_name(&parent, &name, Some(&id));
        let key = self.key_after(&id, &parent, true, after.as_deref());
        if let Some(node) = self.nodes.get_mut(&id) {
            node.parent = parent;
            node.key = key;
            node.item.set_name(name);
        }
        Ok(self.path_of(&id))
    }

    /// 拿掉一个文件夹 / 智能文件夹连同它底下的所有节点（笔记的引用也在里面）。
    /// 返回拿掉的节点，原样交给 restore 就能放回去
    pub fn remove_branch(&mut self, path: &str) -> Result<Tree> {
        let id = self.branch_id(path)?;
        let mut removed = Tree::default();
        let mut stack = vec![id];
        while let Some(id) = stack.pop() {
            stack.extend(
                self.nodes
                    .iter()
                    .filter(|(_, node)| node.parent == id)
                    .map(|(child, _)| child.clone()),
            );
            if let Some(node) = self.nodes.remove(&id) {
                removed.nodes.insert(id, node);
            }
        }
        Ok(removed)
    }

    /// 撤销 remove_branch：节点放回去。父节点在这期间没了的挪到根上，撞名的加序号；
    /// 期间又被放到别处的笔记留在新位置
    pub fn restore(&mut self, removed: &Tree) {
        let placed: HashSet<String> = self.nodes.values().filter_map(|node| node.item.ref_key()).collect();
        for (id, node) in &removed.nodes {
            let moved_since = node.item.ref_key().is_some_and(|key| placed.contains(&key));
            if !moved_since && !self.nodes.contains_key(id) {
                self.nodes.insert(id.clone(), node.clone());
            }
        }
        self.normalize();
    }

    /// 把一篇放进 parent（树上的文件夹路径，空串是根；None = 未整理：去掉它的节点），排在 after
    /// （同一层另一篇的节点）后面，None 是最前面。at 是它现在的节点（find_note）
    pub fn place(&mut self, at: Option<String>, item: Item, parent: Option<&str>, after: Option<&str>) -> Result<()> {
        let Some(parent) = parent else {
            if let Some(at) = at {
                self.nodes.remove(&at);
            }
            return Ok(());
        };
        let parent = self.folder_id(parent)?;
        let id = at.unwrap_or_else(|| self.new_id());
        let after = after.filter(|after| self.nodes.get(*after).is_some_and(|node| node.parent == parent));
        let key = self.key_after(&id, &parent, false, after);
        self.nodes.insert(id, Node { parent, key, item });
        Ok(())
    }

    /// 在文件夹 parent（路径，空串是根）里放一个快捷方式，指向 target（一篇的引用，Item::link_to 之前的），
    /// 排在这一层笔记的最前面。这个文件夹里已经有指向它的就不再放。返回快捷方式的节点 id
    pub fn add_link(&mut self, parent: &str, target: &Item) -> Result<String> {
        let link = target.link_to().ok_or_else(|| AppError::Invalid("快捷方式只能指向笔记".into()))?;
        let parent = self.folder_id(parent)?;
        if let Some((id, _)) = self.nodes.iter().find(|(_, node)| node.parent == parent && node.item == link) {
            return Ok(id.clone());
        }
        let id = self.new_id();
        let key = self.key_after(&id, &parent, false, None);
        self.nodes.insert(id.clone(), Node { parent, key, item: link });
        Ok(id)
    }

    /// 拿掉一个快捷方式（不是快捷方式的不动）
    pub fn remove_link(&mut self, id: &str) -> Result<()> {
        match self.nodes.get(id) {
            Some(node) if node.item.is_link() => {
                self.nodes.remove(id);
                Ok(())
            }
            _ => Err(AppError::NotFound("快捷方式不在了".into())),
        }
    }

    /// 改一个节点引用的东西（file → note：这篇的属性块里写上了 id）
    pub fn set_item(&mut self, id: &str, item: Item) {
        if let Some(node) = self.nodes.get_mut(id) {
            node.item = item;
        }
    }

    /// 去掉一批节点（引用的笔记已经不在了）
    pub fn remove_nodes(&mut self, ids: &[String]) {
        for id in ids {
            self.nodes.remove(id);
        }
    }
}

/* ---------------- 从文件夹结构建 ---------------- */

/// 本地目录转逻辑目录（docs §7.3）：按现在的文件夹结构建一棵，一个文件都不动。
/// folders 是树根下的文件夹（相对树根的路径），notes 是 (所在文件夹, 引用)，笔记按传进来的顺序排
pub fn from_structure(folders: &[String], notes: &[(String, Item)]) -> Tree {
    let mut tree = Tree::default();
    let mut ids: HashMap<String, String> = HashMap::from([(String::new(), ROOT.to_string())]);
    let mut sorted: Vec<&String> = folders.iter().collect();
    // 父在子前（路径短的在前）；同一层按名字
    sorted.sort_by(|a, b| (a.matches('/').count(), *a).cmp(&(b.matches('/').count(), *b)));
    let mut last_key: HashMap<String, String> = HashMap::new();
    let mut next_key = |parent: &str| {
        let key = key_between(last_key.get(parent).map(String::as_str), None);
        last_key.insert(parent.to_string(), key.clone());
        key
    };
    for path in sorted {
        let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
        let Some(parent) = ids.get(dir).cloned() else { continue };
        let Some(name) = layout::folder_name(name) else { continue };
        let id = tree.new_id();
        let key = next_key(&parent);
        tree.nodes.insert(id.clone(), Node { parent, key, item: Item::Folder(name) });
        ids.insert(path.clone(), id);
    }
    let mut note_keys: HashMap<String, String> = HashMap::new();
    for (folder, item) in notes {
        let parent = ids.get(folder).cloned().unwrap_or_else(|| ROOT.to_string());
        let key = key_between(note_keys.get(&parent).map(String::as_str), None);
        note_keys.insert(parent.clone(), key.clone());
        let id = tree.new_id();
        tree.nodes.insert(id, Node { parent, key, item: item.clone() });
    }
    tree.normalize();
    tree
}

/* ---------------- 合并 ---------------- */

/// 同步时两边都改了清单（docs §7.4）：按节点三方合并。每个节点各自比 —— 只有一边改了用那一边；
/// 两边都改了用本机的；一边删一边改，留改过的。合完理顺：成环的断开挪到根上、同一篇两处留本机那处
pub fn merge3(base: &str, ours: &str, theirs: &str) -> String {
    let (base, ours, theirs) = (Tree::parse_raw(base), Tree::parse_raw(ours), Tree::parse_raw(theirs));
    let ids: BTreeSet<&String> = base.nodes.keys().chain(ours.nodes.keys()).chain(theirs.nodes.keys()).collect();
    let mut merged = Tree::default();
    for id in ids {
        let (b, o, t) = (base.nodes.get(id), ours.nodes.get(id), theirs.nodes.get(id));
        let pick = if o == t || t == b {
            o
        } else if o == b {
            t
        } else {
            o.or(t)
        };
        if let Some(node) = pick {
            merged.nodes.insert(id.clone(), node.clone());
        }
    }
    merged.dedupe_refs(|id| ours.nodes.contains_key(id));
    merged.normalize();
    merged.render()
}

/// 网盘的冲突副本（`tree (1)` 这类）和原文合并：没有共同祖先，当两边都是新加的 ——
/// 两边的节点都留下，同一个节点不一样用原文的（本机这一份）
pub fn merge_copy(original: &str, copy: &str) -> String {
    merge3("", original, copy)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(parent: &str, key: &str, item: Item) -> Node {
        Node { parent: parent.into(), key: key.into(), item }
    }

    fn folder(name: &str) -> Item {
        Item::Folder(name.into())
    }

    fn note(id: &str) -> Item {
        Item::Note(id.into())
    }

    fn tree(nodes: &[(&str, Node)]) -> Tree {
        Tree { nodes: nodes.iter().map(|(id, node)| (id.to_string(), node.clone())).collect() }
    }

    #[test]
    fn keys_always_fit_between() {
        assert_eq!(key_between(None, None), "i");
        assert_eq!(key_between(Some("i"), None), "r");
        assert_eq!(key_between(None, Some("i")), "9");
        assert_eq!(key_between(Some("a"), Some("b")), "ai");
        assert_eq!(key_between(Some("a"), Some("ab")), "a5");
        assert_eq!(key_between(Some("az"), Some("b")), "azi");
        assert_eq!(key_between(Some("a"), Some("b5")), "b");
        // 一直往同一处插：键变长，但永远插得进、顺序对
        let mut low = "a".to_string();
        let high = "b".to_string();
        for _ in 0..200 {
            let mid = key_between(Some(&low), Some(&high));
            assert!(low < mid && mid < high, "{low} < {mid} < {high}");
            assert!(!mid.ends_with('0'));
            low = mid;
        }
        let mut high = "b".to_string();
        for _ in 0..200 {
            let mid = key_between(None, Some(&high));
            assert!(mid < high && !mid.is_empty() && !mid.ends_with('0'), "{mid} < {high}");
            high = mid;
        }
        assert_eq!(spaced_keys(3), vec!["i", "r", "v"]);
    }

    #[test]
    fn parses_renders_and_skips_broken_lines() {
        let text = "# 注释\n\
                    d7k2a1  .       i     folder 交易\n\
                    n9x1b2  d7k2a1  i     note 0199f3c2-aaaa\n\
                    p3x8c3  d7k2a1  r     file 旧资料/数学 建模.md\n\
                    q1m4d4  .       r     query 近期复盘 | #复盘 updated:30d\n\
                    这一行  读不懂\n\
                    zzzzzz  .       i     banana 香蕉\n";
        let tree = Tree::parse(text);
        assert_eq!(tree.nodes.len(), 4);
        assert_eq!(tree.nodes["p3x8c3"].item, Item::File("旧资料/数学 建模.md".into()));
        assert_eq!(
            tree.nodes["q1m4d4"].item,
            Item::Query { name: "近期复盘".into(), query: "#复盘 updated:30d".into() }
        );
        // 写出去再读回来一样
        assert_eq!(Tree::parse(&tree.render()), tree);
        assert_eq!(tree.folder_paths(), vec!["交易"]);
        let paths: Vec<String> = tree.branches().into_iter().map(|b| b.path).collect();
        assert_eq!(paths, vec!["交易", "近期复盘"]);
        assert_eq!(tree.query_at("近期复盘").as_deref(), Some("#复盘 updated:30d"));
        assert_eq!(tree.find_note("0199f3c2-aaaa", ""), Some("n9x1b2".into()));
        assert_eq!(tree.find_note("别的", "旧资料/数学 建模.md"), Some("p3x8c3".into()));
    }

    #[test]
    fn shortcuts_are_extra_and_never_the_placement() {
        let text = "d7k2a1  .       i     folder 交易\n\
                    n9x1b2  d7k2a1  i     note 0199f3c2-aaaa\n\
                    k5w2e5  .       j     link note 0199f3c2-aaaa\n\
                    k5w2e6  .       k     link note 0199f3c2-aaaa\n\
                    m1x2y3  d7k2a1  r     link file 旧资料/数学 建模.md\n\
                    zzzzzz  .       l     link 坏的\n";
        let mut tree = Tree::parse(text);
        // 同一个文件夹里指着同一篇的留一个；坏的那行跳过
        assert_eq!(tree.nodes.len(), 4);
        assert_eq!(tree.nodes["m1x2y3"].item, Item::LinkFile("旧资料/数学 建模.md".into()));
        // 快捷方式不算这篇放在哪
        assert_eq!(tree.find_note("0199f3c2-aaaa", ""), Some("n9x1b2".into()));
        assert_eq!(Tree::parse(&tree.render()), tree);
        // 加：已经有就是那一个；不能指着文件夹
        let link = tree.add_link("交易", &Item::Note("0199f3c2-aaaa".into())).unwrap();
        assert_eq!(tree.nodes[&link].item, Item::LinkNote("0199f3c2-aaaa".into()));
        assert_eq!(tree.add_link("交易", &Item::Note("0199f3c2-aaaa".into())).unwrap(), link);
        assert!(tree.add_link("", &Item::Folder("x".into())).is_err());
        tree.remove_link(&link).unwrap();
        assert!(tree.remove_link("n9x1b2").is_err(), "不是快捷方式的不动");
        assert!(tree.nodes.contains_key("n9x1b2"));
    }

    #[test]
    fn straightens_out_whatever_it_reads() {
        let mut broken = tree(&[
            // 父节点没了
            ("a", node("gone", "i", folder("孤儿"))),
            // 成环：b 在 c 里，c 在 b 里
            ("b", node("c", "i", folder("乙"))),
            ("c", node("b", "i", folder("丙"))),
            // 同一层重名（不分大小写）
            ("d", node(ROOT, "r", folder("Work"))),
            ("e", node(ROOT, "v", folder("work"))),
            // 同一篇引用了两次；挂在笔记下面的
            ("f", node("d", "i", note("x"))),
            ("g", node("e", "i", note("x"))),
            ("h", node("f", "", note("y"))),
        ]);
        broken.normalize();
        assert_eq!(broken.nodes["a"].parent, ROOT);
        assert_eq!(broken.nodes["b"].parent, ROOT, "环上 id 最小的挪到根上");
        assert_eq!(broken.nodes["c"].parent, "b");
        assert_eq!(broken.nodes["e"].item, folder("work 2"));
        assert!(broken.nodes.contains_key("f") && !broken.nodes.contains_key("g"));
        assert_eq!(broken.nodes["h"].parent, ROOT);
        assert!(!broken.nodes["h"].key.is_empty(), "没有键的补上");
        assert_eq!(broken.find_branch("乙/丙"), Some("c".into()));
    }

    #[test]
    fn folders_are_added_renamed_moved_and_removed_by_path() {
        let mut tree = Tree::default();
        assert_eq!(tree.add_folder("", "交易").unwrap(), "交易");
        assert_eq!(tree.add_folder("", "读书").unwrap(), "读书");
        // 新建的排在最前面
        assert_eq!(tree.folder_paths(), vec!["读书", "交易"]);
        assert_eq!(tree.add_folder("交易", "学习").unwrap(), "交易/学习");
        assert_eq!(tree.add_folder("交易", "学习").unwrap(), "交易/学习 2");
        assert_eq!(tree.rename("交易/学习 2", "复盘").unwrap(), "交易/复盘");
        assert_eq!(tree.rename("交易/复盘", "学习").unwrap(), "交易/学习 2", "改成重名的加序号");
        assert!(tree.add_folder("没有", "x").is_err());
        assert!(tree.rename("", "x").is_err(), "根不能改名");

        // 挪：进别的文件夹、同一层里换顺序；不能挪进自己底下
        assert_eq!(tree.move_branch("交易/学习 2", "读书", None).unwrap(), "读书/学习 2");
        assert_eq!(tree.move_branch("读书", "", Some("交易")).unwrap(), "读书");
        assert_eq!(tree.folder_paths(), vec!["交易", "交易/学习", "读书", "读书/学习 2"]);
        assert!(tree.move_branch("读书", "读书/学习 2", None).is_err());
        // 挪过去重名的加序号
        assert_eq!(tree.move_branch("读书/学习 2", "交易", Some("交易/学习")).unwrap(), "交易/学习 2");

        // 拿掉一个文件夹连同底下的，撤销时放回去
        let id = tree.find_branch("交易/学习").unwrap();
        tree.place(None, note("n1"), Some("交易/学习"), None).unwrap();
        let before = tree.clone();
        let removed = tree.remove_branch("交易").unwrap();
        assert_eq!(removed.nodes.len(), 4);
        assert_eq!(tree.folder_paths(), vec!["读书"]);
        tree.restore(&removed);
        assert_eq!(tree, before);
        assert_eq!(tree.find_branch("交易/学习"), Some(id));
    }

    #[test]
    fn notes_are_placed_ordered_and_unsorted() {
        let mut tree = Tree::default();
        tree.add_folder("", "交易").unwrap();
        let order = |tree: &Tree| -> Vec<String> {
            let parent = tree.find_branch("交易").unwrap();
            tree.children(&parent, false)
                .into_iter()
                .map(|id| tree.nodes[&id].item.name().to_string())
                .collect()
        };
        for id in ["a", "b", "c"] {
            tree.place(None, note(id), Some("交易"), None).unwrap();
        }
        assert_eq!(order(&tree), vec!["c", "b", "a"], "放进来的排在最前面");
        let at = |tree: &Tree, id: &str| tree.find_note(id, "").unwrap();
        // 把 c 挪到 a 后面：只改 c 那一行
        let before = tree.render();
        let (c, a) = (at(&tree, "c"), at(&tree, "a"));
        tree.place(Some(c.clone()), note("c"), Some("交易"), Some(&a)).unwrap();
        assert_eq!(order(&tree), vec!["b", "a", "c"]);
        let changed = before.lines().zip(tree.render().lines()).filter(|(x, y)| x != y).count();
        assert_eq!(changed, 1);
        // 移到未整理 = 去掉节点
        tree.place(Some(c), note("c"), None, None).unwrap();
        assert_eq!(order(&tree), vec!["b", "a"]);
        assert_eq!(tree.find_note("c", ""), None);
        // 两个键撞了（两台设备在同一处各插了一个）：这一组重排一遍，照样插得进去
        let (a, b) = (at(&tree, "a"), at(&tree, "b"));
        let key = tree.nodes[&a].key.clone();
        tree.nodes.get_mut(&b).unwrap().key = key;
        let first = tree.children(&tree.find_branch("交易").unwrap(), false)[0].clone();
        tree.place(None, note("d"), Some("交易"), Some(&first)).unwrap();
        let parent = tree.find_branch("交易").unwrap();
        let keys: Vec<String> = tree.children(&parent, false).iter().map(|id| tree.nodes[id].key.clone()).collect();
        assert!(keys.windows(2).all(|pair| pair[0] < pair[1]), "{keys:?}");
        // 智能文件夹里放不了
        tree.add_query("", "近期", "updated:7d").unwrap();
        assert!(tree.place(None, note("e"), Some("近期"), None).is_err());
    }

    #[test]
    fn builds_from_the_folder_structure() {
        let folders = vec!["工作".to_string(), "工作/周报".to_string(), "读书".to_string()];
        let notes = vec![
            ("工作/周报".to_string(), note("w1")),
            (String::new(), Item::File("随手.md".into())),
            ("工作/周报".to_string(), note("w2")),
            ("不存在".to_string(), note("z")),
        ];
        let tree = from_structure(&folders, &notes);
        assert_eq!(tree.folder_paths(), vec!["工作", "工作/周报", "读书"]);
        let weekly = tree.find_branch("工作/周报").unwrap();
        let ids: Vec<String> =
            tree.children(&weekly, false).iter().map(|id| tree.nodes[id].item.name().to_string()).collect();
        assert_eq!(ids, vec!["w1", "w2"], "照传进来的顺序");
        assert_eq!(tree.nodes[&tree.find_note("z", "").unwrap()].parent, ROOT);
        assert_eq!(tree.nodes[&tree.find_note("", "随手.md").unwrap()].parent, ROOT);
    }

    /// 两台设备各自挪树，同步后合得上（docs §8 P11.3 完成的样子）
    #[test]
    fn merges_two_devices_by_node() {
        let mut base = Tree::default();
        base.add_folder("", "甲").unwrap();
        base.add_folder("", "乙").unwrap();
        base.add_folder("", "丙").unwrap();
        for id in ["n1", "n2", "n3"] {
            base.place(None, note(id), Some("甲"), None).unwrap();
        }
        let id = |tree: &Tree, path: &str| tree.find_branch(path).unwrap();

        // 本机：n1 挪进乙，丙改名「丙丙」，删掉 n3；对方：n2 挪进丙、乙改名「乙乙」、n3 挪进乙、新建「丁」
        let mut ours = base.clone();
        let n1 = ours.find_note("n1", "").unwrap();
        ours.place(Some(n1), note("n1"), Some("乙"), None).unwrap();
        ours.rename("丙", "丙丙").unwrap();
        let n3 = ours.find_note("n3", "").unwrap();
        ours.place(Some(n3), note("n3"), None, None).unwrap();
        let mut theirs = base.clone();
        let n2 = theirs.find_note("n2", "").unwrap();
        theirs.place(Some(n2), note("n2"), Some("丙"), None).unwrap();
        theirs.rename("乙", "乙乙").unwrap();
        let n3 = theirs.find_note("n3", "").unwrap();
        theirs.place(Some(n3), note("n3"), Some("乙乙"), None).unwrap();
        theirs.add_folder("", "丁").unwrap();

        let merged = Tree::parse(&merge3(&base.render(), &ours.render(), &theirs.render()));
        let parent_of = |id: &str| merged.path_of(&merged.nodes[&merged.find_note(id, "").unwrap()].parent);
        assert_eq!(parent_of("n1"), "乙乙");
        assert_eq!(parent_of("n2"), "丙丙");
        assert_eq!(parent_of("n3"), "乙乙", "一边删一边改：留改过的");
        assert!(merged.find_branch("丁").is_some());
        assert_eq!(id(&merged, "乙乙"), id(&base, "乙"));

        // 两边都挪了同一篇：用本机的
        let mut ours = base.clone();
        let mut theirs = base.clone();
        let at = ours.find_note("n1", "").unwrap();
        ours.place(Some(at.clone()), note("n1"), Some("乙"), None).unwrap();
        theirs.place(Some(at), note("n1"), Some("丙"), None).unwrap();
        let merged = Tree::parse(&merge3(&base.render(), &ours.render(), &theirs.render()));
        let n1 = merged.find_note("n1", "").unwrap();
        assert_eq!(merged.path_of(&merged.nodes[&n1].parent), "乙");

        // 两边把乙、丙互相挪进对方：合出环，断开挪到根上，两个文件夹都还在
        let mut ours = base.clone();
        ours.move_branch("乙", "丙", None).unwrap();
        let mut theirs = base.clone();
        theirs.move_branch("丙", "乙", None).unwrap();
        let merged = Tree::parse(&merge3(&base.render(), &ours.render(), &theirs.render()));
        let mut paths = merged.folder_paths();
        paths.sort();
        assert_eq!(paths.len(), 3, "{paths:?}");
        assert!(paths.iter().any(|p| p == "乙" || p == "丙"), "{paths:?}");

        // 两边都把未整理里的同一篇放进了不同的文件夹（两个新节点）：留本机那处
        let mut ours = base.clone();
        ours.place(None, note("new"), Some("乙"), None).unwrap();
        let mut theirs = base.clone();
        theirs.place(None, note("new"), Some("丙"), None).unwrap();
        let merged = Tree::parse(&merge3(&base.render(), &ours.render(), &theirs.render()));
        let placed: Vec<_> = merged.nodes.values().filter(|n| n.item == note("new")).collect();
        assert_eq!(placed.len(), 1);
        assert_eq!(merged.path_of(&placed[0].parent), "乙");

        // 两边在同一层各建了同名的文件夹：都留下，后一个加序号
        let mut ours = base.clone();
        ours.add_folder("", "新").unwrap();
        let mut theirs = base.clone();
        theirs.add_folder("", "新").unwrap();
        let merged = Tree::parse(&merge3(&base.render(), &ours.render(), &theirs.render()));
        let news = merged.folder_paths().into_iter().filter(|p| p.starts_with('新')).count();
        assert_eq!(news, 2);
    }

    #[test]
    fn merges_a_cloud_drive_copy_without_losing_anything() {
        let mut original = Tree::default();
        original.add_folder("", "甲").unwrap();
        let mut copy = original.clone();
        copy.add_folder("", "乙").unwrap();
        original.rename("甲", "甲甲").unwrap();
        copy.rename("甲", "另一个名字").unwrap();
        let merged = Tree::parse(&merge_copy(&original.render(), &copy.render()));
        let mut paths = merged.folder_paths();
        paths.sort();
        assert_eq!(paths, vec!["乙", "甲甲"], "两边新加的都在，同一个节点用原文的");
    }
}
