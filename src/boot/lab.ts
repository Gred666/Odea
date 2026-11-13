// 和仓库窗口一样先装上内置插件（boot/vault.tsx）
import "@/plugins";
import { initPreferences } from "@/app/store";
import { mountCollabLab } from "@/collab/lab/CollabLab";
import { ensureLoro } from "@/collab/loro";

/** 协作实验台（collab/lab）：只在浏览器预览里进得来（`/?lab=collab`） */
export async function boot() {
  initPreferences();
  await ensureLoro();
  mountCollabLab(document.getElementById("root")!);
}
