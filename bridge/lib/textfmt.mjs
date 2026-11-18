// 微信只部分渲染 Markdown（社区实测）：代码块、粗体、H1–H4 能显示；
// 表格右侧会被截断；成对的 _ 会被吞成斜体；单独的 < 会吞掉这一行剩下的内容；图片语法显示不了。
// 这里只改会出问题的部分，代码里的内容一律不动。

// 切成 [{code:true|false, s}]：``` 围起来的块和 `行内代码` 算代码
function segments(text) {
  const out = [];
  const re = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ code: false, s: text.slice(last, m.index) });
    out.push({ code: true, s: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, s: text.slice(last) });
  return out;
}

// 网址原样保留，下划线和 < 只在网址以外处理
const URL_RE = /(?:https?:\/\/|www\.)[^\s)）\]>＞"'，。]+/g;
function fixProse(s) {
  // 图片：显示不了，改成说明加网址
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, url) => (alt ? `[图片：${alt}] ${url}` : url));
  // 表格：去掉分隔行，每行写成「a · b · c」
  s = s.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$\n?/gm, '');
  s = s.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row) => row.split('|').map((x) => x.trim() || '—').join(' · '));
  // H5、H6 不渲染
  s = s.replace(/^#{5,6}\s+/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  const pieces = [];
  let last = 0, m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s))) {
    pieces.push(fixPlain(s.slice(last, m.index)), m[0]);
    last = m.index + m[0].length;
  }
  pieces.push(fixPlain(s.slice(last)));
  return pieces.join('');
}

function fixPlain(s) {
  // 带下划线的词（文件名、变量名）包进反引号，免得被吞成斜体
  s = s.replace(/(^|[^\w`@])([\w.\/~-]*[A-Za-z0-9]_[\w.\/~-]*[A-Za-z0-9])(?=$|[^\w`@])/g, (_, pre, word) => `${pre}\`${word}\``);
  // 单独的 < 换成全角
  return s.replace(/</g, '＜');
}

export function formatForWeixin(md) {
  const text = String(md || '').replace(/\r\n/g, '\n').trim();
  return segments(text).map((p) => (p.code ? p.s : fixProse(p.s))).join('').trim();
}

// 按段落优先、换行其次、句号再次切成不超过 max 字的若干条；切在代码块中间时补上围栏
export function chunkText(text, max) {
  const parts = [];
  let rest = text;
  while ([...rest].length > max) {
    const head = [...rest].slice(0, max).join('');
    let cut = head.lastIndexOf('\n\n');
    if (cut < head.length * 0.4) cut = head.lastIndexOf('\n');
    if (cut < head.length * 0.4) cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('；'), head.lastIndexOf('. '));
    if (cut < head.length * 0.4) cut = head.length - 1;
    parts.push(head.slice(0, cut + 1).trimEnd());
    rest = rest.slice(cut + 1).replace(/^\n+/, '');
  }
  if (rest.trim()) parts.push(rest);
  // 围栏配对：切在代码块中间时，本段末尾补上收尾，下一段开头带着原来的语言标记重新打开
  let openLang = null;
  return parts.map((p) => {
    let s = openLang !== null ? '```' + openLang + '\n' + p : p;
    let lang = null;
    for (const m of s.matchAll(/```([^\n`]*)/g)) lang = lang === null ? m[1].trim() : null;
    openLang = lang;
    if (openLang !== null) s += '\n```';
    return s;
  });
}
// Only customer-facing progress belongs in the WeChat acknowledgement.
export function publicNarration(text) {
  if (!text) return '';
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\*\*|[`#>|]/g, '').replace(/\s+/g, ' ').trim();
  const sentence = clean.split(/(?<=[。！？!?])/).map(s => s.trim()).find(s => s &&
    !/dawn-[\w-]+|superpowers|SKILL\.md|AGENTS\.md|\w+\.mjs|\bP[1-7]\b|技能|护栏|安全审核|工具调用|环境变量|记账|事务/i.test(s)) || '';
  return [...sentence].length > 80 ? `${[...sentence].slice(0, 80).join('')}…` : sentence;
}
