// 内置插件（日程）要在别的模块之前装上，和仓库窗口一样（boot/vault.tsx）
import "@/plugins";
import { GuestShell } from "@/app/GuestShell";
import { initPreferences } from "@/app/store";
import { initCollab } from "@/collab/store";
import { preloadEditor } from "@/components/DocumentView";
import { installCloseGuard } from "@/editor/saveBus";
import { mount } from "./mount";

/** 协作的访客窗口（docs/仓库与启动器.md §13）：不开仓库，只有别人共享的那一篇 */
export async function boot() {
  initPreferences();
  await preloadEditor();
  await installCloseGuard().catch((error) => console.error("安装关闭前保存保护失败", error));
  initCollab().catch((error) => console.error("协作初始化失败", error));
  void mount(<GuestShell />);
}
