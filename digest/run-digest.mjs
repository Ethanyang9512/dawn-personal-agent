#!/usr/bin/env node
// Dawn 日报主流程：采集 → Codex 主编精选 → 渲染长图 → 投递箱（08:20 launchd 启动，约 08:30 到微信）
// 用法：node run-digest.mjs [--date YYYY-MM-DD] [--no-send] [--force]
// 测试钩子（只在本机测试用）：DAWN_DIGEST_FAKE=ok|stale、DAWN_FAKE_RENDER=1、DAWN_OUTBOX=目录
import { dataHome, workspaceHome } from '../bridge/lib/locations.mjs';
import fs from 'node:fs';
import { waitingItems } from '../bridge/lib/waiting.mjs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { backendOptions, readBackendConfig } from '../bridge/lib/backend.mjs';
import { createAlerter } from '../bridge/lib/alert.mjs';

const HERE = import.meta.dirname;
const OUTBOX = process.env.DAWN_OUTBOX || path.join(dataHome(), 'outgoing');
const args = process.argv.slice(2);
const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const NO_SEND = args.includes('--no-send');
const FORCE = args.includes('--force');
const bjNow = new Date(Date.now() + 8 * 3600e3);
const DATE = getArg('--date') || bjNow.toISOString().slice(0, 10);
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const dateLabel = `${Number(DATE.slice(5, 7))}月${Number(DATE.slice(8, 10))}日`;
const weekday = WEEKDAYS[new Date(`${DATE}T12:00:00+08:00`).getUTCDay()];
const OUT = path.join(process.env.DAWN_DIGEST_OUT_BASE || path.join(workspaceHome(), '发出', 'digest'), DATE);
const STATE = process.env.DAWN_DIGEST_STATE_DIR || path.join(dataHome(), 'digest', 'state');
const LOGDIR = process.env.DAWN_DIGEST_LOG_DIR || path.join(dataHome(), 'digest', 'logs');
const START = Date.now();
const STAMP = new Date(START).toISOString().replace(/[:.]/g, '-').slice(0, 19);
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(LOGDIR, { recursive: true });
const logFile = path.join(LOGDIR, `${DATE}.log`);
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); fs.appendFileSync(logFile, line + '\n'); };
const run = (cmd, a, opt = {}) => new Promise((resolve, reject) => {
  execFile(cmd, a, { maxBuffer: 16 * 1024 * 1024, ...opt }, (e, stdout, stderr) => e ? reject(new Error(`${cmd} 失败：${stderr || e.message}`)) : resolve(stdout));
});
const alertState = {};
const alert = createAlerter({ cfg: readCfg(), state: alertState, saveState: () => {}, log });
function readCfg() {
  return readBackendConfig();
}
const notifyFail = async (msg) => {
  log(`失败：${msg}`);
  if (process.env.DAWN_ALERT_DISABLE || readCfg().alert?.mac !== true || process.platform !== 'darwin') return; // 测试时不弹通知、不发飞书
  execFile('osascript', ['-e', `display notification "Dawn 日报 ${DATE} 生成失败，要看日志" with title "Dawn 日报"`], () => {});
  await alert('digest-fail', `Dawn 日报 ${DATE} 连续失败，已记录；请到电脑上查看日志。`);
};
const writeJsonAtomic = (file, data) => {
  const tmp = `${file}.tmp-${START}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
};
const freshFile = (f) => fs.existsSync(f) && fs.statSync(f).mtimeMs >= START - 1000; // 容忍 1 秒文件系统误差

const historyPath = path.join(STATE, 'history.json');
function loadHistory() {
  if (!fs.existsSync(historyPath)) return { nextIssue: 1, days: [] };
  try {
    const h = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    return { nextIssue: h.nextIssue || (h.days?.length + 1) || 1, days: h.days || [] };
  } catch (e) {
    const bad = `${historyPath}.corrupt-${STAMP}`;
    fs.renameSync(historyPath, bad);
    const err = new Error(`history.json 损坏（已留底 ${path.basename(bad)}）：${e.message}`);
    err.noRetry = true; // 状态损坏要人来处理，重试只会悄悄重置掩盖问题
    throw err;
  }
}

async function editDigest(candPath, onthisdayRaw) {
  if (process.env.DAWN_DIGEST_FAKE) {
    log(`测试模式主编（${process.env.DAWN_DIGEST_FAKE}）`);
    if (process.env.DAWN_DIGEST_FAKE === 'stale') return; // 模拟"正常退出但没写文件"
    const c = JSON.parse(fs.readFileSync(candPath, 'utf8'));
    const items = [];
    for (const sec of ['ai', 'world', 'tech']) {
      for (const it of c.items.filter((x) => x.section === sec).slice(0, 2)) {
        items.push({ section: sec, title: it.title.slice(0, 28), summary: it.summary || it.title, why: '测试推荐理由', sources: [{ name: it.source, url: it.link }] });
      }
    }
    writeJsonAtomic(path.join(OUT, 'digest.json'), { overview: '测试导读', items, onthisday: onthisdayRaw.slice(0, 2) });
    return;
  }
  const tpl = fs.readFileSync(path.join(HERE, 'editor-prompt.md'), 'utf8');
  const history = loadHistory();
  const historyText = history.days.slice(-3).map((d) => `${d.date}：${d.titles.join('；')}`).join('\n') || '（暂无）';
  const prompt = tpl.replaceAll('{{DATE}}', `${DATE} ${weekday}`)
    .replaceAll('{{CANDIDATES_JSON}}', fs.readFileSync(candPath, 'utf8'))
    .replaceAll('{{HISTORY}}', historyText);
  const options = backendOptions(readBackendConfig(), { pipeline: true });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dawn-digest-editor-'));
  try {
    const r = await options.runner({
      ...options, cwd, prompt,
      idleMs: 10 * 60e3, maxMs: 15 * 60e3,
    }).done;
    if (r.isError) throw new Error(`主编失败：${r.errorText || r.text || '未知'}`);
    if (r.steps !== 0) throw new Error('主编调用了工具，本轮不采用');
    // 无工具模式：模型只回 JSON，文件由脚本写（防止外部内容借工具之手）
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('主编没有返回 JSON');
    let data;
    try { data = JSON.parse(m[0]); } catch (e) { throw new Error(`主编返回的 JSON 无法解析：${e.message}`); }
    writeJsonAtomic(path.join(OUT, 'digest.json'), data);
    log(`主编完成：${data.items?.length ?? '?'} 条（无工具模式，工具调用 ${r.steps} 次）`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function validate(candidates, onthisdayRaw) {
  if (!freshFile(path.join(OUT, 'digest.json'))) throw new Error('主编没有写出新的 digest.json（旧文件不能冒充新结果）');
  const data = JSON.parse(fs.readFileSync(path.join(OUT, 'digest.json'), 'utf8'));
  const byLink = new Map(candidates.items.map((x) => [x.link, x]));
  const cap = { ai: 9, world: 6, tech: 5 };
  const seen = new Set();
  const items = [];
  for (const it of data.items || []) {
    if (!cap[it.section] || !it.title || !it.summary) continue;
    const sources = [];
    for (const s of it.sources || []) {
      const c = byLink.get(s.url);
      if (c && !sources.some((x) => x.name === s.name || x.url === s.url)) sources.push({ name: s.name, url: s.url, time: c.time });
    }
    if (!sources.length) { log(`丢弃（链接不在候选集）：${it.title}`); continue; }
    const key = it.title.replace(/\s/g, '').slice(0, 16);
    if (seen.has(key)) continue;
    seen.add(key);
    if (items.filter((x) => x.section === it.section).length >= cap[it.section]) continue;
    items.push({ ...it, sources });
  }
  if (items.length < 3) throw new Error('主编结果不足 3 条，质量不达标');
  const onthisday = onthisdayRaw;
  return { overview: String(data.overview || '').trim(), items, onthisday };
}

function markdown(data, issue) {
  const secName = { ai: 'AI 前沿', world: '政经', tech: '科技与开源' };
  let md = `# Dawn 日报 · ${dateLabel} ${weekday}（第 ${issue} 期）\n\n${data.overview}\n`;
  for (const sec of ['ai', 'world', 'tech']) {
    const rows = data.items.filter((x) => x.section === sec);
    if (!rows.length) continue;
    md += `\n## ${secName[sec]}\n`;
    for (const it of rows) {
      md += `\n### ${it.title}\n${it.summary}\n\n为什么值得看：${it.why}\n`;
      for (const s of it.sources) md += `来源：${s.name} ${s.url}\n`;
    }
  }
  if (data.onthisday.length) {
    md += '\n## 历史上的今天\n';
    for (const e of data.onthisday) md += `- ${e.year} 年：${e.text}\n`;
  }
  return md;
}

