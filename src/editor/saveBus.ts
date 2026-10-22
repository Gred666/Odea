import { useData } from "@/data/store";
import { isTauri, win } from "@/lib/tauri";
import { flushViewMemory } from "@/lib/viewMemory";

export type FlushEditor = () => Promise<void>;

const flushers = new Set<FlushEditor>();

export function registerEditorFlush(flush: FlushEditor): () => void {
  flushers.add(flush);
  return () => flushers.delete(flush);
}

export async function flushAllEditors(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush()));
}

/** 关窗口前（编辑器存完以后）还要做的：团队仓库里主持着的先说一声不主持了（team/store.ts） */
const beforeClose = new Set<() => Promise<void>>();

export function registerBeforeClose(run: () => Promise<void>): () => void {
  beforeClose.add(run);
  return () => beforeClose.delete(run);
}

/** 最多等 2 秒：卡住了也照样关 */
function runBeforeClose(): Promise<unknown> {
  return Promise.race([
    Promise.all([...beforeClose].map((run) => run().catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}

const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const { message } = error as { message: unknown };
    if (typeof message === "string" && message) return message;
  }
  return String(error);
};

/**
 * close() 先触发 Tauri 的关闭请求；前端阻止默认关闭、等待所有编辑器落盘，
 * 再调用 forceClose() 真正销毁窗口。
 *
 * 保存失败时**不能**把窗口永久锁死 —— debouncedSave 会把失败的那一版放回队列，
 * 下一次 flush 还是同一版、还是失败，用户会陷在一个点关闭没反应的窗口里。
 * 所以失败时把原因显示到界面上并放行下一次关闭：再点一次 = 明确表示放弃未保存内容。
 */
export async function installCloseGuard(): Promise<() => void> {
  if (!isTauri) {
    const beforeUnload = () => {
      flushViewMemory();
      void flushAllEditors();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  let closing = false;
  let discardOnNextRequest = false;
  return getCurrentWindow().onCloseRequested(async (event) => {
    if (closing) return;
    // 每篇看到哪、光标在哪（lib/viewMemory.ts）平时攒一会儿才写，关窗前写掉
    flushViewMemory();
    if (discardOnNextRequest) {
      closing = true;
      // 「放弃」只针对当时那次失败。之后保存可能早已恢复、又攒了几百毫秒还没
      // 落盘的输入，所以仍然尽力 flush 一次；失败或卡住（最多等 2 秒）才真的放弃。
      await Promise.race([
        flushAllEditors()
          .then(() => useData.getState().flushDrafts())
          .catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      await runBeforeClose();
      await win.forceClose();
      return;
    }
    event.preventDefault();
    try {
      await flushAllEditors();
      // 编辑器已经卸载、保存失败留下的草稿也再试一次。放在编辑器之后：开着的那篇
      // 如果刚存成功，它的草稿已经清掉了，不会用旧草稿盖掉新内容。
      await useData.getState().flushDrafts();
      await runBeforeClose();
      closing = true;
      await win.forceClose();
    } catch (error) {
      discardOnNextRequest = true;
      const reason = messageOf(error);
      console.error("保存失败，已取消本次关闭", error);
      useData.setState({
        saveError: {
          key: null,
          message: `${reason}（内容尚未保存；再次点击关闭将放弃这些修改）`,
        },
      });
    }
  });
}
