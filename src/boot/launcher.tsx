import { initPreferences } from "@/app/store";
import { Launcher } from "@/launcher/Launcher";
import { mount } from "./mount";

/** 启动器（docs/仓库与启动器.md §3）：不开仓库，只有用过的仓库和几个操作 */
export function boot() {
  initPreferences();
  void mount(<Launcher />);
}
