/* ============================================================
   命令面板够到「当前的编辑器」：正文编辑器挂上时登记，获得焦点时排到最前，卸载时注销。
   命令面板不在编辑器的分包里，不能直接引用 CodeMirror 的东西，只经过这里。
   ============================================================ */

export type EditorCommand = "fold-all" | "unfold-all";

type Runner = (command: EditorCommand) => boolean;

/** 最近获得焦点（或最近挂上）的在最后 */
const runners: Runner[] = [];

export function registerEditorCommands(run: Runner): { focus: () => void; dispose: () => void } {
  runners.push(run);
  return {
    focus() {
      const index = runners.indexOf(run);
      if (index < 0 || index === runners.length - 1) return;
      runners.splice(index, 1);
      runners.push(run);
    },
    dispose() {
      const index = runners.indexOf(run);
      if (index >= 0) runners.splice(index, 1);
    },
  };
}

/** 交给当前的编辑器；没有编辑器、或者它没什么可做的，返回 false */
export function runEditorCommand(command: EditorCommand): boolean {
  return runners.at(-1)?.(command) ?? false;
}
