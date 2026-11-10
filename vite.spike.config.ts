// CEF 试验（spike/cef）的开发服务器：worktree 的 node_modules 是接到主目录那份的 junction，
// loro 的 .wasm 真实路径在主目录的 node_modules 底下，出了 Vite 的允许范围（403、协作实验台起不来）。
// 这里放开文件访问限制，其余照 vite.config.ts
import { mergeConfig } from "vite";
import base from "./vite.config";

export default mergeConfig(base, { server: { fs: { strict: false } } });