const decodeEntities = (s) => String(s).replace(/&#(\d+|x[0-9a-f]+);/gi, (raw, value) => {
  const hex = value[0].toLowerCase() === 'x';
  const cp = Number.parseInt(value.slice(hex ? 1 : 0), hex ? 16 : 10);
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : raw;
});
const clean = (s) => { // 删到不再变：删掉里层后外层可能重新拼成标记
  let text = decodeEntities(s);
  for (let prev = ''; text !== prev;) { prev = text; text = text.replace(/\[\[[^\]]*\]\]/g, ''); }
  return text;
};
const sourceDefs = JSON.parse(fs.readFileSync(path.join(HERE, 'sources.json'), 'utf8'));
const sourceByName = new Map(sourceDefs.map((s) => [s.name, s]));

function fallbackDigest(candidates, onthisdayRaw) {
  const pool = candidates.items.filter((it) => {
    const def = sourceByName.get(it.source);
    const level = it.level || def?.level;
    const lang = it.lang || def?.lang;
    return level === 'official' || (level === 'media' && lang === 'zh');
  }).map((it) => {
    const title = clean(it.title).replace(/\s+/g, ' ').trim();
    const summary = clean(it.summary || it.title).replace(/\s+/g, ' ').trim();
    const titleChars = [...title];
    const summaryChars = [...summary];
    return {
      section: it.section,
      title: titleChars.length > 40 ? `${titleChars.slice(0, 39).join('')}…` : title,
      summary: summaryChars.length > 180 ? `${summaryChars.slice(0, 179).join('')}…` : summary,
      why: '',
      sources: [{ name: clean(it.source), url: clean(it.link), time: it.time }],
    };
  }).filter((it) => it.title);
  const items = []; // 三个栏目轮流取，避免被先抓到的源占满
  for (let i = 0; i < pool.length && items.length < 10; i += 1) {
    for (const section of ['ai', 'world', 'tech']) {
      const it = pool.filter((x) => x.section === section)[i];
      if (it && items.length < 10) items.push(it);
    }
  }
  if (!items.length) {
    const e = new Error('主编失败，且没有可用于双图版的官方或中文媒体候选');
    e.noRetry = true;
    throw e;
  }
  log(`改用未编辑双图版：${items.length} 条；标记 fallback 并记录入箱历史`);
  return { overview: '今日精选（主编未完成，未编辑版）', items, onthisday: onthisdayRaw };
}

