import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { conversationCatalog, conversationFactFilters, readConversation, refreshConversationSources } from './conversation-memory.mjs';
import { readMemory } from './memory.mjs';
import { withAutomationControlLock } from './automation-control.mjs';
import { writeDurableJson } from './durable-json.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const bytes = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const fail = message => { throw Object.assign(new Error(message), { code: 'DAWN_NOTEBOOK' }); };
const quote = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('`', '&#96;').replaceAll('[', '&#91;').replaceAll(']', '&#93;').split('\n').map(line => `> ${line}`).join('\n');
const role = { user: '用户原话', assistant: '助手当时回复', proactive: 'Dawn主动发出', legacy: '历史流水摘要', note: '人工笔记' };
const localDate = at => new Date(Date.parse(at) + 8 * 3600e3).toISOString().slice(0,10);
const topicId = topic => hash(topic).slice(0,12);
const topicFile = topic => `话题/${topic}-${topicId(topic)}.md`;
const dailyFile = date => `日常/${date}.md`;
function noteLink(from, to, label, anchor = '') {
  const location = path.posix.relative(path.posix.dirname(from), to).split('/').map(s => encodeURIComponent(s).replace(/[()]/g, c => '%' + c.charCodeAt(0).toString(16))).join('/');
  const plain = label.replace(/[\r\n]/g,' ').replace(/[\\[\]*_`<>!&]/g, c => `&#${c.charCodeAt(0)};`);
  return `[${plain}](${location}${anchor})`;
}
function paths(options) {
  const vaultDir = options.vaultDir || process.env.DAWN_VAULT_DIR;
  if (!path.isAbsolute(vaultDir || '') || !path.isAbsolute(options.indexPath || process.env.DAWN_CONVERSATIONS_INDEX || '')) fail('显式提供Obsidian库和聊天索引路径');
  const stateDir = path.dirname(options.indexPath || process.env.DAWN_CONVERSATIONS_INDEX);
  return { root: path.join(vaultDir, '30_Resources/Dawn'), state: path.join(stateDir, 'notebook-state.json'), journal: path.join(stateDir, 'notebook-transaction.json') };
}
function safe(file) {
  for (let p = file; p !== path.dirname(p); p = path.dirname(p)) {
    if (p === '/var' && fs.realpathSync(p) === '/private/var') continue;
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('笔记路径不能使用软链');
  }
  return file;
}
function target(p, relative) {
  const file = relative === '$state' ? p.state : path.join(p.root, relative);
  if (relative !== '$state' && (!file.startsWith(p.root + path.sep) || !relative.endsWith('.md') || relative.includes('..'))) fail('笔记只能写入Dawn专属目录');
  return safe(file);
}
function atomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`, fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function recover(p) {
  if (!fs.existsSync(p.journal)) return;
  const tx = JSON.parse(bytes(p.journal)); if (tx.version !== 1 || !Array.isArray(tx.files)) fail('笔记恢复记录无效');
  for (const item of tx.files) if (![item.before, hash(item.text)].includes(hash(bytes(target(p, item.file))))) fail('笔记在中断期间被手改，保留现场');
  for (const item of tx.files) { const file = target(p, item.file); if (hash(bytes(file)) !== hash(item.text)) atomic(file, item.text); }
  fs.unlinkSync(p.journal);
}
function locked(options, work) {
  const p = paths(options); safe(p.root); safe(p.state); safe(p.journal);
  return withAutomationControlLock(p.journal, () => { recover(p); const state = bytes(p.state) ? JSON.parse(bytes(p.state)) : { version: 1, notes: {} }; return work(p, state); });
}
function notebookIndex(notes) {
  const groups = Object.values(notes).filter(n => !n.retired).sort((a,b) =>
    (b.latestAt || '').localeCompare(a.latestAt || '') || a.id.localeCompare(b.id));
  const topics = groups.filter(n => n.kind === 'topic'), days = groups.filter(n => n.kind === 'daily');
  const drafts = groups.filter(n => n.kind === 'draft');
  const file = '记忆工作台.md';
  const entry = n => `- ${noteLink(file,n.file,n.title)}${n.kind === 'draft' ? ` · 第 ${n.revision} 版` : ` · ${n.sourceCount ?? n.sources.length} 段`}`;
  const sections = ['从最近聊过的话题回到原话，或打开已经写过的稿件。'];
  if (notes.facts) sections.push(noteLink(file,notes.facts.file,'现行事实与偏好'));
  if (drafts.length) sections.push('## 可以接着写的稿件\n\n' + drafts.map(entry).join('\n'));
  if (topics.length) sections.push('## 最近聊到的话题\n\n' + topics.slice(0,6).map(entry).join('\n'));
  if (days.length) sections.push('## 最近的日期\n\n' + days.slice(0,7).map(entry).join('\n'));
  for (const [label,rest] of [['更早的话题',topics.slice(6)],['更早的日期',days.slice(7)]]) {
    if (rest.length) sections.push(`> [!list]- ${label}（${rest.length}）\n` + rest.map(n => '> ' + entry(n)).join('\n'));
  }
  const body = sections.join('\n\n') + '\n', sourceHash = hash(body);
  return { id:'index', file, title:'Dawn 记忆工作台', kind:'index', sources:[], sourceHash, text:header('Dawn 记忆工作台','index',sourceHash) + body };
}
function commit(p, state, updates, options, conflicts = []) {
  const files = [];
  let metadataChanged = false;
  function stage({ id, file, text, expectedSha256, ...meta }) {
    const actual = bytes(target(p, file)), old = state.notes[id];
    if ((old && hash(actual) !== old.sha256 && expectedSha256 !== hash(actual)) || (!old && actual)) {
      if (meta.kind === 'draft') fail(`笔记被手改或来源不明，未覆盖：${file}`);
      conflicts.push(file);
      return;
    }
    if (actual === text) {
      if (old && meta.kind === 'draft' && old.factsRevision !== meta.factsRevision) {
        old.factsRevision = meta.factsRevision;
        metadataChanged = true;
      }
      return;
    }
    const history = old?.history || [];
    if (meta.kind === 'draft' && actual) {
      const historical = `草稿/历史/${id.slice(6)}-r${old.revision}.md`;
      if (bytes(target(p, historical))) fail('草稿历史版本已存在');
      files.push({ file: historical, before: hash(''), text: actual });
      history.push({ revision: old.revision, sha256: hash(actual), path: target(p, historical) });
    }
    files.push({ file, before: hash(actual), text });
    state.notes[id] = { id, file, ...meta, ...(history.length ? { history } : {}), sha256: hash(text), revision: (old?.revision || 0) + 1 };
  }
  for (const update of updates) stage(update);
  stage(notebookIndex(state.notes));
  if (!files.length && !metadataChanged) return { changed: 0, conflicts };
  files.push({ file: '$state', before: hash(bytes(p.state)), text: JSON.stringify(state, null, 2) + '\n' });
  writeDurableJson(p.journal, { version: 1, files }); options.afterPrepare?.(); recover(p);
  return { changed: files.length - 1, conflicts };
}
function header(title, kind, sourceHash) {
  return `---\ntype: dawn-${kind}\nmanaged_by: Dawn\nsource_hash: ${sourceHash}\ntags: [dawn, ${kind}]\n---\n\n# ${title}\n\n`;
}
function recordBlock(record, limit, daily) {
  const text = record.text.slice(0, limit);
  const stamp = new Date(Date.parse(record.at) + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  const when = record.timePrecision === 'day' ? `${stamp.slice(0,10)}（未记录具体时刻）` : `${stamp} 北京时间`;
  return `### ${when} · ${role[record.role]}\n\n${quote(text)}${record.text.length > limit ? '\n> ……完整内容见原文。' : ''}\n\n来源：\`${record.id}\`${daily ? ' ^dawn-' + record.id : ''}\n\n`;
}
export function maintainNotebook(options = {}) {
  refreshConversationSources(options);
  const catalog = conversationCatalog(options), memory = readMemory(options);
  return locked(options, (p, state) => {
    const updates = [], groups = new Map(), conflicts = [];
    const add = (key, title, kind, file, row) => { if (!groups.has(key)) groups.set(key, { id: key, title, kind, file, rows: [] }); groups.get(key).rows.push(row); };
    for (const row of catalog.filter(r => r.role !== 'proactive')) {
      const date = localDate(row.at);
      add(`daily:${date}`, date, 'daily', dailyFile(date), row);
      if (row.annotation) { const topic = row.annotation.topic || '日常交流'; add(`topic:${topicId(topic)}`, topic, 'topic', topicFile(topic), row); }
    }
    const factsText = header('现行事实与偏好', 'facts', memory.revision) + '来源为 Dawn 的现行记忆；本页由系统更新。历史记录继续保留发生时的说法。\n\n' + memory.current + '\n';
    updates.push({ id: 'facts', file: '现行事实.md', kind: 'facts', title: '现行事实与偏好', text: factsText, sources: [], sourceHash: memory.revision });
    for (const group of groups.values()) {
      const sourceHash = hash(JSON.stringify([3, group.rows.map(r => [r.id, r.hash, r.annotation])]));
      if (!state.notes[group.id]?.retired && state.notes[group.id]?.sourceHash === sourceHash) {
        if (hash(bytes(target(p, group.file))) !== state.notes[group.id].sha256) conflicts.push(group.file);
        continue;
      }
      let text = header(group.title, group.kind, sourceHash) + '[[30_Resources/Dawn/记忆工作台|记忆工作台]] · [[30_Resources/Dawn/现行事实|现行事实与偏好]]\n\n';
      text += '> [!info] 当时的记录\n> 以下保留日期与来源角色。现行事实和后来的纠正优先；助手推测、历史摘要及写作想法按原身份保留。\n\n';
      const selected = group.kind === 'topic' ? group.rows.slice(-80) : group.rows;
      if (selected.length < group.rows.length) text += `共${group.rows.length}段；本页展开最近80段，更早内容通过微信按话题查询。\n\n`;
      for (const row of selected) {
        const record = readConversation(row.id, options); if (record.stale || !record.text) continue;
        if (group.kind === 'topic') text += `**整理线索**：${quote(row.annotation.summary).replace(/^> /, '')}\n\n`;
        const daily = group.kind === 'daily';
        text += recordBlock(record, daily ? 1800 : 600, daily);
        if (daily && row.annotation) {
          const topic = row.annotation.topic || '日常交流';
          text += noteLink(group.file,topicFile(topic),'话题 · ' + topic) + ' · ';
        }
        if (!daily) text += noteLink(group.file,dailyFile(localDate(row.at)),'回到当日日常','#^dawn-' + row.id) + ' · ';
        text += `[完整原文](${pathToFileURL(row.path).href})\n\n`;
      }
      if (group.kind === 'topic') text += '## 可继续写的材料\n\n以上片段可在微信里要求 Dawn 继续讨论、组织文章或写成草稿。引用回到各段原文，写作稿单独保留版本。\n';
      updates.push({ ...group, rows: undefined, text, latestAt: group.rows.at(-1).at, sourceCount: group.rows.length, sources: selected.map(r => ({ id: r.id, sha256: r.hash, role: r.role })), sourceHash });
    }
    for (const n of Object.values(state.notes).filter(n => ['daily','topic'].includes(n.kind) && !groups.has(n.id) && !n.retired)) {
      updates.push({ ...n, text: bytes(target(p,n.file)) + '\n> [!warning] 历史页面\n> 原始资料已更新或移除，本页退出现行检索。\n', retired: true });
    }
    return commit(p, state, updates, options, conflicts);
  });
}
export function listNotebook(options = {}) {
  return locked(options, (p, state) => Object.values(state.notes).map(n => ({ ...n, path: target(p, n.file) })));
}
export function notebookBrief(input, options = {}) {
  const {query = '', since, until, kind, topic, mode, after} = typeof input === 'string' ? {query:input} : input || {};
  const browsing = mode === 'topics' || mode === 'clues';
  if (mode !== undefined && !browsing) fail('查询模式无效');
  if (topic !== undefined && (typeof topic !== 'string' || !topic.trim() || topic.length > 40)) fail('话题名称无效');
  if (after !== undefined && (!browsing || typeof after !== 'string' ||
    (mode === 'clues' && topic ? !/^[0-9a-f]{64}$/.test(after) : after.length > 40))) fail('话题分页位置无效');
  if (typeof query !== 'string' || query.length > 200 || (!query.trim() && !kind && !topic && !browsing)) fail('提供主题关键词或素材类型');
  if (kind && !['idea','discussion','life','vent','work'].includes(kind)) fail('素材类型无效');
  for (const date of [since,until].filter(v => v !== undefined)) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) fail('素材日期无效');
  }
  if (since && until && since > until) fail('素材日期范围无效');
  const normalize = s => s.normalize('NFKC').toLowerCase();
  const keys = normalize(query.trim()).split(/\s+/).filter(Boolean);
  const has = (text, key) => /^[a-z0-9]+$/.test(key)
    ? new RegExp(`(?<![a-z0-9])${key}(?![a-z0-9])`).test(text) : text.includes(key);
  const memory = readMemory(options), filters = conversationFactFilters({...options,records:memory.records,factsRevision:memory.revision},options.now);
  const catalog = new Map(conversationCatalog(options).map(row => [row.id,row]));
  const cache = new Map(), unavailable = new Set();
  function current(id) {
    if (!cache.has(id)) {
      let record;
      try { record = catalog.has(id) ? readConversation(id,options) : null; }
      catch (error) {
        if (!['ENOENT','CONVERSATION_MEMORY'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
        unavailable.add(id);
      }
      const eligible = record && !record.stale && filters.valid(record) && !filters.redactRecent(record).redacted;
      cache.set(id,eligible ? record : null);
    }
    return cache.get(id);
  }
  const candidates = [];
  for (const row of catalog.values()) {
    const card = row.annotation, date = localDate(row.at);
    if (!card || card.sourceHash !== row.hash || !['user','note','legacy'].includes(row.role) || (topic && card.topic !== topic)
      || (kind && kind !== card.kind) || (since && date < since) || (until && date > until)) continue;
    const title = normalize(card.topic), aliases = card.terms.map(normalize), evidence = normalize(card.quote);
    if (!keys.every(k => [title,...aliases,evidence].some(field => has(field,k)))) continue;
    const score = keys.reduce((sum,k) => sum + (title === k ? 4 : has(title,k) ? 3 : aliases.includes(k) ? 2 : 1),0);
    candidates.push({row,date,score});
  }
  candidates.sort((a,b) => b.score-a.score || b.row.at.localeCompare(a.row.at) || a.row.id.localeCompare(b.row.id));
  function verifiedBody(row) {
    const record = current(row.id);
    if (!record || (record.role === 'legacy' && /^- (?:记忆修订|旧记忆迁入|维护整理) /.test(record.text))) return '';
    const body = record.role === 'user' ? record.text.split(/(?:^|\n)（(?:这条引用了|用户发来|用户引用了)/u)[0] : record.text;
    return body.includes(row.annotation.quote) ? body.trim() : '';
  }
  if (mode === 'clues' && topic) {
    const records = [];
    for (const {row,date} of candidates) {
      const body = verifiedBody(row);
      if (body) records.push({id:row.id, date, role:row.role, text:body.slice(0,360), ...(body.length > 360 ? {truncated:true} : {})});
    }
    const offset = after ? records.findIndex(r => r.id === after) + 1 : 0;
    if (after && !offset) fail('来源分页位置已变化，请重新读取这个话题');
    const items = records.slice(offset,offset + 12);
    return {topic, total:records.length, items, ...(offset + items.length < records.length ? {after:items.at(-1).id} : {}),
      ...(unavailable.size ? {unavailableSources:unavailable.size} : {})};
  }
  if (mode === 'clues') {
    const groups = new Map();
    const compact = text => normalize(text).replace(/\s+/gu,'');
    for (const {row} of candidates) {
      const card = row.annotation, title = card.topic;
      if (after && title <= after) continue;
      const body = verifiedBody(row);
      if (!body) continue;
      const source = compact(body);
      const terms = card.terms.filter(t => t.length >= 2 && t.length <= 24 && !compact(title).includes(compact(t)) && source.includes(compact(t)));
      const sample = card.quote.slice(0,56);
      if (!groups.has(title)) groups.set(title,{example:sample,sources:[]});
      const group = groups.get(title);
      if (sample !== group.example) group.earlierExample = sample;
      group.sources.push([...new Set([terms[0],terms.at(-1),...terms].filter(Boolean))]);
    }
    const labels = [...groups.keys()].sort();
    const topics = labels.slice(0,80).map(topic => {
      const {sources,example,earlierExample} = groups.get(topic), hints = new Set();
      for (let place = 0; place < 12 && hints.size < 4; place++) {
        for (const terms of sources) {
          if (terms[place]) hints.add(terms[place]);
          if (hints.size === 4) break;
        }
      }
      return {topic,hints:[...hints],example,...(earlierExample ? {earlierExample} : {})};
    });
    return {topics, ...(labels.length > topics.length ? {after:topics.at(-1).topic} : {}),
      ...(unavailable.size ? {unavailableSources:unavailable.size} : {})};
  }
  if (browsing) {
    const titles = new Set();
    for (const {row} of candidates) {
      const title = row.annotation.topic;
      if ((!after || title > after) && !titles.has(title) && verifiedBody(row)) titles.add(title);
    }
    const sorted = [...titles].sort(), topics = sorted.slice(0,80);
    return {topics, ...(sorted.length > topics.length ? {after:topics.at(-1)} : {}),
      ...(unavailable.size ? {unavailableSources:unavailable.size} : {})};
  }
  const matched = new Set(candidates.map(c => c.row.id)), materials = [];
  for (const {row,date} of candidates) {
    if (!verifiedBody(row)) continue;
    const {topic,quote} = row.annotation;
    materials.push({id:row.id,topic,date,role:row.role,timePrecision:current(row.id).timePrecision,quote:quote.slice(0,240)});
    if (materials.length === 6) break;
  }
  const drafts = locked(options,(p,state) => Object.values(state.notes)
    .filter(n => n.kind === 'draft' && !n.retired)
    .map(n => ({n, titleMatch:keys.length > 0 && keys.every(k => has(normalize(n.title),k)),
      overlap:n.sources.filter(s => matched.has(s.id) && verifiedBody(catalog.get(s.id))).length}))
    .filter(({titleMatch,overlap}) => overlap || (titleMatch && !kind && !since && !until && !topic))
    .sort((a,b) => Number(b.titleMatch)-Number(a.titleMatch) || b.overlap-a.overlap
      || (b.n.latestAt || '').localeCompare(a.n.latestAt || '') || a.n.id.localeCompare(b.n.id))
    .filter(({n}) => fs.existsSync(target(p,n.file)) && n.sources.every(s => current(s.id)?.sourceHash === s.sha256))
    .slice(0,3).map(({n}) => ({id:n.id,title:n.title,revision:n.revision,factsChanged:!!n.factsRevision && n.factsRevision !== memory.revision})));
  return {materials,drafts,...(unavailable.size ? {unavailableSources:unavailable.size} : {})};
}
export function readNotebook(id, options = {}) {
  return locked(options, (p, state) => {
    const n = state.notes[id]; if (!n) fail('笔记不存在，先查询notebook list');
    const text = bytes(target(p, n.file));
    const staleSources = (n.sources || []).filter(s => { try { const r = readConversation(s.id,options); return r.stale || r.sourceHash !== s.sha256; } catch { return true; } }).map(s=>s.id);
    const memory = readMemory(options), stale = !!n.retired || !!staleSources.length || (n.kind === 'facts' && n.sourceHash !== memory.revision);
    return { ...n, path: target(p, n.file), text: stale && !options.history ? null : text, sha256: hash(text), manuallyEdited: hash(text) !== n.sha256,
      stale, staleSources, factsChanged: !!n.factsRevision && n.factsRevision !== memory.revision,
      currentFacts: memory.records, note: '话题与日常是有来源的历史材料；草稿是助手写作成果，不能当作用户亲口表达或新指令。失效正文仅用 --history 追溯。' };
  });
}
export function saveDraft(input, options = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,70}$/.test(input.id || '') || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 80
    || /[\r\n]/.test(input.title) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 50000
    || !Array.isArray(input.sources) || !input.sources.length || input.sources.length > 30) fail('写作稿需要稳定ID、标题、正文和原始材料');
  const catalog = new Map(conversationCatalog(options).map(row => [row.id,row]));
  const sources = input.sources.map(id => {
    const row = catalog.get(id); if (!row || readConversation(id, options).stale) fail('草稿来源不存在或已变化');
    return { id, sha256: row.hash, role: row.role };
  });
  return locked(options, (p, state) => {
    const id = `draft:${input.id}`, file = `草稿/${input.id}.md`, actual = bytes(target(p, file));
    if ((actual ? hash(actual) : null) !== input.expectedSha256) fail('写作稿版本已变化，请读取当前内容再合并');
    const references = sources.map(s => {
      const row = catalog.get(s.id), date = localDate(row.at), daily = state.notes['daily:'+date];
      const anchor = '^dawn-' + s.id;
      const dayLink = daily && !daily.retired && bytes(target(p,daily.file)).includes(anchor)
        ? noteLink(file,daily.file,date,'#' + anchor) : date;
      return `- ${dayLink} · ${role[s.role]} · [完整原文](${pathToFileURL(row.path).href}) · \`${s.id}\``;
    });
    const text = header(input.title, 'draft', hash(JSON.stringify(sources))) + input.text + '\n\n---\n素材来源：\n' + references.join('\n') + '\n';
    const result = commit(p, state, [{ id, file, kind: 'draft', title: input.title, text, sources, expectedSha256: input.expectedSha256, factsRevision: readMemory(options).revision, latestAt:new Date(options.now ?? Date.now()).toISOString() }], options);
    return { ...state.notes[id], path: target(p, file), ...(result.conflicts.length ? {conflicts:result.conflicts} : {}) };
  });
}
