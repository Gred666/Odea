import { isTauri, signalReady, windowKind } from "@/lib/tauri";
import "@/styles/globals.css";
// 只取版本号这一个字段（Vite 的 JSON 具名导入，不把整个 package.json 打进来）：启动失败时复制的错误信息里带上
import { version } from "../package.json";

/* ============================================================
   入口只分流（docs/REVIEWS/2026-11-10-审查与竞品调研.md §5.3.1）：每种窗口一个启动模块（src/boot/），动态加载。
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
  .catch(showBootFailure);

/**
 * 启动失败（docs/技术方案.md §8.9）：分包加载不了、初始化抛错。窗口建的时候是藏着的、等 ready 才显示，
 * 以前这里只 console.error，窗口就一直不出来。用几行 DOM 写清楚原因（不靠 React：可能正是它没加载成），
 * 照样 ready 把窗口显示出来。已经画出来了的（之后的步骤出的错，比如重开弹出窗口）界面照常用，只记一笔
 */
function showBootFailure(error: unknown): void {
  const root = document.getElementById("root");
  if (!root || root.childElementCount > 0) {
    console.error("启动后的步骤失败", error);
    return;
  }
  console.error("启动失败", error);
  const message = error instanceof Error ? error.message : String(error);
  const detail = error instanceof Error && error.stack ? error.stack : message;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = "") => {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
  };
  const button = (text: string, primary: boolean, onClick: () => void) => {
    const element = node(
      "button",
      primary
        ? "h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-ink hover:bg-accent-hover"
        : "h-8 rounded-md px-3 text-[13px] font-medium text-body hover:bg-raised",
      text,
    );
    element.type = "button";
    element.addEventListener("click", onClick);
    return element;
  };
  const copy = button("复制错误信息", false, () => {
    void navigator.clipboard
      .writeText(`Odea ${version}（${navigator.userAgent}）\n启动失败\n${detail}`)
      .then(() => {
        copy.textContent = "已复制";
      });
  });
  const actions = node("div", "mt-4 flex gap-2");
  actions.append(
    button("重新载入", true, () => window.location.reload()),
    copy,
  );
  const box = node("div", "w-[440px] max-w-full");
  box.append(
    node("h1", "text-[17px] font-semibold text-ink", "Odea 没能打开"),
    node(
      "p",
      "mt-1.5 text-[13px] leading-[1.7] text-body",
      "启动时出了错。存过的笔记都在仓库文件夹里；重新载入一般就好了，还不行的话把错误信息复制给我们。",
    ),
    node(
      "pre",
      "mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-raised/50 px-3 py-2 font-mono text-[12px] leading-[1.6] text-muted",
      message,
    ),
    actions,
  );
  root.className = "flex h-full w-full items-center justify-center bg-canvas p-8";
  root.append(box);
  document.getElementById("recovering")?.remove();
  void signalReady().catch(() => undefined);
}
