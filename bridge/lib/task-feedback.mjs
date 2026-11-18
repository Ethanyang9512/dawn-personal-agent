import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const kinds = new Set(['adopted', 'new_requirement', 'correction', 'quality_issue', 'rejected', 'user_edit']);
function readEdit(file) {
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size > 20 * 1024 * 1024) fail('FEEDBACK_EDIT', '用户改稿须为不超过20MB的普通文件绝对路径');
    return fs.readFileSync(file);
  } catch (error) { if (error.code === 'FEEDBACK_EDIT') throw error; fail('FEEDBACK_EDIT', '用户改稿不可读'); }
}
export function validateTaskFeedback(value, options = {}) {
  const messages = options.userMessages ?? JSON.parse(process.env.DAWN_MEMORY_USER_MESSAGES || '[]');
  const source = messages.find(m => m.id === value?.sourceId);
  if (!source || typeof source.text !== 'string' || !source.text.trim() || !Number.isFinite(Date.parse(source.at))) fail('FEEDBACK_SOURCE', '反馈必须引用本轮实际用户消息');
  const target = value.target;
  if (!target || (target.inputRevision !== null && (!Number.isInteger(target.inputRevision) || target.inputRevision < 1))
    || typeof target.path !== 'string' || !path.isAbsolute(target.path) || !/^[a-f0-9]{64}$/.test(target.sha256 || '')) fail('FEEDBACK_INVALID', '反馈需绑定具体成果版本、绝对路径和正文哈希；原基线版本为null');
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 8) fail('FEEDBACK_INVALID', '一次反馈需要1–8个明确事项');
  const items = value.items.map(item => {
    if (!kinds.has(item?.kind) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2000 || typeof item.revise !== 'boolean'
      || (['adopted', 'rejected'].includes(item.kind) && item.revise) || (item.kind === 'user_edit' && !item.revise)) fail('FEEDBACK_INVALID', '反馈需要分类、具体说明与显式revise；采用/否定不触发修订，用户改稿需要修订');
    return { kind: item.kind, text: item.text.trim(), revise: item.revise,
      ...(item.kind === 'user_edit' ? { edit: { path: item.path, sha256: hash(readEdit(item.path)) } } : {}) };
  });
  if (items.filter(item => item.kind === 'user_edit').length > 1) fail('FEEDBACK_INVALID', '一次反馈只提交一份完整用户改稿');
  return { source: { id: source.id, text: source.text, at: source.at }, target: { inputRevision: target.inputRevision, path: target.path, sha256: target.sha256 }, items };
}
function targets(task) {
  const found = [];
  const append = (inputRevision, artifacts) => {
    for (const a of artifacts || []) if (a.audience !== 'internal' && /\.(md|txt|html|docx|pdf)$/i.test(a.path || '')) found.push({ inputRevision: inputRevision ?? null, path: a.path, sha256: a.sha256, basis: inputRevision == null ? 'baseline' : 'generated' });
  };
  append(task.completedRevision, task.resultArtifacts);
  if (task.previousResult) append(task.previousResult.inputRevision, task.previousResult.artifacts);
  append(null, task.opportunity?.baselineArtifacts);
  for (const previous of task.resultHistory || []) append(previous.inputRevision, previous.artifacts);
  return found;
}
const targetKey = target => JSON.stringify([target.inputRevision, target.path, target.sha256]);
export function currentFeedbackTargets(task) {
  const all = targets(task), revision = Math.max(0, ...all.map(a => a.inputRevision || 0));
  return all.filter(a => (a.inputRevision || 0) === revision).filter((a, index, list) => list.findIndex(b => targetKey(b) === targetKey(a)) === index);
}
export function feedbackEntries(task, { history = false } = {}) {
  const current = new Set(currentFeedbackTargets(task).map(targetKey));
  return structuredClone((task.feedback || []).filter(entry => history || current.has(targetKey(entry.target))));
}
export function rememberTaskResult(task) {
  if (!task.resultArtifacts.length) return;
  const previous = { inputRevision: task.completedRevision, artifacts: structuredClone(task.resultArtifacts) };
  task.resultHistory ||= [];
  if (!task.resultHistory.some(r => r.inputRevision === previous.inputRevision)) task.resultHistory.push(previous);
  task.previousResult = previous;
}
export function prepareTaskFeedback(task, feedback, allTasks, artifactRoot, at) {
  const existing = task?.feedback?.find(entry => entry.source.id === feedback.source.id);
  if (existing) return { entry: existing, duplicate: true, revise: false };
  if (!task || task.routine?.name !== 'job-preparation' || task.status === 'cancelled') fail('FEEDBACK_TARGET', '没有可接收反馈的求职任务');
  const normalized = text => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const mentions = Object.values(allTasks).filter(t => t.routine && normalized(feedback.source.text).includes(normalized(t.routine.company)));
  if (mentions.length && !mentions.some(t => t.id === task.id)) fail('FEEDBACK_TARGET', '反馈消息明确属于另一家公司');
  const target = targets(task).find(a => targetKey(a) === targetKey(feedback.target));
  if (!target) fail('FEEDBACK_TARGET', '反馈目标不是该任务已登记的正文版本');
  try { if (hash(fs.readFileSync(target.path)) !== target.sha256) fail('FEEDBACK_TARGET', '原成果正文已变化'); }
  catch { fail('FEEDBACK_TARGET', '原成果正文已变化或不可读，用户改稿请另存后提交'); }
  const current = currentFeedbackTargets(task).some(a => targetKey(a) === targetKey(target));
  if (!current && feedback.items.some(item => item.kind === 'user_edit')) fail('FEEDBACK_EDIT', '用户改稿需基于当前成果；旧稿反馈只记入历史');
  const items = structuredClone(feedback.items);
  // 先验证全部文件，再创建快照；提交后的改动不能偷换本次改稿。
  const editBytes = items.filter(item => item.edit).map(item => {
    const bytes = readEdit(item.edit.path);
    if (hash(bytes) !== item.edit.sha256) fail('FEEDBACK_EDIT', '提交后用户改稿发生变化，请重新登记');
    return bytes;
  });
  let index = 0;
  for (const item of items.filter(item => item.edit)) {
    const directory = path.join(artifactRoot, task.id, '用户改稿', item.edit.sha256);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.realpathSync(directory).startsWith(fs.realpathSync(artifactRoot) + path.sep)) fail('FEEDBACK_EDIT', '用户改稿快照路径越界');
    const file = path.join(directory, path.basename(item.edit.path));
    try { fs.writeFileSync(file, editBytes[index++], { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (hash(readEdit(file)) !== item.edit.sha256) fail('FEEDBACK_EDIT', '用户改稿快照已被修改');
    item.edit.snapshot = file;
  }
  const revise = current && items.some(item => item.revise);
  return { duplicate: false, revise, entry: { id: `fb_${hash(`${task.id}\n${feedback.source.id}`).slice(0, 28)}`, source: feedback.source, target, items,
    receivedAt: at, disposition: !current ? 'historical' : revise ? 'revision_requested' : 'recorded', revisionTo: null } };
}
export function latestUserEdit(task) { return task.userEdits?.at(-1) || null; }
export function verifyUserEdit(task) {
  const edit = latestUserEdit(task);
  if (!edit) return null;
  try { if (hash(readEdit(edit.snapshot)) !== edit.sha256) fail('USER_EDIT_CHANGED', '用户改稿快照已变化，需核对后继续'); }
  catch { fail('USER_EDIT_CHANGED', '用户改稿快照已变化或不可读，需核对后继续'); }
  return edit;
}
