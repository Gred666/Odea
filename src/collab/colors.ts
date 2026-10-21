/* 协作者的颜色：从固定的色板里按 id（设备公钥）算，同一个人在谁那里都是同一个颜色。
   单独一个文件：主包里的东西（协作的状态、成员列表）要用它，又不该把 Loro 拉进主包 */

/** 色板有几种颜色（globals.css 的 --color-peer-0 … --color-peer-7，亮、暗各一套） */
export const PEER_COLORS = 8;

export function peerColor(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % PEER_COLORS;
}
