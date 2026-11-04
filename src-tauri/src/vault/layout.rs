/* ============================================================
仓库文件夹的约定：什么路径是什么文档、文档该放在哪。

Odea 建的仓库（新建的、老用户的）：

    笔记/秋季项目复盘.md          笔记（笔记/ 下任意深度，以及仓库里其它不认识的位置）
    归档/第一版信息架构草稿.md      归档的笔记
    日记/2026/2026-09-26.md       日程插件的某一天（plugins/journal）
    目标/2026/2026-W39.md          日程插件的周目标；2026-09.md 月目标；2026.md 年目标
    附件/                          图片等，正文里用相对路径引用
    .odea/                         应用自己的东西（回收站、行为日志、仓库标记）

核心只认笔记。某一天、目标这些是插件声明的文档类型（plugins/mod.rs 的 DocType），插件开着才认；
归档单独一个开关（只写笔记的人也要归档旧资料）。开关和文件夹名记在仓库标记 `.odea/vault.json` 里
（Layout）。什么都没开的仓库里什么都是笔记；没开日程这类插件的仓库，文件树的根是整个仓库。

路径在程序里一律是正斜杠分隔的相对路径字符串，落到磁盘时再按组件拼。
============================================================ */

use std::path::Path;
use std::sync::Arc;

use serde_json::Value;

use crate::error::{AppError, Result};
use crate::plugins::{self, DocType, Plugin};

pub const NOTES_DIR: &str = "笔记";
pub const ARCHIVE_DIR: &str = "归档";
/// 粘贴 / 拖进来的图片，正文里用相对路径引用（见 Vault::attach）
pub const ATTACHMENTS_DIR: &str = "附件";
/// 应用自己的文件夹。改名前叫 .ontheway，打开仓库时搬过来（old_name::move_vault_dir）
pub const APP_DIR: &str = ".odea";
pub const TRASH_DIR: &str = ".odea/trash";
pub const ACTIVITY_DIR: &str = ".odea/activity";
pub const VAULT_MARKER: &str = ".odea/vault.json";

/// 新笔记 / 空标题的占位，和前端 NEW_NOTE_TITLE 一致
pub const UNTITLED: &str = "无标题笔记";

/// 归档开关在仓库标记 plugins 里的键。P14.1 归档还在核心里，开关照插件的规矩记（docs/插件与跨端.md §6.3）
pub const ARCHIVE_SWITCH: &str = "odea.archive";

/// 一个 .md 文件按它的位置是哪种文档
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Slot {
    Note { archived: bool },
    /// 插件声明的一种（DocType）：类型 id 和 key
    Typed { kind: &'static str, key: String },
}

/* ---------------- 这个仓库怎么摆（.odea/vault.json） ----------------
   {
     "kind": "logical",
     "plugins": { "odea.journal": { "enabled": true }, "odea.archive": { "enabled": true } },
     "features": { "journal": true, "archive": true },
     "folders": { "notes": "笔记", "days": "日记", "goals": "目标", "archive": "归档" }
   }
   - plugins（P14.1 起）记开着哪些插件。features 是老版本（0.7.0 及以前）认的那一份：新版本两边一起写
     （marker_with_switch），读的时候以 plugins 为准。有老开关的那几个两边对不上，说明是老版本后来改了
     features（团队里有人还没升级），听 features 的
   - 两样都没有的（P11.2 以前写的标记、老用户的仓库）：照 Odea 的摆法，日程、归档开着、文件树的根是「笔记」
   - features 里没写 archive 的（0.4.2 以前写的）：归档跟着那时唯一的开关 features.journal
   - 新建的、空文件夹：上面这一份。打开一个已经有笔记的文件夹：都关着，不往别人的文件夹里建日记、目标
     （boot::prepare）
   - 日程这类插件（roots_tree_at_notes）都关着时文件树的根一律是整个仓库：日记、目标这时候都只是普通文件夹；
     归档关着时「归档」也是
   - 插件自己的文件夹（folders.days、folders.goals）、别的工具的设置（Obsidian 的日记）由插件读（plugins/journal）
   - `kind: "logical"`（或者有 .odea/tree）是逻辑目录（docs/仓库与启动器.md §7）：树是清单里摆的那一棵，
     和文件在哪无关；新建的笔记平放在 notes（新建的逻辑目录是仓库根）。启动器「新建」建的就是它 */

/// 一个仓库的文件摆法。打开仓库时读一次（Vault::bare），开关插件时换一份（Vault::set_plugin）
#[derive(Clone)]
pub struct Layout {
    /// 逻辑目录：文件树按 .odea/tree 摆（vault/tree.rs），不按文件夹
    pub logical: bool,
    /// 开没开归档：「归档」文件夹里的是归档的笔记，不在树上
    pub archiving: bool,
    /// 文件树的根：「笔记」，或者整个仓库（空串）
    pub notes: String,
    pub archive: String,
    /// 粘贴、拖进来的文件放哪（attachment_dir）
    pub attachments: AttachDir,
    /// 开着的插件（内置的那几个里，这个仓库开了哪些）
    pub plugins: Vec<&'static str>,
    /// 开着的插件声明的文档类型：classify 按它们的路径规则认文件
    pub types: Vec<Arc<dyn DocType>>,
}

impl PartialEq for Layout {
    fn eq(&self, other: &Self) -> bool {
        self.logical == other.logical
            && self.attachments == other.attachments
            && self.plugins == other.plugins
            && self.fingerprint() == other.fingerprint()
    }
}

impl Eq for Layout {}

impl std::fmt::Debug for Layout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Layout")
            .field("logical", &self.logical)
            .field("archiving", &self.archiving)
            .field("notes", &self.notes)
            .field("archive", &self.archive)
            .field("attachments", &self.attachments)
            .field("plugins", &self.plugins)
            .field("types", &self.types.iter().map(|ty| ty.fingerprint()).collect::<Vec<_>>())
            .finish()
    }
}

