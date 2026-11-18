import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { conversationFactFilters, readConversation } from './conversation-memory.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const invalid = message => fail('OPPORTUNITY_INVALID', message);
const normalized = text => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const equivalent = (a,b) => typeof a === 'string' && typeof b === 'string' ? normalized(a) === normalized(b) : a === b;
function time(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) invalid('时间使用带时区的 ISO 日期');
  return new Date(value).toISOString();
}
function changes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) invalid('需要实际变化字段');
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (key === 'stage') {
      if (!['research', 'contacted', 'interview', 'offer', 'closed'].includes(v)) invalid('stage 为 research/contacted/interview/offer/closed');
      out[key] = v;
    } else if (key === 'priority') {
      if (![0, 1, 2].includes(v)) invalid('priority 为 0/1/2，默认 1，只有用户明确排序才改变');
      out[key] = v;
    } else if (key === 'interviewAt') out[key] = v === null ? null : time(v);
    else if (['location', 'preparation', 'nextAction', 'waitingFor'].includes(key)) {
      if (v !== null && (typeof v !== 'string' || !v.trim() || v.length > 3000)) invalid(`${key} 需要文本或 null`);
      out[key] = v === null ? null : v.trim();
    } else invalid(`未知机会字段：${key}`);
  }
  return out;
}
export function validateTracking(value) {
  const current = changes(value?.current);
  if (!current.stage) invalid('登记需明确当前阶段');
  if (!Array.isArray(value.baseline) || value.baseline.length > 8 || value.baseline.some(p => typeof p !== 'string' || !path.isAbsolute(p))) invalid('baseline 使用最多 8 个已有材料绝对路径');
  return { current, asOf: time(value.asOf), baseline: [...new Set(value.baseline)] };
}
export function baselineArtifacts(tracking) {
  return tracking.baseline.map(file => {
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 100 * 1024 * 1024) invalid('已有材料必须是 100MB 内的文件');
    const data = fs.readFileSync(file);
    return { name: path.basename(file), path: file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  });
}
export function validateProgress(value, options = {}) {
  const messages = options.userMessages ?? JSON.parse(process.env.DAWN_MEMORY_USER_MESSAGES || '[]');
  const source = messages.find(m => m.id === value?.sourceId);
  if (!source || typeof source.text !== 'string') fail('OPPORTUNITY_SOURCE', 'sourceId 必须来自本轮 DAWN_MEMORY_USER_MESSAGES 中的实际用户消息');
  const at = time(source.at), occurredAt = time(value.occurredAt || at);
  if (Date.parse(occurredAt) > Date.parse(at) + 300000) invalid('occurredAt 是进展发生时间，未来面试时间写 interviewAt');
  if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 1500) invalid('summary 需要简短进展摘要');
  return { source: { id: source.id, text: source.text, at }, occurredAt, summary: value.summary.trim(), changes: changes(value.changes) };
}
export function opportunityProgress(task, progress, tasks, receivedAt) {
  if (!task.opportunity) fail('OPPORTUNITY_MISSING', '先登记机会，再接收进展');
  const opportunity = structuredClone(task.opportunity);
  // 一个用户消息可分别涉及多个机会，但对同一机会只接收一个完整变化包。
  if (opportunity.history.some(e => e.source.id === progress.source.id)) return { opportunity, changed: false };
  const mentions = Object.values(tasks).filter(t => t.opportunity && normalized(progress.source.text).includes(normalized(t.routine.company)));
  if (mentions.length && !mentions.some(t => t.id === task.id)) fail('OPPORTUNITY_TARGET', '消息明确提到另一家公司，请核对机会归属');
  const entry = { ...progress, receivedAt, disposition: 'duplicate' };
  if (Date.parse(progress.occurredAt) < Date.parse(opportunity.asOf)) entry.disposition = 'stale';
  else {
    const difference = Object.entries(progress.changes).filter(([key,value]) => !equivalent(opportunity.current[key],value));
    opportunity.asOf = progress.occurredAt;
    if (difference.length) {
      Object.assign(opportunity.current, Object.fromEntries(difference));
      opportunity.revision++; entry.disposition = 'applied'; entry.revision = opportunity.revision;
    }
  }
  opportunity.history.push(entry);
  return { opportunity, changed: entry.disposition === 'applied', disposition: entry.disposition };
}
export function opportunityOrder(a, b) {
  const ac = a.opportunity?.current, bc = b.opportunity?.current;
  return (bc?.priority ?? 1) - (ac?.priority ?? 1)
    || (ac?.interviewAt ? Date.parse(ac.interviewAt) : Infinity) - (bc?.interviewAt ? Date.parse(bc.interviewAt) : Infinity)
    || a.createdAt.localeCompare(b.createdAt);
}

