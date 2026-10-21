// 第一个：改名前 otw. 开头的存储键先换成 odea.，后面的模块一加载就会读它们
import "@/lib/legacyStorage";
import { Shell } from "@/app/Shell";
import { armIntro, markShown } from "@/app/intro";
import { initPreferences, restoreVaultSession } from "@/app/store";
import { initCollab } from "@/collab/store";
import { preloadEditor } from "@/components/DocumentView";
import { backend } from "@/data/backend";
import { useData } from "@/data/store";
import { installCloseGuard } from "@/editor/saveBus";
import { isTauri, signalReady, thisWindow, windowKind } from "@/lib/tauri";
import { initShare } from "@/share/store";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/globals.css";

async function bootstrap() {
  initPreferences();
  // 协作实验台（collab/lab）：只在浏览器预览里进得来，单独一个包
  if (!isTauri && new URLSearchParams(location.search).get("lab") === "collab") {
    const [{ mountCollabLab }, loro] = await Promise.all([
      import("@/collab/lab/CollabLab"),
      import("@/collab/loro"),
    ]);
    await loro.ensureLoro();
    mountCollabLab(document.getElementById("root")!);
    return;
  }
  // 启动器（docs/仓库与启动器.md §3）：不开仓库，只有用过的仓库和几个操作
  if (windowKind === "launcher") {
    const { Launcher } = await import("@/launcher/Launcher");
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <Launcher />
      </StrictMode>,
    );
    requestAnimationFrame(() => requestAnimationFrame(() => void signalReady()));
    return;
  }
  // 协作的访客窗口（docs/仓库与启动器.md §13）：不开仓库，只有别人共享的那一篇
  if (windowKind === "guest") {
    const { GuestShell } = await import("@/app/GuestShell");
    await preloadEditor();
    await installCloseGuard().catch((error) => console.error("安装关闭前保存保护失败", error));
    initCollab().catch((error) => console.error("协作初始化失败", error));
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <GuestShell />
      </StrictMode>,
    );
    requestAnimationFrame(() => requestAnimationFrame(() => void signalReady()));
    return;
  }
  // 「上次停在哪」按仓库分开记：先问这个窗口开的是哪个仓库，再把那个仓库的记录放进界面状态，
  // 下面取列表、取正文时才知道上次看的是哪篇（一个窗口一个仓库，localStorage 是所有窗口共用的）
  if (isTauri) {
    const info = await (await backend()).vaultInfo().catch(() => null);
    // 从旧配置迁过来的那个仓库（窗口标签 main）认旧的、不分仓库的记录：老用户升级后照旧回到上次那篇
    if (info) restoreVaultSession(info.root, thisWindow().label === "main");
  }
  // 这一次要不要播开场（冷启动、没开减少动效）。要在第一帧之前定：盖着的那层纸得出现在第一帧里
  armIntro();
  // 编辑器分包与数据初始化并行加载，挂载 React 之前一起等。
  // 首屏默认工作区就要用编辑器渲染正文，不预载的话 Suspense 会先渲染一次
  // 排版不同的只读预览、再换成编辑器，整篇重排一次（见 DocumentView）。
  // 这里多等的时间不会被用户看到：窗口本来就是 visible:false，
  // 要等下面首帧 paint 完 signalReady 才 show()。
  const editorLoaded = preloadEditor();
  await useData.getState().initialize();
  await editorLoaded;
  try {
    await installCloseGuard();
  } catch (error) {
    // capability 配置异常不能阻断整个 React 根节点渲染。关闭保护失效时
    // 保留控制台错误，应用主体仍然可用。
    console.error("安装关闭前保存保护失败", error);
  }

  // 协作：订阅成员、加入请求，接住 odea:// 链接（冷启动带进来的要等界面起来再弹对话框）
  initCollab().catch((error) => console.error("协作初始化失败", error));
  // 共享仓库（docs/协同编辑.md §20）：不是共享仓库的话就是取一次状态（null）
  initShare().catch((error) => console.error("共享仓库初始化失败", error));

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );

  // 首帧真正上屏后再让 Rust show() 窗口，避免开局白闪。
  // 双 rAF：第一帧排进渲染队列，第二帧确认已经 paint。窗口出来了，开场才开始落笔
  requestAnimationFrame(() => requestAnimationFrame(() => void signalReady().then(markShown)));
}

void bootstrap();