/// 附件放在哪。Odea 自己的仓库是固定的「附件」；Obsidian 的库照它的「新附件的默认位置」
/// （.obsidian/app.json 的 attachmentFolderPath）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachDir {
    /// 仓库里一个固定的文件夹（空串是仓库根，Obsidian 的默认）
    Fixed(String),
    /// 和这篇文档同一个文件夹，或者它底下的子文件夹（Obsidian 的 `./`、`./附件`）
    BesideDoc(String),
}

impl Default for Layout {
    fn default() -> Self {
        Self::odea()
    }
}

impl Layout {
    /// Odea 自己建的仓库：老仓库里算开着的插件（日程）都开着，归档开着，根是「笔记」
    pub fn odea() -> Self {
        let on: Vec<&'static dyn Plugin> =
            plugins::builtin().into_iter().filter(|plugin| plugin.on_in_legacy_vaults()).collect();
        Self {
            logical: false,
            archiving: true,
            notes: NOTES_DIR.into(),
            archive: ARCHIVE_DIR.into(),
            attachments: AttachDir::Fixed(ATTACHMENTS_DIR.into()),
            plugins: on.iter().map(|plugin| plugin.id()).collect(),
            types: on.iter().flat_map(|plugin| plugin.doc_types(None, None)).collect(),
        }
    }

    /// 读仓库标记。没有标记、读不了的照 Odea 的老规矩
    pub fn load(root: &Path) -> Self {
        let marker = read_json(&root.join(APP_DIR).join("vault.json"));
        let mut layout = match &marker {
            Some(marker) => Self::from_marker(marker, Some(root)),
            None => Self::odea(),
        };
        // 附件：标记里写了的照写的，没写的看 Obsidian 的设置，都没有是「附件」
        let own = marker
            .as_ref()
            .and_then(|marker| marker.get("folders"))
            .and_then(|folders| folders.get("attachments"))
            .and_then(Value::as_str)
            .and_then(clean_dir);
        if let Some(dir) = own {
            layout.attachments = AttachDir::Fixed(dir);
        } else if let Some(obsidian) = obsidian_attachments(root) {
            layout.attachments = obsidian;
        }
        // 清单在就是逻辑目录：别的设备转过来、同步过来的标记还没跟上时也认
        layout.logical = marker.as_ref().and_then(|marker| marker.get("kind")).and_then(Value::as_str)
            == Some("logical")
            || root.join(super::tree::TREE_FILE).is_file();
        layout
    }

    /// 按标记摆。root 给插件看别的工具的设置（Obsidian 的日记），None 就不看
    pub fn from_marker(marker: &Value, root: Option<&Path>) -> Self {
        if marker.get("features").is_none() && marker.get("plugins").is_none() {
            return Self::odea();
        }
        let on: Vec<&'static dyn Plugin> =
            plugins::builtin().into_iter().filter(|plugin| plugin_on(marker, *plugin)).collect();
        // 0.4.2 以前只有一个开关（features.journal），没写 archive 的归档跟着它
        let only_switch = marker
            .get("features")
            .and_then(|features| features.get("journal"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Self {
            logical: false,
            archiving: switch_on(marker, ARCHIVE_SWITCH, Some("archive"), only_switch),
            // 日程这类插件都关着时日记、目标、归档都是普通文件夹，整个仓库都在树上
            notes: if on.iter().any(|plugin| plugin.roots_tree_at_notes()) {
                marker_folder(marker, "notes").unwrap_or_default()
            } else {
                String::new()
            },
            archive: marker_folder(marker, "archive")
                .filter(|dir| !dir.is_empty())
                .unwrap_or_else(|| ARCHIVE_DIR.into()),
            attachments: AttachDir::Fixed(ATTACHMENTS_DIR.into()),
            plugins: on.iter().map(|plugin| plugin.id()).collect(),
            types: on.iter().flat_map(|plugin| plugin.doc_types(root, Some(marker))).collect(),
        }
    }

    /// 这个插件开着没有
    pub fn has_plugin(&self, id: &str) -> bool {
        self.plugins.contains(&id)
    }

    /// 开着的插件声明的这一种文档
    pub fn doc_type(&self, kind: &str) -> Option<&Arc<dyn DocType>> {
        self.types.iter().find(|ty| ty.id() == kind)
    }

    /// 给这篇文档（仓库里的相对路径）粘贴、拖进来的文件放在哪个文件夹（仓库里的相对路径，空串是根）
    pub fn attachment_dir(&self, doc_rel: &str) -> String {
        match &self.attachments {
            AttachDir::Fixed(dir) => dir.clone(),
            AttachDir::BesideDoc(sub) if sub.is_empty() => dir_of(doc_rel).to_string(),
            AttachDir::BesideDoc(sub) => join(dir_of(doc_rel), sub),
        }
    }

    /// 这个文件是不是放在这篇文档的附件位置上（协作时只把这里的文件给访客，docs/协同编辑.md §7.2）。
    /// 附件和笔记放在一起（Obsidian 的 `./`）时，同一个文件夹里的别的笔记不算
    pub fn is_attachment_of(&self, doc_rel: &str, file_rel: &str) -> bool {
        let dir = self.attachment_dir(doc_rel);
        let ext = stem_and_ext(file_rel).1;
        let note = ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown");
        let hidden = file_rel.split('/').any(|part| part.starts_with('.'));
        !note && !hidden && dir_of(file_rel) == dir
    }

    /// 摆法变了，索引里每篇是什么文档就得重新认（Vault::bare 拿它和索引里记的比）
    pub fn fingerprint(&self) -> String {
        let types: Vec<String> = self.types.iter().map(|ty| ty.fingerprint()).collect();
        format!("{}|{}|{}|{}", self.notes, self.archive, self.archiving, types.join(";"))
    }

    /// 文件树上不出现的文件夹：开着的插件放文档的文件夹（日记、目标），归档开着时的归档（从窄栏进）。
    /// 根是「笔记」的仓库里它们本来就在树外面，这里也照样列出来，不碍事
    pub fn hidden_dirs(&self) -> Vec<&str> {
        let mut dirs: Vec<&str> = self.types.iter().map(|ty| ty.dir()).collect();
        if self.archiving {
            dirs.push(self.archive.as_str());
        }
        let mut seen = Vec::new();
        for dir in dirs {
            if !dir.is_empty() && !seen.contains(&dir) {
                seen.push(dir);
            }
        }
        seen
    }

    pub fn classify(&self, rel: &str) -> Slot {
        if self.archiving && within(dir_of(rel), &self.archive) {
            return Slot::Note { archived: true };
        }
        for ty in &self.types {
            if let Some(key) = ty.key_of(rel) {
                return Slot::Typed { kind: ty.id(), key };
            }
        }
        Slot::Note { archived: false }
    }

    /// 文件树上的文件夹（相对树根的路径，`工作/周报`；空串是树根）→ 仓库里的目录。
    /// 路径是前端传来的，逐段检查：不能是空的、`.`、`..`，不能以点开头（会被当成隐藏目录跳过）。
    pub fn folder_dir(&self, folder: &str) -> Result<String> {
        if folder.is_empty() {
            return Ok(self.notes.clone());
        }
        let ok = folder.split('/').all(|part| {
            !part.is_empty() && !part.starts_with('.') && !part.contains('\\') && part.trim() == part
        });
        if !ok {
            return Err(AppError::Invalid(format!("文件夹路径不对: {folder}")));
        }
        Ok(join(&self.notes, folder))
    }

    /// 反过来：仓库里的目录 → 树上的文件夹。不在树根底下、或者在插件、归档那几个文件夹里的返回 None
    pub fn folder_of_dir<'a>(&self, dir: &'a str) -> Option<&'a str> {
        if self.hidden_dirs().iter().any(|hidden| within(dir, hidden)) {
            return None;
        }
        if self.notes.is_empty() {
            return Some(dir);
        }
        if dir == self.notes {
            return Some("");
        }
        dir.strip_prefix(self.notes.as_str())?.strip_prefix('/')
    }

