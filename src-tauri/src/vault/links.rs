/* ============================================================
正文里的 `[[双链]]`：反向链接面板用（Vault::backlinks），改标题时改写别处的链接（retarget）。

和编辑器（src/editor/links.ts 的 wikiTargetAt / splitWikiTarget）认同一套写法：
  [[标题]]  [[标题|别名]]  [[标题#小节]]  [[标题^块id]]
目标按标题匹配，去掉首尾空白、不分大小写。围栏代码块和行内代码里的不算。
============================================================ */

/// 正文里的一处双链
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiLink {
    /// 正文里的行号（从 0 开始，不含属性块）
    pub line: usize,
    /// 目标笔记的标题（去掉了 `|别名`、`#小节`、`^块`）
    pub title: String,
}

/// 一处双链里标题那一段在正文里的位置（字节，不含两头的空白、`|别名`、`#小节`、`^块`）
struct Span {
    line: usize,
    start: usize,
    end: usize,
}

/// 一篇正文里所有的双链，按出现顺序
pub fn wikilinks(body: &str) -> Vec<WikiLink> {
    spans(body)
        .into_iter()
        .map(|span| WikiLink {
            line: span.line,
            title: body[span.start..span.end].to_string(),
        })
        .collect()
}

/// 标题能不能原样写进 `[[…]]`：`[` `]` 会把链接拆断，`|` `#` `^` 会被当成别名、小节、块
pub fn linkable(title: &str) -> bool {
    let title = title.trim();
    !title.is_empty() && !title.contains(['[', ']', '|', '#', '^', '\n', '\r'])
}

/// 把正文里链到 `old` 的双链改成链到 `new`：只换标题那一段，`|别名`、`#小节`、`^块` 和两头的空白
/// 原样留着；代码里的、转义的不动。返回改过的正文和改了几处；一处都没有返回 None
pub fn retarget(body: &str, old: &str, new: &str) -> Option<(String, usize)> {
    let hits: Vec<Span> = spans(body)
        .into_iter()
        .filter(|span| same_title(&body[span.start..span.end], old))
        .collect();
    if hits.is_empty() {
        return None;
    }
    let new = new.trim();
    let mut out = String::with_capacity(body.len() + hits.len() * new.len());
    let mut at = 0;
    for span in &hits {
        out.push_str(&body[at..span.start]);
        out.push_str(new);
        at = span.end;
    }
    out.push_str(&body[at..]);
    Some((out, hits.len()))
}

/// 不在围栏代码块里的行（开头、结尾那两行也不算）：（第几行，这一行在正文里的字节位置，这一行）
fn prose_lines(body: &str) -> impl Iterator<Item = (usize, usize, &str)> {
    let mut fence: Option<(char, usize)> = None;
    let mut offset = 0;
    body.split('\n').enumerate().filter_map(move |(index, line)| {
        let line_start = offset;
        offset += line.len() + 1;
        let trimmed = line.trim_start_matches(' ');
        let indent = line.len() - trimmed.len();
        if indent <= 3 {
            if let Some(marker) = fence_marker(trimmed) {
                match fence {
                    None => {
                        fence = Some(marker);
                        return None;
                    }
                    Some((ch, len)) if marker.0 == ch && marker.1 >= len && is_closing(trimmed) => {
                        fence = None;
                        return None;
                    }
                    _ => {}
                }
            }
        }
        fence.is_none().then_some((index, line_start, line))
    })
}

/// 正文去掉代码：围栏代码块整段拿掉、行内代码换成空格。标签、待办这些不认代码里写的
pub fn without_code(body: &str) -> String {
    prose_lines(body)
        .map(|(_, _, line)| without_code_spans(line))
        .collect::<Vec<_>>()
        .join("\n")
}

fn spans(body: &str) -> Vec<Span> {
    let mut out = Vec::new();
    for (index, line_start, line) in prose_lines(body) {
        if !line.contains("[[") {
            continue;
        }
        // 行内代码换成了等长的空格，字节位置和原来那一行一一对应
        for (start, end) in links_in_line(&without_code_spans(line)) {
            out.push(Span {
                line: index,
                start: line_start + start,
                end: line_start + end,
            });
        }
    }
    out
}

/// 目标标题在 `[[` `]]` 之间那段原文里的位置（去掉两头空白）：
/// `标题|别名` → 标题，`标题#小节` / `标题^块` → 标题
fn title_range(inner: &str) -> (usize, usize) {
    let target = inner.split('|').next().unwrap_or("");
    let cut = [target.find('#'), target.find('^')]
        .into_iter()
        .flatten()
        .filter(|&index| index > 0)
        .min()
        .unwrap_or(target.len());
    let segment = &target[..cut];
    let start = segment.len() - segment.trim_start().len();
    (start, start + segment.trim().len())
}

