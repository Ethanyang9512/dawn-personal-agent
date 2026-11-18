import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withAutomationControlLock } from './automation-control.mjs';
import { readTaskJson, writeTaskJson } from './task-protocol.mjs';
import { readProjectContext } from './project-context.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
const blockPattern = /<!-- dawn-memory (\{[^\n]+\}) -->\n([\s\S]*?)\n<!-- \/dawn-memory -->/g;
const plain = (value, name, max = 1500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('INVALID_MEMORY', `${name} 为空或过长`);
  return value.trim();
};
export function memoryPaths(options = {}, env = process.env) {
  const memoryDir = options.memoryDir || env.DAWN_MEMORY_DIR;
  const journalPath = options.journalPath || env.DAWN_MEMORY_JOURNAL;
  if (![memoryDir, journalPath].every(p => typeof p === 'string' && path.isAbsolute(p))) fail('MISSING_MEMORY_PATHS', '显式提供 DAWN_MEMORY_DIR 和 DAWN_MEMORY_JOURNAL 绝对路径');
  return { memoryDir, journalPath };
}
function safeFile(root, relative) {
  if (!/^(?:profile\.md|now\.md|reminders\.json|goals\/[a-zA-Z0-9_-]+\.md|log\/\d{4}-\d{2}-\d{2}\.md|archive\/(?:index\.json|[a-f0-9]{64}\.md))$/.test(relative)) fail('MEMORY_PATH', '只操作当前记忆、日期日志和内容归档');
  const file = path.join(root, relative);
  fs.mkdirSync(root, { recursive: true });
  let ancestor = file;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actual = fs.realpathSync(ancestor), base = fs.realpathSync(root);
  if (actual !== base && !actual.startsWith(base + path.sep)) fail('MEMORY_PATH', '记忆路径越界');
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) fail('MEMORY_PATH', '记忆必须是普通文件');
  return file;
}
function parseProfile(profile) {
  const records = [];
  for (const match of profile.matchAll(blockPattern)) {
    let meta;
    try { meta = JSON.parse(match[1]); } catch { fail('MEMORY_INVALID', '有效记忆元数据损坏'); }
    if (!/^[a-z0-9][a-z0-9_.-]{0,79}$/.test(meta.id || '') || !Number.isInteger(meta.revision) || meta.revision < 1
      || !['active', 'withdrawn'].includes(meta.status) || !Array.isArray(meta.requests) || typeof meta.subject !== 'string'
      || meta.bodyHash !== hash(match[2]) || records.some(r => r.id === meta.id)) fail('MEMORY_INVALID', '有效记忆身份或内容校验失败');
    records.push({ ...meta, value: match[2], raw: match[0] });
  }
  const remaining = profile.replace(blockPattern, '');
  if (remaining.includes('<!-- dawn-memory') || remaining.includes('<!-- /dawn-memory')) fail('MEMORY_INVALID', '有效记忆标记不完整');
  return { records, remaining };
}
function recover(paths) {
  const tx = readTaskJson(paths.journalPath, null);
  if (!tx) return;
  if (tx.version !== 1 || !Array.isArray(tx.files)) fail('MEMORY_TRANSACTION_INVALID', '记忆事务无效');
  // 先核对所有文件，不能写完一半才发现另一文件被手改。
  for (const item of tx.files) {
    const current = read(safeFile(paths.memoryDir, item.file));
    const archive = item.file.match(/^archive\/([a-f0-9]{64})\.md$/);
    if (archive && hash(item.after) !== archive[1]) fail('MEMORY_ARCHIVE', '恢复归档内容与文件名哈希不符');
    if (![item.beforeHash, hash(item.after)].includes(hash(current))) fail('MEMORY_CONFLICT', `记忆事务遇到并发修改：${item.file}`);
  }
  for (const item of tx.reads || []) {
    if (tx.files.some(file => file.file === item.file)) continue;
    if (hash(read(safeFile(paths.memoryDir, item.file))) !== item.sha256) fail('MEMORY_CONFLICT', `记忆事务依赖已变化：${item.file}`);
  }
  for (const item of tx.files) {
    const file = safeFile(paths.memoryDir, item.file);
    if (hash(read(file)) === hash(item.after)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, item.after, { mode: 0o600 }); fs.renameSync(tmp, file);
  }
  fs.unlinkSync(paths.journalPath);
}
function locked(options, fn) {
  const paths = memoryPaths(options);
  // 其他进程的短事务可能正好与读记忆相撞，短暂等锁，不把正常查询误报成损坏。
  for (let attempt = 0; ; attempt++) {
    try { return withAutomationControlLock(paths.journalPath, () => { recover(paths); return fn(paths); }); } catch (error) {
      if (error.code !== 'CONTROL_BUSY' || attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
export function mutateMemory(options, prepare) {
  return locked(options, paths => {
    const originals = new Map();
    const original = relative => {
      if (!originals.has(relative)) originals.set(relative, read(safeFile(paths.memoryDir, relative)));
      return originals.get(relative);
    };
    const { edits, result } = prepare({ read: original, paths });
    if (!(edits instanceof Map)) fail('MEMORY_TRANSACTION_INVALID', '记忆变更需要文件映射');
    const files = [];
    for (const [file, after] of edits) {
      if (typeof after !== 'string') fail('MEMORY_TRANSACTION_INVALID', '记忆文件内容须为文本');
      const before = original(file), target = safeFile(paths.memoryDir, file);
      const archive = file.match(/^archive\/([a-f0-9]{64})\.md$/);
      if (archive && (hash(after) !== archive[1] || (fs.existsSync(target) && before !== after))) fail('MEMORY_ARCHIVE', '归档须匹配内容哈希，已有归档不可覆盖');
      if (before !== after) files.push({ file, beforeHash: hash(before), after });
    }
    if (!files.length) return result;
    options.beforePrepare?.();
    for (const [file, before] of originals) if (hash(read(safeFile(paths.memoryDir, file))) !== hash(before)) fail('MEMORY_CONFLICT', `记忆事务遇到并发修改：${file}`);
    writeTaskJson(paths.journalPath, { version: 1, files, reads: [...originals].map(([file, before]) => ({ file, sha256: hash(before) })) });
    options.afterPrepare?.();
    recover(paths);
    return result;
  });
}
const isExpired = (record, now) => !!record.expiresAt && Date.parse(record.expiresAt) <= now;
function currentRecord(record, now) {
  const { raw, bodyHash, requests, ...result } = record;
  if (record.status === 'withdrawn' || isExpired(record, now)) {
    result.status = record.status === 'withdrawn' ? 'withdrawn' : 'expired';
    result.value = '当前无有效值；回原来源核对，不回用旧版本。';
  }
  return result;
}
export function profileRecords(profileText, now = Date.now()) {
  return parseProfile(profileText).records.map(record => currentRecord(record, now));
}
function summary(records, now) {
  return records.filter(r => r.status === 'active' && !isExpired(r, now)).map(r => {
    const c = currentRecord(r, now);
    const source = c.source.kind === 'legacy' ? '旧记录' : c.source.kind === 'maintenance' ? '来源整理' : '用户来源';
    return `- [${c.id} r${c.revision} ${c.status}] ${c.subject}：${c.value}（${source} ${c.source.at.slice(0, 10)}）`;
  }).join('\n');
}
export function readMemory(options = {}) {
  return locked(options, paths => {
    const parsed = parseProfile(read(safeFile(paths.memoryDir, 'profile.md')));
    const now = options.now ?? Date.now();
    return { revision: hash(parsed.records.map(r => `${r.id}:${r.revision}:${isExpired(r, now)}`).sort().join('\n')),
      records: parsed.records.map(r => currentRecord(r, now)),
      current: summary(parsed.records, now), profile: parsed.remaining.trim(), now: read(safeFile(paths.memoryDir, 'now.md')).trim() };
  });
}
export function memoryContext(options = {}) {
  const data = readMemory(options);
  const cap = (text, n) => text.length > n ? `${text.slice(0, n)}\n（已截断，可用 memory CLI 查询）` : text;
  const parts = [];
  if (data.current) parts.push(`[Dawn 当前有效记忆 · 优先于旧聊天/日志/任务检查点]\n${data.current}\n历史记录只解释当时情况，不恢复被替代、撤销或过期的值。临时选择仅用于本次请求。项目状态按 project-sources 的 ID 回原源核对。`);
  if (data.now) parts.push(`[Dawn 长期记忆 · 当前状态]\n${cap(data.now, 4000)}`);
  if (data.profile) parts.push(`[Dawn 长期记忆 · 用户偏好]\n${cap(data.profile, Math.max(0, 2000 - data.current.length))}`);
  parts.push('完成事项详记通过 memory search/archive 读取，历史不能覆盖当前事实。');
  return { ...data, text: parts.length ? `${parts.join('\n\n')}\n\n` : '' };
}
export function migrateLegacyMemory(input, options = {}) {
  if (options.maintenance !== true || process.env.DAWN_WECHAT || process.env.DAWN_PERSISTENT_TASK) fail('MEMORY_MAINTENANCE_ONLY', '旧记忆迁入仅限桌面维护入口');
  if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 20 || !/^[a-f0-9]{64}$/.test(input.expectedProfileSha256 || '')) fail('MEMORY_LEGACY_CONFLICT', '迁入需要当前 profile 哈希和 1–20 条精确旧记录');
  const request = hash(JSON.stringify(input)), now = options.now ?? Date.now();
  return mutateMemory(options, ({ read: original }) => {
    const profile = original('profile.md'), parsed = parseProfile(profile);
    if (input.entries.every(entry => parsed.records.find(record => record.id === entry.id)?.requests.includes(request))) {
      return { edits: new Map(), result: { status: 'already_applied', records: input.entries.map(entry => currentRecord(parsed.records.find(record => record.id === entry.id), now)) } };
    }
    if (hash(profile) !== input.expectedProfileSha256) fail('MEMORY_CONFLICT', '旧记忆迁入基线已变化，重新读取 profile');
    let remaining = parsed.remaining;
    const records = [], events = [], recordedAt = new Date(now).toISOString();
    for (const entry of input.entries) {
      const { id, subject, legacyText, source } = entry;
      if (!/^[a-z0-9][a-z0-9_.-]{0,79}$/.test(id || '') || typeof subject !== 'string' || !subject.trim() || subject.length > 100) fail('MEMORY_LEGACY_CONFLICT', '旧记忆需要稳定 ID 和主题');
      if (parsed.records.some(record => record.id === id) || records.some(record => record.id === id)) fail('MEMORY_REVISION_CONFLICT', '迁入不能覆盖已有记忆 ID');
      if ('value' in entry || typeof legacyText !== 'string' || !legacyText.startsWith('- ') || legacyText.length > 1202 || legacyText.includes('<!--') || remaining.split('\n').filter(line => line === legacyText).length !== 1) fail('MEMORY_LEGACY_CONFLICT', '旧记录必须逐字匹配 profile 中一条完整原文，不能改写');
      if (!source || source.kind !== 'legacy' || !path.isAbsolute(source.path || '') || !/^[a-f0-9]{64}$/.test(source.sha256 || '') || source.quote !== legacyText || !['recorded', 'snapshot'].includes(source.dateBasis)
        || !Number.isFinite(Date.parse(source.at)) || Date.parse(source.at) > now || typeof source.dateQuote !== 'string' || !source.dateQuote.includes(source.at)) fail('MEMORY_LEGACY_SOURCE', '旧记忆来源需要真实文件、哈希、原句和可核对的记录日期');
      let body;
      try {
        const stat = fs.lstatSync(source.path);
        if (!stat.isFile() || stat.size > 1024 * 1024) fail('MEMORY_LEGACY_SOURCE', '旧记忆来源须为普通文本文件');
        body = fs.readFileSync(source.path, 'utf8');
      } catch (error) { if (error.code === 'MEMORY_LEGACY_SOURCE') throw error; fail('MEMORY_LEGACY_SOURCE', '旧记忆来源文件不可读'); }
      if (hash(body) !== source.sha256 || !body.includes(source.quote) || !body.includes(source.dateQuote)) fail('MEMORY_LEGACY_SOURCE', '旧记忆来源哈希、原句或日期依据不匹配');
      const value = legacyText.slice(2);
      const record = { id, subject: subject.trim(), affects: [], revision: 1, status: 'active', source: { kind: 'legacy', path: source.path, reference: source.path, sha256: source.sha256, quote: source.quote, at: source.at, dateBasis: source.dateBasis, dateQuote: source.dateQuote }, recordedAt, expiresAt: null, replaces: null, requests: [request], bodyHash: hash(value) };
      records.push({ ...record, value });
      remaining = remaining.split('\n').filter(line => line !== legacyText).join('\n');
      events.push({ id, revision: 1, recordedAt, replaces: null, previous: null, current: { ...record, value }, retiredLegacy: [{ file: 'profile.md', text: legacyText }] });
    }
    if (summary([...parsed.records, ...records], now).length + remaining.trim().length > 2000) fail('MEMORY_BUDGET', '迁入后有效记忆超过完整注入预算，先精简条目');
    const blocks = records.map(({ value, ...record }) => `<!-- dawn-memory ${JSON.stringify(record)} -->\n${value}\n<!-- /dawn-memory -->`);
    const next = `${remaining.trimEnd()}\n\n${[...parsed.records.map(record => record.raw), ...blocks].join('\n\n')}\n`;
    const logFile = `log/${new Date(now + 8 * 3600e3).toISOString().slice(0, 10)}.md`;
    const log = `${original(logFile).trimEnd()}\n\n${events.map(event => `<!-- dawn-memory-history ${JSON.stringify(event)} -->\n- 旧记忆迁入 ${event.id}@1：原文与来源保留，当前值用 memory CLI 查询。`).join('\n\n')}\n`;
    return { edits: new Map([['profile.md', next], [logFile, log]]), result: { status: 'migrated', records: records.map(record => currentRecord(record, now)) } };
  });
}
export function migrateProfile(input, options = {}) {
  if (options.maintenance !== true || process.env.DAWN_WECHAT || process.env.DAWN_PERSISTENT_TASK) fail('MEMORY_MAINTENANCE_ONLY', '仅限桌面维护');
  if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 20) fail('INVALID_MEMORY', '需要1–20条迁移');
  const request = hash(JSON.stringify(input)), now = options.now ?? Date.now();
  return mutateMemory(options, ({read: original}) => {
    const profile = original('profile.md'), parsed = parseProfile(profile);
    if (input.entries.every(e => parsed.records.find(r => r.id === e.id)?.requests.includes(request))) return {edits:new Map(),result:{status:'already_applied'}};
    if (hash(profile) !== input.expectedProfileSha256) fail('MEMORY_CONFLICT', 'profile基线已变化');
    let next = profile;
    const events = [], seen = new Set(), at = new Date(now).toISOString();
    for (const entry of input.entries) {
      const previous = parsed.records.find(r => r.id === entry.id);
      if (!previous || seen.has(entry.id) || previous.revision !== entry.expectedRevision) fail('MEMORY_REVISION_CONFLICT', '需已有唯一ID及准确版本');
      seen.add(entry.id);
      if (!['moved','merged','merge','source_completion'].includes(entry.action)) fail('INVALID_MEMORY', '未知维护动作');
      const value = plain(entry.value,'value',1200);
      if (value.includes('<!--')) fail('INVALID_MEMORY','不能包含控制标记');
      const evidence = entry.evidence;
      if (entry.action === 'source_completion') {
        if (!evidence || !path.isAbsolute(evidence.path || '') || !/^[a-f0-9]{64}$/.test(evidence.sha256 || '') || typeof evidence.quote !== 'string' || !evidence.quote.trim()) fail('MEMORY_SOURCE','补全需要真实文件原句和哈希');
        const body = fs.readFileSync(evidence.path,'utf8');
        if (hash(body) !== evidence.sha256 || !body.includes(evidence.quote)) fail('MEMORY_SOURCE','来源文件不匹配');
      }
      if (['moved','merged'].includes(entry.action)) plain(entry.target,'target',500);
      const merged = (entry.mergeFrom || []).map(id => {
        const record = parsed.records.find(r => r.id === id);
        if (!record || record.status !== 'active') fail('MEMORY_SOURCE','合并来源不存在');
        return currentRecord(record,now);
      });
      if (entry.action === 'merge' && !merged.length) fail('MEMORY_SOURCE','合并需原记录');
      const {raw, value: oldValue, ...meta} = previous;
      const record = {...meta,revision:previous.revision+1,status:['moved','merged'].includes(entry.action)?'withdrawn':'active',
        replaces:`${previous.id}@${previous.revision}`,recordedAt:at,bodyHash:hash(value),requests:[...previous.requests,request],
        source:{kind:'maintenance',at,dateBasis:'snapshot',action:entry.action,reference:entry.target || previous.id,
          previousSource:previous.source, ...(evidence ? {evidence}:{}), ...(merged.length ? {merged}: {})}};
      next = next.replace(raw,`<!-- dawn-memory ${JSON.stringify(record)} -->\n${value}\n<!-- /dawn-memory -->`);
      events.push({id:record.id,revision:record.revision,recordedAt:at,replaces:record.replaces,
        previous:{...currentRecord(previous,now),status:'superseded',supersededBy:`${record.id}@${record.revision}`},current:{...record,value},maintenance:entry.action});
    }
    const final = parseProfile(next);
    if (summary(final.records,now).length + final.remaining.trim().length > 2000) fail('MEMORY_BUDGET','迁移超过注入预算');
    const logFile = `log/${new Date(now+8*3600e3).toISOString().slice(0,10)}.md`;
    const log = `${original(logFile).trimEnd()}\n\n${events.map(e=>`<!-- dawn-memory-history ${JSON.stringify(e)} -->\n- 维护整理 ${e.id}@${e.revision}：${e.maintenance}；保留原来源，非用户新发言。`).join('\n\n')}\n`;
    return {edits:new Map([['profile.md',next],[logFile,log]]),result:{status:'migrated',changed:events.length}};
  });
}
export function rememberMemory(input, options = {}) {
  const messages = Object.hasOwn(options, 'userMessages') ? options.userMessages : JSON.parse(process.env.DAWN_MEMORY_USER_MESSAGES || 'null');
  const versions = Object.hasOwn(options, 'factVersions') ? options.factVersions : JSON.parse(process.env.DAWN_MEMORY_FACT_VERSIONS || 'null');
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) fail('MEMORY_REVISION_REQUIRED', '需要桥提供本轮记忆版本快照');
  const quote = plain(input.quote, '用户原话', 4000);
  const matches = Array.isArray(messages) ? messages.filter(m => (!input.sourceId || m.id === input.sourceId) && m.text.includes(quote)) : [];
  if (matches.length !== 1) fail('MEMORY_SOURCE', '原话需唯一对应本轮用户消息；多条同文时指定 sourceId');
  const source = matches[0], expectedRevision = Object.hasOwn(versions, input.id) ? versions[input.id] : 0;
  if (input.expectedRevision !== undefined && input.expectedRevision !== expectedRevision) fail('MEMORY_REVISION_CONFLICT', '不能覆盖桥提供的本轮版本');
  return correctMemory({ ...input, expectedRevision, duration: input.duration || 'persistent',
    source: { kind: 'user', quote, reference: source.id, at: source.at } }, { ...options, userMessages: messages });
}

export function correctMemory(input, options = {}) {
  const id = plain(input.id, 'id', 80);
  if (!/^[a-z0-9][a-z0-9_.-]{0,79}$/.test(id)) fail('INVALID_MEMORY', 'id 使用小写英文、数字、点或横线');
  if (input.duration !== 'persistent') fail('TEMPORARY_MEMORY', '临时选择不覆盖长期记忆');
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) fail('MEMORY_REVISION_REQUIRED', '先查询当前版本，再提供 expectedRevision');
  const subject = plain(input.subject, 'subject', 100);
  const status = input.status || 'active';
  if (!['active', 'withdrawn'].includes(status)) fail('INVALID_MEMORY', 'status 为 active/withdrawn');
  const value = status === 'withdrawn' ? '用户已撤销该条记忆，当前无有效值。' : plain(input.value, 'value', 1200);
  if (value.includes('<!--')) fail('INVALID_MEMORY', '记忆值不能包含控制标记');
  const source = input.source || {};
  if (source.kind !== 'user') fail('MEMORY_SOURCE', '只有用户明确表达或纠正可写长期记忆，模型建议不能升级为偏好');
  const quote = plain(source.quote, '用户原话', 4000), reference = plain(source.reference, '来源', 500);
  if (!Number.isFinite(Date.parse(source.at))) fail('MEMORY_SOURCE', '来源需要明确时间');
  const messages = options.userMessages ?? (process.env.DAWN_MEMORY_USER_MESSAGES ? JSON.parse(process.env.DAWN_MEMORY_USER_MESSAGES) : null);
  if (messages && !messages.some(m => m.id === reference && m.text.includes(quote))) fail('MEMORY_SOURCE', '引用必须来自本轮实际用户消息');
  if (input.expiresAt && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= (options.now ?? Date.now()))) fail('INVALID_MEMORY', 'expiresAt 应为未来时间');
  if (input.affects !== undefined && (!Array.isArray(input.affects) || input.affects.length > 40 || input.affects.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id)))) fail('INVALID_MEMORY', 'affects 使用受影响任务 ID 数组');
  const request = hash(JSON.stringify({ affects: input.affects, id, subject, value, status, quote, reference, at: source.at, expiresAt: input.expiresAt || null }));
  return mutateMemory(options, ({ read: original }) => {
    const profile = original('profile.md');
    const parsed = parseProfile(profile), previous = parsed.records.find(r => r.id === id);
    if (previous?.requests.includes(request)) return { edits: new Map(), result: { status: 'already_applied', current: currentRecord(previous, options.now ?? Date.now()) } };
    if ((previous?.revision || 0) !== input.expectedRevision) fail('MEMORY_REVISION_CONFLICT', '记忆已被更新，重新读取后再决定；不能用旧版本覆盖');
    if (previous && previous.value === value && previous.subject === subject && previous.status === status
      && previous.expiresAt === (input.expiresAt || null) && (input.affects || []).every(id => previous.affects?.includes(id))) return { edits: new Map(), result: { status: 'already_current', current: currentRecord(previous, options.now ?? Date.now()) } };
    const recordedAt = new Date(options.now ?? Date.now()).toISOString();
    const record = { id, subject, affects: [...new Set([...(previous?.affects || []), ...(input.affects || [])])].sort(), revision: input.expectedRevision + 1, status, source: { kind: 'user', quote, reference, at: source.at },
      recordedAt, expiresAt: input.expiresAt || null, replaces: previous ? `${id}@${previous.revision}` : null,
      requests: [...(previous?.requests || []), request], bodyHash: hash(value) };
    const replacement = `<!-- dawn-memory ${JSON.stringify(record)} -->\n${value}\n<!-- /dawn-memory -->`;
    const edits = new Map([['profile.md', previous ? profile.replace(previous.raw, replacement) : `${profile.trimEnd()}\n\n${replacement}\n`]]);
    const legacy = input.legacy || [];
    if (!Array.isArray(legacy) || legacy.length > 20) fail('INVALID_MEMORY', 'legacy 最多 20 个旧条目位置');
    for (const item of legacy) {
      if (!item || typeof item.file !== 'string') fail('INVALID_MEMORY', 'legacy 需要 file 与 text');
      if (item.file.startsWith('log/')) fail('MEMORY_PATH', '历史日志不重写');
      const text = plain(item.text, '待替代原文', 6000);
      const current = edits.get(item.file) ?? original(item.file);
      if (text.includes('<!--') || current.split(text).length !== 2) fail('MEMORY_LEGACY_CONFLICT', '待替代原文必须精确匹配一处，重新查询后再改');
      edits.set(item.file, current.replace(text, item.file === 'profile.md' ? '' : `当前有效值见 profile.md 的 ${id} 条目。`));
    }
    const next = parseProfile(edits.get('profile.md'));
    if (summary(next.records, options.now ?? Date.now()).length > 2000) fail('MEMORY_BUDGET', '有效记忆超过每轮注入预算，先精简条目再写入');
    const day = new Date((options.now ?? Date.now()) + 8 * 3600e3).toISOString().slice(0, 10);
    const logFile = `log/${day}.md`;
    const event = { id, revision: record.revision, recordedAt, replaces: record.replaces,
      previous: previous ? { ...currentRecord(previous, options.now ?? Date.now()), status: 'superseded', supersededBy: `${id}@${record.revision}` } : null,
      current: { ...record, value }, retiredLegacy: legacy };
    const log = original(logFile);
    edits.set(logFile, `${log.trimEnd()}\n\n<!-- dawn-memory-history ${JSON.stringify(event)} -->\n- 记忆修订 ${id}@${record.revision}：替代 ${record.replaces || '旧散落条目/首次登记'}；历史值已失效，当前值用 memory CLI 查询。\n`);
    return { edits, result: { status: 'corrected', current: currentRecord({ ...record, value }, options.now ?? Date.now()) } };
  });
}
export function memoryHistory(id, options = {}) {
  return locked(options, paths => {
    const current = parseProfile(read(safeFile(paths.memoryDir, 'profile.md'))).records.find(r => r.id === id);
    const events = [];
    const dir = path.join(paths.memoryDir, 'log');
    for (const file of fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort() : []) {
      for (const match of read(safeFile(paths.memoryDir, `log/${file}`)).matchAll(/<!-- dawn-memory-history (\{[^\n]+\}) -->/g)) {
        const event = JSON.parse(match[1]);
        if (event.id === id) events.push({ ...event, current: { ...event.current, status: event.revision === current?.revision ? current.status : 'superseded' }, historical: true, isCurrent: event.revision === current?.revision });
      }
    }
    return { historical: true, current: current ? currentRecord(current, options.now ?? Date.now()) : null, events };
  });
}
export function searchMemory(query, options = {}) {
  const data = readMemory(options), needle = plain(query, '查询词', 300).toLowerCase();
  const records = data.records.filter(r => `${r.id} ${r.subject} ${r.value}`.toLowerCase().includes(needle));
  const lines = [data.profile, data.now].flatMap(t => t.split('\n')).filter(l => l.toLowerCase().includes(needle));
  return { currentOnly: true, revision: data.revision, records, notes: lines.slice(0, 20), historyIncluded: false };
}
export function currentProject(id, options = {}) {
  const paths = memoryPaths(options);
  return readProjectContext({ indexPath: path.join(paths.memoryDir, 'project-sources.json'), projectId: id });
}
export const historicalLogText = text => text.replace(/<!-- dawn-memory-history [^\n]*/g, '（记忆修订详情属历史；当前事实以上方有效记忆为准）');
