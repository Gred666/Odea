// 找没有可读名字的按钮：<button> / <motion.button> / role="button" 的元素，里面只有图标（或者什么都没有），
// 又没写 aria-label、aria-labelledby、title。读屏软件读到它们只会说「按钮」（docs/1110审查与研究.md §6）。
//
//   node scripts/a11y-names.mjs            列出来
//   node scripts/a11y-names.mjs --check    有的话退出码 1（CI 里用）
//
// 按「孩子里有没有字」判断：有文字、有 {表达式}（多半是字）就算有名字；只有大写开头的组件（图标）、
// 或者只有空白，就算没有。{表达式} 里放的是图标的话会漏判，宁可漏不错报。
// 确实不该有名字的（比如 aria-hidden 的装饰按钮），在那一行上面写 `// a11y-names-ignore: 原因`。
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "../src");
const check = process.argv.includes("--check");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

const NAMED = new Set(["aria-label", "aria-labelledby", "title"]);

function tagName(node) {
  return node.tagName.getText();
}

function attrs(node) {
  const map = new Map();
  for (const prop of node.attributes.properties) {
    if (ts.isJsxAttribute(prop)) map.set(prop.name.getText(), prop);
    // {...props} 展开的：可能带着名字，不判
    else if (ts.isJsxSpreadAttribute(prop)) map.set("...", prop);
  }
  return map;
}

function isButton(opening) {
  const name = tagName(opening);
  if (name === "button" || name === "motion.button") return true;
  const role = attrs(opening).get("role");
  return !!role && /"button"/.test(role.getText());
}

/** 表达式里是不是只有 JSX（图标）：`{open ? <A /> : <B />}`、`{x && <A />}`、`{<A />}` */
function onlyJsx(expression) {
  if (!expression) return true;
  if (ts.isParenthesizedExpression(expression)) return onlyJsx(expression.expression);
  if (ts.isJsxSelfClosingElement(expression)) return /^[A-Z]/.test(expression.tagName.getText());
  if (ts.isJsxElement(expression)) return !hasText(expression.children);
  if (ts.isConditionalExpression(expression)) return onlyJsx(expression.whenTrue) && onlyJsx(expression.whenFalse);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return onlyJsx(expression.right);
  if (expression.kind === ts.SyntaxKind.NullKeyword) return true;
  return false;
}

/** 孩子里有没有可能是字的东西 */
function hasText(children) {
  for (const child of children) {
    if (ts.isJsxText(child)) {
      if (child.getText().trim()) return true;
    } else if (ts.isJsxExpression(child)) {
      if (!onlyJsx(child.expression)) return true;
    } else if (ts.isJsxElement(child)) {
      const name = tagName(child.openingElement);
      // 小写开头的标签（span、div……）里再找
      if (/^[a-z]/.test(name) && hasText(child.children)) return true;
      // 自己写的组件（大写开头、不是图标那种自闭合的）：里面多半有字
      if (/^[A-Z]/.test(name) && child.children.length > 0) return true;
    } else if (ts.isJsxFragment(child)) {
      if (hasText(child.children)) return true;
    }
  }
  return false;
}

const findings = [];
for (const file of walk(ROOT)) {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = text.split("\n");
  const visit = (node) => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (opening && isButton(opening)) {
      const a = attrs(opening);
      const named = [...NAMED].some((key) => a.has(key)) || a.has("...");
      const hidden = a.get("aria-hidden");
      const children = ts.isJsxElement(node) ? node.children : [];
      if (!named && !(hidden && !/false/.test(hidden.getText())) && !hasText(children)) {
        const { line } = source.getLineAndCharacterOfPosition(opening.getStart());
        const above = lines[line - 1] ?? "";
        if (!above.includes("a11y-names-ignore")) {
          findings.push(`${path.relative(process.cwd(), file).split(path.sep).join("/")}:${line + 1}  <${tagName(opening)}>`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

for (const finding of findings) console.log(finding);
console.log(`${findings.length} 个按钮没有可读的名字`);
if (check && findings.length > 0) process.exit(1);
