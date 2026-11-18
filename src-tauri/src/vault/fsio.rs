/* ============================================================
文件读写的几件小事。

- 写入一律「先写同目录的隐藏临时文件，再改名覆盖」：改名是原子的，
  断电或崩溃时文件要么是旧的、要么是新的，不会是写了一半的。
- 临时文件以点开头，扫描和文件监听都会跳过它。
- 内容指纹用 FNV-1a：只用来判断「这个文件是不是我刚写的那一版」，不需要抗碰撞。
============================================================ */

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use crate::error::Result;

/// 相对路径（正斜杠）→ 磁盘路径
pub fn abs(root: &Path, rel: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in rel.split('/').filter(|part| !part.is_empty()) {
        path.push(part);
    }
    path
}

pub fn fingerprint(text: &str) -> String {
    fingerprint_bytes(text.as_bytes())
}

/// 同 fingerprint，算的是原样的字节（不是 UTF-8 的文件：转换前核对还是预览的那一版）
pub fn fingerprint_bytes(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 认出一个不是 UTF-8 的文件原来是什么编码、解成文字：返回（给人看的编码名，文字）。认不出是 None。
///
/// - 开头有 BOM 的 UTF-16（Windows 记事本的「Unicode」）
/// - 没有 BOM 的 UTF-16：文字里不会有 0 字节，有的话多半是 UTF-16 里 ASCII 那一半；0 落在奇数位是小端
/// - 都不是就按 GB 18030 解（GBK 的超集，旧的记事本、国内不少工具默认存它），有解不开的字节就不认
///
/// 认对没认对靠人看：转之前把解出来的样子给用户看一眼（Vault::legacy_text）。UTF-8 被当成 GBK 也解得开，
/// 只是满屏乱码，所以这一步不能省
pub fn decode_legacy(bytes: &[u8]) -> Option<(&'static str, String)> {
    let utf16 = |rest: &[u8], little: bool| -> Option<String> {
        if !rest.len().is_multiple_of(2) {
            return None;
        }
        // 长度是偶数，余下的那一截是空的
        let (pairs, _) = rest.as_chunks::<2>();
        let units: Vec<u16> = pairs
            .iter()
            .map(|&pair| if little { u16::from_le_bytes(pair) } else { u16::from_be_bytes(pair) })
            .collect();
        String::from_utf16(&units).ok()
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest, true).map(|text| ("UTF-16", text));
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(rest, false).map(|text| ("UTF-16", text));
    }
    if bytes.contains(&0) {
        let odd = bytes.iter().skip(1).step_by(2).filter(|byte| **byte == 0).count();
        let even = bytes.iter().step_by(2).filter(|byte| **byte == 0).count();
        return utf16(bytes, odd >= even).map(|text| ("UTF-16", text));
    }
    let (text, had_errors) = encoding_rs::GB18030.decode_without_bom_handling(bytes);
    (!had_errors).then(|| ("GBK", text.into_owned()))
}

/// 按 UTF-8 解出来的一个文件
pub struct Decoded {
    pub text: String,
    /// false：不是 UTF-8（GBK、UTF-16 这些），认不出的字节换成了 U+FFFD。这样的字只能拿来显示、
    /// 建索引，改了写回去原文就没了（docs/REVIEWS/2026-11-10-审查与竞品调研.md §5.1）
    pub utf8: bool,
}

pub fn decode(bytes: Vec<u8>) -> Decoded {
    match String::from_utf8(bytes) {
        Ok(text) => Decoded { text, utf8: true },
        Err(error) => Decoded { text: String::from_utf8_lossy(error.as_bytes()).into_owned(), utf8: false },
    }
}

/// 一个文件名（不是整条路径）最多这么多字节。ext4 这些按 UTF-8 字节算 255；NTFS、APFS 按字符算 255 ——
/// 一个字的 UTF-8 字节数不少于它占的 UTF-16 单元数，按字节卡住，哪个盘上都放得下
const MAX_NAME_BYTES: usize = 255;