    /// 归档关着时不往「归档」里挪（打开的是别人的文件夹，那里的「归档」可能只是个普通文件夹）
    pub fn require_archive(&self) -> Result<()> {
        if self.archiving {
            Ok(())
        } else {
            Err(AppError::Invalid("这个仓库没开归档（命令面板「启用归档」）".into()))
        }
    }

    /// 这个开关（插件 id，或者 ARCHIVE_SWITCH）现在开着没有
    fn switch(&self, id: &str) -> bool {
        if id == ARCHIVE_SWITCH {
            self.archiving
        } else {
            self.has_plugin(id)
        }
    }
}

/// 一个开关开着没有（docs/插件与跨端.md §6.3）。plugins 里写的为准；有老开关（legacy：features 里的键）的，
/// 两边不一致说明是老版本后来改过 features —— 新版本总是两边一起写 —— 这时听 features 的。都没写的是 unset
fn switch_on(marker: &Value, id: &str, legacy: Option<&str>, unset: bool) -> bool {
    let own = marker
        .get("plugins")
        .and_then(|plugins| plugins.get(id))
        .and_then(|entry| entry.get("enabled"))
        .and_then(Value::as_bool);
    let old = legacy.and_then(|key| marker.get("features")?.get(key)?.as_bool());
    match (own, old) {
        (Some(own), Some(old)) if own != old => old,
        (Some(own), _) => own,
        (None, Some(old)) => old,
        (None, None) => unset,
    }
}

fn plugin_on(marker: &Value, plugin: &dyn Plugin) -> bool {
    switch_on(marker, plugin.id(), plugin.legacy_feature(), false)
}

/// 标记里写的一个文件夹（folders 里的键），按 clean_dir 的规矩清理过；没写、写得不对的是 None
pub fn marker_folder(marker: &Value, key: &str) -> Option<String> {
    marker
        .get("folders")
        .and_then(|folders| folders.get(key))
        .and_then(Value::as_str)
        .and_then(clean_dir)
}

/// dir 是 base 本身或者在它底下
pub fn within(dir: &str, base: &str) -> bool {
    dir == base || dir.strip_prefix(base).is_some_and(|rest| rest.starts_with('/'))
}

/// 配置里写的文件夹：正斜杠、去掉两头的斜杠；有 `..`、以点开头的段不收
pub fn clean_dir(raw: &str) -> Option<String> {
    let dir = raw.replace('\\', "/");
    let dir = dir.trim().trim_matches('/');
    let ok = dir.is_empty()
        || dir.split('/').all(|part| !part.is_empty() && !part.starts_with('.') && part.trim() == part);
    ok.then(|| dir.to_string())
}

