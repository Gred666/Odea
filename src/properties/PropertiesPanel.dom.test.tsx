// @vitest-environment happy-dom

import type { Backend } from "@/data/backend";
import type { DocumentRef } from "@/data/types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 属性面板的键盘和写回（docs/REVIEWS/2026-11-13-全项目审查.md §4.4–§4.7）：
 * Esc 是不改了（以前失焦的那一下把不要的字存了）、提示列表开着时先收列表；
 * 应用自己的键名留下的行只能看；连着改两次，前一次的结果不把界面换回旧的；用完焦点还回去。
 * 换类型只记类型、不改值，对不上的标「类型不符」（§6.8）；文字值的提示不默认选中（§6.2）
 */

let stored = "";
/** 写回的每一次：谁先谁后、什么时候回来由测试定 */
let writes: Array<{
  text: string;
  done: (saved?: string) => void;
  fail: (message: string) => void;
}>;
let catalog = { keys: [] as Array<Record<string, unknown>>, types: {} as Record<string, string> };
const api = {
  docProperties: vi.fn(async () => ({ text: stored, editable: true })),
  docSetProperties: vi.fn(
    (_target: DocumentRef, text: string) =>
      new Promise<{ text: string; editable: boolean }>((resolve, reject) => {
        writes.push({
          text,
          done: (saved = text) => {
            stored = saved;
            resolve({ text: saved, editable: true });
          },
          fail: (message) => reject({ kind: "Invalid", message }),
        });
      }),
  ),
  propertyCatalog: vi.fn(async () => catalog),
  // 和 Rust 一样：记进仓库的 types.json，回来的是记完的整张表
  setPropertyType: vi.fn(async (key: string, kind: string | null) => {
    const types = { ...catalog.types };
    if (kind) types[key] = kind;
    else delete types[key];
    catalog = { ...catalog, types };
    return { ...types };
  }),
  onVaultChanged: vi.fn(
    (_listen: (change: { notes: string[]; docs: unknown[] }) => void) => () => {},
  ),
};
vi.mock("@/data/backend", () => ({ backend: async () => api as unknown as Backend }));
vi.mock("@/data/store", () => ({
  messageOf: (cause: { message?: string }) => cause?.message ?? String(cause),
  useData: { setState: vi.fn() },
}));

const { PropertiesPanel } = await import("./PropertiesPanel");
const {
  invalidateCatalog,
  loadCatalog,
  primeProperties,
  requestAddProperty,
  useAddRequest,
  useCatalog,
} = await import("./store");

const target: DocumentRef = { type: "note", key: "n1" };
let container: HTMLDivElement;
let outside: HTMLTextAreaElement;
let root: Root;

const flush = () => act(async () => {});

async function mount(text: string) {
  stored = text;
  primeProperties(target, text, true);
  await act(async () => root.render(<PropertiesPanel target={target} />));
  await flush();
}

beforeEach(() => {
  writes = [];
  catalog = { keys: [], types: {} };
  useCatalog.setState({ catalog: null, stale: true });
  invalidateCatalog();
  // 上一条要过的「添加属性」不带进这一条（不然一挂上就开着加属性那一行、顺手取了一览）
  useAddRequest.setState({ key: null, at: 0 });
  for (const mock of Object.values(api)) mock.mockClear();
  // 面板外面的一个能拿焦点的地方（应用里是正文）
  outside = document.createElement("textarea");
  container = document.createElement("div");
  document.body.append(outside, container);
  root = createRoot(container);
});

afterEach(async () => {
  // 这一条里起的那次取一览等它回来：不然落到下一条里，把那一条的一览换成这一条的
  await act(async () => {
    await loadCatalog();
  });
  act(() => root.unmount());
  container.remove();
  outside.remove();
});

const input = (label: string) =>
  [...container.querySelectorAll<HTMLInputElement>("input")].filter(
    (element) => element.getAttribute("aria-label") === label,
  );

/** 从面板外面进来（应用里：在正文里写着，点了一下这个框） */
async function enter(field: HTMLElement) {
  await act(async () => {
    outside.focus();
    field.focus();
  });
}

/** 属性一览取回来（鼠标移上来、焦点进来时才去取） */
async function catalogLoaded() {
  await act(async () => {
    await vi.waitFor(() => expect(useCatalog.getState().catalog).not.toBeNull());
  });
}

