import { describe, expect, it } from "vitest";
import { useRelays } from "./relayStore";

/* 浏览器里走 mockNet：中继码 → relay.example.com（docs/协同编辑.md §6.4） */

describe("协作中继的删除", () => {
  // 应用里别的删除都能撤销；手滑删掉的那台带着令牌和证书指纹，得再找给中继码的人要一次（审查 2026-11-13 §5.9）
  it("deleting a relay can be undone with its code, until the dialog closes", async () => {
    useRelays.getState().openRelays();
    await useRelays.getState().inspect("odea://relay/mockaaaabbbbccccdddd");
    await useRelays.getState().confirmPending();
    const url = useRelays.getState().relays[0]!.url;

    await useRelays.getState().remove(url);
    expect(useRelays.getState().relays).toEqual([]);
    expect(useRelays.getState().removed).toMatchObject({ url, label: "团队的中继" });

    await useRelays.getState().undoRemove();
    expect(useRelays.getState().relays.map((relay) => relay.url)).toEqual([url]);
    expect(useRelays.getState().removed).toBeNull();

    // 关了对话框就作废
    await useRelays.getState().remove(url);
    useRelays.getState().close();
    expect(useRelays.getState().removed).toBeNull();
  });
});
