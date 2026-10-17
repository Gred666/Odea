/**
 * 动态表情（`:odea_fire:`）的 Unicode 替身。
 *
 * 设计稿在 editor/animatedEmojiSet.ts，跟编辑器一起按需加载。这里单独放一份
 * 「短码 → Unicode」的小表，列表摘要、目录这类主包里只显示文字的地方用它，
 * 不用把整套 SVG 拖进首屏。两边的 id 一一对应，单测守着。
 */
export const ANIMATED_EMOJI_FALLBACK: Readonly<Record<string, string>> = {
  smile: "😊",
  laugh: "😆",
  love: "❤️",
  sad: "😢",
  think: "💭",
  wow: "😮",
  done: "✅",
  fire: "🔥",
  rocket: "🚀",
  target: "🎯",
  idea: "💡",
  coffee: "☕",
  way: "🛣️",
  flag: "🚩",
  pin: "📍",
  bell: "🔔",
  hourglass: "⏳",
  write: "✍️",
  sun: "☀️",
  rain: "🌧️",
  moon: "🌙",
  sprout: "🌱",
  star: "⭐",
  party: "🎉",
  fish: "🐟",
  flat: "🛌",
  bald: "🧑‍🦲",
  offwork: "🏃",
  charge: "🔋",
  boba: "🧋",
  melon: "🍉",
  pigeon: "🕊️",
  lemon: "🍋",
  crack: "😵",
  "666": "666",
  soul: "👻",
  doge: "🐶",
  facepalm: "🤦",
  sweat: "😅",
  eyeroll: "🙄",
  sigh: "😮‍💨",
  like: "👍",
  cat: "🐱",
  duck: "🦆",
  panda: "🐼",
  snail: "🐌",
  chick: "🐣",
  hamster: "🐹",
};

/** 改名前插进去的 `:otw_fire:` 也认（editor/animatedEmoji.ts 的 LEGACY_SHORTCODE_PREFIX） */
const SHORTCODE_RE = /:(?:odea|otw)_([a-z0-9_]+):/gi;

/** 纯文本里的动态表情短码换成 Unicode：`冲 :odea_fire:` → `冲 🔥`。不认识的原样留着。 */
export function animatedEmojiText(text: string): string {
  if (!/:(?:odea|otw)_/i.test(text)) return text;
  return text.replace(
    SHORTCODE_RE,
    (code, id: string) => ANIMATED_EMOJI_FALLBACK[id.toLowerCase()] ?? code,
  );
}
