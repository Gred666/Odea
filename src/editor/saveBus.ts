import { useData } from "@/data/store";
import { isTauri, win } from "@/lib/tauri";
import { flushViewMemory } from "@/lib/viewMemory";

export type FlushEditor = () => Promise<void>;

const flushers = new Set<FlushEditor>();
/** 各个编辑器「正在用输入法组字吗」 */
const composers = new Set<() => boolean>();

/** 组完字最多等多久：整句模式能组好几秒，再久就当输入法卡住了，照样往下走 */
const COMPOSE_WAIT_MS = 10_000;
const COMPOSE_POLL_MS = 50;

export function registerEditorFlush(flush: FlushEditor, composing?: () => boolean): () => void {
  flushers.add(flush);
  if (composing) composers.add(composing);
  return () => {
    flushers.delete(flush);
    if (composing) composers.delete(composing);
  };
}

export async function flushAllEditors(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush()));
}

/**
 * 等编辑器都组完字（最多 COMPOSE_WAIT_MS）。建协作会话、加入一篇之前用：组字时正文里是拼音，
 * 这时存下去、读出来当本机那一版，三方合会把拼音合进会话，别人那里闪一下拼音（docs/协同编辑.md §27.5）。
 * 只在这种一次性的时候轮询；平时的存盘不等（组字时防抖存盘自己会往后挪，见 debouncedSave.ts）
 */
export async function untilEditorsComposed(maxMs = COMPOSE_WAIT_MS): Promise<void> {
  const until = Date.now() + maxMs;
  while ([...composers].some((composing) => composing()) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, COMPOSE_POLL_MS));
  }
}

/** 组完字再存：要拿磁盘上的正文去建会话、三方合的地方用它，别用 flushAllEditors */
export async function flushEditorsComposed(): Promise<void> {
  await untilEditorsComposed();
  await flushAllEditors();
}

/**
 * 关窗口前（编辑器存完以后）还要做的：团队仓库里主持着的先说一声不主持了（team/store.ts）；
 * 做客的几篇把本机留的那份写完（collab/store.ts）
 */
const beforeClose = new Set<() => Promise<void>>();

export function registerBeforeClose(run: () => Promise<void>): () => void {
  beforeClose.add(run);
  return () => beforeClose.delete(run);
}

/** 最多等 2 秒：卡住了也照样关。导出给测试 */
export function runBeforeClose(): Promise<unknown> {
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
