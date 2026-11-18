#!/usr/bin/env node
// Dawn 日报采集：并发抓 RSS/Atom，解析条目，留过去 48 小时的候选，写 candidates.json
// 用法：node collect.mjs <输出路径> [sources.json 路径]
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const OUT = process.argv[2];
const SRC = process.argv[3] || path.join(import.meta.dirname, 'sources.json');
const WINDOW_H = 48;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sources = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const curl = (s) => new Promise((resolve) => {
  const args = ['-sSL', '--compressed', '--max-time', '25', '-A', UA];
  args.push(s.url);
  execFile('curl', args, { maxBuffer: 8 * 1024 * 1024 }, (e, stdout) => {
    if (e) return resolve({ error: `网络抓取失败（curl ${e.code || 'error'}）` });
    resolve({ body: stdout });
  });
});

const decode = (t) => String(t || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const text = (t, cap = 600) => decode(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap);
const tag = (xml, names) => {
  for (const n of names) {
    const m = xml.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m) return m[1].trim();
  }
  return '';
};
const attr = (xml, name, attrName) => {
  const m = xml.match(new RegExp(`<${name}[^>]*${attrName}="([^"]+)"`, 'i'));
  return m ? m[1] : '';
};

function parseItems(xml, s) {
  const blocks = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  const atoms = [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
  const now = Date.now();
  const rows = [];
  for (const b of [...blocks, ...atoms]) {
    const title = text(tag(b, ['title']), 300);
    const link = decode(tag(b, ['link', 'guid'])) || attr(b, 'link', 'href');
    const dateRaw = tag(b, ['pubDate', 'published', 'updated', 'dc:date']);
    const t = Date.parse(dateRaw);
    const summaryRaw = tag(b, ['description', 'summary', 'content:encoded', 'content']);
    const summary = text(s.id === 'github-trending' ? summaryRaw.split(/(?:&amp;|&)nbsp;/i)[0].replace(/https?:\/\/\S+/gi, '') : summaryRaw);
    if (!title || !link) continue;
    if (dateRaw && !Number.isNaN(t) && now - t > WINDOW_H * 3600e3) continue; // 太旧
    if (dateRaw && !Number.isNaN(t) && t - now > 3600e3) continue; // 时间在未来，多半源有问题
    rows.push({
      id: `${s.id}:${rows.length}`, source: s.name, level: s.level, lang: s.lang, section: s.section,
      title, link, time: Number.isNaN(t) ? null : new Date(t).toISOString(), summary,
    });
    if (rows.length >= 12) break; // 每个源最多 12 条，防一家刷屏
  }
  return rows;
}

const all = [];
const errors = {};
await Promise.all(sources.map(async (s) => {
  const response = await curl(s);
  if (response.error) { errors[s.id] = response.error; return; }
  const xml = response.body;
  if (!xml || !/<(rss|feed|rdf)\b/i.test(xml.slice(0, 2000))) { errors[s.id] = '响应不是 RSS'; return; }
  const rows = parseItems(xml, s);
  if (!rows.length) errors[s.id] = '48 小时窗口内没有条目';
  all.push(...rows);
}));
all.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
const result = { generatedAt: new Date().toISOString(), windowHours: WINDOW_H, count: all.length, items: all, errors };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(`候选 ${all.length} 条；异常源：${Object.entries(errors).map(([k, v]) => `${k}(${v})`).join('、') || '无'}`);
