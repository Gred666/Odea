// @vitest-environment happy-dom

import { history, redo, undo } from "@codemirror/commands";
import {
  ChangeSet,
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  StateEffect,
  Text,
  type Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { LABEL_MS, collab, isCollabSync } from "./binding";
import { remoteCarets } from "./cursors";
import { fineEdits, mergeExternal, snapshot } from "./external";
import { LoopbackHub, type LoopbackMember, ManualScheduler } from "./loopback";
import {
  CURSOR_HEARTBEAT_MS,
  CURSOR_TIMEOUT_MS,
  type Peer,
  encodeCursor,
  peerColor,
} from "./session";

const peer = (id: string, name = id): Peer => ({ id, name, color: peerColor(id) });

const views: EditorView[] = [];
const hubs: LoopbackHub[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  for (const hub of hubs.splice(0)) hub.destroy();
  document.body.replaceChildren();
});

/** 每个编辑器收到的事务，按顺序记下来 */
type Log = Transaction[];

function mount(member: LoopbackMember, extensions: Extension[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const log: Log = [];
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: member.session.toString(),
      extensions: [
        history(),
        collab(member.session),
        EditorView.updateListener.of((update) => log.push(...update.transactions)),
        ...extensions,
      ],
    }),
  });
  views.push(view);
  return { view, log, member };
}

/** 一个主持人 + 几个访客，各自一个编辑器 */
function room(text: string, guests = 1, latency = 0) {
  const scheduler = new ManualScheduler();
  const hub = new LoopbackHub({ scheduler, latency: () => latency });
  hubs.push(hub);
  const members = [hub.host(peer("host", "主持人"), text)];
  for (let index = 0; index < guests; index += 1) {
    members.push(hub.join(peer(`guest${index}`, `访客${index + 1}`)));
  }
  const editors = members.map((member) => mount(member));
  return { scheduler, hub, editors };
}

const type = (view: EditorView, at: number, insert: string) =>
  view.dispatch({
    changes: { from: at, insert },
    selection: { anchor: at + insert.length },
    userEvent: "input.type",
  });

/** 所有编辑器和它们的正文都是同一段文字 */
function expectConverged(editors: { view: EditorView; member: LoopbackMember }[]) {
  const text = editors[0]!.view.state.doc.toString();
  for (const { view, member } of editors) {
    expect(view.state.doc.toString()).toBe(text);
    expect(member.session.toString()).toBe(text);
  }
  return text;
}

const fire = (view: EditorView, type: "compositionstart" | "compositionend") =>
  view.contentDOM.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: "" }));

