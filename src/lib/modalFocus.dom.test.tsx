// @vitest-environment happy-dom

import { act, useState } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModalFocus } from "./modalFocus";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 模态对话框的焦点（D 段 §4.41）：以前 13 个对话框都不管 —— 打开时焦点留在 body，第一下 Tab 落在遮罩上，
 * 关掉以后焦点掉在 body，Ctrl+K → Esc 接着打字什么都不进
 */

let container: HTMLDivElement;
let root: Root;
let setPalette: (open: boolean) => void;
let setDialog: (open: boolean) => void;
/** 对话框关了还挂着（AnimatePresence 的退场动画那 0.2 秒） */
let setLinger: (linger: boolean) => void;

function Modal({
  name,
  open,
  linger = false,
  autoFocus,
}: { name: string; open: boolean; linger?: boolean; autoFocus?: boolean }) {
  const panel = useModalFocus(open);
  if (!open && !linger) return null;
  return (
    <>
      <button type="button" aria-label={`关闭${name}`} data-scrim={name} />
      <div>
        <div ref={panel} role="dialog" aria-modal="true" aria-label={name}>
          {autoFocus ? <input aria-label={`${name}输入`} ref={(el) => el?.focus()} /> : null}
          <button type="button">{name}一</button>
          <button type="button" disabled>
            {name}灰
          </button>
          <button type="button">{name}二</button>
        </div>
      </div>
    </>
  );
}

let setMenu: (open: boolean) => void;

function App() {
  const [palette, setP] = useState(false);
  const [dialog, setD] = useState(false);
  const [linger, setL] = useState(false);
  const [menu, setM] = useState(false);
  setPalette = setP;
  setDialog = setD;
  setLinger = setL;
  setMenu = setM;
  return (
    <>
      <textarea aria-label="正文" />
      <button type="button">别处</button>
      <button type="button">更多操作</button>
      {/* Radix 的下拉菜单：一选就拆掉 */}
      {menu && (
        <div role="menu">
          <button type="button" role="menuitem">
            移动到…
          </button>
        </div>
      )}
      <Modal name="面板" open={palette} autoFocus />
      <Modal name="对话框" open={dialog} linger={linger} />
    </>
  );
}

const byLabel = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
const byText = (text: string) =>
  [...container.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === text)!;
const focused = () =>
  document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "";

function tab(shift = false) {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: shift,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<App />));
  act(() => byLabel("正文").focus());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("模态对话框的焦点", () => {
  it("打开时进面板，关掉还给打开之前的那个", () => {
    act(() => setDialog(true));
    expect(focused()).toBe("对话框");
    act(() => setDialog(false));
    expect(focused()).toBe("正文");
  });

  it("面板里自己聚焦了输入框的，不抢", () => {
    act(() => setPalette(true));
    expect(focused()).toBe("面板输入");
  });

  it("Tab 在面板里转圈，跳过禁用的，不走到遮罩", () => {
    act(() => setDialog(true));
    // 焦点在面板本身：Shift+Tab 去最后一个，不去前面的遮罩
    tab(true);
    expect(focused()).toBe("对话框二");
    tab();
    expect(focused()).toBe("对话框一");
    tab(true);
    expect(focused()).toBe("对话框二");
    // 焦点丢在 body 上（按着的按钮没了）：Tab 拉回面板
    act(() => (document.activeElement as HTMLElement).blur());
    tab();
    expect(focused()).toBe("对话框一");
  });

  it("从命令面板开的对话框：关掉还给正文，不是已经没了的面板输入框", () => {
    act(() => setPalette(true));
    act(() => {
      setPalette(false);
      setDialog(true);
    });
    expect(focused()).toBe("对话框");
    act(() => setDialog(false));
    expect(focused()).toBe("正文");
  });

  it("命令面板 Esc：回正文", () => {
    act(() => setPalette(true));
    act(() => setPalette(false));
    expect(focused()).toBe("正文");
  });

  it("点遮罩关掉：按下那一下焦点落在遮罩上，也还给正文", () => {
    act(() => {
      setDialog(true);
      setLinger(true);
    });
    act(() => byLabel("关闭对话框").focus());
    act(() => setDialog(false));
    // 退场动画里遮罩还在：焦点不能留在它上面，等它拆掉就掉回 body
    expect(focused()).toBe("正文");
  });

  it("退场动画里焦点还在面板上：关掉那一刻就还回去", () => {
    act(() => {
      setDialog(true);
      setLinger(true);
    });
    act(() => byText("对话框一").focus());
    act(() => setDialog(false));
    expect(focused()).toBe("正文");
  });

  it("关掉时的动作已经把焦点挪到别处的，不抢回来", () => {
    act(() => setDialog(true));
    act(() => {
      byText("别处").focus();
      setDialog(false);
    });
    expect(focused()).toBe("别处");
  });

  it("叠着两层：上面那层关掉，焦点回下面那层", () => {
    act(() => setDialog(true));
    act(() => setPalette(true));
    expect(focused()).toBe("面板输入");
    act(() => setPalette(false));
    expect(focused()).toBe("对话框");
  });

  it("从下拉菜单里开的（行菜单「移动到…」）：关掉回到打开菜单的按钮，不是已经拆掉的那一项（§4.56）", () => {
    act(() => byText("更多操作").focus());
    act(() => setMenu(true));
    act(() => byText("移动到…").focus());
    act(() => {
      setMenu(false);
      setDialog(true);
    });
    expect(focused()).toBe("对话框");
    act(() => setDialog(false));
    expect(focused()).toBe("更多操作");
  });
});

describe("模态对话框的焦点：头一回打开", () => {
  it("面板一挂上里面的输入框就拿走了焦点（autoFocus，在 effect 之前）：关掉照样还给打开之前的那个（§4.56）", async () => {
    // 新的一份模块：还没有哪个对话框开过
    vi.resetModules();
    const fresh = await import("./modalFocus");
    function Picker({ open }: { open: boolean }) {
      const panel = fresh.useModalFocus(open);
      if (!open) return null;
      return (
        <div ref={panel} role="dialog" aria-modal="true" aria-label="选择器">
          <input aria-label="筛选" ref={(el) => el?.focus()} />
        </div>
      );
    }
    let setOpen: (open: boolean) => void = () => {};
    function Host() {
      const [open, set] = useState(false);
      setOpen = set;
      return (
        <>
          <button type="button">标题</button>
          <Picker open={open} />
        </>
      );
    }
    act(() => root.render(<Host />));
    act(() => byText("标题").focus());
    act(() => setOpen(true));
    expect(focused()).toBe("筛选");
    act(() => setOpen(false));
    // 比元素，不比字：焦点掉在 body 上时 body 的字也是「标题」
    expect(document.activeElement).toBe(byText("标题"));
  });
});
