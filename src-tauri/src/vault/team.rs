/* ============================================================
团队仓库（docs/协同编辑.md §22.3）：仓库标记里的 `team: { id }`，和设备名单 `.odea/devices`。
两样都在仓库里、随 git 走 —— 成员打开时认得出这是团队仓库，知道名单里有谁。

名单一行一台设备，tab 隔开：设备公钥（十六进制）、账号（`github:login`）、更新时间（毫秒）、设备名
（最后一列，里面可以有空格）。每台设备只改自己那一行；`.gitattributes` 里给它 merge=union
（sync/repo.rs），两台设备同时改相邻的行时两边都留下 —— 同一把公钥出现两行时认更新时间新的那行，
下次改自己那一行时顺手去掉旧的
============================================================ */

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use super::{fsio, layout};
use crate::error::Result;

pub const DEVICES_FILE: &str = ".odea/devices";
/// 团队的中继（docs/协同编辑.md §22.4）：一行一个中继码，随 git 走。成员打开时问一句用不用
pub const RELAYS_FILE: &str = ".odea/relays";

const RELAYS_HEADER: &str = "\
# Odea 团队仓库的中继（docs/协同编辑.md §22.4）：一行一个中继码。成员打开这个仓库时会问一句用不用
";

const HEADER: &str = "\
# Odea 团队仓库的设备名单（docs/协同编辑.md §22.3）
# 一行一台设备，tab 隔开：设备公钥、账号、更新时间、设备名。每台设备只改自己那一行
";

/// 名单里的一台设备
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    /// 设备公钥（64 位十六进制，小写）
    pub key: String,
    /// `托管方:账号`，比如 `github:Gred666`
    pub account: String,
    /// 这一行最后一次改的时间（毫秒）
    pub updated: i64,
    pub name: String,
}

/// 这个仓库是团队仓库的话，团队 id（32 位十六进制）
pub fn team_id(root: &Path) -> Option<String> {
    let marker = read_marker(root)?;
    let id = marker.get("team")?.get("id")?.as_str()?;
    (!id.is_empty()).then(|| id.to_string())
}

/// 标成团队仓库（已经是了就原样），返回团队 id。标记里别的键都留着
pub fn mark_team(root: &Path) -> Result<String> {
    if let Some(id) = team_id(root) {
        return Ok(id);
    }
    let mut marker = read_marker(root)
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    let id = uuid::Uuid::now_v7().simple().to_string();
    marker["team"] = serde_json::json!({ "id": id });
    let path = fsio::abs(root, layout::VAULT_MARKER);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    fsio::write_atomic(&path, &serde_json::to_string_pretty(&marker)?)?;
    Ok(id)
}

fn read_marker(root: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(fsio::abs(root, layout::VAULT_MARKER)).ok()?).ok()
}

/// 账号：`github:Gred666` → (`github`, `Gred666`)
pub fn split_account(account: &str) -> Option<(&str, &str)> {
    let (provider, login) = account.split_once(':')?;
    (!provider.is_empty() && !login.is_empty()).then_some((provider, login))
}

fn valid_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 名字里不能有 tab、换行（会把一行拆坏），最长 60 个字
fn clean(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .chars()
        .take(60)
        .collect()
}

fn parse_line(line: &str) -> Option<Device> {
    let line = line.trim_end_matches('\r');
    if line.trim().is_empty() || line.starts_with('#') {
        return None;
    }
    let mut parts = line.splitn(4, '\t');
    let key = parts.next()?.trim().to_ascii_lowercase();
    let account = parts.next()?.trim().to_string();
    let updated = parts.next()?.trim().parse().ok()?;
    let name = clean(parts.next().unwrap_or_default());
    (valid_key(&key) && split_account(&account).is_some()).then_some(Device { key, account, updated, name })
}