/// 两篇标题是不是同一篇（和编辑器里 Mod+点击跳转的规则一样）
pub fn same_title(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// 一行里每处双链的标题在这一行里的位置（字节）
fn links_in_line(line: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut base = 0;
    while let Some(start) = line[base..].find("[[") {
        let open = base + start;
        let after = &line[open + 2..];
        let Some(end) = after.find("]]") else {
            break;
        };
        let inner = &after[..end];
        // `[[a [b] c]]` 这类嵌套不是双链；`\[[` 是转义
        let escaped = open > 0 && line.as_bytes()[open - 1] == b'\\';
        if !inner.contains('[') && !inner.contains(']') && !escaped {
            let (from, to) = title_range(inner);
            if from < to {
                out.push((open + 2 + from, open + 2 + to));
            }
        }
        base = open + 2 + end + 2;
    }
    out
}

/// 去掉行内代码（成对的反引号串之间的内容），换成空格，位置不变
fn without_code_spans(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'`' {
            let run = bytes[index..].iter().take_while(|&&b| b == b'`').count();
            let ticks = &line[index..index + run];
            if let Some(close) = line[index + run..].find(ticks) {
                let end = index + run + close + run;
                out.push_str(&" ".repeat(end - index));
                index = end;
                continue;
            }
            out.push_str(ticks);
            index += run;
            continue;
        }
        let ch = line[index..].chars().next().unwrap_or(' ');
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

/// 围栏代码块的开头 / 结尾：三个以上的 ``` 或 ~~~
fn fence_marker(line: &str) -> Option<(char, usize)> {
    let ch = line.chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let len = line.chars().take_while(|&c| c == ch).count();
    (len >= 3).then_some((ch, len))
}

fn is_closing(line: &str) -> bool {
    let ch = line.chars().next().unwrap_or(' ');
    line.trim_start_matches(ch).trim().is_empty()
}

/// 反向链接里给人看的那一行：去掉列表符号、任务框、引用和标题的井号，
/// 太长的截出链接附近的一段。
pub fn context_line(line: &str, title: &str) -> String {
    let mut text = line.trim();
    loop {
        let before = text;
        text = text.trim_start_matches('>').trim_start();
        for prefix in ["- [ ] ", "- [x] ", "- [X] ", "* [ ] ", "* [x] ", "- ", "* ", "+ "] {
            if let Some(rest) = text.strip_prefix(prefix) {
                text = rest.trim_start();
            }
        }
        if text.starts_with('#') {
            text = text.trim_start_matches('#').trim_start();
        }
        let digits = text.chars().take_while(char::is_ascii_digit).count();
        if digits > 0 {
            if let Some(rest) = text[digits..].strip_prefix(". ") {
                text = rest.trim_start();
            }
        }
        if text == before {
            break;
        }
    }

    const MAX: usize = 120;
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= MAX {
        return text.to_string();
    }
    // 从链接前面 30 个字开始截，链接一定在里面
    let lower = text.to_lowercase();
    let needle = format!("[[{}", title.trim().to_lowercase());
    let at = lower
        .find(&needle)
        .map(|byte| lower[..byte].chars().count())
        .unwrap_or(0);
    let start = at.saturating_sub(30);
    let end = (start + MAX).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn titles(body: &str) -> Vec<String> {
        wikilinks(body).into_iter().map(|link| link.title).collect()
    }

    #[test]
    fn finds_every_form_of_wikilink() {
        let body = "看 [[周报]] 和 [[周报|上周的]]，跳到 [[周报#结论]]、[[周报^abc]]\n第二行 [[ 京都书店清单 ]]";
        assert_eq!(
            titles(body),
            vec!["周报", "周报", "周报", "周报", "京都书店清单"]
        );
        assert_eq!(wikilinks(body)[4].line, 1);
    }

    #[test]
    fn skips_code_and_escapes() {
        let body = "```\n[[代码里的]]\n```\n`[[行内代码]]` 真的 [[链接]]\n\\[[转义]]\n~~~md\n[[也是代码]]\n~~~";
        assert_eq!(titles(body), vec!["链接"]);
    }

    #[test]
    fn ignores_broken_brackets() {
        assert!(titles("[[没有结尾").is_empty());
        assert!(titles("[[a [b] c]]").is_empty());
        assert!(titles("[[]] [[|别名]]").is_empty());
    }

    #[test]
    fn retargets_only_links_to_the_old_title() {
        let body = "看 [[周报]] 和 [[周报|上周的]]，跳到 [[ 周报 #结论]]、[[Weekly^abc]]\n\
                    `[[周报]]` 是代码，\\[[周报]] 是转义，[[周报 2]] 是别的\n```\n[[周报]]\n```\n末行 [[周报]]";
        let (out, count) = retarget(body, "周报", "月报").unwrap();
        assert_eq!(count, 4);
        assert_eq!(
            out,
            "看 [[月报]] 和 [[月报|上周的]]，跳到 [[ 月报 #结论]]、[[Weekly^abc]]\n\
             `[[周报]]` 是代码，\\[[周报]] 是转义，[[周报 2]] 是别的\n```\n[[周报]]\n```\n末行 [[月报]]"
        );
        // 不分大小写、去掉首尾空白，和跳转的规则一样
        let (out, count) = retarget("见 [[weekly notes]]", " Weekly Notes ", "Monthly").unwrap();
        assert_eq!((out.as_str(), count), ("见 [[Monthly]]", 1));
        assert!(retarget("没有链接", "周报", "月报").is_none());
        assert!(retarget("[[月报]]", "周报", "月报").is_none());
    }

    #[test]
    fn some_titles_cannot_be_written_into_a_link() {
        assert!(linkable("月报 2026"));
        for title in ["", "  ", "C# 笔记", "a|b", "[草稿]", "x^y"] {
            assert!(!linkable(title), "{title}");
        }
    }

    #[test]
    fn titles_match_loosely() {
        assert!(same_title(" Weekly Notes ", "weekly notes"));
        assert!(!same_title("周报", "周报 2"));
    }

    #[test]
    fn context_lines_are_trimmed_around_the_link() {
        assert_eq!(context_line("- [ ] 回看 [[周报]] 的结论", "周报"), "回看 [[周报]] 的结论");
        assert_eq!(context_line("> ## 参考 [[周报]]", "周报"), "参考 [[周报]]");
        assert_eq!(context_line("3. 见 [[周报]]", "周报"), "见 [[周报]]");
        let long = format!("{}[[周报]]{}", "前".repeat(100), "后".repeat(100));
        let cut = context_line(&long, "周报");
        assert!(cut.starts_with('…') && cut.ends_with('…'));
        assert!(cut.contains("[[周报]]"));
    }
}
