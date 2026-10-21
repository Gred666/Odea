import syntaxGuide from "@/content/guide/syntax.md?raw";
import { MarkdownEditor } from "@/editor/MarkdownEditor";
import { EditorView } from "@codemirror/view";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LoopbackHub, type LoopbackMember } from "../loopback";
import { type Peer, peerColor } from "../session";

/* ============================================================
   协作实验台（浏览器预览里打开 /?lab=collab，桌面端进不来）。

   P10.0 还不碰网络：同一个窗口里并排几个真的 MarkdownEditor，各自一个会话，经模拟网络
   （loopback.ts，星形、延迟带 ±20% 抖动）连着。用来在真浏览器里看体验 —— 别人的字和光标、
   名字标签、组字、撤销、断线重连 —— 也给 scripts/perf 里的脚本用：
     /?lab=collab&bot=1        访客一进来就开始每秒打 20 个字（perf.mjs 的 collab 场景）
     /?lab=collab&latency=80   单程延迟 80ms
     /?lab=collab&guests=2     两个访客
     /?lab=collab&doc=long     长文（语法全览重复 5 遍，约 65KB）
     /?lab=collab&view=host    只画主持人一栏（量性能：访客那一栏自己的排版不该算在主持人头上）

   脚本还可以用 window.__collabLab.typeHeadless(访客序号, 位置) 让机器人直接往那位访客的
   正文里打字（不经过编辑器，就像对方在另一台电脑上打），stopHeadless() 停下。
   ============================================================ */

const SAMPLE = `# 周会记录

这一页大家一起改。左边是主持人，右边是访客：在任意一边打字，另一边几乎同时出现。

## 本周

- [ ] 把协同编辑的编辑器绑定做完
- [ ] 模糊测试跑一万轮
- [x] 定下来用 Yjs 和 iroh

## 讨论

> 组字的时候别人的字先排队，上屏以后一起进来。

试试：在一边用输入法打一串中文，同时让另一边的机器人打字；在两边各撤销一次，看是不是只撤自己的。
`;

const NAMES = ["林夕", "Alex", "佐藤"];
const LATENCIES = [0, 20, 80, 250];
const BOT_TEXT = "我们把这一段改得更清楚一些，顺便补上下周要做的事。Then we sync again. ";

const params = new URLSearchParams(location.search);

function makePeer(index: number): Peer {
  const id = index === 0 ? "lab-host" : `lab-guest-${index}`;
  return { id, name: NAMES[index] ?? `访客${index}`, color: peerColor(id) };
}

interface Room {
  hub: LoopbackHub;
  members: LoopbackMember[];
  /** 机器人直接往某位访客的正文里打字，每秒 20 个，从 at 开始往后（光标也跟着发） */
  typeHeadless(guest: number, at: number): void;
  stopHeadless(): void;
}

function openRoom(guests: number, latency: { current: number }): Room {
  const hub = new LoopbackHub({
    latency: () => latency.current * (0.8 + Math.random() * 0.4),
  });
  const text = params.get("doc") === "long" ? Array(5).fill(syntaxGuide).join("\n\n") : SAMPLE;
  const members = [hub.host(makePeer(0), text)];
  for (let index = 1; index <= guests; index += 1) members.push(hub.join(makePeer(index)));
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopHeadless = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const typeHeadless = (guest: number, at: number) => {
    stopHeadless();
    const session = members[guest]!.session;
    let position = at;
    let index = 0;
    timer = setInterval(() => {
      const char = BOT_TEXT[index % BOT_TEXT.length]!;
      index += 1;
      session.insertText(Math.min(position, session.text.length), char);
      position += char.length;
      session.setLocalCursor(position);
    }, 50);
  };
  return { hub, members, typeHeadless, stopHeadless };
}

