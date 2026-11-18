import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { experienceProblems, experienceView } from './task-experience.mjs';
import { latestUserEdit, verifyUserEdit, currentFeedbackTargets, feedbackEntries } from './task-feedback.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const fingerprint = facts => JSON.stringify(facts.map(f => [f.id, f.revision, f.status, f.value]).sort());
function content(file) {
  if (!path.isAbsolute(file) || !fs.statSync(file).isFile() || fs.statSync(file).size > 20 * 1024 * 1024) fail('CONTEXT_SOURCE', '来源应为不超过20MB的普通文件');
  return fs.readFileSync(file);
}
export function validateSourceChange(value, options = {}) {
  const messages = options.userMessages ?? JSON.parse(process.env.DAWN_MEMORY_USER_MESSAGES || '[]');
  const source = messages.find(m => m.id === value?.sourceId);
  if (!source) fail('CONTEXT_SOURCE', '新版资料必须引用本轮实际消息');
  if (!['company', 'role', 'candidate'].includes(value.kind) || !Number.isInteger(value.expectedRevision) || value.expectedRevision < 1
    || typeof value.path !== 'string' || !path.isAbsolute(value.path) || !/^\d{4}-\d{2}-\d{2}$/.test(value.asOf || '')
    || !Number.isFinite(Date.parse(value.asOf)) || value.asOf > new Date(Date.parse(source.at) + 8 * 3600e3).toISOString().slice(0, 10)
    || (value.validUntil && !Number.isFinite(Date.parse(value.validUntil)))) fail('CONTEXT_SOURCE', '需要资料类型、日期、绝对路径和当前 expectedRevision；日期不能晚于消息');
  return { kind: value.kind, path: value.path, asOf: value.asOf, validUntil: value.validUntil || null,
    expectedRevision: value.expectedRevision, sha256: hash(content(value.path)), source: { id: source.id, text: source.text, at: source.at } };
}
function snapshot(material, root, taskId) {
  const bytes = content(material.path), sha256 = hash(bytes);
  const directory = path.join(root, taskId, '资料版本', sha256);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.realpathSync(directory).startsWith(fs.realpathSync(root) + path.sep)) fail('CONTEXT_SOURCE', '资料快照越界');
  const file = path.join(directory, path.basename(material.path));
  try { fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (hash(content(file)) !== sha256) fail('CONTEXT_SOURCE', '资料快照被修改');
  return { kind: material.kind, path: material.path, asOf: material.asOf, validUntil: material.validUntil || null, sha256, snapshot: file };
}
export function initialTaskContext(task, root, at) {
  return { revision: 1, sources: task.routine.materials.map(m => snapshot(m, root, task.id)), facts: [], history: [],
    changedAt: at, builtRevision: task.resultArtifacts.length || task.previousResult ? 1 : null, baseline: true };
}
export function dependentFacts(task, records) {
  const known = new Set(task.context?.facts.map(f => f.id) || []);
  return records.filter(r => known.has(r.id) || r.affects?.includes(task.id)).map(r => ({ id: r.id, revision: r.revision, status: r.status, subject: r.subject, value: r.value, source: r.source, expiresAt: r.expiresAt }));
}
export function contextProblems(task, records, now = Date.now()) {
  if (!task.context) return [];
  const problems = [];
  if (fingerprint(task.context.facts) !== fingerprint(dependentFacts(task, records))) problems.push({ kind: 'facts', reason: '关联事实已纠正、撤销或过期' });
  for (const s of task.context.sources) {
    try {
      if (hash(content(s.path)) !== s.sha256 || hash(content(s.snapshot)) !== s.sha256) problems.push({ kind: 'source', path: s.path, reason: '资料内容已变化，等待登记当前版本' });
    } catch { problems.push({ kind: 'source', path: s.path, reason: '来源或快照不可读，需重新核对' }); }
    if (s.validUntil && Date.parse(s.validUntil) <= now) problems.push({ kind: 'source', path: s.path, reason: '资料已到明确有效期，需新来源' });
  }
  return problems;
}
export function replaceTaskSource(task, change, tasks, root, at) {
  const ctx = task.context;
  if (ctx.history.some(h => h.source?.id === change.source.id && h.kind === change.kind)) return null;
  const other = Object.values(tasks).find(t => t.id !== task.id && t.routine && change.source.text.toLowerCase().includes(t.routine.company.toLowerCase()));
  if (other && !change.source.text.toLowerCase().includes(task.routine.company.toLowerCase())) fail('CONTEXT_TARGET', '消息明确属于其他公司');
  const previous = ctx.sources.filter(s => s.kind === change.kind);
  if (previous.length === 1 && previous[0].sha256 === change.sha256 && previous[0].asOf === change.asOf && previous[0].validUntil === change.validUntil
    && !contextProblems(task, task.context.facts).some(p => p.kind === 'source')) return null;
  if (change.expectedRevision !== ctx.revision) fail('CONTEXT_CONFLICT', '上下文版本已变化，请重读当前版本');
  if (previous.some(s => s.asOf > change.asOf)) fail('CONTEXT_STALE', '旧日期资料不能替代当前资料');
  if (hash(content(change.path)) !== change.sha256) fail('CONTEXT_SOURCE', '登记后文件又变化，请重新登记');
  const next = snapshot(change, root, task.id);
  return { ...ctx, revision: ctx.revision + 1, changedAt: at, sources: [...ctx.sources.filter(s => s.kind !== change.kind), next],
    history: [...ctx.history, { revision: ctx.revision, sources: ctx.sources, facts: ctx.facts, source: change.source, kind: change.kind, replacedAt: at }] };
}
export function correctedTaskContext(task, records, at) {
  const facts = dependentFacts(task, records), ctx = task.context;
  if (fingerprint(facts) === fingerprint(ctx.facts)) return null;
  return { ...ctx, revision: ctx.revision + 1, facts, changedAt: at,
    history: [...ctx.history, { revision: ctx.revision, sources: ctx.sources, facts: ctx.facts, replacedAt: at, reason: 'memory_correction' }] };
}
export function currentTaskView(task, records = [], now = Date.now(), taskState = null) {
  const view = structuredClone(task);
  view.feedbackTargets = currentFeedbackTargets(task);
  const feedback = feedbackEntries(task), last = feedback.at(-1), edit = latestUserEdit(task);
  view.feedbackSummary = { scope: 'current_published', total: feedback.length, historyTotal: (task.feedback || []).length,
    byKind: Object.fromEntries([...new Set(feedback.flatMap(f => f.items.map(item => item.kind)))].map(kind => [kind, feedback.reduce((n, f) => n + f.items.filter(item => item.kind === kind).length, 0)])),
    last: last ? { targetInputRevision: last.target.inputRevision, disposition: last.disposition, revisionTo: last.revisionTo, receivedAt: last.receivedAt } : null };
  if (edit) view.latestUserEdit = { feedbackId: edit.feedbackId, snapshot: edit.snapshot, sha256: edit.sha256, revisionTo: edit.revisionTo, receivedAt: edit.receivedAt };
  delete view.feedback; delete view.resultHistory; delete view.userEdits;
  if (view.inputs) view.inputs = view.inputs.filter(input => input.kind !== 'feedback');
  if (!task.context) return view;
  const problems = contextProblems(task, records, now);
  try { verifyUserEdit(task); } catch (error) { problems.push({ kind: 'source', path: edit?.snapshot, reason: error.message }); }
  if (taskState) problems.push(...experienceProblems(task, taskState));
  if (taskState && view.experienceRefs) view.experienceRefs = view.experienceRefs.map(ref => {
    const current = experienceView(taskState, ref.id);
    return { id: ref.id, usedRevision: ref.revision, applied: ref.applied, current };
  });
  const state = problems.some(p => p.kind === 'source') ? 'needs_source' : problems.length || task.context.builtRevision !== task.context.revision || ((!task.context.baseline || task.inputRevision > 1) && task.status !== 'completed') ? 'updating' : task.context.baseline ? 'baseline' : 'current';
  view.freshness = { state, contextRevision: task.context.revision, builtRevision: task.context.builtRevision, checkedAt: new Date(now).toISOString(), problems,
    sources: task.context.sources.map(s => ({ kind: s.kind, asOf: s.asOf, validUntil: s.validUntil, path: s.path })), facts: dependentFacts(task, records) };
  if (state === 'baseline') view.baselineArtifacts = task.previousResult?.artifacts || task.resultArtifacts;
  if (!['current', 'baseline'].includes(state)) view.resultArtifacts = [];
  // 默认查询只暴露当前入口；修订器仍从持久状态回读历史文件。
  view.evidenceArtifacts = state === 'current' ? task.checkpoints.filter(c => c.stepId === 'evidence').flatMap(c => c.artifacts) : [];
  view.historyAvailable = !!task.previousResult || !!task.checkpoints.length || !!task.context.history.length;
  delete view.previousResult; delete view.checkpoints; delete view.attempts;
  view.context = { revision: task.context.revision, sources: task.context.sources, facts: view.freshness.facts };
  if (view.opportunity) delete view.opportunity.baselineArtifacts;
  return view;
}