// Read-only. The task ledger names the opportunity; the captured message establishes who said what.
export function opportunityDecision(task, options, scenario) {
  const opportunity = task.opportunity;
  if (!opportunity) fail('OPPORTUNITY_MISSING','这个任务尚未登记求职机会');
  const filters = conversationFactFilters(options,options.now);
  const history = opportunity.history.filter(e => e.disposition === 'applied').map(entry => {
    const id = createHash('sha256').update('wechat:' + entry.source.id).digest('hex');
    const result = {at:entry.occurredAt,revision:entry.revision,fields:Object.keys(entry.changes)};
    let original;
    try { original = readConversation(id,options); } catch (error) {
      if (!['ENOENT','CONVERSATION_MEMORY'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
    }
    if (!original || original.stale || original.role !== 'user' || original.text !== entry.source.text
      || !filters.valid(original) || filters.redactRecent(original).redacted) return {...result,evidence:'unavailable'};
    const quote = original.text.split(/(?:^|\n)（(?:这条引用了|用户发来|用户引用了)/u)[0].trim();
    if (!quote) return {...result,evidence:'unavailable'};
    const context = task.context;
    const at = Date.parse(entry.occurredAt);
    const previous = context?.history?.find(v => Date.parse(v.replacedAt) > at);
    const existed = !task.createdAt || Date.parse(task.createdAt) <= at;
    const versions = existed && (previous || (context && Date.parse(context.changedAt) <= at ? context : undefined));
    const roles = (versions?.sources || []).filter(s => s.kind === 'role' && (!s.asOf || s.asOf <= entry.occurredAt.slice(0,10))).flatMap(s => {
      try {
        if (createHash('sha256').update(fs.readFileSync(s.snapshot)).digest('hex') === s.sha256)
          return [{asOf:s.asOf,snapshot:s.snapshot,sha256:s.sha256}];
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return [];
    });
    return {...result,evidence:'user_message',sourceId:id,quote,roleDocumentsAtDecision:roles};
  });
  const result = {id:task.id,title:task.title,asOf:opportunity.asOf,revision:opportunity.revision,current:opportunity.current,history};
  if (scenario === undefined) return result;
  if (!scenario || !['hypothetical','unconfirmed','reported'].includes(scenario.basis)
    || !scenario.changes || typeof scenario.changes !== 'object' || Array.isArray(scenario.changes)) invalid('比较需给出 basis 与 changes');
  const proposed = Object.keys(scenario.changes).length ? changes(scenario.changes) : {};
  const differences = Object.entries(proposed).filter(([field,value]) => !equivalent(opportunity.current[field],value))
    .map(([field,value]) => ({field,before:opportunity.current[field] ?? null,after:value}));
  const earlier = scenario.occurredAt && Date.parse(time(scenario.occurredAt)) < Date.parse(opportunity.asOf);
  const impact = earlier ? 'older_information' : !differences.length ? 'no_change' : scenario.basis === 'unconfirmed' ? 'needs_confirmation'
    : scenario.basis === 'hypothetical' ? 'would_change' : 'reported_difference';
  return {...result,comparison:{basis:scenario.basis,impact,differences,recorded:false}};
}