pub fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Obsidian 的「新附件的默认位置」（.obsidian/app.json 的 attachmentFolderPath）：
/// `/` 仓库根（不写就是它），`./` 和笔记同一个文件夹，`./子文件夹` 笔记旁边的子文件夹，别的是仓库里那个文件夹。
/// 不是 Obsidian 的库返回 None
fn obsidian_attachments(root: &Path) -> Option<AttachDir> {
    let config = root.join(".obsidian");
    if !config.is_dir() {
        return None;
    }
    let settings = read_json(&config.join("app.json")).unwrap_or(Value::Null);
    let raw = settings.get("attachmentFolderPath").and_then(Value::as_str).unwrap_or("/").trim();
    let raw = raw.replace('\\', "/");
    if raw == "." || raw == "./" {
        return Some(AttachDir::BesideDoc(String::new()));
    }
    if let Some(sub) = raw.strip_prefix("./") {
        return clean_dir(sub).map(AttachDir::BesideDoc);
    }
    clean_dir(&raw).map(AttachDir::Fixed)
}

/// 标记里有哪几个开关：内置的插件，和归档。(plugins 里的键, features 里的老键)
fn switches() -> Vec<(&'static str, Option<&'static str>)> {
    let mut all: Vec<(&'static str, Option<&'static str>)> = plugins::builtin()
        .iter()
        .map(|plugin| (plugin.id(), plugin.legacy_feature()))
        .collect();
    all.push((ARCHIVE_SWITCH, Some("archive")));
    all
}

/// 写一个开关：plugins 里 enabled（这一项里别的键原样留着），有老开关的 features 里也写
fn write_switch(marker: &mut Value, id: &str, legacy: Option<&str>, on: bool) {
    let object = marker.as_object_mut().expect("标记总是对象");
    let plugins = object.entry("plugins").or_insert_with(|| serde_json::json!({}));
    if !plugins.is_object() {
        *plugins = serde_json::json!({});
    }
    let entry = plugins
        .as_object_mut()
        .expect("上面保证了是对象")
        .entry(id)
        .or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }
    entry["enabled"] = Value::Bool(on);
    if let Some(key) = legacy {
        let features = object.entry("features").or_insert_with(|| serde_json::json!({}));
        if !features.is_object() {
            *features = serde_json::json!({});
        }
        features[key] = Value::Bool(on);
    }
}

/// 新仓库的标记（boot::prepare）。`fresh` = 空文件夹（新建的、换到的空文件夹）：Odea 的摆法，日程、归档开着；
/// 已经有笔记的文件夹都关着，树就是它本来的样子。`logical`（启动器「新建」）：逻辑目录，
/// 笔记平放在仓库根上
pub fn new_marker(fresh: bool, logical: bool, created_at: i64) -> Value {
    let mut marker = serde_json::json!({ "app": "Odea", "version": 1, "createdAt": created_at });
    if logical {
        marker["kind"] = "logical".into();
    }
    for (id, legacy) in switches() {
        write_switch(&mut marker, id, legacy, fresh);
    }
    if fresh {
        let mut folders = serde_json::json!({ "notes": if logical { "" } else { NOTES_DIR }, "archive": ARCHIVE_DIR });
        for plugin in plugins::builtin() {
            for (key, dir) in plugin.new_folders() {
                folders[*key] = (*dir).into();
            }
        }
        marker["folders"] = folders;
    }
    marker
}

/// 每个开关现在的样子都写实（plugins、features 两边一致），别的键（包括不认识的）原样留着。
/// 老标记（两样都没有）是 Odea 的摆法：补上 folders.notes，关了日程再开，树根还是「笔记」
fn marker_written(marker: Option<Value>) -> Value {
    let mut marker = match marker {
        Some(Value::Object(map)) => Value::Object(map),
        _ => serde_json::json!({ "app": "Odea", "version": 1 }),
    };
    let current = Layout::from_marker(&marker, None);
    if marker.get("features").is_none() && marker.get("plugins").is_none() {
        let folders = marker
            .as_object_mut()
            .expect("上面保证了是对象")
            .entry("folders")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(folders) = folders.as_object_mut() {
            folders.entry("notes").or_insert_with(|| NOTES_DIR.into());
        }
    }
    for (id, legacy) in switches() {
        write_switch(&mut marker, id, legacy, current.switch(id));
    }
    marker
}

/// 开 / 关一个插件或者归档（id 是插件的 id，或者 ARCHIVE_SWITCH）：plugins 和老版本认的 features
/// 两边一起写，别的开关照现在的样子写实（老标记里归档跟着日程，只改其中一个时另一个不能跟着变）
pub fn marker_with_switch(marker: Option<Value>, id: &str, on: bool) -> Value {
    let mut marker = marker_written(marker);
    let legacy = switches().into_iter().find(|(switch, _)| *switch == id).and_then(|(_, legacy)| legacy);
    write_switch(&mut marker, id, legacy, on);
    marker
}

/// 本地目录转成逻辑目录：只加 `kind`，开关照现在的样子写实，别的键原样留着
pub fn marker_logical(marker: Option<Value>) -> Value {
    let mut marker = marker_written(marker);
    marker["kind"] = "logical".into();
    marker
}

/// Odea 的老规矩下一个文件是什么（旧库搬家、测试用）
#[cfg(test)]
pub fn classify(rel: &str) -> Slot {
    Layout::odea().classify(rel)
}

/// 文件名去掉目录和 .md
pub fn stem_of(rel: &str) -> &str {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.len().checked_sub(3) {
        Some(cut) if name.is_char_boundary(cut) && name[cut..].eq_ignore_ascii_case(".md") => {
            &name[..cut]
        }
        _ => name,
    }
}

/// 文件名（不含目录）拆成主名和扩展名（没有扩展名时是空串）
pub fn stem_and_ext(rel: &str) -> (&str, &str) {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, ext),
        _ => (name, ""),
    }
}

