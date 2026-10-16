use regex::{Regex, RegexBuilder};

pub use super::model::FindOptions;

/* ============================================================
搜正文用到的几样：全局搜索（commands::find_in_vault）的匹配器，以及索引时算好的摘要、字数。

全局搜索和 VS Code 的「在文件中查找」一样是纯文本匹配，不分词：输入的字在正文里原样出现就算命中，
三个开关（区分大小写 / 全词匹配 / 正则）的含义和编辑器里的查找面板（searchPanel.ts，
CodeMirror 的 SearchQuery）一致，从结果跳进文档后，篇内查找接着用同一个条件。

以前这里是 jieba 分词 + FTS5 全文索引：词典常驻 40 多 MB（2026-10-16 实测），可那套搜索
没有任何界面在用（技术方案 §6），2026-10-16 去掉了。
============================================================ */

/// 编译好的查找条件。不论哪种开关都编成一个正则：不是正则模式就先转义，
/// 不区分大小写交给正则的 Unicode 大小写折叠（和 JS 的 `iu` 一样，转小写会改变字节长度，不好换算位置）
pub struct Finder {
    re: Regex,
    whole_word: bool,
    /// 不是正则模式：可以整篇先过一遍再一行一行地找（见 may_match）
    literal: bool,
}

/// 全词匹配里算「词」的字符：和 CodeMirror 一样是 `[\p{Alphabetic}\p{Number}_]` ——
/// 汉字也算，所以全词搜「笔记」不会命中「写笔记本」，和编辑器里的查找面板一致
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

impl Finder {
    /// 空查询返回 Ok(None)；正则写错了返回 Err(给人看的原因)
    pub fn new(query: &str, options: FindOptions) -> std::result::Result<Option<Self>, String> {
        if query.is_empty() {
            return Ok(None);
        }
        let pattern = if options.regex {
            query.to_string()
        } else {
            regex::escape(query)
        };
        let re = RegexBuilder::new(&pattern)
            .case_insensitive(!options.case_sensitive)
            // 一行一行地搜：^ $ 是行首行尾
            .multi_line(true)
            // 防止写出来的正则编译成一个巨大的自动机
            .size_limit(1 << 22)
            .build()
            .map_err(|error| match error {
                regex::Error::Syntax(message) => {
                    // 原文最后一行是「error: …」，前面是带箭头的示意，界面上只放得下最后一行
                    let last = message.lines().rev().find(|line| !line.trim().is_empty());
                    last.unwrap_or("").trim().trim_start_matches("error: ").to_string()
                }
                regex::Error::CompiledTooBig(_) => "正则太复杂了".to_string(),
                _ => "正则写错了".to_string(),
            })?;
        Ok(Some(Self {
            re,
            whole_word: options.whole_word,
            literal: !options.regex,
        }))
    }

    /// 这篇正文里可能有命中吗：不是正则时先整篇找一遍，大多数不含这个词的文档就不用一行一行地看了。
    /// 正则不这么省：`\A`、`\z` 这类锚点在整篇和在一行里意思不一样
    pub fn may_match(&self, text: &str) -> bool {
        !self.literal || self.re.is_match(text)
    }

    /// 一行里的匹配（字节位置，不含空匹配），最多 limit 个；行里不该有换行
    pub fn find_in_line(&self, line: &str, limit: usize) -> Vec<(usize, usize)> {
        let mut found = Vec::new();
        let mut at = 0;
        while at <= line.len() && found.len() < limit {
            let Some(hit) = self.re.find_at(line, at) else { break };
            let (from, to) = (hit.start(), hit.end());
            if from == to || (self.whole_word && !word_bounded(line, from, to)) {
                // 空匹配（`^`、`a*`）不算；全词不成立的从下一个字再找 —— 不能从 to 接着找，
                // 「aab ab」里全词找「ab」，第一个候选失败后真正的那个可能和它重叠
                at = from + line[from..].chars().next().map_or(1, char::len_utf8);
                continue;
            }
            found.push((from, to));
            at = to;
        }
        found
    }
}

/// CodeMirror 的全词判断：匹配的两头，各自只要「外面那个字」和「里面那个字」不都是词字符就行
fn word_bounded(line: &str, from: usize, to: usize) -> bool {
    let word = |c: Option<char>| c.is_some_and(is_word_char);
    let before = line[..from].chars().next_back();
    let first = line[from..].chars().next();
    let last = line[..to].chars().next_back();
    let after = line[to..].chars().next();
    (!word(before) || !word(first)) && (!word(last) || !word(after))
}

