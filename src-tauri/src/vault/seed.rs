/* ============================================================
新仓库里放的东西：只有使用指南（「欢迎使用 OnTheWay」和「语法全览」，见 vault/guide.rs）。

只在第一次建仓库、而且文件夹里一篇 .md 都没有时写一次；用户删光了也不会再塞回来
（仓库标记 .ontheway/vault.json 在）。

以前这里是原型图上那一套示例笔记、归档、日记和目标（京都书店清单、秋季项目复盘……），
截图好看，真用户打开却是一堆别人的笔记，只能一篇篇删。2026-10-08 换成了指南。
============================================================ */

use std::path::Path;

use super::guide;
use crate::error::Result;

pub fn write(root: &Path) -> Result<()> {
    guide::write_all(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;

    #[test]
    fn seeds_only_the_guides() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path()).unwrap();
        let vault = Vault::open_in_memory(dir.path());

        let titles: Vec<_> = vault
            .note_list_full(false)
            .unwrap()
            .into_iter()
            .map(|note| note.title)
            .collect();
        assert_eq!(titles, vec!["欢迎使用 OnTheWay", "语法全览"], "欢迎那篇置顶，排在最前");
        assert!(vault.note_list_full(true).unwrap().is_empty(), "没有归档");
        assert!(vault.journal_list().unwrap().is_empty(), "没有日记和目标");
        // 指南里的待办都没写日期，不会出现在日历上
        assert!(vault.marked_dates("2000-01-01", "2100-12-31").unwrap().is_empty());
        let found = crate::vault::find_text(&vault.db, "命令面板", Default::default(), || false);
        assert!(!found.unwrap().unwrap().files.is_empty(), "指南能搜到");
    }
}