/// 相对路径的目录部分（没有目录时是空串）
pub fn dir_of(rel: &str) -> &str {
    rel.rsplit_once('/').map_or("", |(dir, _)| dir)
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// 用户起的文件夹名 → 磁盘上的目录名：和笔记文件名同一套规矩（非法字符换成相近的全角字符）。
/// 空的返回 None
pub fn folder_name(raw: &str) -> Option<String> {
    // file_stem_for_title 会把空名字换成「无标题笔记」；文件夹名空着就是没起名
    let blank = raw
        .trim()
        .trim_start_matches('.')
        .trim_end_matches(['.', ' '])
        .trim()
        .is_empty();
    // 开头的点去掉之后可能露出空格：目录名两头不留空白（folder_dir 不收）
    (!blank).then(|| file_stem_for_title(raw).trim().to_string())
}

/// 文件名最多这么多个字符。中文一个字 3 字节，80 个字 240 字节，
/// 在 macOS / Linux 255 字节的文件名上限以内；Windows 的整条路径也不容易超 260。
const MAX_STEM_CHARS: usize = 80;

/// 标题 → 文件名（不含 .md）。
///
/// 文件系统不允许的字符换成外观相近的全角字符（`:` → `：`），标题本身的样子
/// 还在；截断、去掉结尾的点和空格（Windows 会悄悄吃掉它们）、避开设备名。
/// 文件名和标题不一样时，完整标题记在属性块的 title 里。
pub fn file_stem_for_title(title: &str) -> String {
    let mut stem: String = title
        .trim()
        .chars()
        .map(|c| match c {
            '/' => '／',
            '\\' => '＼',
            ':' => '：',
            '*' => '＊',
            '?' => '？',
            '"' => '＂',
            '<' => '＜',
            '>' => '＞',
            '|' => '｜',
            c if c.is_control() => ' ',
            c => c,
        })
        .take(MAX_STEM_CHARS)
        .collect();
    // 开头的点会让文件变成「隐藏文件」，扫描时被跳过
    stem = stem.trim_start_matches('.').to_string();
    stem = stem.trim_end_matches(['.', ' ']).to_string();
    if stem.is_empty() {
        return UNTITLED.to_string();
    }
    let base = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((base.starts_with("COM") || base.starts_with("LPT"))
            && base.len() == 4
            && base.as_bytes()[3].is_ascii_digit());
    if reserved {
        stem.push('_');
    }
    stem
}

/* ---------------- 网盘的冲突副本 ----------------
   两台机器都改了同一篇、同步时撞上，网盘不覆盖，而是把其中一版另存一份：
     Dropbox     「周报 (张三's conflicted copy 2026-10-06).md」「周报 (张三的冲突副本 …).md」
     Syncthing   「周报.sync-conflict-20261006-153012-ABCDEFG.md」
     OneDrive    「周报-DESKTOP-ABC1234.md」（机器名）
     Google Drive / 百度网盘「周报 (1).md」「周报(1).md」
     本应用自己  「周报 (冲突 2026-10-06 1530).md」
   iCloud 的「周报 2.md」和本应用给重名笔记起的名字一样，只能靠属性块里重复的 id 认。
   这里只看名字给出「原文可能叫什么」，原文在不在同一个文件夹里由调用方核对 ——
   光看名字，「方案 (1)」也可能就是一篇正经起名的笔记。 */

/// 这个文件名若是冲突副本，原文件可能叫什么（不含 .md），按可信程度排。
pub fn conflict_originals(stem: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |base: &str| {
        let base = base.trim_end();
        if !base.is_empty() && base != stem && !out.iter().any(|known: &String| known == base) {
            out.push(base.to_string());
        }
    };
    // 本应用起冲突副本时撞名会再加「 2」：先去掉这个序号再看
    let trimmed = strip_counter(stem);
    for name in [stem, trimmed] {
        if let Some(index) = name.find(".sync-conflict-") {
            push(&name[..index]);
        }
        if let Some((base, inner)) = trailing_group(name) {
            let lower = inner.to_lowercase();
            if inner.contains("冲突") || lower.contains("conflict") {
                push(base);
            } else if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit()) {
                push(base);
            }
        }
        let lower = name.to_lowercase();
        for marker in ["_冲突", "-冲突", " 冲突", "_conflict", "-conflict", " conflict"] {
            if let Some(index) = lower.rfind(marker) {
                // 中文标记的字节位置在小写前后一样（只有 ASCII 会变）
                if name.is_char_boundary(index) {
                    push(&name[..index]);
                }
            }
        }
        // OneDrive：结尾是「-机器名」，机器名本身可能也带连字符，每个切点都试
        for (index, _) in name.match_indices('-').collect::<Vec<_>>().into_iter().rev() {
            let suffix = &name[index + 1..];
            let machine = (3..=24).contains(&suffix.len())
                && suffix
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-')
                && suffix.chars().any(|c| c.is_ascii_uppercase());
            if machine {
                push(&name[..index]);
            }
        }
    }
    out
}

/// 「周报 (冲突 …) 2」→「周报 (冲突 …)」；没有序号原样返回
fn strip_counter(stem: &str) -> &str {
    match stem.rsplit_once(' ') {
        Some((base, n)) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => base,
        _ => stem,
    }
}

/// 结尾的「(…)」或「（…）」：返回 (前面的部分, 括号里的内容)
fn trailing_group(name: &str) -> Option<(&str, &str)> {
    for (open, close) in [('(', ')'), ('（', '）')] {
        if let Some(body) = name.strip_suffix(close) {
            if let Some(index) = body.rfind(open) {
                return Some((&name[..index], &body[index + open.len_utf8()..]));
            }
        }
    }
    None
}