/// 读名单：坏行跳过；同一把公钥出现好几行（union 合并留下的）认更新时间新的那行。按公钥排
pub fn parse(text: &str) -> Vec<Device> {
    let mut latest: BTreeMap<String, Device> = BTreeMap::new();
    for device in text.lines().filter_map(parse_line) {
        match latest.get(&device.key) {
            Some(known) if known.updated >= device.updated => {}
            _ => {
                latest.insert(device.key.clone(), device);
            }
        }
    }
    latest.into_values().collect()
}

pub fn render(devices: &[Device]) -> String {
    let mut sorted: Vec<&Device> = devices.iter().collect();
    sorted.sort_by(|a, b| a.key.cmp(&b.key));
    let mut out = String::from(HEADER);
    for device in sorted {
        out.push_str(&format!(
            "{}\t{}\t{}\t{}\n",
            device.key,
            device.account,
            device.updated,
            clean(&device.name)
        ));
    }
    out
}

pub fn read(root: &Path) -> Vec<Device> {
    std::fs::read_to_string(fsio::abs(root, DEVICES_FILE))
        .map(|text| parse(&text))
        .unwrap_or_default()
}

/// 写上 / 改好自己那一行（`own.updated` 是现在）。账号、名字都没变、也没有重复的就不写；返回写没写
pub fn put_own(root: &Path, own: &Device) -> Result<bool> {
    let path = fsio::abs(root, DEVICES_FILE);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mine: Vec<Device> = text
        .lines()
        .filter_map(parse_line)
        .filter(|device| device.key == own.key)
        .collect();
    let name = clean(&own.name);
    if let [only] = mine.as_slice() {
        if only.account == own.account && only.name == name {
            return Ok(false);
        }
    }
    let mut devices: Vec<Device> = parse(&text).into_iter().filter(|device| device.key != own.key).collect();
    devices.push(Device { name, ..own.clone() });
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    fsio::write_atomic(&path, &render(&devices))?;
    Ok(true)
}

/// 把一个账号的设备都去掉（移出成员）。返回去掉了几台
pub fn remove_account(root: &Path, account: &str) -> Result<usize> {
    let devices = read(root);
    let kept: Vec<Device> = devices.iter().filter(|device| device.account != account).cloned().collect();
    let removed = devices.len() - kept.len();
    if removed > 0 {
        fsio::write_atomic(&fsio::abs(root, DEVICES_FILE), &render(&kept))?;
    }
    Ok(removed)
}

/// 仓库里写的中继码（坏行、注释跳过，重复的只留一行）
pub fn read_relays(root: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(fsio::abs(root, RELAYS_FILE)).unwrap_or_default();
    let mut codes: Vec<String> = Vec::new();
    for line in text.lines().map(str::trim) {
        if !line.is_empty() && !line.starts_with('#') && !codes.iter().any(|code| code == line) {
            codes.push(line.to_string());
        }
    }
    codes
}

