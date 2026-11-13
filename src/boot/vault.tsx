// 第一个：装上内置插件（日程）。数据层初始化、第一帧之前就得在，别的模块加载时可能就要查注册表
import "@/plugins";
import { Shell } from "@/app/Shell";
import { armIntro, markShown } from "@/app/intro";
import { startQuickCapture } from "@/app/quickCapture";
import { initPreferences, restoreVaultSession } from "@/app/store";
import { initCollab } from "@/collab/store";
import { preloadEditor } from "@/components/DocumentView";
import { backend } from "@/data/backend";
import { useData } from "@/data/store";
import { installCloseGuard } from "@/editor/saveBus";
import { isTauri, thisWindow } from "@/lib/tauri";
import { initDeclaredPlugins } from "@/plugins/declared";
import { initScriptedPlugins } from "@/plugins/scripted";
import { mount } from "./mount";

/** 仓库窗口的启动序列（docs/技术方案.md §3.3） */
export async function boot() {
  initPreferences();
  // 「上次停在哪」按仓库分开记：先问这个窗口开的是哪个仓库，再把那个仓库的记录放进界面状态，
  // 下面取列表、取正文时才知道上次看的是哪篇（一个窗口一个仓库，localStorage 是所有窗口共用的）
  if (isTauri) {
    const info = await (await backend()).vaultInfo().catch(() => null);
    // 从旧配置迁过来的那个仓库（窗口标签 main）认旧的、不分仓库的记录：老用户升级后照旧回到上次那篇
    if (info) restoreVaultSession(info.root, thisWindow().label === "main");
  }
  // 这一次要不要播开场（冷启动、没开减少动效）。要在第一帧之前定：盖着的那层纸得出现在第一帧里
  armIntro();
  // 纯声明的插件（L0：提示块、模板、主题、导航顺序）：读这台设备装着的，取到仓库的摆法时就换上，
  // 主题色、提示块第一帧就是对的
  initDeclaredPlugins();
  // 带脚本的插件（L1）：跑在沙箱里，用到时才起（plugins/scripted.ts）。要等清单读好、仓库的摆法取到
  initScriptedPlugins();
  // 编辑器分包与数据初始化并行加载，挂载 React 之前一起等。
  // 首屏默认工作区就要用编辑器渲染正文，不预载的话 Suspense 会先渲染一次
  // 排版不同的只读预览、再换成编辑器，整篇重排一次（见 DocumentView）。
  // 这里多等的时间不会被用户看到：窗口本来就是 visible:false，
  // 要等首帧 paint 完 signalReady 才 show()。
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

  // 全局快捷键速记：小窗记下的一行交给这个窗口写进今日TODO（app/quickCapture.ts）
  startQuickCapture();
  // 协作：订阅成员、加入请求，接住 odea:// 链接（冷启动带进来的要等界面起来再弹对话框）
  initCollab().catch((error) => console.error("协作初始化失败", error));

  // 窗口出来了，开场才开始落笔
  await mount(<Shell />);
  markShown();
}