describe("CodeMirror ⇄ Loro 的正文", () => {
  it("把一边打的字带到另一边，远端事务不算用户输入", async () => {
    const { scheduler, editors } = room("开头\n结尾");
    const [a, b] = editors;
    type(a!.view, 2, "，中间");
    await scheduler.advance(20);
    expect(b!.view.state.doc.toString()).toBe("开头，中间\n结尾");
    expectConverged(editors);

    const remote = b!.log.filter((transaction) => transaction.docChanged);
    expect(remote).toHaveLength(1);
    expect(isCollabSync(remote[0]!)).toBe(true);
    // 模板、`[[` 补全只认 input.type：别人的字不能触发它们
    expect(remote[0]!.isUserEvent("input")).toBe(false);
  });

  it("访客打的字经主持人转给其他访客", async () => {
    const { scheduler, editors } = room("", 2);
    type(editors[1]!.view, 0, "访客一");
    type(editors[2]!.view, 0, "访客二");
    await scheduler.advance(20);
    const text = expectConverged(editors);
    expect(text).toContain("访客一");
    expect(text).toContain("访客二");
  });

  it("同一处同时打字：各自连成一片，所有人一致", async () => {
    const { scheduler, editors } = room("[]", 2, 40);
    for (let round = 0; round < 6; round += 1) {
      for (const [index, editor] of editors.entries()) {
        const head = editor.view.state.selection.main.head;
        type(editor.view, round === 0 ? 1 : head, "甲乙丙"[index]!);
      }
      await scheduler.advance(10);
    }
    await scheduler.advance(500);
    const text = expectConverged(editors);
    expect(text).toMatch(/^\[(甲{6}|乙{6}|丙{6}){3}\]$/);
  });

  it("一次改好几处（多光标、替换全部）也对得上", async () => {
    const { scheduler, editors } = room("a-b-c-d");
    const [a, b] = editors;
    a!.view.dispatch({
      changes: [
        { from: 1, to: 2, insert: "++" },
        { from: 3, to: 4, insert: "" },
        { from: 5, to: 6, insert: "—" },
      ],
    });
    await scheduler.advance(20);
    expect(b!.view.state.doc.toString()).toBe("a++bc—d");
    expectConverged(editors);
  });

  it("撤销只撤自己的，撤销出来的改动也同步出去", async () => {
    const { scheduler, editors } = room("");
    const [a, b] = editors;
    type(a!.view, 0, "我写的");
    await scheduler.advance(20);
    type(b!.view, 3, "，他补的");
    await scheduler.advance(20);
    expect(a!.view.state.doc.toString()).toBe("我写的，他补的");

    undo(a!.view);
    await scheduler.advance(20);
    expect(expectConverged(editors)).toBe("，他补的");

    redo(a!.view);
    await scheduler.advance(20);
    expect(expectConverged(editors)).toBe("我写的，他补的");

    // 访客的历史里只有自己那一笔
    undo(b!.view);
    await scheduler.advance(20);
    expect(expectConverged(editors)).toBe("我写的");
    expect(undo(b!.view)).toBe(false);
  });

  it("远端改动在自己的撤销记录前面：撤销时位置跟着挪", async () => {
    const { scheduler, editors } = room("中间");
    const [a, b] = editors;
    type(a!.view, 2, "，我的");
    await scheduler.advance(20);
    type(b!.view, 0, "他在前面加了一大段。");
    await scheduler.advance(20);
    undo(a!.view);
    await scheduler.advance(20);
    expect(expectConverged(editors)).toBe("他在前面加了一大段。中间");
  });

  it("断线期间各写各的，重连后补齐", async () => {
    const { scheduler, hub, editors } = room("第一行\n第二行");
    const [a, b] = editors;
    hub.disconnect(b!.member);
    type(a!.view, 3, "（主持人改）");
    type(b!.view, b!.view.state.doc.length, "（访客改）");
    await scheduler.advance(50);
    expect(a!.view.state.doc.toString()).not.toContain("访客改");
    hub.reconnect(b!.member);
    await scheduler.advance(50);
    const text = expectConverged(editors);
    expect(text).toBe("第一行（主持人改）\n第二行（访客改）");
  });

  it("一帧里来了好几个更新：第一个马上进来，剩下的合到下一帧一次派发", async () => {
    const { scheduler, editors } = room("");
    const [a, b] = editors;
    // 加入时的同步刚应用过一次：等这一帧过去
    await scheduler.advance(40);
    // 连着打五下，几乎同时到
    for (const char of "一二三四五") {
      type(a!.view, a!.view.state.doc.length, char);
      await scheduler.advance(1);
    }
    await scheduler.advance(4);
    const changes = b!.log.filter((transaction) => transaction.docChanged);
    // 五个更新：第一个立刻派发，同一帧里后到的四个攒到下一帧合成一次
    expect(changes.length).toBeLessThan(5);
    await scheduler.advance(40);
    expect(b!.view.state.doc.toString()).toBe("一二三四五");
    expect(b!.log.filter((transaction) => transaction.docChanged).length).toBe(2);
  });
});

