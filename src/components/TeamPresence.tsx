import type { DocumentModel } from "@/data/types";
import { teamDocId, useTeam } from "@/team/store";
import { PeerAvatar } from "./CollabDialog";

/**
 * 团队仓库里别人也开着这一篇（docs/协同编辑.md §22.4）：标题那一行右端「小王 也在看」，和协作标签
 * 同一个位置。在一份会话里时改动实时同步；还在连的时候悬停说一句。出现、消失都不做动画
 */
export function TeamPresence({ doc }: { doc: DocumentModel }) {
  const id = teamDocId(doc);
  const peers = useTeam((s) => s.peers);
  // 在不在一个会话里、谁存盘：undefined = 还在连
  const remote = useTeam((s) => (id ? s.sessions[id]?.remote : undefined));
  if (!id) return null;
  const viewers = peers.filter((peer) => peer.online && peer.docs.some((item) => item.doc === id));
  if (!viewers.length) return null;
  const names = [...new Set(viewers.map((peer) => peer.name))];
  const text =
    names.length <= 2 ? `${names.join("、")} 也在看` : `${names[0]} 等 ${names.length} 人也在看`;
  return (
    <span
      data-team-presence
      title={
        remote === undefined
          ? "正在连上他那边…"
          : remote
            ? "一起编辑：改动实时同步，他那边存盘"
            : "一起编辑：改动实时同步，你这边存盘"
      }
      className="-my-[5px] ml-auto flex h-[30px] shrink-0 items-center gap-2 px-2 text-[12px] text-muted"
    >
      <span className="flex -space-x-1.5">
        {viewers.slice(0, 4).map((peer) => (
          <PeerAvatar key={peer.id} id={peer.id} name={peer.name} ring />
        ))}
      </span>
      <span className="max-w-[200px] truncate">{text}</span>
    </span>
  );
}