/// 正文摘要：取纯文本前 n 个字符。
pub fn make_excerpt(md: &str, n: usize) -> String {
    let plain = strip_markdown(md);
    let mut out: String = plain.chars().take(n).collect();
    if plain.chars().count() > n {
        out.push('…');
    }
    out
}

/// 字数：中文按字算，英文按词算；裸网址算一个词。
pub fn count_words(md: &str) -> i64 {
    let plain = strip_markdown(md);
    let cjk = plain.chars().filter(|c| is_cjk(*c)).count();
    let words: usize = plain
        .split_whitespace()
        .map(|token| {
            if token.contains("://") {
                1
            } else {
                token
                    .split(|c: char| !c.is_ascii_alphanumeric())
                    .filter(|s| !s.is_empty())
                    .count()
            }
        })
        .sum();
    (cjk + words) as i64
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF)
}

/* ============================================================
摘要和字数用的纯文本。
只认最常见的写法，不追求完备 —— 但标记本身不能漏进去：以前 `- [x] 任务`
的摘要是「x 任务」，`[官网](https://…)` 是「官网https://…」，网址的每一段
还都各算一个字。前端 mock（src/lib/plainText.ts）按同一套规则实现。

整行跳过：front matter、围栏行、分隔线 / Setext 下划线、表格分隔行、
链接和缩写定义、`[TOC]`、callout 标签行、HTML 注释。
行首剥掉：引用、标题、列表符号、任务勾选框、脚注定义的 `[^id]:`。
行内：见 strip_inline。
============================================================ */

fn strip_markdown(md: &str) -> String {
    let lines: Vec<&str> = md.lines().collect();
    let mut out = String::with_capacity(md.len());
    let mut in_comment = false;

    for raw in &lines[front_matter_len(&lines)..] {
        let mut line = raw.trim();
        if in_comment {
            let Some(end) = line.find("-->") else {
                continue;
            };
            in_comment = false;
            line = line[end + 3..].trim();
        }
        if let Some(start) = line.find("<!--") {
            if !line[start..].contains("-->") {
                in_comment = true;
                line = line[..start].trim();
            }
        }
        if is_markup_only_line(line) {
            continue;
        }

        let mut text = strip_inline(strip_line_prefix(line));
        if line.starts_with('|') {
            text = text.replace('|', " ");
        }
        for word in text.split_whitespace() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(word);
        }
    }
    out
}

/// 文档开头的 YAML front matter 占几行。规则和编辑器（editor/frontMatter.ts）一致：
/// 第一行 `---`，60 行以内以 `---` 收尾，中间至少有一行 `key: value`。
fn front_matter_len(lines: &[&str]) -> usize {
    let is_fence = |line: &str| line.trim_end() == "---";
    if lines.len() < 3 || !is_fence(lines[0]) {
        return 0;
    }
    let mut saw_key = false;
    for (index, line) in lines.iter().enumerate().take(60).skip(1) {
        if is_fence(line) {
            return if saw_key { index + 1 } else { 0 };
        }
        saw_key |= is_yaml_key(line);
    }
    0
}