/// 从一篇文档引用仓库里一个文件的相对路径：`笔记/周报.md` 引用 `附件/图.png` 写成 `../附件/图.png`，
/// 同一个文件夹里的直接写名字。和别的编辑器（Typora、Obsidian、VS Code）的解析方式一样，
/// 相对文档自己所在的文件夹
pub fn relative_link(doc_rel: &str, file_rel: &str) -> String {
    let from: Vec<&str> = dir_of(doc_rel).split('/').filter(|part| !part.is_empty()).collect();
    let to: Vec<&str> = file_rel.split('/').filter(|part| !part.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    // 文件名本身不算共同前缀
    let common = common.min(to.len().saturating_sub(1));
    let mut out = "../".repeat(from.len() - common);
    out.push_str(&to[common..].join("/"));
    out
}

/// 附件文件夹里一个文件从这篇文档怎么引用（Odea 的老规矩：仓库根上的「附件」）
#[cfg(test)]
pub fn attachment_link(doc_rel: &str, file_name: &str) -> String {
    relative_link(doc_rel, &join(ATTACHMENTS_DIR, file_name))
}

/// 附件的文件名（不含扩展名）：去掉文件系统和 Markdown 链接里有特殊含义的字符，
/// 空白换成连字符（`![](a b.png)` 里的空格会把链接截断）。
pub fn attachment_stem(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.trim().chars() {
        let bad = c.is_whitespace()
            || c.is_control()
            || matches!(
                c,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '%' | '[' | ']' | '(' | ')'
                    | '{' | '}' | '^' | '`' | '!'
            );
        let c = if bad { '-' } else { c };
        if c == '-' && out.ends_with('-') {
            continue;
        }
        out.push(c);
        if out.chars().count() >= 60 {
            break;
        }
    }
    out.trim_matches(['-', '.', ' ']).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::journal;
    use serde_json::json;

    #[test]
    fn recognizes_conflict_copy_names() {
        let first = |stem: &str| conflict_originals(stem).into_iter().next();
        assert_eq!(first("周报 (冲突 2026-10-06 1530)").as_deref(), Some("周报"));
        assert_eq!(first("周报 (冲突 2026-10-06 1530) 2").as_deref(), Some("周报"));
        assert_eq!(first("周报 (张三's conflicted copy 2026-10-06)").as_deref(), Some("周报"));
        assert_eq!(first("周报 (张三的冲突副本 2026-10-06)").as_deref(), Some("周报"));
        assert_eq!(
            first("周报.sync-conflict-20261006-153012-ABCDEFG").as_deref(),
            Some("周报")
        );
        assert_eq!(first("周报 (1)").as_deref(), Some("周报"));
        assert_eq!(first("周报(2)").as_deref(), Some("周报"));
        assert_eq!(first("周报（冲突副本）").as_deref(), Some("周报"));
        assert_eq!(first("周报_冲突_20261006").as_deref(), Some("周报"));
        assert!(conflict_originals("周报-DESKTOP-ABC1234").contains(&"周报".to_string()));
        // 普通的名字不算
        assert!(conflict_originals("周报").is_empty());
        assert!(conflict_originals("第 3 期周报").is_empty());
        assert!(conflict_originals("周报 (草稿)").is_empty());
        assert!(conflict_originals("api-v2").is_empty());
    }

    #[test]
    fn attachment_links_are_relative_to_the_document() {
        assert_eq!(attachment_link("笔记/周报.md", "图.png"), "../附件/图.png");
        assert_eq!(attachment_link("日记/2026/2026-10-06.md", "图.png"), "../../附件/图.png");
        assert_eq!(attachment_link("随手.md", "图.png"), "附件/图.png");
        assert_eq!(attachment_stem("屏幕 截图 (2)"), "屏幕-截图-2");
        assert_eq!(attachment_stem("  a  b  "), "a-b");
        assert_eq!(attachment_stem("周报#1 [草稿]"), "周报-1-草稿");
        assert_eq!(attachment_stem("..."), "");
    }

    #[test]
    fn classifies_by_location() {
        assert_eq!(classify("笔记/秋季项目复盘.md"), Slot::Note { archived: false });
        assert_eq!(classify("笔记/工作/周报.md"), Slot::Note { archived: false });
        assert_eq!(classify("随手记.md"), Slot::Note { archived: false });
        assert_eq!(classify("归档/旧版路线图.md"), Slot::Note { archived: true });
        // 开着的插件声明的文档按插件的路径规则认（plugins/journal 里有完整的规则）；
        // 规则对不上的就是普通笔记，不会消失
        assert_eq!(
            classify("日记/2026/2026-09-26.md"),
            Slot::Typed { kind: journal::DAY, key: "2026-09-26".into() }
        );
        assert_eq!(classify("日记/2026/杂记.md"), Slot::Note { archived: false });
    }

    fn layout_of(marker: Value) -> Layout {
        Layout::from_marker(&marker, None)
    }

    #[test]
    fn markers_decide_the_layout() {
        // P11.2 以前写的标记、新建的仓库：Odea 的摆法
        assert_eq!(layout_of(json!({ "app": "Odea" })), Layout::odea());
        assert_eq!(layout_of(new_marker(true, false, 0)), Layout::odea());
        // 打开一个已经有笔记的文件夹：什么都不开，树根是整个仓库
        let plain = layout_of(new_marker(false, false, 0));
        assert!(plain.plugins.is_empty() && plain.types.is_empty() && !plain.archiving);
        assert_eq!(plain.notes, "");
        assert_eq!(plain.classify("日记/2026/2026-10-20.md"), Slot::Note { archived: false });
        assert_eq!(plain.classify("归档/旧.md"), Slot::Note { archived: false });
        assert!(plain.hidden_dirs().is_empty());
        assert_eq!(plain.folder_dir("").unwrap(), "");
        assert_eq!(plain.folder_dir("工作/周报").unwrap(), "工作/周报");
        assert_eq!(plain.folder_of_dir("工作"), Some("工作"));
        assert_eq!(plain.folder_of_dir(""), Some(""));
        // 配置里乱写的文件夹不收
        let odd = layout_of(json!({
            "features": { "journal": true },
            "folders": { "notes": "../外面", "archive": "" },
        }));
        assert_eq!(odd.notes, "");
        assert_eq!(odd.archive, ARCHIVE_DIR);
    }

    #[test]
    fn archive_has_its_own_switch() {
        // 0.4.2 以前的标记没写 archive：跟着日程
        let old = layout_of(json!({ "features": { "journal": false } }));
        assert!(!old.archiving);
        // 只写笔记、归档旧资料：日程关着，归档开着
        let marker = marker_with_switch(Some(json!({ "features": { "journal": false } })), ARCHIVE_SWITCH, true);
        assert_eq!(marker["features"], json!({ "journal": false, "archive": true }));
        assert_eq!(marker["plugins"][journal::ID]["enabled"], false);
        assert_eq!(marker["plugins"][ARCHIVE_SWITCH]["enabled"], true);
        let notes_only = layout_of(marker);
        assert!(notes_only.plugins.is_empty() && notes_only.archiving);
        assert_eq!(notes_only.classify("归档/旧.md"), Slot::Note { archived: true });
        assert_eq!(notes_only.classify("日记/2026/2026-10-20.md"), Slot::Note { archived: false });
        assert_eq!(notes_only.hidden_dirs(), vec!["归档"]);
        assert_eq!(notes_only.folder_of_dir("归档"), None);
        assert!(notes_only.require_archive().is_ok());
        // 关日程不带走归档：老标记（没写 archive，归档跟着日程开着）关了日程，归档照旧开着
        let off = marker_with_switch(Some(json!({ "features": { "journal": true } })), journal::ID, false);
        assert_eq!(off["features"], json!({ "journal": false, "archive": true }));
        let off = marker_with_switch(Some(json!({ "app": "Odea" })), journal::ID, false);
        assert_eq!(off["features"], json!({ "journal": false, "archive": true }));
        assert!(layout_of(off).archiving);
        // 只开日程、不要归档
        let journal_only = layout_of(json!({ "features": { "journal": true, "archive": false } }));
        assert_eq!(journal_only.classify("归档/旧.md"), Slot::Note { archived: false });
        assert_eq!(journal_only.hidden_dirs(), vec!["日记", "目标"]);
        assert!(journal_only.require_archive().is_err());
    }

    #[test]
    fn plugins_are_read_first_but_old_versions_can_still_switch_them() {
        // 新版本写的：plugins、features 两边一致
        let on = marker_with_switch(Some(new_marker(false, false, 0)), journal::ID, true);
        assert_eq!(on["plugins"][journal::ID]["enabled"], true);
        assert_eq!(on["features"]["journal"], true);
        assert!(layout_of(on.clone()).has_plugin(journal::ID));
        // 团队里有人还在用 0.7.0、关了日程：它只认、只改 features，plugins 原样留着。
        // 两边对不上就是老版本后来改的，听 features 的
        let mut old = on.clone();
        old["features"]["journal"] = false.into();
        assert!(!layout_of(old.clone()).has_plugin(journal::ID));
        // 新版本再写一次（这里改的是归档）：两边又一致了，日程还是关着
        let again = marker_with_switch(Some(old), ARCHIVE_SWITCH, true);
        assert_eq!(again["plugins"][journal::ID]["enabled"], false);
        assert_eq!(again["features"]["journal"], false);
        assert!(layout_of(again).archiving);
        // 只有 plugins（以后的版本不写 features 了）也认；插件那一项里别的键原样留着
        let mut future = json!({ "plugins": {} });
        future["plugins"][journal::ID] = json!({ "enabled": true, "version": "^1.0" });
        assert!(layout_of(future.clone()).has_plugin(journal::ID));
        let off = marker_with_switch(Some(future), journal::ID, false);
        assert_eq!(off["plugins"][journal::ID], json!({ "enabled": false, "version": "^1.0" }));
        assert_eq!(off["features"]["journal"], false, "老版本也看得懂");
    }

    #[test]
    fn plugins_on_a_whole_vault_hide_their_folders_from_the_tree() {
        let tree = layout_of(json!({ "features": { "journal": true } }));
        assert_eq!(tree.notes, "");
        assert_eq!(tree.hidden_dirs(), vec!["日记", "目标", "归档"]);
        assert_eq!(tree.folder_of_dir("工作"), Some("工作"));
        assert_eq!(tree.folder_of_dir("日记/2026"), None);
        assert_eq!(tree.folder_of_dir("日记本"), Some("日记本"));
        assert_eq!(
            tree.classify("日记/2026/2026-10-20.md"),
            Slot::Typed { kind: journal::DAY, key: "2026-10-20".into() }
        );
        assert_eq!(tree.classify("日记本/2026-10-20.md"), Slot::Note { archived: false });
    }

    #[test]
    fn attachments_follow_obsidian_settings() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(Layout::load(root).attachment_dir("笔记/周报.md"), ATTACHMENTS_DIR, "Odea 的仓库");
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        let app = |json: &str| std::fs::write(root.join(".obsidian/app.json"), json).unwrap();
        assert_eq!(Layout::load(root).attachment_dir("工作/周报.md"), "", "Obsidian 什么都没设：仓库根");
        app(r#"{ "attachmentFolderPath": "./" }"#);
        assert_eq!(Layout::load(root).attachment_dir("工作/周报.md"), "工作");
        assert_eq!(Layout::load(root).attachment_dir("周报.md"), "");
        app(r#"{ "attachmentFolderPath": "./assets" }"#);
        assert_eq!(Layout::load(root).attachment_dir("工作/周报.md"), "工作/assets");
        app(r#"{ "attachmentFolderPath": "Files/Images" }"#);
        assert_eq!(Layout::load(root).attachment_dir("工作/周报.md"), "Files/Images");
        app(r#"{ "attachmentFolderPath": "../外面" }"#);
        assert_eq!(Layout::load(root).attachments, AttachDir::Fixed(ATTACHMENTS_DIR.into()), "乱写的不认");
        // 标记里自己写了的不看 Obsidian 的
        std::fs::create_dir_all(root.join(APP_DIR)).unwrap();
        std::fs::write(root.join(VAULT_MARKER), r#"{ "folders": { "attachments": "图" } }"#).unwrap();
        assert_eq!(Layout::load(root).attachment_dir("工作/周报.md"), "图");
    }

    #[test]
    fn attachment_files_of_a_note() {
        let beside = Layout { attachments: AttachDir::BesideDoc(String::new()), ..Layout::odea() };
        assert!(beside.is_attachment_of("工作/周报.md", "工作/图.png"));
        assert!(!beside.is_attachment_of("工作/周报.md", "工作/私密.md"), "旁边的别的笔记不给");
        assert!(!beside.is_attachment_of("工作/周报.md", "工作/子/图.png"));
        assert!(!beside.is_attachment_of("工作/周报.md", "别处/图.png"));
        let odea = Layout::odea();
        assert!(odea.is_attachment_of("笔记/周报.md", "附件/图.png"));
        assert!(!odea.is_attachment_of("笔记/周报.md", "附件/.git/config"));
        assert!(!odea.is_attachment_of("笔记/周报.md", "笔记/图.png"));
    }

    #[test]
    fn relative_links_between_vault_files() {
        assert_eq!(relative_link("笔记/周报.md", "附件/图.png"), "../附件/图.png");
        assert_eq!(relative_link("工作/周报.md", "工作/图.png"), "图.png");
        assert_eq!(relative_link("工作/周报.md", "工作/assets/图.png"), "assets/图.png");
        assert_eq!(relative_link("a/b/周报.md", "a/c/图.png"), "../c/图.png");
        assert_eq!(relative_link("周报.md", "图.png"), "图.png");
        assert_eq!(relative_link("a/周报.md", "图.png"), "../图.png");
        // 文件名和目录名一样时不能当成共同前缀
        assert_eq!(relative_link("图.png/周报.md", "图.png"), "../图.png");
    }

    #[test]
    fn toggling_a_plugin_keeps_the_rest_of_the_marker() {
        let legacy = json!({ "app": "Odea", "version": 1, "别的": 1 });
        let off = marker_with_switch(Some(legacy), journal::ID, false);
        assert_eq!(off["别的"], 1);
        assert_eq!(off["features"]["journal"], false);
        // 老仓库关了日程：整个仓库在树上；再开回来，树根还是「笔记」
        assert_eq!(layout_of(off.clone()).notes, "");
        let on = marker_with_switch(Some(off), journal::ID, true);
        assert_eq!(layout_of(on), Layout::odea());
        // 打开的文件夹开了日程：树根还是整个仓库
        let opened = marker_with_switch(Some(new_marker(false, false, 0)), journal::ID, true);
        let tree = layout_of(opened);
        assert!(tree.has_plugin(journal::ID));
        assert_eq!(tree.notes, "");
    }

    #[test]
    fn logical_vaults_are_marked_or_have_a_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(APP_DIR)).unwrap();
        let write = |marker: &Value| std::fs::write(root.join(VAULT_MARKER), marker.to_string()).unwrap();
        // 启动器新建的：逻辑目录、日程开着、新笔记平放在仓库根上
        write(&new_marker(true, true, 0));
        let fresh = Layout::load(root);
        assert!(fresh.logical && fresh.has_plugin(journal::ID));
        assert_eq!(fresh.notes, "");
        assert_eq!(fresh.hidden_dirs(), vec!["日记", "目标", "归档"]);
        // 转过来的老仓库：照旧是 Odea 的摆法，只多了 kind
        write(&marker_logical(Some(json!({ "app": "Odea" }))));
        let converted = Layout::load(root);
        assert!(converted.logical);
        assert_eq!(Layout { logical: false, ..converted }, Layout::odea());
        // 标记还是本地目录，但清单在（别的设备转过来了、标记还没同步到）
        write(&new_marker(false, false, 0));
        assert!(!Layout::load(root).logical);
        std::fs::write(root.join(super::super::tree::TREE_FILE), "").unwrap();
        assert!(Layout::load(root).logical);
    }

    #[test]
    fn file_names_are_safe_on_every_platform() {
        assert_eq!(file_stem_for_title("周报: 第 3 期?"), "周报： 第 3 期？");
        assert_eq!(file_stem_for_title("a/b\\c"), "a／b＼c");
        assert_eq!(file_stem_for_title("  ...隐藏. "), "隐藏");
        assert_eq!(file_stem_for_title("   "), UNTITLED);
        assert_eq!(file_stem_for_title("con"), "con_");
        assert_eq!(file_stem_for_title("LPT1.txt"), "LPT1.txt_");
        assert_eq!(file_stem_for_title("COMMENT"), "COMMENT");
        let long = "秋".repeat(200);
        assert_eq!(file_stem_for_title(&long).chars().count(), MAX_STEM_CHARS);
    }

    #[test]
    fn stems_and_dirs() {
        assert_eq!(stem_of("笔记/a.b.MD"), "a.b");
        assert_eq!(dir_of("笔记/工作/周报.md"), "笔记/工作");
        assert_eq!(dir_of("周报.md"), "");
        assert_eq!(join("", "a.md"), "a.md");
    }
}