/// 在一个已有的名字后面接东西（「 (冲突 2026-11-14 1030)」、序号、扩展名，一共 `tail_bytes` 字节）时，
/// 原名最多留多长：接上以后超了上限就从后面截（按字截，不切开一个字）。80 个汉字的标题在 ext4 上
/// 是 240 字节，再接一截「 (冲突 …)」就超了；别的工具建的文件名更可能本来就很长
pub fn fit_stem(stem: &str, tail_bytes: usize) -> &str {
    let room = MAX_NAME_BYTES.saturating_sub(tail_bytes);
    if stem.len() <= room {
        return stem;
    }
    let mut end = room;
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    &stem[..end]
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn write_atomic(path: &Path, text: &str) -> Result<()> {
    write_atomic_bytes(path, text.as_bytes())
}

/// 同 write_atomic，写的是任意字节（附件）
pub fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let tail = format!(".{}-{}.tmp", std::process::id(), TEMP_COUNTER.fetch_add(1, Ordering::Relaxed));
    // 临时文件的名字比原名多十几个字节：原名已经快到上限的（ext4 上 80 个汉字的标题，别的工具建的长名字）
    // 截短一点，不然连临时文件都建不了，这一篇就怎么也存不进去
    let temp = dir.join(format!(".{}{tail}", fit_stem(&name, 1 + tail.len())));
    let written = (|| {
        use std::io::Write;
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })()
    .and_then(|()| fs::rename(&temp, path));
    // 哪一步没成（盘满了写到一半、目标被占着改不了名）都把临时文件收掉：不然每失败一次，
    // 用户的文件夹里就多一个写了一半的隐藏文件
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(error.into());
    }
    Ok(())
}

/// (修改时间毫秒, 字节数)
pub fn stat(path: &Path) -> Option<(i64, i64)> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    Some((mtime_ms(&meta), meta.len() as i64))
}

pub fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as i64)
}

pub fn set_mtime(path: &Path, ms: i64) -> Result<()> {
    let time = filetime::FileTime::from_unix_time(ms.div_euclid(1000), (ms.rem_euclid(1000) * 1_000_000) as u32);
    filetime::set_file_mtime(path, time)?;
    Ok(())
}

/// 以点开头的文件和目录：应用自己的东西、临时文件、别的工具的配置（.obsidian、.git）
pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

/// 仓库里相对路径的一段是不是一个普通的名字：不空、不以点开头（`.`、`..`、隐藏的）、没有反斜杠，
/// 操作系统也只把它当成一个名字。Windows 上 `D:` 是盘符：`abs` 往下 push 它，前面的整条路径就被换掉了，
/// `笔记/D:/x.md` 落到 D 盘上去。前端、访客、配置文件、文件内容里来的路径，拼进 `abs` 之前每一段都过它
pub fn is_plain_name(part: &str) -> bool {
    use std::path::Component;
    !part.is_empty()
        && !is_hidden_name(part)
        && !part.contains('\\')
        && matches!(Path::new(part).components().collect::<Vec<_>>()[..], [Component::Normal(name)] if name == part)
}

pub fn is_markdown(name: &str) -> bool {
    name.len() > 3 && name.is_char_boundary(name.len() - 3) && name[name.len() - 3..].eq_ignore_ascii_case(".md")
}

pub struct FileEntry {
    pub rel: String,
    pub mtime: i64,
    pub size: i64,
}

/// 仓库里所有的 .md 文件，跳过隐藏的文件和目录。按路径排序，结果稳定。
pub fn walk_markdown(root: &Path) -> Vec<FileEntry> {
    walk(root, |_| false).0
}

/// 走一遍仓库：所有的 .md 文件（同 walk_markdown），外加 `want` 认的别的文件的相对路径
/// （都按路径排序）。扫描时用它顺带收集图片，不用为 `![[图.png]]` 再走一遍
pub fn walk(root: &Path, want: impl Fn(&str) -> bool) -> (Vec<FileEntry>, Vec<String>) {
    let mut out = Vec::new();
    let mut others = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel_dir)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_hidden_name(&name) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let rel = if rel_dir.is_empty() { name.clone() } else { format!("{rel_dir}/{name}") };
            if file_type.is_dir() {
                stack.push((entry.path(), rel));
            } else if file_type.is_file() && is_markdown(&name) {
                if let Ok(meta) = entry.metadata() {
                    out.push(FileEntry { rel, mtime: mtime_ms(&meta), size: meta.len() as i64 });
                }
            } else if file_type.is_file() && want(&name) {
                others.push(rel);
            }
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    others.sort();
    (out, others)
}

/// 仓库里有没有任何 .md 文件
pub fn has_markdown(root: &Path) -> bool {
    !walk_markdown(root).is_empty()
}

/// 在 dir 下给 stem 找一个没被占用的文件名：`周报.md`、`周报 2.md`、`周报 3.md`…
///
/// `keep` 是这篇文档现在的路径：改名时撞上自己不算占用（包括只改大小写 ——
/// Windows / macOS 默认不区分大小写，`exists()` 会说 `A.md` 已经在了，其实就是它自己）。
pub fn unique_rel(root: &Path, dir: &str, stem: &str, keep: Option<&str>) -> String {
    let keep = keep.map(str::to_lowercase);
    for n in 1.. {
        let name = if n == 1 { format!("{stem}.md") } else { format!("{stem} {n}.md") };
        let rel = super::layout::join(dir, &name);
        if keep.as_deref() == Some(rel.to_lowercase().as_str()) || !abs(root, &rel).exists() {
            return rel;
        }
    }
    unreachable!()
}

