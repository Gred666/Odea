import { journalPlugin } from "./journal";
import { registerPlugin } from "./registry";

/* ============================================================
   装上内置插件（L2，docs/插件与跨端.md §5.1）。main.tsx 在第一帧之前引入它；
   开没开看仓库的摆法（.odea/vault.json 的 plugins，VaultLayout.plugins）
   ============================================================ */

registerPlugin(journalPlugin);
