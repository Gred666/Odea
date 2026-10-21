/**
 * 平台判断，只为了把快捷键提示写对。
 *
 * WebView2 / WKWebView 里 userAgentData 不一定有，navigator.platform 虽然被标了
 * deprecated 但两边都还在返回值，所以按「新的优先、旧的兜底」取。
 * 判断结果在进程内不会变，算一次存成常量就行。
 */
const platform =
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
  navigator.platform ??
  "";

export const isMac = /mac/i.test(platform);
export const IS_WINDOWS = /win/i.test(platform);

/** 主修饰键的显示名：mac 上是 ⌘，其余平台是 Ctrl。 */
export const MOD_KEY = isMac ? "⌘" : "Ctrl";

/**
 * 拼一个能直接显示给用户看的组合键。
 * mac 上 ⌘ 和字母是连写的（⌘K），Windows 习惯带分隔（Ctrl K）。
 */
export function shortcut(key: string): string {
  return isMac ? `${MOD_KEY}${key}` : `${MOD_KEY} ${key}`;
}
