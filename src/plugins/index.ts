import { journalPlugin } from "./journal";
import { registerPlugin } from "./registry";

/* ============================================================
   装上内置插件（L2，docs/插件与跨端.md §5.1）。仓库窗口、访客窗口的启动模块（src/boot/）第一个引入它；
   开没开看仓库的摆法（.odea/vault.json 的 plugins，VaultLayout.plugins）
   ============================================================ */

registerPlugin(journalPlugin);