export function CollabLab() {
  const [latency, setLatency] = useState(() => Number(params.get("latency") ?? 20));
  const latencyRef = useRef(latency);
  latencyRef.current = latency;
  // 渲染里不能有副作用：StrictMode 会把初始化跑两遍、留第一遍的结果（useMemo 也一样）。
  // 多建的那一间没人用，也没开定时器，扔掉就是了；换人数在事件里关旧开新
  const [room, setRoom] = useState(() =>
    openRoom(Math.min(2, Math.max(1, Number(params.get("guests") ?? 1))), latencyRef),
  );
  const guests = room.members.length - 1;
  const changeGuests = (count: number) => {
    room.stopHeadless();
    room.hub.destroy();
    setRoom(openRoom(count, latencyRef));
  };
  const shown = params.get("view") === "host" ? room.members.slice(0, 1) : room.members;
  // 给 scripts/perf 里的脚本读各人的会话
  useEffect(() => {
    (window as { __collabLab?: Room }).__collabLab = room;
  }, [room]);

  // 所有人的正文一不一致（网络里还有东西在路上的时候当然不一致）
  const [synced, setSynced] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => {
      const texts = room.members.map((member) => member.session.toString());
      setSynced(texts.every((text) => text === texts[0]));
    }, 250);
    return () => clearInterval(timer);
  }, [room]);

  return (
    <div className="flex h-screen flex-col bg-canvas text-body">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-5 py-2.5 text-[13px]">
        <span className="font-semibold text-ink">协作实验台</span>
        <label className="flex items-center gap-2">
          单程延迟
          <select
            className="rounded border border-line bg-panel px-1.5 py-0.5"
            value={latency}
            onChange={(event) => setLatency(Number(event.target.value))}
          >
            {LATENCIES.map((value) => (
              <option key={value} value={value}>
                {value} ms
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          访客
          <select
            className="rounded border border-line bg-panel px-1.5 py-0.5"
            value={guests}
            onChange={(event) => changeGuests(Number(event.target.value))}
          >
            <option value={1}>1 个</option>
            <option value={2}>2 个</option>
          </select>
        </label>
        <span data-lab-synced={synced} className={synced ? "text-muted" : "text-faint"}>
          {synced ? "所有人一致" : "同步中…"}
        </span>
      </header>
      <div
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}
      >
        {shown.map((member, index) => (
          <Pane
            key={member.peer.id}
            hub={room.hub}
            member={member}
            bot={index === 1 && params.get("bot") === "1"}
          />
        ))}
      </div>
    </div>
  );
}

function Pane({ hub, member, bot }: { hub: LoopbackHub; member: LoopbackMember; bot: boolean }) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(true);
  const [typing, setTyping] = useState(bot);
  const noop = useCallback(() => {}, []);
  const save = useCallback(async () => {}, []);

  // 机器人：每秒 20 个字，打在自己的光标处（不抢焦点）
  useEffect(() => {
    if (!typing) return;
    let index = 0;
    const timer = setInterval(() => {
      const dom = paneRef.current?.querySelector<HTMLElement>(".cm-editor");
      const view = dom ? EditorView.findFromDOM(dom) : null;
      if (!view) return;
      const char = BOT_TEXT[index % BOT_TEXT.length]!;
      index += 1;
      const head = view.state.selection.main.head;
      view.dispatch({
        changes: { from: head, insert: char },
        selection: { anchor: head + char.length },
        userEvent: "input.type",
      });
    }, 50);
    return () => clearInterval(timer);
  }, [typing]);

  const toggleConnection = () => {
    if (connected) hub.disconnect(member);
    else hub.reconnect(member);
    setConnected(!connected);
  };

  return (
    <section
      ref={paneRef}
      data-lab-peer={member.peer.id}
      className="flex min-h-0 flex-col border-line border-r last:border-r-0"
    >
      <div className="flex items-center gap-3 border-b border-line px-5 py-2 text-[13px]">
        <span
          className={`odea-peer-${member.peer.color} flex items-center gap-1.5 font-medium text-ink`}
        >
          <span
            className="inline-block size-2 rounded-full"
            style={{ background: "var(--peer)" }}
          />
          {member.peer.name}
          <span className="font-normal text-faint">{member.host ? "主持人" : "访客"}</span>
        </span>
        <span className="flex-1" />
        {!member.host && (
          <button type="button" className="text-muted hover:text-ink" onClick={toggleConnection}>
            {connected ? "断线" : "重连"}
          </button>
        )}
        <button
          type="button"
          data-lab-bot
          className="text-muted hover:text-ink"
          onClick={() => setTyping((value) => !value)}
        >
          {typing ? "停下机器人" : "机器人打字"}
        </button>
      </div>
      <div data-doc-scroller className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-10 pb-10 pt-6">
          <MarkdownEditor
            initialMarkdown=""
            onSave={save}
            outlineItems={[]}
            onOutlineHandle={noop}
            collab={member.session}
          />
        </div>
      </div>
    </section>
  );
}

export function mountCollabLab(root: HTMLElement) {
  document.title = "协作实验台 · Odea";
  createRoot(root).render(
    <StrictMode>
      <CollabLab />
    </StrictMode>,
  );
}