async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(field: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

/** Radix 的菜单开、关在下一个宏任务里才处理完 */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

/** 这一行的类型图标（名字是「键：类型」，对不上时后面再跟一句「类型不符：…」） */
const kindButton = (key: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label^="${key}："]`);

/** 用键盘换类型：类型图标上回车开菜单，挑一项回车 */
async function pickKind(key: string, label: string) {
  const trigger = kindButton(key)!;
  await enter(trigger);
  await press(trigger, "Enter");
  await settle();
  const item = [...document.querySelectorAll<HTMLElement>("[role^=menuitem]")].find(
    (element) => element.textContent?.trim() === label,
  )!;
  await act(async () => {
    item.focus();
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
  await flush();
}

const options = () => [...container.querySelectorAll<HTMLElement>("[role=option]")];

describe("PropertiesPanel", () => {
  it("Esc leaves a value as it was, Enter saves it", async () => {
    await mount("status: 草稿");
    const [value] = input("值");
    await enter(value!);
    await type(value!, "进行中");
    await press(value!, "Escape");
    expect(api.docSetProperties).not.toHaveBeenCalled();
    expect(input("值")[0]?.value).toBe("草稿");
    expect(document.activeElement).toBe(outside);

    await enter(input("值")[0]!);
    await type(input("值")[0]!, "进行中");
    await press(input("值")[0]!, "Enter");
    expect(writes.map((write) => write.text)).toEqual(["status: 进行中"]);
    expect(document.activeElement).toBe(outside);
  });

  it("Esc does not add the half-typed list item", async () => {
    await mount("tags:\n  - 项目");
    const [more] = input("加一项");
    await enter(more!);
    await type(more!, "发版");
    await press(more!, "Escape");
    expect(api.docSetProperties).not.toHaveBeenCalled();
    expect(input("加一项")[0]?.value).toBe("");

    // 回车加一项、留在框里接着加；空着再按一次是加完了
    await enter(input("加一项")[0]!);
    await type(input("加一项")[0]!, "发版");
    await press(input("加一项")[0]!, "Enter");
    expect(writes.map((write) => write.text)).toEqual(["tags:\n  - 项目\n  - 发版"]);
    expect(document.activeElement).toBe(input("加一项")[0]);
    await press(input("加一项")[0]!, "Enter");
    expect(document.activeElement).toBe(outside);
    expect(writes).toHaveLength(1);
  });

  it("with suggestions open, Esc first closes them so Enter can save what was typed", async () => {
    catalog = {
      keys: [{ key: "status", count: 3, kind: "text", values: ["进行中", "已完成"] }],
      types: {},
    };
    // 空着的值：光标一进去就提示这个键出现过的值
    await mount("status:");
    const [value] = input("值");
    await enter(value!);
    await catalogLoaded();
    expect(container.querySelector("[role=listbox]")).toBeTruthy();
    // 什么都没打：Esc 一下就走，不用按两次
    await press(value!, "Escape");
    expect(document.activeElement).toBe(outside);

    await enter(input("值")[0]!);
    await type(input("值")[0]!, "进行");
    expect(container.querySelector("[role=listbox]")?.textContent).toContain("进行中");
    await press(input("值")[0]!, "Escape");
    // 列表收了，字还在、光标还在
    expect(container.querySelector("[role=listbox]")).toBeNull();
    expect(input("值")[0]?.value).toBe("进行");
    expect(document.activeElement).toBe(input("值")[0]);
    await press(input("值")[0]!, "Enter");
    expect(writes.map((write) => write.text)).toEqual(["status: 进行"]);
  });

  it("a line left by another tool under one of the app's own names can be seen and removed, not edited", async () => {
    await mount('created: "[[2024-01-05]]"\nstatus: 草稿');
    const values = input("值");
    expect(values[0]?.disabled).toBe(true);
    expect(values[1]?.disabled).toBe(false);
    const names = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((b) =>
      ["created", "status"].includes(b.textContent ?? ""),
    );
    expect(names.map((b) => b.disabled)).toEqual([true, false]);
    expect(container.querySelector('button[aria-label="删掉 created"]')).toBeTruthy();

    // 改别的那一条：那一行原样带回去
    await enter(values[1]!);
    await type(values[1]!, "进行中");
    await press(values[1]!, "Enter");
    expect(writes[0]?.text).toBe('created: "[[2024-01-05]]"\nstatus: 进行中');
  });

  it("an earlier write coming back does not put the older text on screen", async () => {
    await mount("公开: false\nstatus: 草稿");
    const box = container.querySelector<HTMLButtonElement>("button[role=checkbox]")!;
    await act(async () => box.click());
    await flush();
    const [value] = input("值");
    await enter(value!);
    await type(value!, "进行中");
    await press(value!, "Enter");
    await flush();
    // 第一次写回来了，第二次还排着：界面上不能退回「草稿」
    expect(writes).toHaveLength(1);
    await act(async () => writes[0]!.done());
    await flush();
    expect(input("值")[0]?.value).toBe("进行中");
    expect(writes).toHaveLength(2);
    expect(writes[1]?.text).toBe("公开: true\nstatus: 进行中");
    await act(async () => writes[1]!.done());
    await flush();
    expect(input("值")[0]?.value).toBe("进行中");
    expect(box.getAttribute("aria-checked")).toBe("true");
  });

  it("a write that fails goes back to what is on disk and says why", async () => {
    await mount("status: 草稿");
    const [value] = input("值");
    await enter(value!);
    await type(value!, "进行中");
    await press(value!, "Enter");
    await flush();
    await act(async () => writes[0]!.fail("属性太多了"));
    await flush();
    expect(container.querySelector("[role=alert]")?.textContent).toBe("属性太多了");
    expect(input("值")[0]?.value).toBe("草稿");
  });

  it("adding a name that is already there puts the cursor in that row", async () => {
    await mount("status: 草稿\ntags:\n  - 项目");
    await act(async () => requestAddProperty(target));
    const [name] = input("新属性的名字");
    await type(name!, "status");
    await press(name!, "Enter");
    await flush();
    expect(api.docSetProperties).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input("值")[0]);
  });

  it("Esc on the new-property row adds nothing and gives the focus back", async () => {
    await mount("status: 草稿");
    outside.focus();
    await act(async () => requestAddProperty(target));
    // 那一行一出来光标就在里面（从正文过来的）
    const [name] = input("新属性的名字");
    expect(document.activeElement).toBe(name);
    await type(name!, "优先");
    await press(name!, "Escape");
    // 提示列表没开着（仓库里没有别的键）：一下就收
    expect(input("新属性的名字")).toHaveLength(0);
    expect(api.docSetProperties).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
  });

  it("Enter that hands the focus back to the body swallows the key (体验轮 §4.47)", async () => {
    // 焦点在按下的这一下就回了正文：回车的默认动作不拦，换行会落进正文开头，每加一条属性正文多一个空行
    await mount("status: 草稿");
    outside.focus();
    const [value] = input("值");
    await enter(value!);
    await type(value!, "进行中");
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      value!.dispatchEvent(event);
    });
    expect(document.activeElement).toBe(outside);
    expect(event.defaultPrevented).toBe(true);
  });

  it("picking a day in the calendar does not make Enter drop the focus on body (体验轮 §4.49)", async () => {
    await mount("due: 2026-11-20");
    const date = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("11月20日"),
    )!;
    await enter(date);
    await act(async () => date.click());
    const [field] = input("日期");
    expect(document.activeElement).toBe(field);
    // 日历关上、焦点回框里时，Chromium 给的 relatedTarget 是框里已经拆掉的「年」那一格
    const gone = document.createElement("span");
    await act(async () => {
      field!.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: gone }));
    });
    await press(field!, "Enter");
    expect(document.activeElement).toBe(outside);
  });

  it("taking an item out with the keyboard keeps the focus in the list (体验轮 §4.50)", async () => {
    await mount("tags: [工作, 计划, 复盘]");
    const remove = (item: string) =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="去掉 ${item}"]`);
    // 回车、空格按出来的 click 的 detail 是 0
    const pressOn = async (button: HTMLButtonElement) =>
      act(async () => {
        button.focus();
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
      });
    await pressOn(remove("工作")!);
    expect(writes.at(-1)?.text).toBe("tags: [计划, 复盘]");
    // 按钮跟着那一项拆掉了：落到接替它的那一项上，不掉在 body 上
    expect(document.activeElement).toBe(remove("计划"));
    await pressOn(remove("复盘")!);
    // 后面没有了：落进「加一项」
    expect(document.activeElement).toBe(input("加一项")[0]);
  });

  it("taking an item out with the mouse leaves the focus where it was (体验轮 §4.50)", async () => {
    await mount("tags: [工作, 计划]");
    outside.focus();
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="去掉 工作"]')!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 });
    await act(async () => {
      button.dispatchEvent(down);
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(down.defaultPrevented).toBe(true);
    expect(writes.at(-1)?.text).toBe("tags: [计划]");
    expect(document.activeElement).toBe(outside);
  });

  it("changing the kind only records it, the value in the file stays as it was (审查 §6.8)", async () => {
    await mount("status: 草稿");
    const marker = "类型不符：这个值不是";
    for (const [label, kind] of [
      ["日期", "date"],
      ["数字", "number"],
      ["勾选", "checkbox"],
      ["文字", "text"],
    ] as const) {
      await pickKind("status", label);
      // 只记了类型，属性一个字没写
      expect(api.docSetProperties).not.toHaveBeenCalled();
      expect(api.setPropertyType).toHaveBeenLastCalledWith("status", kind);
      expect(stored).toBe("status: 草稿");
      // 值照原来的字显示，能按文字改；勾选不画成一个没勾的框（一点就把「草稿」盖成 true）
      expect(input("值")[0]?.value).toBe("草稿");
      expect(container.querySelector("[role=checkbox]")).toBeNull();
      const name = kindButton("status")?.getAttribute("aria-label");
      if (kind === "text") expect(name).toBe("status：文字");
      else expect(name).toBe(`status：${label}，${marker}${label}`);
    }
    expect(api.setPropertyType).toHaveBeenCalledTimes(4);
  });

  it("a value its kind cannot show is marked, shown as typed, and fixed as text (审查 §6.8)", async () => {
    // 别的工具写的：types.json 说是日期、数字、勾选，值是 soon
    catalog = { keys: [], types: { 截止: "date", n: "number", ok: "checkbox" } };
    await mount("截止: soon\nn: soon\nok: soon");
    // 有属性就去取一览（记着的类型跟着它来），不等指上来、点进来
    await catalogLoaded();
    const marker = kindButton("截止")!;
    expect(marker.getAttribute("aria-label")).toBe("截止：日期，类型不符：这个值不是日期");
    expect(marker.title).toContain("类型不符：这个值不是日期");
    // 标记就是这一行的类型按钮：键盘走得到，点它换类型
    expect(marker.disabled).toBe(false);
    expect(kindButton("n")?.getAttribute("aria-label")).toBe("n：数字，类型不符：这个值不是数字");
    expect(kindButton("ok")?.getAttribute("aria-label")).toBe("ok：勾选，类型不符：这个值不是勾选");
    expect(container.querySelector("[role=checkbox]")).toBeNull();
    const values = input("值");
    expect(values.map((field) => field.value)).toEqual(["soon", "soon", "soon"]);
    expect(values[0]?.getAttribute("aria-invalid")).toBe("true");
    // title 是输入框的描述：读屏读完「值」接着读这一句
    expect(values[0]?.title).toBe("类型不符：这个值不是日期");

    // 点进去、不改就走：什么都不写（以前日期框是空的，一走就把 soon 抹了）
    await enter(values[0]!);
    await act(async () => values[0]!.blur());
    await flush();
    expect(api.docSetProperties).not.toHaveBeenCalled();

    // 改成日期读得了的：照日期写（不加引号），标记没了，画回日期
    await enter(values[0]!);
    await type(values[0]!, "2026-11-20");
    await press(values[0]!, "Enter");
    expect(writes.map((write) => write.text)).toEqual(["截止: 2026-11-20\nn: soon\nok: soon"]);
    expect(kindButton("截止")?.getAttribute("aria-label")).toBe("截止：日期");
    expect(
      [...container.querySelectorAll("button")].some((b) => b.textContent?.includes("11月20日")),
    ).toBe(true);
    await act(async () => writes[0]!.done());
    await flush();

    // 改成还是读不了的：照文字写，标记还在
    const [n] = input("值");
    await enter(n!);
    await type(n!, "很快");
    await press(n!, "Enter");
    expect(writes[1]?.text).toBe("截止: 2026-11-20\nn: 很快\nok: soon");
    expect(kindButton("n")?.getAttribute("aria-label")).toContain("类型不符");
  });

  it("a date under 日期和时间 reads as it is: opening the picker and leaving writes nothing (审查 §6.8)", async () => {
    catalog = { keys: [], types: { 截止: "datetime" } };
    await mount("截止: 2026-11-20");
    await catalogLoaded();
    expect(kindButton("截止")?.getAttribute("aria-label")).toBe("截止：日期和时间");
    const date = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("11月20日"),
    )!;
    await enter(date);
    await act(async () => date.click());
    const [field] = input("日期和时间");
    expect(field?.value).toBe("2026-11-20T09:00");
    await act(async () => field!.blur());
    await flush();
    expect(api.docSetProperties).not.toHaveBeenCalled();
  });

  it("a text value: Enter saves what was typed, ↓ picks a suggestion (审查 §6.2)", async () => {
    catalog = {
      keys: [{ key: "status", count: 3, kind: "text", values: ["进行中", "已完成"] }],
      types: {},
    };
    await mount("status:");
    const [value] = input("值");
    await enter(value!);
    await catalogLoaded();
    await type(value!, "进行");
    // 列表开着，但哪一条都没选
    expect(options().map((option) => option.textContent)).toEqual(["进行中"]);
    expect(options().some((option) => option.getAttribute("aria-selected") === "true")).toBe(false);
    expect(value!.hasAttribute("aria-activedescendant")).toBe(false);
    await press(value!, "Enter");
    expect(writes.map((write) => write.text)).toEqual(["status: 进行"]);
    expect(document.activeElement).toBe(outside);
    await act(async () => writes[0]!.done());
    await flush();

    // ↓ 进第一条、↑ 回到没选、再 ↓，回车存的是那一条
    const field = input("值")[0]!;
    await enter(field);
    await type(field, "");
    await press(field, "ArrowDown");
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(field.getAttribute("aria-activedescendant")).toBe(options()[0]?.id);
    await press(field, "ArrowUp");
    expect(options().some((option) => option.getAttribute("aria-selected") === "true")).toBe(false);
    expect(field.hasAttribute("aria-activedescendant")).toBe(false);
    await press(field, "ArrowDown");
    await press(field, "ArrowDown");
    expect(options()[1]?.textContent).toBe("已完成");
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    await press(field, "Enter");
    expect(writes[1]?.text).toBe("status: 已完成");
  });

  it("key names and tags still pick the first suggestion on Enter (审查 §6.2)", async () => {
    catalog = {
      keys: [
        { key: "status", count: 3, kind: "text", values: [] },
        { key: "tags", count: 2, kind: "tags", values: ["项目", "计划"] },
      ],
      types: {},
    };
    await mount("tags: [工作]");
    const [more] = input("加一项");
    await enter(more!);
    await catalogLoaded();
    await type(more!, "项");
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(more!.getAttribute("aria-activedescendant")).toBe(options()[0]?.id);
    await press(more!, "Enter");
    expect(writes.map((write) => write.text)).toEqual(["tags: [工作, 项目]"]);
    await act(async () => writes[0]!.done());
    await flush();

    await act(async () => requestAddProperty(target));
    const [name] = input("新属性的名字");
    await type(name!, "sta");
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    await press(name!, "Enter");
    expect(writes[1]?.text).toBe("tags: [工作, 项目]\nstatus:");
  });

  it("the YAML being edited is not wiped by a change from elsewhere; untouched, it follows", async () => {
    await mount("status: 草稿");
    const open = container.querySelector<HTMLButtonElement>('button[title="直接改 YAML"]')!;
    await act(async () => open.click());
    const yaml = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="属性（YAML）"]',
    )!;
    // 外面改了这一篇：面板收到仓库的变动，去取一遍
    const changedElsewhere = async (text: string) => {
      stored = text;
      const listen = api.onVaultChanged.mock.calls.at(-1)?.[0];
      await act(async () => listen!({ notes: [target.key], docs: [] }));
      await flush();
    };
    // 没动过：外面改了就跟上
    await changedElsewhere("status: 进行中");
    expect(yaml.value).toBe("status: 进行中");
    // 改了一半：外面再改，打的字留着，上面说一声
    expect(container.querySelector('[role="status"]')).toBeNull();
    await type(yaml, "status: 进行中\n截止: 2026-11-20");
    await changedElsewhere("status: 已完成");
    expect(yaml.value).toBe("status: 进行中\n截止: 2026-11-20");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "这一篇的属性在别处改过了。存的时候两边合起来",
    );
    // 存的时候按属性合：框里没动的 status 用外面的，框里加的截止留着（桌面端验证 §4.9）
    await press(yaml, "Enter", { ctrlKey: true });
    expect(writes.map((write) => write.text)).toEqual(["status: 已完成\n截止: 2026-11-20"]);
  });

  it("the source box names the keys both sides changed, and 用外面的 takes the outside version", async () => {
    await mount("status: 草稿\n截止: 2026-11-20");
    const open = container.querySelector<HTMLButtonElement>('button[title="直接改 YAML"]')!;
    await act(async () => open.click());
    const yaml = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="属性（YAML）"]',
    )!;
    const changedElsewhere = async (text: string) => {
      stored = text;
      const listen = api.onVaultChanged.mock.calls.at(-1)?.[0];
      await act(async () => listen!({ notes: [target.key], docs: [] }));
      await flush();
    };
    const status = () => container.querySelector('[role="status"]')?.textContent;
    await type(yaml, "status: 进行中\n截止: 2026-11-20");
    await changedElsewhere("status: 已完成\n截止: 2026-11-20\n负责人: 小王");
    expect(status()).toBe(
      "这一篇的属性在别处改过了。存的时候两边合起来，「status」两边都改了，按这里的",
    );
    // 框里写成读不出来的：说外面的会被盖掉
    await type(yaml, "status: 进行中\n随手写的一行");
    expect(status()).toBe("这一篇的属性在别处改过了。这里的读不出来，存的话外面的改动会被盖掉");

    // 用外面的：框里换成外面现在的，提示收起，没写文件
    const useTheirs = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "用外面的",
    )!;
    await act(async () => useTheirs.click());
    expect(yaml.value).toBe("status: 已完成\n截止: 2026-11-20\n负责人: 小王");
    expect(status()).toBeUndefined();
    expect(writes).toEqual([]);

    // 再改、两边都改了 status：存的是框里的 status，外面改的截止、加的负责人都在
    await type(yaml, "status: 搁置\n截止: 2026-11-20\n负责人: 小王");
    await changedElsewhere("status: 取消\n截止: 2026-11-21\n负责人: 小王");
    await press(yaml, "Enter", { ctrlKey: true });
    expect(writes.map((write) => write.text)).toEqual([
      "status: 搁置\n截止: 2026-11-21\n负责人: 小王",
    ]);
  });

  it("typing a whole existing name and Enter keeps that name, not a longer one that starts with it", async () => {
    catalog = {
      keys: [
        { key: "tag", count: 3, kind: "text", values: [] },
        { key: "tags", count: 2, kind: "tags", values: ["项目二期", "项目"] },
      ],
      types: {},
    };
    await mount("tags: [工作]");
    const [more] = input("加一项");
    await enter(more!);
    await catalogLoaded();
    // 照着显示的样子带 `#` 打：照样有提示
    await type(more!, "#项");
    expect(options().map((option) => option.textContent)).toEqual(["#项目二期", "#项目"]);
    await type(more!, "项目");
    // 打的字就是一条现成的：它排第一、选中的是它
    expect(options()[0]?.textContent).toBe("#项目");
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    await press(more!, "Enter");
    expect(writes.map((write) => write.text)).toEqual(["tags: [工作, 项目]"]);
    await act(async () => writes[0]!.done());
    await flush();

    await act(async () => requestAddProperty(target));
    const [name] = input("新属性的名字");
    await type(name!, "tag");
    await press(name!, "Enter");
    expect(writes[1]?.text).toBe("tags: [工作, 项目]\ntag:");
  });
});