/// 换成这几行（没变不写）。返回写了没有
pub fn write_relays(root: &Path, codes: &[String]) -> Result<bool> {
    if read_relays(root) == codes {
        return Ok(false);
    }
    let path = fsio::abs(root, RELAYS_FILE);
    if codes.is_empty() {
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        return Ok(true);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = String::from(RELAYS_HEADER);
    for code in codes {
        out.push_str(code);
        out.push('\n');
    }
    fsio::write_atomic(&path, &out)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(c: char) -> String {
        c.to_string().repeat(64)
    }

    fn device(c: char, account: &str, updated: i64, name: &str) -> Device {
        Device { key: key(c), account: account.into(), updated, name: name.into() }
    }

    #[test]
    fn the_list_reads_back_what_it_wrote_and_skips_bad_lines() {
        let devices = vec![device('b', "github:xiaowang", 20, "小王的 笔记本"), device('a', "github:Gred666", 10, "书房的电脑")];
        let text = render(&devices);
        assert!(text.starts_with("# Odea"));
        // 按公钥排
        assert_eq!(parse(&text), vec![devices[1].clone(), devices[0].clone()]);

        let messy = format!(
            "{text}这一行不对\n{}\tgithub:x\n{}\t没有冒号\t1\t名字\nzz\tgithub:x\t1\t短公钥\n",
            key('c'),
            key('d')
        );
        assert_eq!(parse(&messy).len(), 2);
    }

    #[test]
    fn a_device_listed_twice_after_a_union_merge_counts_once_with_its_newest_line() {
        // 两边：一边是 a 改了名字，另一边加了 b；union 合并把 a 的新旧两行都留下了
        let merged = format!(
            "{}\tgithub:Gred666\t10\t旧名字\n{}\tgithub:Gred666\t30\t新名字\n{}\tgithub:xiaowang\t20\t小王\n",
            key('a'),
            key('a'),
            key('b')
        );
        let devices = parse(&merged);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].name, "新名字");
    }

    #[test]
    fn a_device_only_rewrites_its_own_line_and_only_when_it_changed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mine = device('a', "github:Gred666", 100, "书房的电脑");
        assert!(put_own(root, &mine).unwrap());
        assert!(!put_own(root, &Device { updated: 200, ..mine.clone() }).unwrap(), "没变就不写");

        // 别人那一行（git 拉来的）
        let path = root.join(DEVICES_FILE);
        let text = std::fs::read_to_string(&path).unwrap() + &format!("{}\tgithub:xiaowang\t50\t小王\n", key('b'));
        std::fs::write(&path, text).unwrap();

        assert!(put_own(root, &Device { updated: 300, name: "客厅的电脑".into(), ..mine.clone() }).unwrap());
        let devices = read(root);
        assert_eq!(devices.len(), 2);
        assert_eq!((devices[0].name.as_str(), devices[0].updated), ("客厅的电脑", 300));
        assert_eq!((devices[1].name.as_str(), devices[1].updated), ("小王", 50), "别人那一行原样");

        assert_eq!(remove_account(root, "github:xiaowang").unwrap(), 1);
        assert_eq!(read(root).len(), 1);
    }

    #[test]
    fn marking_a_team_vault_keeps_the_rest_of_the_marker_and_happens_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(team_id(root), None);
        std::fs::create_dir_all(root.join(".odea")).unwrap();
        std::fs::write(root.join(layout::VAULT_MARKER), r#"{ "kind": "logical", "features": { "journal": true } }"#).unwrap();
        let id = mark_team(root).unwrap();
        assert_eq!(id.len(), 32);
        assert_eq!(mark_team(root).unwrap(), id);
        assert_eq!(team_id(root).as_deref(), Some(id.as_str()));
        let marker: Value = serde_json::from_str(&std::fs::read_to_string(root.join(layout::VAULT_MARKER)).unwrap()).unwrap();
        assert_eq!(marker["kind"], "logical");
        assert_eq!(marker["features"]["journal"], true);
        // 日程、摆法照旧
        assert!(layout::Layout::load(root).journal);
        assert_eq!(split_account("github:Gred666"), Some(("github", "Gred666")));
        assert_eq!(split_account("Gred666"), None);
    }

    #[test]
    fn team_relays_are_one_code_per_line_and_an_empty_list_removes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(read_relays(root).is_empty());
        let codes = vec!["odea:relay/aaa".to_string(), "odea:relay/bbb".to_string()];
        assert!(write_relays(root, &codes).unwrap());
        assert!(!write_relays(root, &codes).unwrap(), "没变不写");
        // union 合并以后重复的行只算一次；注释、空行跳过
        let path = root.join(RELAYS_FILE);
        let text = std::fs::read_to_string(&path).unwrap() + "odea:relay/aaa

# 备注
";
        std::fs::write(&path, text).unwrap();
        assert_eq!(read_relays(root), codes);
        assert!(write_relays(root, &[]).unwrap());
        assert!(!path.exists());
    }
}