function dropOutbox(text, name = `digest-${DATE}`) {
  fs.mkdirSync(OUTBOX, { recursive: true });
  const tmp = path.join(OUTBOX, `${name}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, path.join(OUTBOX, `${name}.txt`));
  log('已写入投递箱');
}

const healthPath = path.join(STATE, 'health.json');
const previousDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);
const wasOutboxed = (day) => !!(day?.outboxedAt || (day?.at && !day?.generatedAt));

async function pipelineAlert(kind, text) {
  if (process.env.DAWN_ALERT_DISABLE) { log(`alert ${kind}（测试禁用外发）`); return; }
  await alert(kind, text);
}

async function updateHealth(candidates, fallback) {
  if (NO_SEND) return;
  let health = { days: {} };
  try { health = JSON.parse(fs.readFileSync(healthPath, 'utf8')); } catch {}
  health.days ||= {};
  health.days[DATE] = {
    fallback,
    failedSources: Object.entries(candidates.errors || {}).filter(([, reason]) => reason === '抓取失败或不是 RSS' || reason === '响应不是 RSS' || reason.startsWith('网络抓取失败')).map(([id]) => id),
  };
  for (const date of Object.keys(health.days)) if (DATE > date && new Date(`${DATE}T00:00:00Z`) - new Date(`${date}T00:00:00Z`) > 14 * 86400e3) delete health.days[date];
  const streak = (predicate) => {
    let count = 0;
    for (let date = DATE; health.days[date] && predicate(health.days[date]); date = previousDay(date)) count += 1;
    return count;
  };
  health.fallbackStreak = streak((day) => day.fallback);
  health.sources = {};
  for (const day of Object.values(health.days)) {
    for (const id of day.failedSources || []) health.sources[id] = { streak: 0 };
  }
  for (const id of Object.keys(health.sources)) health.sources[id].streak = streak((day) => (day.failedSources || []).includes(id));
  writeJsonAtomic(healthPath, health);
  if (health.fallbackStreak === 2) await pipelineAlert('digest-fallback', 'Dawn 日报连续 2 天使用未编辑双图版，请到电脑上查看主编日志。');
  for (const [id, source] of Object.entries(health.sources)) {
    if (source.streak === 3) await pipelineAlert(`digest-source-${id}`, `Dawn 日报信源 ${id} 连续 3 天抓取失败，请到电脑上检查或移除该信源。`);
  }
}

async function main() {
  const history = loadHistory(); // 读取放进出错处理里：坏了会留底并触发失败提醒
  const existing = history.days.find((d) => d.date === DATE);
  if (wasOutboxed(existing) && !FORCE) { log(`${DATE} 已写入投递箱（第 ${existing.issue ?? '未知'} 期），本次跳过；要重新入箱请加 --force`); return; }
  const issue = existing ? (existing.issue ?? Math.max(1, history.nextIssue - 1)) : history.nextIssue; // 兼容没有 issue 字段的旧历史
  log(`开始生成 ${DATE} 日报（第 ${issue} 期）`);
  if (fs.existsSync(OUT)) { // 旧产物先留底，杜绝旧文件冒充新结果
    const bakBase = `${OUT}.bak-${STAMP}`;
    let bak = bakBase;
    for (let n = 2; fs.existsSync(bak); n += 1) bak = `${bakBase}-${n}`;
    fs.renameSync(OUT, bak);
    log(`当天旧目录已留底：${path.basename(bak)}`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const candPath = path.join(OUT, 'candidates.json');
  if (process.env.DAWN_DIGEST_FAKE_COLLECT) {
    fs.copyFileSync(process.env.DAWN_DIGEST_FAKE_COLLECT, candPath);
    log('测试模式：使用候选夹具');
  } else {
    log(await run(process.execPath, [path.join(HERE, 'collect.mjs'), candPath]));
  }
  const candidates = JSON.parse(fs.readFileSync(candPath, 'utf8'));
  if (candidates.count < 8) throw new Error(`候选只有 ${candidates.count} 条，网络或信源异常`);
  // 其他日期已经生成的版本都参与去重；同一天重跑不拦截自己的上一版
  const reported = new Set(history.days.filter((d) => d.date !== DATE).flatMap((d) => d.links || []));
  if (reported.size) {
    const before = candidates.items.length;
    candidates.items = candidates.items.filter((x) => !reported.has(x.link));
    log(`按链接拦下近 7 天已报条目：${before - candidates.items.length} 条`);
    writeJsonAtomic(candPath, candidates); // 过滤要写回文件，主编读到的是去重后的候选
    if (candidates.items.length < 3) throw new Error('去重后候选不足 3 条，今天没有值得再报的新内容');
  }
  const rawOnthisday = [];
  let data;
  let fallback = false;
  try {
    await editDigest(candPath, rawOnthisday);
    data = validate(candidates, rawOnthisday);
  } catch (e) {
    const rejected = /provider\.filtered|Provider safety policy|high risk|content_filter/i.test(e.message);
    if (rejected) e.noRetry = true;
    if (rejected || attempt >= 2) {
      log(`主编失败：${e.message}`);
      data = fallbackDigest(candidates, rawOnthisday);
      fallback = true;
    } else {
      throw e;
    }
  }
  const memoryDir = process.env.DAWN_DIGEST_MEMORY_DIR || (!process.env.DAWN_DIGEST_OUT_BASE ? path.join(readCfg().workspace, 'memory') : null);
  let waiting = [];
  if (memoryDir && fs.existsSync(path.join(memoryDir, 'now.md'))) waiting = waitingItems(fs.readFileSync(path.join(memoryDir, 'now.md'), 'utf8')).sort((a,b)=>a.reviewOn.localeCompare(b.reviewOn)).slice(0,3);
  const full = { ...data, dateLabel, weekday, issue, waiting };
  writeJsonAtomic(path.join(OUT, 'render-data.json'), full);
  const md = markdown(data, issue);
  fs.writeFileSync(path.join(OUT, 'digest.md'), md);
  let images = [];
  try {
    if (process.env.DAWN_FAKE_RENDER === 'fail') throw new Error('测试模式渲染失败');
    if (process.env.DAWN_FAKE_RENDER) {
      for (const f of ['page1.png', 'page2.png']) fs.writeFileSync(path.join(OUT, f), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    } else {
      await run(readCfg().pythonBin || 'python3', [path.join(HERE, 'render.py'), path.join(OUT, 'render-data.json'), OUT]);
    }
    images = ['page1.png', 'page2.png'].map((f) => path.join(OUT, f)).filter((f) => fs.existsSync(f));
    if (images.length !== 2) throw new Error('缺少 page1.png 或 page2.png');
    log('长图渲染完成');
  } catch (e) { images = []; log(`渲染失败，仅告知状态：${e.message}`); }
  if (!NO_SEND) {
    // 模型产出的文本先剥掉 [[…]] 标记，防止外部内容借桥的标记语法发文件/卡片（我们自己的图片标记不受影响）
    let text = `Dawn 日报 · ${dateLabel} ${weekday}\n${clean(data.overview) || '今日精选已生成。'}`;
    if (images.length === 2) text += `\n[[发送文件: ${images[0]}]]\n[[发送文件: ${images[1]}]]`;
    else text += '\n今天日报图片未生成，已记录。请到电脑上查看日志。';
    dropOutbox(text);
  }
  const now = new Date().toISOString();
  const outboxedAt = NO_SEND ? (existing?.outboxedAt || existing?.at || null) : (wasOutboxed(existing) ? (existing.outboxedAt || existing.at) : now);
  const links = data.items.flatMap((x) => x.sources.map((s) => s.url));
  const days = history.days.filter((d) => d.date !== DATE);
  days.push({
    date: DATE, issue,
    titles: data.items.map((x) => x.title),
    links: [...new Set([...(existing?.links || []), ...links])],
    generatedAt: now, outboxedAt,
    fallback: NO_SEND ? (existing?.fallback ?? fallback) : fallback,
  });
  history.days = days.slice(-7);
  if (!NO_SEND && !wasOutboxed(existing)) history.nextIssue = Math.max(history.nextIssue, issue + 1); // 只增不减
  writeJsonAtomic(historyPath, history);
  await updateHealth(candidates, fallback);
  log(`完成：${data.items.length} 条，图片 ${images.length} 张${fallback ? '（未编辑双图版）' : ''}${NO_SEND ? '（未入箱）' : ''}`);
}

// 失败重试：默认 5 分钟、15 分钟各一次；仍失败→Mac+飞书提醒，并往投递箱留一句（不悄悄失败）
const RETRY_MS = process.env.DAWN_DIGEST_RETRY_MS ? [Number(process.env.DAWN_DIGEST_RETRY_MS)] : [5 * 60e3, 15 * 60e3];
let attempt = 0;
for (;;) {
  try { await main(); break; } catch (e) {
    if (attempt >= 2 || e.noRetry) {
      await notifyFail(e.message);
      if (!NO_SEND) dropOutbox('今天日报没生成，已记录。请到电脑上查看日志；明天会重新尝试。', `fail-digest-${DATE}`);
      process.exitCode = 1;
      break;
    }
    const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
    log(`第 ${attempt + 1} 次失败：${e.message}；${Math.round(wait / 1000)} 秒后重试`);
    attempt += 1;
    await new Promise((r) => setTimeout(r, wait));
  }
}
