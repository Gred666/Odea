// 第一个：改名前 otw. 开头的存储键先换成 odea.，后面的模块一加载就会读它们
import "@/lib/legacyStorage";
import { isTauri, windowKind } from "@/lib/tauri";
import "@/styles/globals.css";

/* ============================================================
   入口只分流（docs/1110审查与研究.md §5.3.1）：每种窗口一个启动模块（src/boot/），动态加载。
   以前入口静态引着仓库窗口的 Shell 和它引的一切，启动器、速记小窗也要把那 1.4 MB 解析一遍；
   DocumentView 一加载又在模块顶层拉了编辑器分包。
   这里别再静态引别的模块：引进来的每种窗口都要加载、解析一遍
   ============================================================ */

// 一种窗口一个函数，别写成一串三元表达式：压缩时会被折成一个 import 调用，
// Vite 给它配的预载清单就成了五种窗口的依赖加在一起（启动器照样把仓库窗口的分包全拉下来）
const boots = {
  launcher: () => import("@/boot/launcher"),
  capture: () => import("@/boot/capture"),
  guest: () => import("@/boot/guest"),
  vault: () => import("@/boot/vault"),
  // 协作实验台：只在浏览器预览里进得来
  lab: () => import("@/boot/lab"),
};
const lab = !isTauri && new URLSearchParams(location.search).get("lab") === "collab";

boots[lab ? "lab" : windowKind]()
  .then((module) => module.boot())
  .catch((error) => console.error("启动失败", error));
