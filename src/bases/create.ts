import { useApp } from "@/app/store";
import { backend } from "@/data/backend";
import { messageOf, useData } from "@/data/store";
import { baseTabId } from "./ids";

/* ============================================================
   新建视图文件（docs/视图文件.md §3.1、§3.2）：命令面板「新建视图文件」、文件夹「…」里的「新建视图」。
   在树上的那个文件夹里建（重名加序号），筛选默认是「在这个文件夹里」；建好开在当前标签里。
   核心只引这个小文件，写 YAML 的那一包用到时才加载
   ============================================================ */

export async function createBase(folder: string): Promise<void> {
  try {
    const [{ newBaseText }, api] = await Promise.all([import("./config"), backend()]);
    const { layout } = useData.getState();
    // 筛选写仓库里的路径（Obsidian 的 file.inFolder 认的是从仓库根起的路径）；整个仓库当树根时在根上建就不筛
    const dir = [layout.notesDir, folder].filter(Boolean).join("/");
    const rel = await api.baseCreate(folder, "未命名视图", newBaseText(dir || null));
    await useData.getState().refreshFolders();
    const app = useApp.getState();
    app.setWorkspace("notes");
    app.selectNote(baseTabId(rel));
  } catch (error) {
    useData.setState({ error: messageOf(error) });
  }
}
