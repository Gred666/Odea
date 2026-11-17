export interface DebouncedSaver {
  schedule: (markdown: string) => void;
  flush: () => Promise<void>;
  /**
   * 不等结果的 flush（失焦、Mod-S、卸载）。失败已经由 store 的 saveError 显示、
   * 失败的版本也放回了队列，这里只是不让它变成一个没人接的 rejected promise。
   */
  flushQuietly: () => void;
  pending: () => boolean;
}

/** 到点时还不该存，最多再等这么久（组字状态万一卡住，也不至于一直不存） */
const MAX_HOLD = 30_000;

/**
 * 串行的 400ms 防抖保存器。
 *
 * 保存过程中继续输入不会覆盖正在写入的版本；下一次 flush 会排在前一次写入之后，
 * 因此切换文档和关窗时可以可靠等待最后一版落盘。
 *
 * hold：到点时它说「还不该存」就再等一轮。编辑器拿它挡输入法组字 —— 那时正文里是拼音，
 * 存下去的话磁盘上、回音以后的「已存」都是拼音，外面一改文件编辑器就当成没有没存的改动、整篇换掉，
 * 组着的字落到别处（docs/REVIEWS/2026-11-15-桌面端验证.md §3.2）。显式的 flush（失焦、换篇、关窗、Ctrl+S）不等
 */
export function createDebouncedSaver(
  save: (markdown: string) => Promise<void>,
  delay = 400,
  hold?: () => boolean,
): DebouncedSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingMarkdown: string | null = null;
  let writeChain = Promise.resolve();
  /** 从什么时候起一直在等 hold */
  let heldSince: number | null = null;

  const due = () => {
    timer = null;
    if (hold?.()) {
      heldSince ??= Date.now();
      if (Date.now() - heldSince < MAX_HOLD) {
        timer = setTimeout(due, delay);
        return;
      }
    }
    // 自动防抖保存没有直接调用方可接错误；store 会记录错误状态，下一次
    // schedule 仍能重试。显式 blur / 切换 / 关窗 flush 则会正常抛错。
    void flush().catch(() => undefined);
  };

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    heldSince = null;
    if (pendingMarkdown === null) return writeChain;

    const markdown = pendingMarkdown;
    pendingMarkdown = null;
    // 一次失败不能把 Promise 链永久置为 rejected；调用本次 flush 的人仍会
    // 收到错误，但下一次输入可以继续尝试落盘。
    writeChain = writeChain
      .catch(() => undefined)
      .then(() => save(markdown))
      .catch((error) => {
        // 没有更新版本在等待时，把失败版本放回队列。这样自动保存失败后再
        // blur / Ctrl+S / 关窗仍会重试，不会因组件卸载静默丢字。
        if (pendingMarkdown === null) pendingMarkdown = markdown;
        throw error;
      });
    return writeChain;
  };

  return {
    schedule(markdown) {
      pendingMarkdown = markdown;
      if (timer) clearTimeout(timer);
      timer = setTimeout(due, delay);
    },
    flush,
    flushQuietly: () => void flush().catch(() => undefined),
    pending: () => pendingMarkdown !== null,
  };
}
