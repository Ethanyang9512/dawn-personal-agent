import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');
export const experienceMethodHash = value => hash(JSON.stringify({ title: value.title.trim(), when: value.when.trim(), method: value.method.trim(),
  scope: { routine: value.scope.routine.trim(), ...(value.scope.company === undefined ? {} : { company: value.scope.company.trim() }) } }));
// Completed reviews retain their original model provenance after a model switch.
export const recognizedExperienceReviewer = reviewer => reviewer?.kind === 'independent_codex'
  && typeof reviewer.model === 'string' && reviewer.model.trim().length > 0
  && ['high', 'xhigh'].includes(reviewer.effort);
const companyKey = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
function text(value, name, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) fail('EXPERIENCE_INVALID', `${name}需要非空文本，最多${limit}字`);
  return value.trim();
}
function ident(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value) || ['constructor', 'prototype'].includes(value)) fail('EXPERIENCE_INVALID', '经验与任务 ID 需要小写英文、数字、横线或下划线');
  return value;
}
function scope(value) {
  if (value?.routine !== 'job-preparation') fail('EXPERIENCE_INVALID', '经验适用范围须为 job-preparation');
  return { routine: value.routine, ...(value.company === undefined ? {} : { company: text(value.company, '适用公司', 100) }) };
}
export function validateExperienceChange(value, options = {}) {
  if (!['record', 'confirm', 'correct', 'withdraw'].includes(value?.operation) || !Number.isInteger(value.expectedRevision) || value.expectedRevision < 0) fail('EXPERIENCE_INVALID', '需要经验操作和当前 expectedRevision');
  const change = { operation: value.operation, id: ident(value.id), expectedRevision: value.expectedRevision };
  if (value.operation === 'record') {
    Object.assign(change, { title: text(value.title, '标题', 100), when: text(value.when, '适用条件', 500), method: text(value.method, '方法', 2000), scope: scope(value.scope) });
    if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 6) fail('EXPERIENCE_INVALID', '每次登记需要 1–6 条正文证据');
    change.evidence = value.evidence.map(e => {
      if (!Number.isInteger(e?.inputRevision) || e.inputRevision < 1 || typeof e.path !== 'string' || !path.isAbsolute(e.path)) fail('EXPERIENCE_INVALID', '证据需要任务版本和绝对路径');
      return { taskId: ident(e.taskId), inputRevision: e.inputRevision, path: e.path, quote: text(e.quote, '正文原句', 1000), criterion: text(e.criterion, '核对标准与结果', 1000) };
    });
  } else {
    const messages = options.userMessages ?? JSON.parse(process.env.DAWN_MEMORY_USER_MESSAGES || '[]');
    const source = messages.find(m => m.id === value.sourceId);
    if (!source || typeof source.text !== 'string' || !source.text.trim() || !Number.isFinite(Date.parse(source.at))) fail('EXPERIENCE_SOURCE', '经验反馈须引用本轮实际用户消息');
    change.source = { id: source.id, text: source.text, at: source.at };
    change.reason = text(value.reason, '反馈理由', 1000);
    if (value.operation === 'correct') Object.assign(change, { when: text(value.when, '当前适用条件', 500), method: text(value.method, '当前完整方法', 2000) });
  }
  return change;
}
function fileBytes(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024) fail('EXPERIENCE_EVIDENCE', '经验凭据须为不超过 20MB 的普通文件');
  return fs.readFileSync(file);
}
function matchesFile(evidence) {
  try {
    const bytes = fileBytes(evidence.path);
    return hash(bytes) === evidence.sha256 && bytes.toString('utf8').includes(evidence.quote);
  } catch { return false; }
}
function verifyEvidence(state, evidence, method, at) {
  const applicable = method.scope;
  const task = state.tasks[evidence.taskId];
  if (!task || task.status !== 'completed' || task.inputRevision !== evidence.inputRevision || task.completedRevision !== evidence.inputRevision
    || task.routine?.name !== applicable.routine || (applicable.company && companyKey(applicable.company) !== companyKey(task.routine.company))) fail('EXPERIENCE_EVIDENCE', '经验凭据须属于适用范围内已完成的当前任务版本');
  if (task.context) {
    if (task.context.revision !== task.context.builtRevision) fail('EXPERIENCE_EVIDENCE', '任务仍在按当前资料修订');
    for (const source of task.context.sources) {
      try {
        if (hash(fileBytes(source.path)) !== source.sha256 || hash(fileBytes(source.snapshot)) !== source.sha256
          || (source.validUntil && Date.parse(source.validUntil) <= Date.parse(at))) fail('EXPERIENCE_EVIDENCE', '任务来源已变化或到期');
      } catch { fail('EXPERIENCE_EVIDENCE', '任务来源无法核对'); }
    }
  }
  const artifacts = [...(task.resultArtifacts || []), ...(task.checkpoints || []).filter(c => c.inputRevision === evidence.inputRevision).flatMap(c => c.artifacts)];
  const artifact = artifacts.find(a => a.path === evidence.path);
  if (!artifact || !/\.(md|txt|html)$/i.test(evidence.path)) fail('EXPERIENCE_EVIDENCE', '证据必须引用当前正文产物，不能用核验清单代替');
  const checked = { taskId: evidence.taskId, inputRevision: evidence.inputRevision, path: evidence.path, quote: evidence.quote, criterion: evidence.criterion,
    sha256: artifact.sha256, company: task.routine.company, checkedAt: at };
  if (!matchesFile(checked)) fail('EXPERIENCE_EVIDENCE', '证据原句不存在或正文已发生变化');
  const proof = task.experienceReview;
  const review = proof?.checks?.find(c => c.id === method.id && c.methodHash === experienceMethodHash(method) && typeof c.passed === 'boolean');
  if (proof?.artifactSha256 === artifact.sha256 && recognizedExperienceReviewer(proof.reviewer)
    && review && typeof review.reason === 'string' && review.reason.trim()
    && (review.passed ? typeof review.quote === 'string' && review.quote.trim() && fileBytes(evidence.path).toString('utf8').includes(review.quote) : review.quote === undefined || typeof review.quote === 'string')) {
    checked.review = { id: review.id, methodHash: review.methodHash, passed: review.passed, reason: review.reason, quote: review.quote || '',
      artifactSha256: proof.artifactSha256, reviewer: structuredClone(proof.reviewer), reviewPath: proof.reviewPath };
  }
  return checked;
}
const evidenceKey = e => JSON.stringify([e.taskId, e.inputRevision, e.path, e.sha256, e.quote]);
function independentCount(evidence) {
  // 同一机会重跑、同公司不同任务都不是第二家独立验证。
  const tasks = new Set(), companies = new Set();
  for (const e of evidence.filter(e => e.review?.passed === true)) { tasks.add(e.taskId); companies.add(companyKey(e.company)); }
  return Math.min(tasks.size, companies.size);
}
function snapshot(entry) {
  const copy = structuredClone(entry); delete copy.history; return copy;
}
export function applyExperienceChange(state, change, at = new Date().toISOString()) {
  const previous = state.experiences?.[change.id];
  if (change.source && [previous, ...(previous?.history || [])].some(e => e?.source?.id === change.source.id && e.operation === change.operation)) return previous;
  if ((previous?.revision || 0) !== change.expectedRevision) fail('EXPERIENCE_CONFLICT', '经验版本已变化，先回读当前版本');
  let entry;
  if (change.operation === 'record') {
    if (previous?.status === 'withdrawn') fail('EXPERIENCE_WITHDRAWN', '已撤回经验不能被旧证据重新激活');
    if (previous && ['title', 'when', 'method', 'scope'].some(k => JSON.stringify(previous[k]) !== JSON.stringify(change[k]))) fail('EXPERIENCE_CONFLICT', 'record 只能追加证据，修改方法请提交实际用户纠正');
    const checked = change.evidence.map(e => verifyEvidence(state, e, change, at));
    entry = previous ? structuredClone(previous) : { id: change.id, title: change.title, when: change.when, method: change.method, scope: change.scope,
      revision: 1, status: 'candidate', basis: 'single_artifact_check', evidence: [], history: [], createdAt: at, updatedAt: at };
    const known = new Map(entry.evidence.map(e => [evidenceKey(e), e]));
    let reviewed = false;
    const added = checked.filter(e => {
      const key = evidenceKey(e), existing = known.get(key);
      if (!existing) { known.set(key, e); return true; }
      if (e.review && existing.review?.passed !== false && JSON.stringify(e.review) !== JSON.stringify(existing.review)) { existing.review = e.review; reviewed = true; }
      return false;
    });
    if (previous && !added.length && !reviewed) return previous;
    entry.evidence.push(...added);
    if (!entry.basis.startsWith('user_') && independentCount(entry.evidence.filter(matchesFile)) >= 2) {
      entry.status = 'active'; entry.basis = 'repeated_artifact_checks';
    }
  } else {
    if (!previous) fail('EXPERIENCE_NOT_FOUND', '经验尚未登记');
    if (previous.status === 'withdrawn') fail('EXPERIENCE_WITHDRAWN', '已撤回经验保留为历史，新方法使用新 ID');
    if (change.operation === 'confirm' && experienceView(state, change.id).status === 'unavailable') fail('EXPERIENCE_EVIDENCE', '原凭据无法核对，不能确认其有效');
    entry = { ...structuredClone(previous), history: [...previous.history, snapshot(previous)], operation: change.operation, source: change.source, reason: change.reason };
    if (change.operation === 'correct') {
      Object.assign(entry, { revision: previous.revision + 1, method: change.method, when: change.when, evidence: [], status: 'active', basis: 'user_correction' });
    } else if (change.operation === 'withdraw') {
      Object.assign(entry, { revision: previous.revision + 1, status: 'withdrawn', basis: 'user_withdrawal' });
    } else Object.assign(entry, { status: 'active', basis: 'user_confirmation' });
  }
  entry.updatedAt = at;
  (state.experiences ||= {})[change.id] = entry;
  return entry;
}
export function experienceView(state, id, { history = false } = {}) {
  const entry = state.experiences?.[id];
  if (!Object.hasOwn(state.experiences || {}, id)) return null;
  if (!entry || entry.id !== id || !Number.isInteger(entry.revision) || entry.revision < 1 || !['candidate', 'active', 'withdrawn'].includes(entry.status)
    || !Array.isArray(entry.evidence) || !Array.isArray(entry.history) || entry.scope?.routine !== 'job-preparation'
    || (entry.scope.company !== undefined && typeof entry.scope.company !== 'string')
    || ['title', 'when', 'method', 'basis', 'updatedAt'].some(k => typeof entry[k] !== 'string' || !entry[k])
    || entry.evidence.some(e => !e || ['taskId', 'path', 'sha256', 'quote', 'criterion', 'company'].some(k => typeof e[k] !== 'string' || !e[k]) || !Number.isInteger(e.inputRevision))) {
    return { id, status: 'unavailable', reason: '经验记录格式损坏，等待复核' };
  }
  const view = snapshot(entry);
  const unavailable = entry.status !== 'withdrawn' && entry.evidence.some(e => !matchesFile(e));
  if (unavailable) { view.status = 'unavailable'; view.reason = '经验的正文证据已变化或不可读，等待复核'; }
  const rejected = entry.evidence.find(e => e.review?.passed === false && e.review.methodHash === experienceMethodHash(entry));
  if (!unavailable && entry.status !== 'withdrawn' && !entry.basis.startsWith('user_') && rejected) {
    view.status = 'needs_revision'; view.reason = `独立复核未通过：${rejected.review.reason}`;
  }
  if (['unavailable', 'withdrawn', 'needs_revision'].includes(view.status)) { delete view.method; delete view.when; }
  if (history) view.history = structuredClone(entry.history);
  return view;
}
export function selectExperiences(state, task) {
  if (task.routine?.name !== 'job-preparation') return [];
  return Object.keys(state.experiences || {}).map(id => experienceView(state, id))
    .filter(e => ['candidate', 'active'].includes(e.status) && e.scope.routine === task.routine.name && (!e.scope.company || companyKey(e.scope.company) === companyKey(task.routine.company)))
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id, 'en'))
    .slice(0, 6).map(e => ({ id: e.id, revision: e.revision, status: e.status, title: e.title, when: e.when, method: e.method, scope: e.scope, basis: e.basis }));
}
export function experienceProblems(task, state) {
  return (task.experienceRefs || []).filter(ref => ref.applied !== false).flatMap(ref => {
    const current = experienceView(state, ref.id);
    const reason = !current ? '引用的经验记录已缺失' : current.status === 'unavailable' ? current.reason : current.revision !== ref.revision ? '引用的经验已纠正或撤回，版本发生变化'
      : current.status === 'withdrawn' ? '引用的经验已撤回' : null;
    return reason ? [{ kind: 'experience', id: ref.id, reason }] : [];
  });
}