describe("组字", () => {
  /** 模拟输入法：开始组字，逐个字母出现在文档里，最后换成上屏的字 */
  function compose(view: EditorView, at: number, pinyin: string) {
    fire(view, "compositionstart");
    let to = at;
    for (let length = 1; length <= pinyin.length; length += 1) {
      view.dispatch({
        changes: { from: at, to, insert: pinyin.slice(0, length) },
        selection: { anchor: at + length },
        userEvent: "input.type.compose",
      });
      to = at + length;
    }
    return to;
  }

  it("组字期间不往外发，对方只看到上屏的字", async () => {
    const { scheduler, editors } = room("前后");
    const [a, b] = editors;
    const seen: string[] = [];
    const end = compose(a!.view, 1, "nihao");
    await scheduler.advance(30);
    seen.push(b!.view.state.doc.toString());
    expect(b!.view.state.doc.toString()).toBe("前后");

    fire(a!.view, "compositionend");
    // CodeMirror 在 compositionend 之后的微任务里才把最后一次组字改动读进来
    a!.view.dispatch({
      changes: { from: 1, to: end, insert: "你好" },
      selection: { anchor: 3 },
      userEvent: "input.type.compose",
    });
    await scheduler.advance(30);
    seen.push(b!.view.state.doc.toString());
    expect(seen).toEqual(["前后", "前你好后"]);
    // 对方那边只有一次改动：插入「你好」，从来没出现过拼音
    const remote = b!.log.filter((transaction) => transaction.docChanged);
    expect(remote).toHaveLength(1);
    expectConverged(editors);
  });

  it("组字期间：别的行的远端改动当场进来，碰到组字那一行的上屏后一起进来，一个字不丢", async () => {
    const { scheduler, editors } = room("甲\n乙");
    const [a, b] = editors;
    const end = compose(a!.view, 1, "shi");
    type(b!.view, b!.view.state.doc.length, "（远端）");
    await scheduler.advance(30);
    // 别的行：当场进来，正文里没有拼音（组字的改动只写不发）
    expect(a!.view.state.doc.toString()).toBe("甲shi\n乙（远端）");
    expect(a!.member.session.toString()).toBe("甲shi\n乙（远端）");
    expect(b!.member.session.toString()).toBe("甲\n乙（远端）");

    fire(a!.view, "compositionend");
    // compositionend 之后、最后一次改动读进来之前，组字那一行来了远端的字：先攒着
    type(b!.view, 0, "【");
    await scheduler.advance(10);
    expect(a!.view.state.doc.toString()).toBe("甲shi\n乙（远端）");
    expect(a!.member.session.toString()).toBe("【甲shi\n乙（远端）");

    a!.view.dispatch({
      changes: { from: 1, to: end, insert: "是" },
      selection: { anchor: 2 },
      userEvent: "input.type.compose",
    });
    await scheduler.advance(30);
    expect(expectConverged(editors)).toBe("【甲是\n乙（远端）");

    // 攒着的那次一定在最后那次组字改动之后才派发
    const order = a!.log
      .filter((transaction) => transaction.docChanged)
      .map((transaction) => (isCollabSync(transaction) ? "remote" : "local"));
    expect(order.slice(-2)).toEqual(["local", "remote"]);
  });

  it("攒着远端改动的时候本地又改了：映射过去写进正文，两边一致", async () => {
    const { scheduler, editors } = room("一二三");
    const [a, b] = editors;
    compose(a!.view, 3, "ni");
    // 同一行：攒着（插在 ni 的位置上会和它并发，谁先谁后由 CRDT 定，这里避开）
    type(b!.view, 0, "【");
    type(b!.view, 2, "·");
    await scheduler.advance(30);
    expect(a!.view.state.doc.toString()).toBe("一二三ni");
    expect(a!.member.session.toString()).toBe("【一·二三ni");
    // 组字中途还在打：本地改动映射过攒着的那几个字
    a!.view.dispatch({
      changes: { from: 3, to: 5, insert: "nih" },
      userEvent: "input.type.compose",
    });
    expect(a!.member.session.toString()).toBe("【一·二三nih");
    fire(a!.view, "compositionend");
    a!.view.dispatch({
      changes: { from: 3, to: 6, insert: "你" },
      selection: { anchor: 4 },
      userEvent: "input.type.compose",
    });
    await scheduler.advance(80);
    expect(expectConverged(editors)).toBe("【一·二三你");
  });

  it("compositionend 之后没有新改动：50ms 后放行", async () => {
    const { scheduler, editors } = room("");
    const [a, b] = editors;
    compose(a!.view, 0, "a");
    type(b!.view, 0, "远");
    await scheduler.advance(20);
    expect(a!.view.state.doc.toString()).toBe("a");
    fire(a!.view, "compositionend");
    await scheduler.advance(30);
    expect(a!.view.state.doc.toString()).toBe("a");
    await scheduler.advance(40);
    expectConverged(editors);
    expect(a!.view.state.doc.toString()).toContain("远");
  });

  it("连着组好几个词：中间不放行", async () => {
    const { scheduler, editors } = room("");
    const [a, b] = editors;
    let end = compose(a!.view, 0, "wo");
    type(b!.view, 0, "远");
    await scheduler.advance(20);
    fire(a!.view, "compositionend");
    a!.view.dispatch({ changes: { from: 0, to: end, insert: "我" }, userEvent: "input.type" });
    // 放行之前马上又开始下一个词
    end = compose(a!.view, 1, "men");
    await scheduler.advance(100);
    expect(a!.view.state.doc.toString()).toBe("我men");
    expect(b!.view.state.doc.toString()).toBe("远");
    fire(a!.view, "compositionend");
    a!.view.dispatch({ changes: { from: 1, to: end, insert: "们" }, userEvent: "input.type" });
    await scheduler.advance(30);
    expect(expectConverged(editors)).toMatch(/^(远我们|我们远)$/);
  });
});