fn is_yaml_key(line: &str) -> bool {
    let mut chars = line.chars();
    if !chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
    {
        return false;
    }
    chars
        .as_str()
        .trim_start_matches(|c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        .trim_start()
        .starts_with(':')
}

/// 整行都是标记、没有可读文字的行。
fn is_markup_only_line(line: &str) -> bool {
    let only = |allowed: &[char]| !line.is_empty() && line.chars().all(|c| allowed.contains(&c));
    line.starts_with("```")
        || line.starts_with("~~~")
        // 分隔线、Setext 下划线
        || only(&['-', '*', '_', '=', ' ', '\t'])
        // 表格分隔行 `|---|:---:|`
        || (line.starts_with('|') && only(&['|', '-', ':', ' ', '\t']))
        // callout 标签行 `> [!核心判断]`
        || (line.starts_with('>')
            && line
                .trim_start_matches(['>', ' ', '\t'])
                .starts_with("[!"))
        || line.eq_ignore_ascii_case("[toc]")
        || line.eq_ignore_ascii_case("[[toc]]")
        || is_definition(line)
}

/// 链接定义 `[标签]: 地址` 和缩写定义 `*[HTML]: …`。脚注定义 `[^1]: …` 的正文要留着。
fn is_definition(line: &str) -> bool {
    let rest = line.strip_prefix('*').unwrap_or(line);
    let Some(rest) = rest.strip_prefix('[') else {
        return false;
    };
    !rest.starts_with('^')
        && rest
            .find("]:")
            .is_some_and(|end| !rest[..end].contains(['[', ']']))
}

/// 行首的块级标记：引用（可嵌套）、标题、列表符号、任务勾选框、脚注定义。
fn strip_line_prefix(line: &str) -> &str {
    let mut line = line.trim_start();
    while let Some(rest) = line.strip_prefix('>') {
        line = rest.trim_start();
    }

    let hashes = line.len() - line.trim_start_matches('#').len();
    if (1..=6).contains(&hashes)
        && line[hashes..]
            .chars()
            .next()
            .map_or(true, char::is_whitespace)
    {
        let text = line[hashes..].trim();
        // `## 标题 ##` 的收尾井号；`## C#` 里的不算（前面没有空格）
        let unclosed = text.trim_end_matches('#');
        return if unclosed.is_empty() || unclosed.ends_with(char::is_whitespace) {
            unclosed.trim_end()
        } else {
            text
        };
    }

    line = strip_list_marker(line);
    for task in ["[ ]", "[x]", "[X]"] {
        if let Some(rest) = line.strip_prefix(task) {
            if rest.is_empty() || rest.starts_with(char::is_whitespace) {
                line = rest.trim_start();
                break;
            }
        }
    }
    if line.starts_with("[^") {
        if let Some(end) = line.find("]:") {
            line = line[end + 2..].trim_start();
        }
    }
    line
}

/// `- ` / `* ` / `+ ` / `1. ` / `1) `
fn strip_list_marker(line: &str) -> &str {
    let digits = line.len() - line.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let marker = match line[digits..].chars().next() {
        Some('-' | '*' | '+') if digits == 0 => 1,
        Some('.' | ')') if (1..=9).contains(&digits) => digits + 1,
        _ => return line,
    };
    let rest = &line[marker..];
    if rest.is_empty() || rest.starts_with(char::is_whitespace) {
        rest.trim_start()
    } else {
        line
    }
}

/// 行内标记：图片留 alt，链接留文字，双链留别名（没有别名就是目标），行内代码
/// 留原文，脚注引用、HTML 标签和注释去掉，强调 / 删除线 / 高亮的符号去掉。
fn strip_inline(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        let step = match c {
            '\\' => escaped(rest),
            '`' => Some(code_span(rest)),
            '!' if rest[1..].starts_with('[') => {
                link_like(&rest[1..]).map(|(label, after)| (image_alt(label).to_string(), after))
            }
            '[' => wiki_link(rest)
                .or_else(|| footnote_ref(rest))
                .or_else(|| link_like(rest).map(|(label, after)| (strip_inline(label), after))),
            '<' => html(rest),
            '*' => Some((String::new(), &rest[1..])),
            '~' | '=' | '_' if rest[1..].starts_with(c) => Some((String::new(), &rest[2..])),
            _ => None,
        };
        match step {
            Some((kept, after)) => {
                out.push_str(&kept);
                rest = after;
            }
            None => {
                out.push(c);
                rest = &rest[c.len_utf8()..];
            }
        }
    }
    out
}

/// `\*` → `*`
fn escaped(rest: &str) -> Option<(String, &str)> {
    let next = rest[1..]
        .chars()
        .next()
        .filter(char::is_ascii_punctuation)?;
    Some((next.to_string(), &rest[1 + next.len_utf8()..]))
}

/// 行内代码原样留下（里面的 `*`、`==` 不是标记）；没闭合就只去掉反引号。
fn code_span(rest: &str) -> (String, &str) {
    let ticks = rest.len() - rest.trim_start_matches('`').len();
    let body = &rest[ticks..];
    match body.find(&rest[..ticks]) {
        Some(end) => (body[..end].trim().to_string(), &body[end + ticks..]),
        None => (String::new(), body),
    }
}

/// `[文字](地址)` / `[文字][标签]`：返回文字和之后的剩余部分。
/// 后面既不是 `(` 也不是 `[` 的方括号只是普通文字，返回 None。
fn link_like(rest: &str) -> Option<(&str, &str)> {
    let close = matching(rest, '[', ']')?;
    let label = &rest[1..close];
    let after = &rest[close + 1..];
    if after.starts_with('(') {
        let end = matching(after, '(', ')')?;
        Some((label, &after[end + 1..]))
    } else if after.starts_with('[') {
        let end = after.find(']')?;
        Some((label, &after[end + 1..]))
    } else {
        None
    }
}

