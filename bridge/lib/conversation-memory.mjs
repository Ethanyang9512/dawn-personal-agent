import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { writeDurableJson } from './durable-json.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { code: 'CONVERSATION_MEMORY' }); };
const day = at => new Date(new Date(at).getTime() + 8 * 3600e3).toISOString().slice(0, 10);
const precision = record => record.timePrecision || (record.role === 'legacy' ? (/^-\s+\d{2}:\d{2}\b/.test(record.text) ? 'minute' : 'day') : 'instant');
const STOP = new Set([...('今天现在之前当时后来这个那个什么怎么觉得可以我们你们记得帮我还有一下一件事情上次就是然后已经可能需要希望'.matchAll(/(?=(..))/gu))].map(m => m[1]));
export function conversationPaths(options = {}, env = process.env) {
  const memoryDir = options.memoryDir || env.DAWN_MEMORY_DIR, indexPath = options.indexPath || env.DAWN_CONVERSATIONS_INDEX;
  if (![memoryDir, indexPath].every(p => typeof p === 'string' && path.isAbsolute(p))) fail('显式提供记忆目录与聊天索引绝对路径');
  return { ...options, memoryDir, indexPath, root: path.join(memoryDir, 'conversations') };
}
function noLink(file) {
  for (let p = file; p !== path.dirname(p); p = path.dirname(p)) {
    if (p === '/var' && fs.realpathSync(p) === '/private/var') continue; // macOS 系统临时目录别名。
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('记忆路径不能使用软链');
  }
}
function open(options, work) {
  const p = conversationPaths(options); noLink(p.root); noLink(p.indexPath);
  fs.mkdirSync(path.dirname(p.indexPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(p.indexPath, { timeout: 2000 });
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, file TEXT NOT NULL, hash TEXT NOT NULL,
        at TEXT NOT NULL, role TEXT NOT NULL, source_key TEXT NOT NULL, text TEXT NOT NULL, annotation TEXT,
        curated INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_search USING fts5(id UNINDEXED, terms);
      CREATE TABLE IF NOT EXISTS conversation_runs(id TEXT PRIMARY KEY, day TEXT NOT NULL, at INTEGER NOT NULL,
        ids TEXT NOT NULL, status TEXT NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS conversation_dates ON conversations(at);
      CREATE INDEX IF NOT EXISTS conversation_sources ON conversations(source_key);`);
    return work(db, p);
  } finally { db.close(); }
}
function transaction(db, work) { db.exec('BEGIN IMMEDIATE'); try { const value = work(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } }
function tokens(text) {
  const found = [];
  for (const m of String(text).normalize('NFKC').toLowerCase().matchAll(/[\p{Script=Han}]+|[a-z0-9][a-z0-9_.+-]*/gu)) {
    if (/\p{Script=Han}/u.test(m[0])) { for (let i = 0; i < m[0].length - 1; i++) { const term = m[0].slice(i, i + 2); if (!STOP.has(term)) found.push(term); } }
    else if (m[0].length > 1) found.push(m[0]);
  }
  return [...new Set(found)];
}
function location(p, record) { return path.join(p.root, record.id.slice(0, 2), `${record.id}.json`); }
function annotationFile(p, id) { return path.join(p.root, 'annotations', `${id}.json`); }
function readRaw(p, row) {
  const file = path.join(p.root, row.file); noLink(file);
  const bytes = fs.readFileSync(file); if (hash(bytes) !== row.hash) fail('聊天原文哈希不符');
  const record = JSON.parse(bytes); if (record.id !== row.id) fail('聊天来源身份不符'); return record;
}
function checkedItem(file, skipped, work) {
  try { noLink(file); return work(); }
  catch (error) { if (!skipped) throw error; skipped.push({ path: file, reason: error.code || error.name }); return null; }
}
function indexRecord(db, p, record, file, annotation = null) {
  const old = db.prepare('SELECT annotation,curated FROM conversations WHERE id=?').get(record.id);
  const card = annotation || (old?.annotation ? JSON.parse(old.annotation) : null);
  if (['obsidian', 'legacy_log'].includes(record.source.kind)) db.prepare('UPDATE conversations SET active=0 WHERE source_key=? AND id<>?').run(record.source.key, record.id);
  db.prepare(`INSERT INTO conversations(id,file,hash,at,role,source_key,text,annotation,curated,active) VALUES(?,?,?,?,?,?,?,?,?,1)
    ON CONFLICT(id) DO UPDATE SET file=excluded.file,hash=excluded.hash,annotation=excluded.annotation,curated=excluded.curated,active=1`)
    .run(record.id, path.relative(p.root, file), hash(fs.readFileSync(file)), record.at, record.role, record.source.key, record.text, card ? JSON.stringify(card) : null, card ? 1 : old?.curated || 0);
  db.prepare('DELETE FROM conversation_search WHERE id=?').run(record.id);
  db.prepare('INSERT INTO conversation_search(id,terms) VALUES(?,?)').run(record.id, tokens(`${record.text}\n${card?.summary || ''}\n${(card?.terms || []).join(' ')}`).join(' '));
}
export function captureConversation(input, options = {}) {
  if (!input || !['user', 'assistant', 'proactive', 'legacy', 'note'].includes(input.role) || typeof input.sourceId !== 'string' || !input.sourceId
    || typeof input.text !== 'string' || !input.text.trim() || !Number.isFinite(Date.parse(input.at))) fail('聊天记录需要角色、来源ID、日期和原文');
  const kind = input.source?.kind || (input.role === 'assistant' ? 'assistant' : 'wechat');
  const id = hash(`${kind}:${input.sourceId}`);
  const record = { version: 1, id, at: new Date(input.at).toISOString(), role: input.role, text: input.text,
    timePrecision: precision(input),
    source: { ...input.source, kind, id: input.sourceId, key: input.source?.key || `${kind}:${input.sourceId}` },
    replyTo: input.replyTo || [], contextIds: input.contextIds || [], completedAt: input.completedAt || null, factVersions: input.factVersions || null, factsRevision: input.factsRevision || null, contextRevision: input.contextRevision || null };
  return open(options, (db, p) => transaction(db, () => {
    const file = location(p, record); noLink(file);
    const indexed = db.prepare('SELECT file FROM conversations WHERE id=?').get(id);
    if (indexed && path.join(p.root, indexed.file) !== file) fail('同一聊天来源出现日期冲突');
    if (fs.existsSync(file)) {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (existing.id !== id || existing.text !== record.text || existing.role !== record.role || existing.at !== record.at
        || JSON.stringify(existing.source) !== JSON.stringify(record.source) || JSON.stringify(existing.replyTo) !== JSON.stringify(record.replyTo)) fail('同一聊天来源出现原文冲突');
      indexRecord(db, p, existing, file); return existing;
    }
    writeDurableJson(file, record);
    options.afterSourceWrite?.();
    indexRecord(db, p, record, file); return record;
  }));
}
export function rebuildConversations(options = {}) {
  return open(options, (db, p) => transaction(db, () => {
    if (!fs.existsSync(p.root)) return { records: 0 };
    const records = [], skipped = [];
    for (const directory of fs.readdirSync(p.root).filter(n => /^[a-f0-9]{2}$/.test(n)).sort()) {
      const names=checkedItem(path.join(p.root,directory),skipped,()=>fs.readdirSync(path.join(p.root,directory))) || [];
      for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).sort()) {
        const file = path.join(p.root, directory, name);
        checkedItem(file, skipped, () => {
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (record.id !== name.slice(0, -5) || hash(`${record.source.kind}:${record.source.id}`) !== record.id || record.version !== 1) fail('原文身份校验失败');
        records.push({ record, file });
        });
      }
    }
    db.exec('DELETE FROM conversation_search; UPDATE conversations SET active=0;');
    const seen = new Set();
    let indexed=0;
    for (const { record, file } of records.sort((a, b) => String(a.record.at).localeCompare(String(b.record.at)))) {
      checkedItem(file, skipped, () => {
      if (seen.has(record.id)) fail('同一来源存在重复原文'); seen.add(record.id);
      const af = annotationFile(p, record.id); noLink(af);
      const annotation = fs.existsSync(af) ? JSON.parse(fs.readFileSync(af, 'utf8')) : null;
      if (annotation && (annotation.id !== record.id || annotation.sourceHash !== hash(fs.readFileSync(file)) || !record.text.includes(annotation.quote))) fail('语义索引与原文不一致');
      indexRecord(db, p, record, file, annotation);
      if (!currentSource(record)) db.prepare('UPDATE conversations SET active=0 WHERE id=?').run(record.id);
      indexed++;
      });
    }
    const ledger = path.join(p.root, 'curation'); noLink(ledger);
    if (fs.existsSync(ledger)) for (const date of fs.readdirSync(ledger).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))) {
      const dir = path.join(ledger,date); noLink(dir);
      for (const name of fs.readdirSync(dir).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
        const file = path.join(dir,name); noLink(file); const run = JSON.parse(fs.readFileSync(file,'utf8'));
        db.prepare('INSERT OR REPLACE INTO conversation_runs(id,day,at,ids,status,error) VALUES(?,?,?,?,?,?)').run(run.id,run.day,run.at,JSON.stringify(run.ids),run.status || 'interrupted',run.error || null);
      }
    }
    return { records: indexed, skipped };
  }));
}
function currentSource(record) {
  if (!record.source.path) return true;
  noLink(record.source.path);
  if (!fs.existsSync(record.source.path)) return false;
  const text = fs.readFileSync(record.source.path, 'utf8');
  return record.source.fragment ? text.split(/\r?\n/).includes(record.text) && hash(record.text) === record.source.sha256 : hash(text) === record.source.sha256;
}
export function refreshConversationSources(options = {}) {
  return open(options, (db, p) => transaction(db, () => {
    let changed = 0;
    for (const row of db.prepare("SELECT * FROM conversations WHERE active=1 AND role IN ('legacy','note')").all()) {
      if (!currentSource(readRaw(p, row))) { db.prepare('UPDATE conversations SET active=0 WHERE id=?').run(row.id); changed++; }
    }
    return { changed };
  }));
}
function excerpt(text, query, max = 1200) {
  if (text.length <= max) return text;
  const matches = tokens(query).map(t => text.toLowerCase().indexOf(t)).filter(n => n >= 0);
  const start = matches.length ? Math.max(0, Math.min(...matches) - 160) : 0;
  return (start ? '…' : '') + text.slice(start, start + max) + '…';
}
export function readConversation(id, options = {}) {
  if (!/^[a-f0-9]{16,64}$/.test(id || '')) fail('使用 recall 返回的记录ID');
  return open(options, (db, p) => {
    const rows = db.prepare('SELECT * FROM conversations WHERE id LIKE ?').all(id + '%');
    if (rows.length !== 1) fail('记录不存在或ID不唯一');
    const row = rows[0], record = readRaw(p, row), stale = !currentSource(record);
    return { ...record, timePrecision: precision(record), sourceHash: row.hash, text: stale && !options.history ? null : record.text, historical: true, stale,
      factsChanged: !!record.factsRevision && !!options.factsRevision && record.factsRevision !== options.factsRevision,
      annotation: row.annotation ? JSON.parse(row.annotation) : null,
      note: '保留的是当时交流；用户原话、助手说法和历史摘要按role区分。现行事实与后来纠正优先。' };
  });
}
export function searchConversations(input, options = {}) {
  const query = typeof input === 'string' ? input : input.query || '';
  const terms = tokens([query, ...(input.queries || [])].join(' ')).slice(0, 48);
  const limit = Math.max(1, Math.min(20, input.limit || 8)), exclude = new Set(input.exclude || []);
  const boundary = (value, end = false) => {
    if (!value) return end ? '9999' : '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${end ? '23:59:59.999' : '00:00:00'}+08:00` : value;
    if (!Number.isFinite(Date.parse(date))) fail('查询日期无效'); return new Date(date).toISOString();
  };
  return open(options, (db, p) => {
    if (!terms.length) return { items: [], query, localOnly: true };
    const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const rows = db.prepare(`SELECT c.*,bm25(conversation_search) AS score FROM conversation_search JOIN conversations c ON c.id=conversation_search.id
      WHERE conversation_search MATCH ? AND c.active=1 AND c.at>=? AND c.at<=? ORDER BY score,c.at DESC LIMIT 80`)
      .all(match, boundary(input.since), boundary(input.until, true));
    const items = [];
    for (const row of rows) {
      if (exclude.has(row.id) || exclude.has(row.source_key)) continue;
      const record = checkedItem(path.join(p.root,row.file),options.skipped,()=>{const r=readRaw(p,row);return currentSource(r)?r:null;}); if (!record) continue;
      items.push({ ...record, timePrecision: precision(record), text: excerpt(record.text, query), textChars: record.text.length, truncated: record.text.length > 1200, historical: true, annotation: row.annotation ? JSON.parse(row.annotation) : null,
        factsChanged: !!record.factsRevision && !!options.factsRevision && record.factsRevision !== options.factsRevision });
      if (items.length === limit) break;
    }
    return { items, query, localOnly: true };
  });
}
export function annotateConversations(cards, options = {}) {
  if (!Array.isArray(cards) || cards.length > 80) fail('整理最多80条');
  return open(options, (db, p) => transaction(db, () => {
    const prepared = cards.map(card => {
      const row = db.prepare('SELECT * FROM conversations WHERE id=?').get(card.id); if (!row) fail('整理引用未知原文');
      const record = readRaw(p, row);
      if (record.role === 'proactive') fail('主动消息不进入语义整理');
      if (typeof card.quote !== 'string' || !card.quote.trim() || card.quote.length > 600 || !record.text.includes(card.quote)) fail('整理必须引用准确原句');
      if (typeof card.summary !== 'string' || card.summary.length > 220 || !Array.isArray(card.terms) || card.terms.length > 12
        || card.terms.some(t => typeof t !== 'string' || !t.trim() || t.length > 40 || /[\r\n<>]/.test(t))) fail('整理摘要或关键词超限');
      if (card.topic && (typeof card.topic !== 'string' || card.topic.length > 40 || /[\/\\\r\n<>\[\]`#]/.test(card.topic))) fail('话题名称无效');
      return { row, record, annotation: { id: card.id, sourceHash: row.hash, quote: card.quote, summary: card.summary, terms: [...new Set(card.terms)],
        topic: card.topic || '日常交流', kind: ['life','vent','idea','discussion','work'].includes(card.kind) ? card.kind : 'discussion' } };
    });
    for (const { row, record, annotation } of prepared) {
      const file = annotationFile(p, record.id); noLink(file); writeDurableJson(file, annotation);
      indexRecord(db, p, record, path.join(p.root, row.file), annotation);
    }
    return { annotated: prepared.length };
  }));
}
function topicalText(text) {
  const ack=/^(?:(?:好的?|收到|谢谢|知道了|辛苦了|明白了|没问题|可以的?|行|嗯|ok|继续|看一下|发我一下|帮我看看|那个怎么样了|今天怎么样|哈哈哈|之前那个|记得吗)[啊呀啦吧呢的了哦嘛～~!！。?？\s\p{Extended_Pictographic}\uFE0F]*)+$/iu;
  return String(text).split(/[，,。；;！？!?\n]/u).map(s=>s.trim()).filter(s=>s&&!ack.test(s)&&!/^(?:(?:帮我)?压缩到\s*\d+\s*条|(?:明天|今天)?\s*\d+点前发我)[。！!\s]*$/.test(s)).join('，');
}
function ends(text,max) {
  if(max<2)return text.slice(0,Math.max(0,max));
  return text.length<=max?text:text.slice(0,Math.ceil((max-1)/2))+'…'+text.slice(-Math.floor((max-1)/2));
}
export function conversationFactFilters(options, now = Date.now(), skipped) {
  const expired=new Set((options.records||[]).filter(f=>f.status==='expired'&&f.source?.kind==='user').map(f=>hash('wechat:'+f.source.reference)));
  const validRecent=r=>!expired.has(r.id)&&!r.replyTo?.some(id=>expired.has(id))&&!(options.records===undefined&&options.factsRevision&&r.factsRevision&&r.factsRevision!==options.factsRevision);
  const facts = options.records || [], versions = new Map(facts.map(r => [r.id, r]));
  const history=[],events=[];
  if(facts.some(f=>f.revision>1||f.status!=='active')){
    const dir=path.join(conversationPaths(options).memoryDir,'log');noLink(dir);
    for(const name of fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>/^\d{4}-\d{2}-\d{2}\.md$/.test(n)):[]){
      const file=path.join(dir,name),text=checkedItem(file,skipped,()=>fs.readFileSync(file,'utf8'));
      for(const m of (text||'').matchAll(/<!-- dawn-memory-history (\{[^\n]+\}) -->/g)) checkedItem(file,skipped,()=>{const e=JSON.parse(m[1]);events.push(e);history.push(...[e.previous,e.current].filter(Boolean));});
    }
  }
  const obsoleteTerms=(old,value)=>{
    const clean=s=>String(s||'').toLowerCase().replace(/^(?:用户|本人|我|你)/u,'');old=clean(old);value=clean(value);
    if(!old||old===value||/^(?:当前无有效值；|已撤销该条记忆，当前无有效值)/.test(old)||/^[a-z0-9]{1,2}$/.test(old))return[];
    const out=[old];if(!value)return out;
    let start=0,end=0;while(start<Math.min(old.length,value.length)&&old[start]===value[start])start++;
    while(end<Math.min(old.length,value.length)-start&&old.at(-end-1)===value.at(-end-1))end++;
    let delta=old.slice(start,old.length-end);if(delta.length===1&&/\p{Script=Han}/u.test(delta))delta=old.slice(Math.max(0,start-1),Math.min(old.length,start+2));
    if(/^[\p{Script=Han}]{2,}$/u.test(delta)||/^[a-z][a-z0-9_.+-]{2,}$/.test(delta))out.push(delta);
    for(const m of old.matchAll(/\d+(?:[-/.]\d+)*/g))if(!value.includes(m[0])){
      const unit=old.slice(m.index+m[0].length).match(/^[\p{Script=Han}%]/u)?.[0]||'';
      if(m[0].length>=3||unit)out.push(m[0]+(m[0].length<3?unit:''));
    }
    for(const m of old.matchAll(/(?:\d{4}[-/年])?(\d{1,2})[-/月](\d{1,2})(?:日)?/g))if(!value.includes(m[0]))out.push(`${Number(m[1])}月${Number(m[2])}日`);
    return [...new Set(out)];
  };
  const targets=facts.map(f=>{
    while(f.source?.kind==='maintenance'){
      const prior=events.find(e=>e.id===f.id&&e.revision===f.revision)?.previous
        || history.filter(h=>h.id===f.id&&h.revision<f.revision&&h.source?.kind!=='maintenance').sort((a,b)=>b.revision-a.revision)[0];
      if(!prior||prior.revision>=f.revision)break;
      f=events.find(e=>e.id===prior.id&&e.revision===prior.revision)?.current||{...prior,status:prior.status==='superseded'?'active':prior.status};
    }
    if(f.expiresAt&&Date.parse(f.expiresAt)<=now)f={...f,status:'expired'};
    return f;
  });
  for(const f of targets)if(f.status==='expired'&&f.source?.kind==='user')expired.add(hash('wechat:'+f.source.reference));
  const redactRecent=r=>{
    if(!['user','assistant'].includes(r.role))return r;
    const changed=targets.filter(f=>{
      const revision=r.factVersions?.[f.id];
      return (revision===undefined?Date.parse(f.recordedAt||f.source?.at)>Date.parse(r.at):revision!==f.revision||f.status!=='active')
        && !(f.status==='active'&&f.source?.kind==='user'&&f.source.reference===r.source.id);
    });
    const needles=changed.flatMap(f=>history.filter(h=>h.id===f.id&&(r.factVersions?.[f.id]===undefined?h.revision<f.revision:h.revision===r.factVersions[f.id])).flatMap(h=>obsoleteTerms(h.value,f.status==='active'?f.value:'')));
    const attachment=/^（用户发来[^\n]*已存到：[^\n]+）$/u;
    let original=r.text;for(const n of needles)if(/[。；;！？!?\n]/.test(n))original=original.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),'');
    const parts=original.split(/(^（用户发来[^\n]*已存到：[^\n]+）$)/mu).flatMap(part=>attachment.test(part)?[part]:part.split(/(?<=[。；;！？!?\n，])|(?<=\.)\s+/u)).filter(Boolean);
    const kept=parts.filter(part=>attachment.test(part)||!needles.some(n=>/^\d+(?:[-/.]\d+)*$/.test(n)?[...part.matchAll(/\d+(?:[-/.]\d+)*/g)].some(m=>m[0]===n):/^[a-z][a-z0-9_.+-]*$/.test(n)?new RegExp('(?<![a-z0-9_])'+n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![a-z0-9_])','i').test(part):part.toLowerCase().includes(n)));
    return original===r.text&&kept.length===parts.length?r:{...r,text:kept.join('')||'（本条原话已失效）',redacted:true};
  };
  const replaced=new Set(events.filter(e=>e.previous?.source?.kind==='user'&&e.current?.source?.kind!=='maintenance').map(e=>'wechat:'+e.previous.source.reference));
  for(const f of targets)if(f.status!=='active'&&f.source?.kind==='user')replaced.add('wechat:'+f.source.reference);
  for(const f of targets)if(f.status==='active'&&f.source?.kind==='user')replaced.delete('wechat:'+f.source.reference);
  const replacedIds=new Set([...replaced].map(hash));
  const valid = r => {
    if(replaced.has(r.source.key)||r.replyTo?.some(id=>replacedIds.has(id)))return false;
    if(!validRecent(r))return false;
    if(facts.some(f=>f.status==='expired' && f.source?.kind==='user' && f.source.reference===r.source.id))return false;
    if (r.factVersions && options.records) {
      if (Object.entries(r.factVersions).some(([id,v]) => { const f=versions.get(id); return (f?.revision !== v || f?.status !== 'active') && !(r.role==='user' && f?.status!=='expired' && f?.source?.kind==='user' && f.source.reference===r.source.id); })) return false;
    } else if (options.factsRevision && r.factsRevision && r.factsRevision !== options.factsRevision) return false;
    return !facts.some(f => f.source?.kind === 'user' && Date.parse(f.source.at) > Date.parse(r.at)
      && [...(f.subject || '').matchAll(/(?=([\p{Script=Han}]{3}))|\b([a-z][a-z0-9_.-]{3,})\b/giu)].some(m=>r.text.toLowerCase().includes((m[1]||m[2]).toLowerCase())));
  };
  return { valid, validRecent, redactRecent };
}
export function conversationContext(input, options = {}) {
  const max=Math.max(0,Math.min(input.maxChars||2400,4000)), skipped=[];
  if(max<200)return {text:'',ids:[]};
  const excluded=new Set([...(input.exclude||[]),...(input.newSession?[]:input.seenIds||[])]);
  const omitted=r=>!r||excluded.has(r.id)||excluded.has(r.source.key);
  const { valid, validRecent, redactRecent }=conversationFactFilters(options,input.now,skipped);
  const query=input.query||'',reference=/上次|那次|之前|以前|刚才|那[个份张条]|记得/.test(query);
  const normalize=text=>text.normalize('NFKC').toLowerCase().replace(/[‐‑‒–—−]/g,'-').replace(/第([一二三四五六七八九])(条|点)/g,(_,n,u)=>'第'+('一二三四五六七八九'.indexOf(n)+1)+u);
  const identifiers=text=>text.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}|(?<!\d)\d{4}(?!\d)|\d{1,2}月\d{1,2}(?:日|号)?/g)||[];
  const topic=topicalText(query),clauses=query.split(/[。！？!?]/u).map(topicalText).filter(Boolean),historyClauses=clauses.filter(s=>/^(?:上次|那次|之前|以前|刚才)/.test(s));
  const filler=new Set('一 个 有 多少 几 是 什么 怎么 为什么 我 你 他 她 我们 你们 上次 那个 之前 以前 当时 现在 今天 那 这 的 了 过 过的 呢 吗 啊 吧 还 还有 再 又 想 要 帮 说 说说 聊 聊聊 谈 提到 讲 展开 一下 详细 具体 主要 需要 可以 会 不会 会不会 整理 认真 内容 想到 很多 事 事情 哪些 哪个 年 各 方面 份 我想 那份 这份 名单 里 和 与 接着 继续 接上 回到 两 两个 两份 两条 回答 都 找 找找 分别 一起 也 ok'.split(' '));
  const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
  const requests=(historyClauses.length?historyClauses:[topic]).flatMap(text=>reference&&/都|分别|两个|两份|两条|一起/.test(text)?text.split(/和|与|以及|还有|、/u):[text]).slice(0,5).map(text=>{
    const lookup=normalize(text).replace(/^\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}[，,]\s*(?=上次|那次|之前|以前|刚才)/,''),parts=[];
    for(const w of segmenter.segment(lookup)){
      if(!w.isWordLike||filler.has(w.segment)||/^\d+$/.test(w.segment))continue;
      const last=parts.at(-1);
      if(last&&last.end===w.index&&last.single&&w.segment.length===1){last.text+=w.segment;last.end++;}
      else parts.push({text:w.segment,end:w.index+w.segment.length,single:w.segment.length===1});
    }
    return {lookup,terms:tokens(lookup).filter(t=>!['是什','是不','不是','ok'].includes(t)&&!/^\d/.test(t)),words:[...new Map(parts.map(w=>[w.text,w])).values()],numbers:identifiers(lookup)};
  });
  const matches=(w,body)=>body.includes(w.text)||(w.single&&w.text.length>2&&Array.from({length:w.text.length},(_,i)=>[w.text.slice(Math.max(0,i-1),i+1),w.text.slice(i,i+2)].some(t=>t.length===2&&body.includes(t))).every(Boolean));
  const relevant=(r,q)=>{
    const body=normalize([r.text,r.annotation?.summary,...(r.annotation?.terms||[])].join(' ')),numeric=new Set(identifiers(body));
    return q.terms.length&&q.words.length&&q.numbers.every(n=>numeric.has(n))&&q.words.filter(w=>matches(w,body)).length/q.words.length>=(reference?2/3:1)&&q.terms.filter(t=>/^[a-z]/i.test(t)).every(t=>body.includes(t));
  };
  const data=open(options,(db,p)=>{
    const read=rows=>rows.map(row=>checkedItem(path.join(p.root,row.file),skipped,()=>{const r={...readRaw(p,row),annotation:row.annotation?JSON.parse(row.annotation):null};return currentSource(r)?r:null;})).filter(Boolean);
    const get=id=>{const row=db.prepare('SELECT * FROM conversations WHERE active=1 AND (id=? OR source_key=?)').get(id,id);return row?read([row])[0]:null;};
    const allAnswers=read(db.prepare("SELECT * FROM conversations WHERE active=1 AND role='assistant' ORDER BY at DESC,rowid DESC").all()),answers=allAnswers.slice(0,2);
    const proactive=read(db.prepare("SELECT * FROM conversations WHERE active=1 AND role='proactive' ORDER BY at DESC,rowid DESC").all());
    const quoted=(input.exclude||[]).flatMap(id=>get(id)?.replyTo||[]);
    const rounds=answers.map(a=>{const users=(a.replyTo||[]).map(get).filter(Boolean);return [...users,a,...[...(a.contextIds||[]),...users.flatMap(u=>u.replyTo||[])].map(get).filter(r=>['proactive','user'].includes(r?.role))].filter(validRecent).map(redactRecent);});
    const answered=new Set(allAnswers.flatMap(a=>[...(a.replyTo||[]),...(a.contextIds||[])]));
    const now=input.now??Date.now();
    const unanswered=(input.unanswered||[]).map(e=>{
      const r=get('wechat:'+e.id);
      return r?{...r,pendingReason:e.reason}:null;
    })
      .filter(r=>r&&!omitted(r)&&!answered.has(r.id)&&r.at>(answers[0]?.at||'')&&now-Date.parse(r.at)<=48*3600e3&&topicalText(r.text))
      .sort((a,b)=>b.at.localeCompare(a.at)).slice(0,3);
    return {answers,allAnswers,proactive,quoted,rounds,unanswered};
  });
  const group=r=>r.source.groupId||r.id,groups=new Set(data.proactive.filter(r=>omitted(r)||data.quoted.includes(r.id)).map(group));
  const latest=data.answers[0],since=latest?.at||'';
  const grouped=[...new Map(data.proactive.filter(r=>!groups.has(group(r))&&r.at>since).map(r=>[group(r),r]).reverse()).values()].reverse().slice(0,8);
  const digestWord=[...segmenter.segment(query)].some(w=>['日报','晨报'].includes(w.segment));
  const digestReference=(digestWord||/^\s*第[一二三四五六七八九十百\d]+条(?:[，,：: ]*(?:展开|说说|讲讲|详细|具体|再|能|吗|呢|是什么|讲什么|解释|一下))*[？?。！! ]*$/.test(query));
  const lists=requests.map(q=>{
    const candidates=searchConversations({...input,query:q.terms.slice(-48).join(' '),exclude:[...excluded],limit:20},{...options,skipped}).items
      .map(r=>checkedItem(r.id,skipped,()=>readConversation(r.id,options))).filter(Boolean).filter(r=>r.text&&!(r.role==='proactive'&&(r.source.type==='digest'||r.text.includes('日报')))&&!(r.role==='legacy'&&/^- (?:记忆修订|旧记忆迁入|维护整理) /.test(r.text))&&valid(r));
    const strict=candidates.filter(r=>relevant(r,q)),score=r=>q.terms.filter(t=>normalize(r.text).includes(t)).length,best=Math.max(0,...strict.map(score));
    return {strict:strict.filter(r=>score(r)===best),relaxed:strict.length?[]:candidates.filter(r=>q.lookup&&q.numbers.every(n=>identifiers(normalize(r.text)).includes(n))&&(r.annotation?.terms||[]).some(t=>t.length>=3&&q.lookup.includes(normalize(t))))};
  });
  const strict=[...new Map([...lists.map(l=>l.strict[0]).filter(Boolean),...lists.flatMap(l=>l.strict)].map(r=>[r.id,r])).values()];
  const relaxed=[...new Map(lists.flatMap(l=>l.relaxed).filter(r=>!strict.some(x=>x.id===r.id)).map(r=>[r.id,r])).values()].slice(0,2);
  const found=digestReference&&/第[一二三四五六七八九十百\d]+条/.test(query)?[]:[...strict,...relaxed.flatMap(r=>[r,...data.allAnswers.filter(a=>r.role==='user'&&a.replyTo?.includes(r.id)&&!omitted(a)&&valid(a)).slice(0,1)])].slice(0,5);
  const ordinal=query.match(/第\s*([一二三四五六七八九十百\d]+)\s*条/)?.[1]||'';
  const number=s=>/^\d+$/.test(s)?Number(s):s.includes('十')?('一二三四五六七八九'.indexOf(s.split('十')[0]||'一')+1)*10+(s.split('十')[1]?'一二三四五六七八九'.indexOf(s.split('十')[1])+1:0):'一二三四五六七八九'.indexOf(s)+1;
  const itemNumber=number(ordinal),now=input.now??Date.now();
  const digestDay=r=>([r.source.taskId,r.source.groupId,r.source.id,r.text].join(' ').match(/\d{4}-\d{2}-\d{2}/)||[])[0]||day(r.at);
  const date=query.match(/(?:(\d{4})[-/年]\s*)?(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*(?:日|号)?/);
  const requestedDay=/昨天|前天/.test(query)?day(now-(/前天/.test(query)?2:1)*86400e3):date?`${date[1]||day(now).slice(0,4)}-${date[2].padStart(2,'0')}-${date[3].padStart(2,'0')}`:null;
  const latestDigest=data.proactive.filter(r=>(r.source.type==='digest'||r.text.includes('日报'))&&(!requestedDay||digestDay(r)===requestedDay)).sort((a,b)=>digestDay(b).localeCompare(digestDay(a)))[0];
  const answerHasItem=itemNumber&&new RegExp(`(?:^|[\\n；;])\\s*(?:${itemNumber}|${ordinal})[.、）)]|第\\s*(?:${itemNumber}|${ordinal})\\s*条`).test(latest?.text||'');
  const olderProactive=digestReference&&latestDigest&&!groups.has(group(latestDigest))&&(digestWord||(now-Date.parse(latestDigest.at)<=86400e3&&!answerHasItem))?[latestDigest]:[];
  const digestExcerpt=(r,cap)=>{
    const split=r.text.indexOf('条目顺序：');
    if(split<0)return excerpt(r.text,query,Math.max(0,cap-2)).slice(0,Math.max(0,cap));
    const intro=r.text.slice(0,split),list=r.text.slice(split).split('\n'),title=list.shift(),target=list.find(x=>new RegExp(`^${itemNumber}\\.`).test(x));
    const ordered=[...new Set([...(target?[target]:[]),...list])],kept=new Map();
    let used=title.length+1;
    for(const line of ordered){
      const body=line===target?ends(line,Math.max(0,cap-used-1)):line;
      if(used+body.length+1<=cap){kept.set(line,body);used+=body.length+1;}
    }
    return ends(intro,Math.max(0,cap-used)).trim()+title+' '+list.map(x=>kept.get(x)).filter(Boolean).join(' ');
  };
  const header='[可追溯的历史交流]\n这是当时的原话或历史摘要，现行事实和纠正优先；助手说法和引用的主动消息不作为用户事实。用 memory.mjs recall 查询，episode ID 读完整原文。\n';
  const render=(r,body)=>`- ${day(r.at)} ${{user:'用户原话',assistant:'助手当时回复',proactive:'Dawn主动发出',legacy:'历史摘要',note:'笔记原文'}[r.role]} ${r.id.slice(0,16)}：${r.pendingReason?'['+r.pendingReason+'] ':''}${r.redacted?'[已隐藏失效句，原文入口保留] ':''}${body}\n`;
  const chosen=new Map();let remaining=max-header.length;
  const add=(records,cap,tail=false)=>{
    const fresh=records.filter(r=>!omitted(r)&&!chosen.has(r.id)&&!(r.role==='proactive'&&groups.has(group(r))));
    const per=Math.min(cap,Math.floor((remaining-fresh.reduce((n,r)=>n+render(r,'').length,0))/Math.max(1,fresh.length)));if(per<1)return;
    for(const r of fresh){if(r.role==='proactive'&&groups.has(group(r)))continue;
      const line=render(r,(r.role==='proactive'&&(r.source.type==='digest'||r.text.includes('日报'))?digestExcerpt(r,per-2):tail?ends(r.text,per):excerpt(r.text,query,Math.max(1,per-2))).replaceAll('\n',' '));
      if(line.length>remaining)continue;chosen.set(r.id,{r,line});remaining-=line.length;if(r.role==='proactive')groups.add(group(r));
    }
  };
  const targetLine=olderProactive[0]?.text.split('\n').find(x=>new RegExp(`^${itemNumber}\\.`).test(x));
  const digestReserve=olderProactive.length&&itemNumber
    ?Math.min(remaining,render(olderProactive[0],'').length+Math.max(160,(targetLine?.length||0)+40)):0;
  remaining-=digestReserve;
  const rest=Math.max(0,remaining-900);remaining-=rest;add(data.unanswered,900,true);remaining+=rest;
  if(digestReserve){
    const rest=remaining;remaining=digestReserve;
    add(olderProactive,digestReserve);remaining+=rest;
  }
  const reserved=Math.min(remaining/2,grouped.reduce((n,r)=>n+render(r,'').length+Math.min(r.text.length,40),0));
  remaining-=reserved;if(input.newSession!==false)add(data.rounds[0]||[],350,true);remaining+=reserved;
  // Reserve brief lines first, then the two newest groups; output below stays chronological.
  add(grouped.slice(2).map(r=>({...r,text:`[${r.source.type||'通知'}] ${r.text.split('\n').find(s=>s.trim()&&!s.includes('；来源ID：'))||''}`.slice(0,40)})),40);
  add(grouped.slice(0,2),450);
  if(input.newSession!==false)add(data.rounds[1]||[],350,true);
  add(olderProactive,360);add(found,360);
  const newest=chosen.get(latest?.id);
  if(newest&&remaining>0){
    const line=render(newest.r,ends(newest.r.text,newest.line.length-render(newest.r,'').length+remaining).replaceAll('\n',' '));
    remaining+=newest.line.length-line.length;newest.line=line;
  }
  const digest=chosen.get(olderProactive[0]?.id);
  if(digest&&remaining>0){
    const line=render(digest.r,digestExcerpt(digest.r,digest.line.length-render(digest.r,'').length+remaining));
    remaining+=digest.line.length-line.length;digest.line=line;
  }
  const text=[...chosen.values()].sort((a,b)=>a.r.at.localeCompare(b.r.at)).map(x=>x.line).join('');
  return {text:text?header+text:'',ids:[...new Set([...chosen.keys(),...data.quoted])],skipped};
}
export function conversationStatus(options = {}) {
  return open(options, db => ({ records: db.prepare('SELECT count(*) n FROM conversations WHERE active=1').get().n,
    pending: db.prepare("SELECT count(*) n FROM conversations WHERE active=1 AND curated=0 AND role NOT IN ('assistant','proactive')").get().n,
    calls: db.prepare('SELECT day,status,count(*) n FROM conversation_runs GROUP BY day,status').all() }));
}
export function conversationCatalog(options = {}) {
  return open(options, (db, p) => db.prepare('SELECT id,file,hash,at,role,annotation FROM conversations WHERE active=1 ORDER BY at,id').all().map(row =>
    ({ ...row, path: path.join(p.root, row.file), annotation: row.annotation ? JSON.parse(row.annotation) : null })));
}
export function planCuration(input = {}, options = {}) {
  const now = input.now ?? Date.now();
  return open(options, (db, p) => transaction(db, () => {
    const today = day(now), ledger = path.join(p.root, 'curation', today); noLink(ledger);
    const calls = fs.existsSync(ledger) ? fs.readdirSync(ledger).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).map(n => {
      const file = path.join(ledger, n); noLink(file); return JSON.parse(fs.readFileSync(file, 'utf8'));
    }) : [];
    if (calls.length >= (input.maxCalls ?? 4) || calls.some(c => now - c.at < 30 * 60e3)) return null;
    const rows = db.prepare("SELECT * FROM conversations WHERE active=1 AND curated=0 AND role NOT IN ('assistant','proactive') ORDER BY at,rowid LIMIT 500").all();
    const records = []; let chars = 0;
    for (const row of rows) {
      const record = readRaw(p, row); if (!currentSource(record)) { db.prepare('UPDATE conversations SET active=0 WHERE id=?').run(record.id); continue; }
      const text = record.text.slice(0, 6000); // 原文完整保留；索引摘要仅处理受限预览。
      if (chars + text.length > Math.min(input.maxChars || 12000,12000)) break;
      records.push({ ...record, timePrecision: precision(record), text, previewTruncated: record.text.length > text.length }); chars += text.length;
      if (records.length === 32) break;
    }
    if (!records.length) return null;
    const id = randomUUID(), ids = records.map(r => r.id);
    writeDurableJson(path.join(ledger, `${id}.json`), { id, day: today, at: now, ids }); // 原子调用承诺独立于可重建索引。
    db.prepare('INSERT INTO conversation_runs(id,day,at,ids,status) VALUES(?,?,?,?,?)').run(id, today, now, JSON.stringify(ids), 'running');
    return { id, records, chars };
  }));
}
export function finishCuration(id, result, options = {}) {
  const run = open(options, db => db.prepare('SELECT * FROM conversation_runs WHERE id=?').get(id));
  if (!run || run.status !== 'running') return { status: run?.status || 'missing' };
  if (!result.error) {
    const ids = JSON.parse(run.ids);
    if (!Array.isArray(result.cards) || result.cards.length !== ids.length || new Set(result.cards.map(c => c.id)).size !== ids.length || result.cards.some(c => !ids.includes(c.id))) fail('整理必须逐条覆盖本批原文');
    annotateConversations(result.cards, options);
  }
  return open(options, (db, p) => { const status = result.error ? 'failed' : 'completed';
    writeDurableJson(path.join(p.root, 'curation', run.day, `${id}.json`), { id, day: run.day, at: run.at, ids: JSON.parse(run.ids), status, error: result.error || null });
    db.prepare('UPDATE conversation_runs SET status=?,error=? WHERE id=?').run(status, result.error || null, id); return { status }; });
}

export function mediaFingerprint(item) {
  const media = item?.image_item?.media || item?.file_item?.media;
  return media?.encrypt_query_param ? hash(media.encrypt_query_param) : null;
}
export function resolveProactiveReference(reference, options = {}) {
  const messageId = reference?.svr_id || reference?.message_item?.msg_id;
  const fingerprint = mediaFingerprint(reference?.message_item);
  if (!messageId && !fingerprint) return null;
  return open(options, (db, p) => {
    const matches = db.prepare("SELECT * FROM conversations WHERE active=1 AND role='proactive' ORDER BY at DESC").all()
      .map(row => readRaw(p, row)).filter(r => messageId ? String(r.source.messageId) === String(messageId) : r.source.fingerprint === fingerprint);
    return matches.length === 1 ? matches[0] : null;
  });
}