describe("远端光标", () => {
  it("别人的光标和选区：位置贴着字走，动了以后名字标签亮一会儿", async () => {
    const { scheduler, editors } = room("第一行\n第二行\n第三行");
    const [a, b] = editors;
    b!.view.dispatch({ selection: EditorSelection.range(4, 7) });
    await scheduler.advance(40);
    let [caret] = a!.view.state.field(remoteCarets);
    expect(caret).toMatchObject({ id: "guest0", name: "访客1", anchor: 4, head: 7, labeled: true });

    // 主持人在前面插字：别人的选区跟着挪，不用等对方再发一次
    type(a!.view, 0, "插");
    expect(a!.view.state.field(remoteCarets)[0]).toMatchObject({ anchor: 5, head: 8 });

    await scheduler.advance(LABEL_MS + 50);
    [caret] = a!.view.state.field(remoteCarets);
    expect(caret).toMatchObject({ labeled: false, leaving: false });

    // 心跳不算「动了」：标签不会每 5 秒亮一下
    await scheduler.advance(CURSOR_HEARTBEAT_MS * 2);
    expect(a!.view.state.field(remoteCarets)[0]).toMatchObject({ labeled: false, leaving: false });

    // 对方打字：标签又亮
    type(b!.view, b!.view.state.selection.main.head, "！");
    await scheduler.advance(40);
    expect(a!.view.state.field(remoteCarets)[0]).toMatchObject({ labeled: true });
  });

  it("对方打字时光标跟在新字后面", async () => {
    const { scheduler, editors } = room("abc");
    const [a, b] = editors;
    b!.view.dispatch({ selection: { anchor: 3 } });
    await scheduler.advance(40);
    for (const char of "xyz") {
      type(b!.view, b!.view.state.selection.main.head, char);
      await scheduler.advance(5);
      // 更新到了、光标消息还没到时也已经在新字后面
      const caret = a!.view.state.field(remoteCarets)[0]!;
      expect(caret.head).toBe(a!.view.state.doc.length);
    }
  });

  it("15 秒没消息就淡出，然后拿掉；对方关了编辑器马上收起", async () => {
    const scheduler = new ManualScheduler();
    const hub = new LoopbackHub({ scheduler });
    hubs.push(hub);
    const host = hub.host(peer("host"), "正文");
    const guest = hub.join(peer("guest"));
    const a = mount(host);
    // 访客那边不挂编辑器，手动发一次光标，之后没有心跳
    guest.session.setLocalCursor(1);
    await scheduler.advance(20);
    guest.session.destroy();
    expect(a.view.state.field(remoteCarets)).toHaveLength(1);
    await scheduler.advance(CURSOR_TIMEOUT_MS);
    expect(a.view.state.field(remoteCarets)[0]).toMatchObject({ leaving: true });
    await scheduler.advance(1000);
    expect(a.view.state.field(remoteCarets)).toHaveLength(0);

    const other = hub.join(peer("other"));
    const b = mount(other);
    await scheduler.advance(40);
    expect(a.view.state.field(remoteCarets)).toHaveLength(1);
    b.view.destroy();
    views.splice(views.indexOf(b.view), 1);
    await scheduler.advance(40);
    expect(a.view.state.field(remoteCarets)).toHaveLength(0);
  });

  it("光标指着还没到的字：先留在原处，字到了再落过去", async () => {
    const { scheduler, editors } = room("abc", 1, 30);
    const [a, b] = editors;
    b!.view.dispatch({ selection: { anchor: 1 } });
    await scheduler.advance(80);
    expect(a!.view.state.field(remoteCarets)[0]!.head).toBe(1);
    // 光标消息绕过还在路上的更新先到（数据报不排队）
    type(b!.view, 3, "def");
    const position = b!.member.session.text.getCursor(4)!.encode();
    a!.member.session.receiveCursor(
      b!.member.peer,
      encodeCursor(1000, { anchor: position, head: position }),
    );
    await scheduler.advance(5);
    expect(a!.view.state.doc.toString()).toBe("abc");
    expect(a!.view.state.field(remoteCarets)[0]!.head).toBe(1);
    await scheduler.advance(40);
    expect(a!.view.state.doc.toString()).toBe("abcdef");
    expect(a!.view.state.field(remoteCarets)[0]!.head).toBe(4);
  });
});

