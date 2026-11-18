import { waitingItems, nextWeekReview, syncWaitingEdits } from './waiting.mjs';
import { createHash } from 'node:crypto';
import { mutateMemory, profileRecords } from './memory.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const INDEX = 'archive/index.json';
const START = '<!-- dawn-archive-index:start -->', END = '<!-- dawn-archive-index:end -->';
const stamp = options => new Date(options.now ?? Date.now()).toISOString();
const day = options => new Date((options.now ?? Date.now()) + 8 * 3600e3).toISOString().slice(0, 10);
const facts = (read, options) => profileRecords(read('profile.md'), options.now ?? Date.now());
const versions = records => records.map(r => [r.id, r.revision, r.status]).sort((a, b) => a[0].localeCompare(b[0]));
const links = text => [...new Set([...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1]).filter(s => s.includes('/') && !s.startsWith('http')))];
function index(read) {
  const text = read(INDEX);
  if (!text) return { version: 1, generation: 0, entries: [], pending: null, lastRun: null };
  let value;
  try { value = JSON.parse(text); } catch { fail('MEMORY_ARCHIVE_INVALID', '记忆归档索引无法读取'); }
  if (value.version !== 1 || !Number.isInteger(value.generation) || !Array.isArray(value.entries)
    || value.entries.some(e => !/^[a-f0-9]{64}$/.test(e.id || '') || e.file !== `archive/${e.id}.md` || !['completed', 'state_snapshot'].includes(e.kind))) {
    fail('MEMORY_ARCHIVE_INVALID', '记忆归档索引格式无效');
  }
  return value;
}
function withoutIndex(text) {
  if (!text.includes(START) && !text.includes(END)) return text;
  const pieces = text.split(START);
  if (pieces.length !== 2 || pieces[1].split(END).length !== 2) fail('MEMORY_ARCHIVE_INVALID', '当前状态的归档入口标记不完整');
  return pieces[0].trimEnd() + pieces[1].slice(pieces[1].indexOf(END) + END.length);
}
function withIndex(text, state) {
  const completed = state.entries.filter(e => e.kind === 'completed');
  if (!completed.length) return text;
  const recent = completed.slice(-8).map(e => e.title).join('；');
  return `${withoutIndex(text).trimEnd()}\n\n${START}\n## 已完成成果入口\n共 ${completed.length} 项，memory search 关键词可取入口，archive ID 可回读详记。事实以现行记忆及项目源为准。\n近期：${recent}。\n${END}\n`;
}
function putEntry(state, edits, text, kind, title, sourceHash, records, options, factVersions = versions(records)) {
  const id = hash(text), file = `archive/${id}.md`;
  const old = state.entries.find(e => e.id === id);
  const entry = { id, file, kind, title, recordedAt: stamp(options), sourceHash, factVersions, links: links(text) };
  if (!old) state.entries.push(entry);
  else if (old.kind === 'state_snapshot' && kind === 'completed') {
    const snapshot = { recordedAt: old.recordedAt, sourceHash: old.sourceHash, factVersions: old.factVersions };
    Object.assign(old, entry, { snapshot });
  } else if (old.kind === 'completed' && kind === 'state_snapshot') {
    old.snapshot ||= { recordedAt: entry.recordedAt, sourceHash, factVersions };
  }
  edits.set(file, text);
  return old || state.entries.at(-1);
}
function selectedBlocks(text, selected) {
  if (!Array.isArray(selected) || selected.length > 30) fail('MEMORY_COMPLETION', '完成项必须是最多30个完整条目');
  const blocks = [...text.matchAll(/^- [^\n]*(?:\n[ \t]+[^\n]+)*/gm)];
  const seen = new Set();
  return selected.map(item => {
    if (!item || typeof item.quote !== 'string' || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 60
      || /[\r\n`<>]/.test(item.title) || blocks.filter(b => b[0] === item.quote).length !== 1 || seen.has(item.quote)) {
      fail('MEMORY_COMPLETION', '完成项需精确匹配一次完整条目，并有简短标题；混合待办保持当前状态');
    }
    seen.add(item.quote);
    const match = blocks.find(b => b[0] === item.quote);
    return { quote: item.quote, title: item.title.trim(), sha256: hash(item.quote), start: match.index, end: match.index + match[0].length };
  });
}
function saveIndex(edits, state) { edits.set(INDEX, `${JSON.stringify(state, null, 2)}\n`); }
export function readNow(options = {}) {
  return mutateMemory(options, ({ read }) => {
    const text = read('now.md'), state = index(read), records = facts(read, options);
    return { edits: new Map(), result: { text, waiting: waitingItems(text), nextWeekReviewOn: nextWeekReview(options.now), sha256: hash(text), factsRevision: hash(JSON.stringify(versions(records))),
      currentFacts: records.map(r => ({ id: r.id, revision: r.revision, status: r.status, value: r.value })),
      completed: state.pending?.nowSha256 === hash(text) ? state.pending.blocks : [], generation: state.generation } };
  });
}
export function updateNow(input, options = {}) {
  if (!input || typeof input.text !== 'string' || !input.text.trim()) fail('MEMORY_STATE_INVALID', '当前状态需要完整文本');
  if (input.text.length > 4000) fail('MEMORY_BUDGET', '当前状态超过4000字，请把已完成详情归档后精简，保留事实与待办入口');
  return mutateMemory(options, ({ read }) => {
    const previous = read('now.md'), state = index(read), records = facts(read, options);
    if (input.expectedSha256 !== hash(previous)) fail('MEMORY_STATE_CONFLICT', '当前状态已更新，先重读再合并本轮变化');
    if (input.expectedFactsRevision !== hash(JSON.stringify(versions(records)))) fail('MEMORY_STATE_CONFLICT', '有效事实已更新或缺少事实版本，先读取 state 的 factsRevision 和当前事实');
    const text = withIndex(input.text, state), completed = selectedBlocks(text, input.completed || []);
    if (text.length > 4000) fail('MEMORY_BUDGET', '当前状态与成果入口超过4000字，先精简当前正文');
    const edits = new Map();
    if (previous !== text) {
      if (previous) putEntry(state, edits, previous, 'state_snapshot', '当前状态修订前快照', hash(previous), records, options);
      edits.set('now.md', text);
    }
    syncWaitingEdits(text, read, edits);
    state.pending = completed.length ? { nowSha256: hash(text), blocks: completed, factVersions: versions(records), declaredAt: stamp(options) } : null;
    saveIndex(edits, state);
    return { edits, result: { status: 'updated', sha256: hash(text), completed: completed.length } };
  });
}
export function maintainMemory(options = {}, { force = false } = {}) {
  return mutateMemory(options, ({ read }) => {
    const state = index(read), previous = read('now.md'), records = facts(read, options);
    if (!force && state.lastRun?.day === day(options)) return { edits: new Map(), result: { status: 'already_checked', moved: 0 } };
    const edits = new Map();
    const pending = state.pending;
    const valid = pending?.nowSha256 === hash(previous) && Array.isArray(pending.factVersions);
    const blocks = valid ? selectedBlocks(previous, pending.blocks) : [];
    let text = previous;
    if (blocks.length) {
      putEntry(state, edits, previous, 'state_snapshot', '整理前当前状态', hash(previous), records, options);
      for (const block of blocks.sort((a, b) => b.start - a.start)) {
        putEntry(state, edits, block.quote, 'completed', block.title, hash(previous), records, options, pending.factVersions);
        text = text.slice(0, block.start) + text.slice(block.end);
      }
      text = withIndex(text.replace(/\n{3,}/g, '\n\n'), state);
      if (text.length > 4000) fail('MEMORY_BUDGET', '整理后的入口超过当前状态预算，原文保持');
      edits.set('now.md', text);
      state.generation++;
    }
    syncWaitingEdits(text, read, edits);
    state.pending = null;
    state.lastRun = { day: day(options), at: stamp(options), moved: blocks.length, staleDeclaration: !!pending && !valid,
      beforeHash: hash(previous), afterHash: hash(text), beforeChars: previous.length, afterChars: text.length };
    saveIndex(edits, state);
    return { edits, result: { status: 'checked', ...state.lastRun, generation: state.generation } };
  });
}
function archiveText(read, entry) {
  const text = read(entry.file);
  if (hash(text) !== entry.id) fail('MEMORY_ARCHIVE_CHANGED', '归档内容与登记哈希不符，需核对原件');
  return text;
}
export function searchArchive(query, options = {}) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  return mutateMemory(options, ({ read }) => {
    const state = index(read);
    const matches = state.entries.filter(e => e.kind === 'completed' || options.history).filter(e =>
      `${e.title}\n${archiveText(read, e)}`.toLowerCase().includes(needle));
    return { edits: new Map(), result: matches.map(e => ({ id: e.id.slice(0, 16), title: e.title, recordedAt: e.recordedAt, links: e.links, historical: true })) };
  });
}
export function readArchive(id, options = {}) {
  if (!/^[a-f0-9]{16,64}$/.test(id || '')) fail('MEMORY_ARCHIVE_ID', '使用 search 返回的归档ID');
  return mutateMemory(options, ({ read }) => {
    const state = index(read), matches = state.entries.filter(e => e.id.startsWith(id) && (e.kind === 'completed' || options.history));
    if (matches.length !== 1) fail('MEMORY_ARCHIVE_ID', '归档不存在或ID不唯一');
    const entry = matches[0], text = archiveText(read, entry), records = facts(read, options);
    const factsChanged = JSON.stringify(entry.factVersions) !== JSON.stringify(versions(records));
    return { edits: new Map(), result: { ...entry, historical: true, factsChanged,
      text: factsChanged && !options.history ? null : text, currentFacts: records.map(r => ({ id: r.id, revision: r.revision, status: r.status, value: r.value })),
      note: factsChanged ? '归档后的有效事实已变化。当前事实以 currentFacts 和项目源为准；以下入口可取成果，完整旧文仅用 archive ID --history 追溯。' : '这是完成事项的历史详记，用于追溯与找成果。当前事实、任务和用户新要求优先。' } };
  });
}
export function maintenanceStatus(options = {}) {
  return mutateMemory(options, ({ read }) => {
    const state = index(read);
    return { edits: new Map(), result: { generation: state.generation, completedCount: state.entries.filter(e => e.kind === 'completed').length,
      snapshotCount: state.entries.filter(e => e.kind === 'state_snapshot' || e.snapshot).length, pendingCount: state.pending?.blocks.length || 0, lastRun: state.lastRun } };
  });
}