/// `s` 以 open 开头，返回和它配对的 close 的位置（允许嵌套）。
fn matching(s: &str, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    for (index, c) in s.char_indices() {
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

/// Obsidian 式尺寸 `![alt|300]` / `![alt|300x200]` 不算 alt。
fn image_alt(label: &str) -> &str {
    match label.rsplit_once('|') {
        Some((alt, size))
            if !size.is_empty() && size.chars().all(|c| c.is_ascii_digit() || c == 'x') =>
        {
            alt.trim()
        }
        _ => label.trim(),
    }
}

fn wiki_link(rest: &str) -> Option<(String, &str)> {
    let body = rest.strip_prefix("[[")?;
    let end = body.find("]]")?;
    let inner = &body[..end];
    let shown = inner.split_once('|').map_or(inner, |(_, alias)| alias);
    Some((shown.trim().to_string(), &body[end + 2..]))
}

fn footnote_ref(rest: &str) -> Option<(String, &str)> {
    let body = rest.strip_prefix("[^")?;
    let end = body.find(']')?;
    Some((String::new(), &body[end + 1..]))
}

/// HTML 注释和标签去掉（`<br>` 换成空格），`<https://…>` / `<a@b.c>` 留地址。
/// 不像标签的 `<`（`a < b`）照原样留下。
fn html(rest: &str) -> Option<(String, &str)> {
    if let Some(body) = rest.strip_prefix("<!--") {
        let end = body.find("-->")?;
        return Some((String::new(), &body[end + 3..]));
    }
    let end = rest.find('>')?;
    let inner = &rest[1..end];
    let after = &rest[end + 1..];
    if !inner.is_empty()
        && !inner.contains(char::is_whitespace)
        && (inner.contains("://") || inner.contains('@'))
    {
        return Some((inner.to_string(), after));
    }
    let name = inner.strip_prefix('/').unwrap_or(inner);
    if !name.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return None;
    }
    let tag: String = name
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .collect();
    let kept = if tag.eq_ignore_ascii_case("br") {
        " "
    } else {
        ""
    };
    Some((kept.to_string(), after))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hits(query: &str, options: FindOptions, line: &str) -> Vec<(usize, usize)> {
        Finder::new(query, options).unwrap().unwrap().find_in_line(line, usize::MAX)
    }

    const PLAIN: FindOptions = FindOptions {
        case_sensitive: false,
        whole_word: false,
        regex: false,
    };

    #[test]
    fn finder_matches_text_literally_and_ignores_case_by_default() {
        assert_eq!(hits("a.b", PLAIN, "axb a.b"), vec![(4, 7)]);
        assert_eq!(hits("hello", PLAIN, "HeLLo hello"), vec![(0, 5), (6, 11)]);
        assert_eq!(hits("äb", PLAIN, "ÄB"), vec![(0, 3)]);
        let exact = FindOptions { case_sensitive: true, ..PLAIN };
        assert_eq!(hits("hello", exact, "HeLLo hello"), vec![(6, 11)]);
        assert!(Finder::new("", PLAIN).unwrap().is_none());
    }

    #[test]
    fn finder_whole_word_follows_codemirror() {
        let word = FindOptions { whole_word: true, ..PLAIN };
        // 第一个候选（aab 里的 ab）不成立，真正的那个要从下一个字接着找才找得到
        assert_eq!(hits("ab", word, "aab ab"), vec![(4, 6)]);
        assert_eq!(hits("ab", word, "ab_c ab1 (ab)"), vec![(10, 12)]);
        // 汉字也是词字符
        assert!(hits("笔记", word, "写笔记本").is_empty());
        assert_eq!(hits("笔记", word, "「笔记」").len(), 1);
        // 查询两头不是词字符时，那一头不用看边界
        assert_eq!(hits(" b", word, "a bc"), vec![]);
        assert_eq!(hits(" b", word, "a b c"), vec![(1, 3)]);
    }

    #[test]
    fn finder_regex_skips_empty_matches() {
        let regex = FindOptions { regex: true, ..PLAIN };
        assert_eq!(hits(r"\d+", regex, "a12b345"), vec![(1, 3), (4, 7)]);
        assert_eq!(hits("x*", regex, "axxb"), vec![(1, 3)]);
        assert!(hits("^", regex, "abc").is_empty());
        assert_eq!(hits("^ab", regex, "abab"), vec![(0, 2)]);
        let reason = Finder::new("(a", regex).err().unwrap();
        assert!(!reason.is_empty() && !reason.contains('\n'), "{reason}");
        // limit
        assert_eq!(
            Finder::new("a", PLAIN).unwrap().unwrap().find_in_line("aaaa", 2),
            vec![(0, 1), (1, 2)]
        );
    }

    #[test]
    fn finder_prefilter_is_skipped_for_regex_anchors() {
        let regex = FindOptions { regex: true, ..PLAIN };
        let finder = Finder::new(r"\Ab", regex).unwrap().unwrap();
        // 整篇的开头不是 b，可第二行的开头是：不能拿整篇先过一遍
        assert!(finder.may_match("a\nb"));
        assert_eq!(finder.find_in_line("b", 10), vec![(0, 1)]);
        assert!(!Finder::new("zz", PLAIN).unwrap().unwrap().may_match("a\nb"));
    }

    #[test]
    fn counts_mixed_cn_en() {
        // 「今天写了」4 字 + code / review 2 词
        assert_eq!(count_words("今天写了 code review"), 6);
    }

    #[test]
    fn excerpt_skips_callout_labels_and_markers() {
        let md = "## 标题\n\n> [!核心判断]\n> 结论在这里\n\n正文第一句。";
        let e = make_excerpt(md, 100);
        assert!(!e.contains("[!"), "callout 标签漏进摘要: {e}");
        assert!(!e.contains('#'), "标题标记漏进摘要: {e}");
        assert!(e.contains("正文第一句"), "正文丢了: {e}");
    }

    #[test]
    fn excerpt_is_plain_text() {
        for (md, expected) in [
            (
                "- [x] 已完成的任务\n- [ ] 待办事项",
                "已完成的任务 待办事项",
            ),
            ("1. 第一步\n2) 第二步", "第一步 第二步"),
            ("见 [官网](https://example.com/a_(b)) 说明", "见 官网 说明"),
            ("![截图|300x200](C:/img/a.png) 和 ![](b.png)", "截图 和"),
            (
                "[[目标笔记|别名]] 与 [[另一篇#小节]]",
                "别名 与 另一篇#小节",
            ),
            (
                "<b>粗体</b>第一行<br>第二行 <https://x.dev> <!-- 备注 -->",
                "粗体第一行 第二行 https://x.dev",
            ),
            (
                "**强调** ==高亮== ~~删除~~ __粗__ `a == b` \\*字面\\*",
                "强调 高亮 删除 粗 a == b *字面*",
            ),
            ("正文[^1]\n\n[^1]: 脚注内容", "正文 脚注内容"),
            ("## 标题 ##\n## C#\n#话题", "标题 C# #话题"),
            (
                "> > 嵌套引用\n> - [ ] 引用里的任务",
                "嵌套引用 引用里的任务",
            ),
            (
                "| 名称 | 数量 |\n|---|:-:|\n| 苹果 | 3 |",
                "名称 数量 苹果 3",
            ),
            ("[草稿] 方括号只是文字 a < b", "[草稿] 方括号只是文字 a < b"),
        ] {
            assert_eq!(make_excerpt(md, 200), expected, "输入: {md:?}");
        }
    }

    #[test]
    fn excerpt_skips_markup_only_lines() {
        let md = "---\ntitle: 周报\ntags: [a]\n---\n[TOC]\n\n```rust\nfn main() {}\n```\n\n\
                  ***\n\n标题\n===\n\n[官网]: https://example.com\n*[HTML]: HyperText\n\n\
                  <!--\n多行注释\n-->\n正文";
        assert_eq!(make_excerpt(md, 200), "fn main() {} 标题 正文");
    }

    /// 以分隔线开头、却不是 front matter 的普通笔记：别把正文当 YAML 吃掉
    #[test]
    fn leading_rule_is_not_front_matter() {
        assert_eq!(make_excerpt("---\n正文\n---\n后面", 200), "正文 后面");
    }

    #[test]
    fn link_urls_do_not_inflate_word_count() {
        assert_eq!(count_words("[官网](https://example.com/a/b/c)"), 2);
        assert_eq!(count_words("裸网址 https://example.com/a/b/c"), 4);
        assert_eq!(count_words("- [x] done task"), 2);
    }

    #[test]
    fn excerpt_truncates_with_ellipsis() {
        let e = make_excerpt("一二三四五六七八九十", 5);
        assert_eq!(e, "一二三四五…");
    }
}