describe("挂上时编辑器带着自己的字（docs/协同编辑.md §27）", () => {
  /**
   * 主持人这边的编辑器早就开着（照 origin 建的），会话也照 origin 建；访客的编辑器照常挂着。
   * 主持人的编辑器和 MarkdownEditor 一样，会话来了才换上绑定（collabSlot.reconfigure）
   */
  function lateRoom(origin: string, mark = true) {
    const scheduler = new ManualScheduler();
    const hub = new LoopbackHub({ scheduler });
    hubs.push(hub);
    const host = hub.host(peer("host", "主持人"), origin);
    if (mark) host.session.markOrigin(origin);
    const guest = mount(hub.join(peer("guest", "访客")));
    const late = (doc: string) => {
      const parent = document.createElement("div");
      document.body.append(parent);
      const slot = new Compartment();
      const log: Log = [];
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc,
          selection: { anchor: doc.length },
          extensions: [
            history(),
            slot.of([]),
            EditorView.updateListener.of((update) => log.push(...update.transactions)),
          ],
        }),
      });
      views.push(view);
      const attach = () => view.dispatch({ effects: slot.reconfigure(collab(host.session)) });
      return { view, log, member: host, attach };
    };
    return { scheduler, host, guest, editor: late(origin), late };
  }

  it("磁盘上是 \\r\\n 换行：会话里是 \\n，访客、主持人的编辑器都不多出空行，外面照样存成 \\r\\n 不算改动", async () => {
    const crlf = "a\r\nb\r\nc";
    const scheduler = new ManualScheduler();
    const hub = new LoopbackHub({ scheduler });
    hubs.push(hub);
    const host = hub.host(peer("host", "主持人"), crlf);
    host.session.markOrigin(crlf);
    const guest = mount(hub.join(peer("guest", "访客")));
    const slot = new Compartment();
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: crlf, extensions: [history(), slot.of([])] }),
    });
    views.push(view);
    const editor = {
      view,
      attach: () => view.dispatch({ effects: slot.reconfigure(collab(host.session)) }),
    };
    await scheduler.advance(100);
    // 主持人的编辑器还没挂上（主持人没开着这一篇也是这样）：访客照会话对齐（以前每个 \r 成了一个空行）
    expect(host.session.toString()).toBe("a\nb\nc");
    expect(guest.view.state.doc.toString()).toBe("a\nb\nc");
    editor.attach();
    await scheduler.advance(100);
    expect(host.session.toString()).toBe("a\nb\nc");
    expect(editor.view.state.doc.toString()).toBe("a\nb\nc");
    expect(guest.view.state.doc.toString()).toBe("a\nb\nc");
    // 别的程序把同样的正文存成 \r\n：不算外部改动
    expect(mergeExternal(host.session, snapshot(host.session), crlf)).toBe(false);
    type(guest.view, 1, "X");
    await scheduler.advance(100);
    expect(host.session.toString()).toBe("aX\nb\nc");
    expect(editor.view.state.doc.toString()).toBe("aX\nb\nc");
  });

  /** 访客看到过的每一版正文（看有没有出现过拼音） */
  function watch(view: EditorView) {
    const seen: string[] = [];
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          if (update.docChanged) seen.push(update.state.doc.toString());
        }),
      ),
    });
    return seen;
  }

  function startComposing(view: EditorView, at: number, pinyin: string) {
    fire(view, "compositionstart");
    view.dispatch({
      changes: { from: at, insert: pinyin },
      selection: { anchor: at + pinyin.length },
      userEvent: "input.type.compose",
    });
    return at + pinyin.length;
  }

  it("编辑器多打的字映射过会话那边的改动写进去，两边对到同一个结果", async () => {
    const { scheduler, host, guest, editor } = lateRoom("甲乙丙\n第二行");
    await scheduler.advance(20);
    // 会话建好以后、编辑器挂上之前：访客打了字，主持人在编辑器里也接着打
    type(guest.view, 0, "【");
    await scheduler.advance(20);
    type(editor.view, 3, "丁");
    expect(host.session.toString()).toBe("【甲乙丙\n第二行");
    expect(editor.view.state.doc.toString()).toBe("甲乙丙丁\n第二行");

    editor.attach();
    // 当场写进了会话（等派发的是编辑器那一半）
    expect(host.session.toString()).toBe("【甲乙丙丁\n第二行");
    await scheduler.advance(20);
    expect(expectConverged([editor, guest])).toBe("【甲乙丙丁\n第二行");
    // 编辑器收的那一半是一次远端事务
    const last = editor.log.filter((transaction) => transaction.docChanged).at(-1)!;
    expect(isCollabSync(last)).toBe(true);

    // CodeMirror 的恒等式：两边从 origin 各走一半，正文一样
    const origin = "甲乙丙\n第二行";
    const local = ChangeSet.of(fineEdits(origin, "甲乙丙丁\n第二行"), origin.length);
    const remote = ChangeSet.of(fineEdits(origin, "【甲乙丙\n第二行"), origin.length);
    const start = Text.of(origin.split("\n"));
    expect(local.compose(remote.map(local)).apply(start).toString()).toBe(
      remote.compose(local.map(remote, true)).apply(start).toString(),
    );
  });

  it("同一行上对方也在打字：两边的字都在，各在各的位置", async () => {
    const { scheduler, guest, editor } = lateRoom("今天开会讨论预算。");
    await scheduler.advance(20);
    // 对方在同一段里改了两处（隔开的）
    guest.view.dispatch({
      changes: [
        { from: 0, to: 1, insert: "明" },
        { from: 9, insert: "（定了）" },
      ],
      userEvent: "input.type",
    });
    await scheduler.advance(20);
    // 我在两处中间打字：整段当一个替换的话，「要」会被挪到替换的边上
    type(editor.view, 4, "要");
    editor.attach();
    await scheduler.advance(20);
    expect(expectConverged([editor, guest])).toBe("明天开会要讨论预算。（定了）");
  });

  it("编辑器比 origin 少字（删了）：删掉的照删，对方在那一段里插的字留着", async () => {
    const { scheduler, guest, editor } = lateRoom("一二三四五六");
    await scheduler.advance(20);
    type(guest.view, 3, "X");
    await scheduler.advance(20);
    editor.view.dispatch({ changes: { from: 2, to: 4 }, userEvent: "delete.backward" });
    editor.attach();
    await scheduler.advance(20);
    expect(expectConverged([editor, guest])).toBe("一二X五六");
  });

  it("挂上以后、派发之前：又来了远端的字、自己又打了字，都对得上", async () => {
    const { scheduler, host, guest, editor } = lateRoom("abc\ndef");
    await scheduler.advance(20);
    type(guest.view, 0, "1");
    await scheduler.advance(20);
    type(editor.view, 3, "X");
    editor.attach();
    // 同一个任务里（派发在微任务里）：远端的字到了，编辑器里又打了一个
    host.session.insertText(host.session.text.length, "!");
    type(editor.view, editor.view.state.doc.length, "Y");
    expect(editor.view.state.doc.toString()).toBe("abcX\ndefY");
    await scheduler.advance(20);
    // 同一处两边都插了字：本机的在前
    expect(expectConverged([editor, guest])).toBe("1abcX\ndefY!");
  });

  it("光标跟着映射：还在自己打的字后面", async () => {
    const { scheduler, guest, editor } = lateRoom("abc\ndef");
    await scheduler.advance(20);
    type(guest.view, 0, "123");
    await scheduler.advance(20);
    type(editor.view, 3, "X");
    expect(editor.view.state.selection.main.head).toBe(4);
    editor.attach();
    await scheduler.advance(20);
    expect(editor.view.state.doc.toString()).toBe("123abcX\ndef");
    expect(editor.view.state.selection.main.head).toBe(7);
  });

  it("对齐那一步不进撤销历史；挂上之前自己打的字还能撤销，撤销也同步出去", async () => {
    const { scheduler, guest, editor } = lateRoom("甲乙丙");
    await scheduler.advance(20);
    type(guest.view, 0, "【");
    await scheduler.advance(20);
    type(editor.view, 3, "丁");
    editor.attach();
    await scheduler.advance(20);
    expect(expectConverged([editor, guest])).toBe("【甲乙丙丁");

    expect(undo(editor.view)).toBe(true);
    await scheduler.advance(20);
    // 撤掉的是自己的「丁」，对方的「【」还在
    expect(expectConverged([editor, guest])).toBe("【甲乙丙");
    // 再撤就没有了：对齐的那一步不在历史里
    expect(undo(editor.view)).toBe(false);
    expect(editor.view.state.doc.toString()).toBe("【甲乙丙");
  });

  it("origin 只用一次：第二个编辑器挂同一份会话，不再拿它算一遍", async () => {
    const { scheduler, host, guest, editor, late } = lateRoom("甲乙丙");
    await scheduler.advance(20);
    type(editor.view, 3, "丁");
    editor.attach();
    await scheduler.advance(20);
    expect(host.session.takeOrigin()).toBeNull();
    type(guest.view, 4, "戊");
    await scheduler.advance(20);
    expect(host.session.toString()).toBe("甲乙丙丁戊");

    // 换了一栏、切走再切回来：新的编辑器拿的是挂上之前那份正文
    editor.view.destroy();
    views.splice(views.indexOf(editor.view), 1);
    const second = late("甲乙丙丁");
    second.attach();
    await scheduler.advance(20);
    // 以会话为准（再算一遍的话「丁」会多出一个）
    expect(expectConverged([second, guest])).toBe("甲乙丙丁戊");
  });

  it("没有 origin：以会话为准，只换不一样的那几处，不往会话里写", async () => {
    const { scheduler, host, guest, editor } = lateRoom("开头\n中间\n结尾", false);
    await scheduler.advance(20);
    type(guest.view, 2, "（访客）");
    await scheduler.advance(20);
    const sent = host.session.stateVector();
    editor.view.dispatch({ selection: { anchor: 7 } });
    editor.attach();
    await scheduler.advance(20);
    expect(expectConverged([editor, guest])).toBe("开头（访客）\n中间\n结尾");
    expect(host.session.coveredBy(sent)).toBe(true);
    // 不是整篇换掉：光标跟着映射到原来那个字后面
    expect(editor.view.state.selection.main.head).toBe(7 + "（访客）".length);
  });

  it("挂上的那一刻正在组字、对方改了组字那一行：拼音不发出去，组字不被打断，上屏后一起进来", async () => {
    const { scheduler, host, guest, editor } = lateRoom("甲\n乙");
    await scheduler.advance(20);
    type(guest.view, 0, "【");
    type(guest.view, guest.view.state.doc.length, "（远端）");
    await scheduler.advance(20);
    const seen = watch(guest.view);

    const end = startComposing(editor.view, 1, "shi");
    editor.attach();
    await scheduler.advance(30);
    // 组字那一行有对方的改动：先不派发，编辑器里还是组字时的样子
    expect(editor.view.compositionStarted).toBe(true);
    expect(editor.view.state.doc.toString()).toBe("甲shi\n乙");
    // 正文里有了（只写不发）
    expect(host.session.toString()).toBe("【甲shi\n乙（远端）");
    expect(guest.view.state.doc.toString()).toBe("【甲\n乙（远端）");

    fire(editor.view, "compositionend");
    editor.view.dispatch({
      changes: { from: 1, to: end, insert: "是" },
      selection: { anchor: 2 },
      userEvent: "input.type.compose",
    });
    await scheduler.advance(80);
    expect(expectConverged([editor, guest])).toBe("【甲是\n乙（远端）");
    expect(seen.some((text) => text.includes("shi"))).toBe(false);
  });

  it("挂上的那一刻正在组字、对方改的是别的行：当场进来，组字照旧", async () => {
    const { scheduler, guest, editor } = lateRoom("甲\n乙");
    await scheduler.advance(20);
    type(guest.view, guest.view.state.doc.length, "（远端）");
    await scheduler.advance(20);
    const seen = watch(guest.view);

    const end = startComposing(editor.view, 1, "shi");
    editor.attach();
    await scheduler.advance(30);
    expect(editor.view.state.doc.toString()).toBe("甲shi\n乙（远端）");
    expect(editor.view.compositionStarted).toBe(true);

    fire(editor.view, "compositionend");
    editor.view.dispatch({
      changes: { from: 1, to: end, insert: "是" },
      selection: { anchor: 2 },
      userEvent: "input.type.compose",
    });
    await scheduler.advance(80);
    expect(expectConverged([editor, guest])).toBe("甲是\n乙（远端）");
    expect(seen.some((text) => text.includes("shi"))).toBe(false);
  });
});
