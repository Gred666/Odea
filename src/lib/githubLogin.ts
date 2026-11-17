import type { SyncAccount, SyncDeviceCode } from "@/lib/bindings";
import { useEffect, useRef } from "react";

/* ============================================================
   GitHub 设备码登录的前端一半：仓库窗口的同步对话框（components/SyncDialog.tsx）和
   启动器的「从同步仓库拉一份」（launcher/ClonePanel.tsx）共用。两边接的后端不一样，传进来。

   领一个码（交给 onCode 显示）→ 等用户在浏览器里确认。在点击里调，不放进 effect：
   StrictMode 下 effect 会跑两次，第二次去等时那次登录已经被第一次拿走了。

   `wanted` 说这次登录还要不要（对话框关了、点了返回 / 取消、又开始了一次，就不要了）。领码要好几秒
   （国内连 GitHub），这期间关对话框发的取消赶在码放进后端之前，什么都没取消：码回来时不要了就收回，
   不然后端会每 5 秒问一次 GitHub，问到码过期（15 分钟）
   ============================================================ */

/** 账号的类型两边不一样（仓库窗口的把托管方收窄成了 github / gitee），按调用方的来 */
export interface DeviceLogin<Account = SyncAccount> {
  start: () => Promise<SyncDeviceCode>;
  wait: () => Promise<Account>;
  cancel: () => Promise<void>;
}

/** 等登录时被取消（点了返回、关了对话框、又开始了一次新的）：不算错 */
export const loginCancelled = (message: string) => message.includes("取消");

export async function githubLogin<Account>(
  login: DeviceLogin<Account>,
  onCode: (code: SyncDeviceCode) => void,
  wanted: () => boolean,
): Promise<Account> {
  const code = await login.start();
  if (!wanted()) {
    await login.cancel();
    throw new Error("登录已取消");
  }
  onCode(code);
  const account = await login.wait();
  if (!wanted()) throw new Error("登录已取消");
  return account;
}

/**
 * 每开始一次登录领一个号（`begin` 返回的 `wanted`）；返回、取消（`drop`）、卸下时作废手上的号，
 * 后到的结果认不出是这一次的就不要
 */
export function useLoginAttempt() {
  const current = useRef(0);
  useEffect(
    () => () => {
      current.current += 1;
    },
    [],
  );
  return {
    begin: () => {
      current.current += 1;
      const mine = current.current;
      return () => current.current === mine;
    },
    drop: () => {
      current.current += 1;
    },
  };
}
