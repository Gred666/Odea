import { Shell } from "@/app/Shell";
import { armIntro, markShown } from "@/app/intro";
import { initPreferences } from "@/app/store";
import { preloadEditor } from "@/components/DocumentView";
import { useData } from "@/data/store";
import { installCloseGuard } from "@/editor/saveBus";
import { signalReady } from "@/lib/tauri";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/globals.css";

async function bootstrap() {
  initPreferences();
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