/// 把 from 挪到 to（同一个仓库里）。目标目录不存在就建。
pub fn move_file(root: &Path, from: &str, to: &str) -> Result<()> {
    let target = abs(root, to);
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::rename(abs(root, from), target)?;
    Ok(())
}

/// 删掉空了的目录（往上一直删到仓库根下的第一层为止）。挪走最后一篇后
/// `日记/2026/` 这种空壳留着没意义；顶层的「笔记」「日记」本身保留。
pub fn prune_empty_dirs(root: &Path, rel_dir: &str) {
    let mut dir = rel_dir.to_string();
    while dir.contains('/') {
        if fs::remove_dir(abs(root, &dir)).is_err() {
            return;
        }
        dir = super::layout::dir_of(&dir).to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_match_the_frontend() {
        // 前端 src/lib/fingerprint.ts 算同一个（保存时带的 base），两边的测试用同一组值
        assert_eq!(fingerprint(""), "cbf29ce484222325");
        assert_eq!(fingerprint("a"), "af63dc4c8601ec8c");
        assert_eq!(fingerprint("周报：第 3 期\n\n- [ ] 交稿 😀"), "0b6430e23ccb5e54");
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("笔记").join("a.md");
        write_atomic(&path, "一").unwrap();
        write_atomic(&path, "二").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "二");
        let names: Vec<_> =
            fs::read_dir(path.parent().unwrap()).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1);
    }

    #[test]
    fn a_write_that_fails_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        // 目标的位置上是个文件夹：临时文件写好了，改名改不过去
        let path = dir.path().join("占着");
        fs::create_dir_all(path.join("里面")).unwrap();
        assert!(write_atomic(&path, "x").is_err());
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("占着")]);
    }

    /// 名字快到上限的文件（ext4 上 80 个汉字的标题是 243 字节）：临时文件的名字也得放得下
    #[test]
    fn a_name_close_to_the_limit_can_still_be_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!("{}.md", "a".repeat(250)));
        write_atomic(&path, "x").unwrap();
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(names, vec![path.file_name().unwrap().to_owned()]);
    }

    #[test]
    fn a_stem_is_cut_by_whole_characters_to_leave_room_for_what_follows() {
        assert_eq!(fit_stem("周报", 30), "周报");
        let long = "长".repeat(85);
        let cut = fit_stem(&long, 30);
        assert_eq!(cut, "长".repeat(75), "225 字节里放得下 75 个字");
        assert_eq!(fit_stem(&long, 400), "");
    }

    #[test]
    fn plain_names_are_single_ordinary_path_parts() {
        for name in ["周报", "a b", "工作:流", "v1.2"] {
            assert!(is_plain_name(name), "{name}");
        }
        for name in ["", ".", "..", ".odea", "a\\b"] {
            assert!(!is_plain_name(name), "{name}");
        }
        #[cfg(windows)]
        for name in ["D:", "c:", "Z:x"] {
            assert!(!is_plain_name(name), "{name}");
        }
    }

    #[test]
    fn walk_skips_hidden_and_non_markdown() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for rel in [
            "笔记/a.md",
            "笔记/子目录/b.MD",
            "随手.md",
            ".odea/trash/x.md",
            ".obsidian/workspace.md",
            "笔记/.草稿.md",
            "附件/图.png",
        ] {
            write_atomic(&abs(root, rel), "x").unwrap();
        }
        let rels: Vec<_> = walk_markdown(root).into_iter().map(|entry| entry.rel).collect();
        // 按 UTF-8 字节序：「笔」(E7…) 在「随」(E9…) 前面
        assert_eq!(rels, vec!["笔记/a.md", "笔记/子目录/b.MD", "随手.md"]);
    }

    #[test]
    fn unique_names_count_up_but_ignore_the_file_itself() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_atomic(&abs(root, "笔记/周报.md"), "x").unwrap();
        write_atomic(&abs(root, "笔记/周报 2.md"), "x").unwrap();
        assert_eq!(unique_rel(root, "笔记", "周报", None), "笔记/周报 3.md");
        assert_eq!(unique_rel(root, "笔记", "周报", Some("笔记/周报.md")), "笔记/周报.md");
        assert_eq!(unique_rel(root, "笔记", "新的", None), "笔记/新的.md");
    }

    #[test]
    fn mtime_can_be_set_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        write_atomic(&path, "x").unwrap();
        set_mtime(&path, 1_788_000_000_123).unwrap();
        assert_eq!(stat(&path).unwrap().0, 1_788_000_000_123);
    }
}
