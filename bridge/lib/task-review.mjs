import fs from 'node:fs';
import path from 'node:path';
import { currentTaskView } from './task-context.mjs';
import { experienceView } from './task-experience.mjs';
import { userArtifacts } from './task-delivery.mjs';
import { currentFeedbackTargets } from './task-feedback.mjs';

const KINDS = ['adopted', 'new_requirement', 'correction', 'quality_issue', 'rejected', 'user_edit'];
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function limited(items, count, budget) {
  const selected = [];
  for (const item of items) {
    const size = JSON.stringify(item, null, 2).length;
    if (selected.length >= count || size > budget) continue;
    selected.push(item); budget -= size;
  }
  return { selected, omitted: items.length - selected.length };
}

// The caller supplies current memory records. This reader never falls back to another task store.
export function taskReviewContext({ statePath, records = [], now = Date.now(), days = 7 } = {}) {
  if (typeof statePath !== 'string' || !path.isAbsolute(statePath)) {
    fail('MISSING_REVIEW_TASKS_PATH', '周复盘必须显式提供 DAWN_REVIEW_TASKS_STATE 绝对路径');
  }
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {
    fail('REVIEW_TASKS_UNAVAILABLE', '周复盘任务状态无法读取，不能用旧记忆替代');
  }
  if (state?.version !== 1 || !state.tasks || Array.isArray(state.tasks) || !state.receipts) {
    fail('REVIEW_TASKS_UNAVAILABLE', '周复盘任务状态格式无效');
  }
  const since = now - days * 86400e3;
  const tasks = Object.values(state.tasks).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const summaries = tasks.map(task => {
    const view = currentTaskView(task, records, now, state);
    return { id: view.id, title: view.title, status: view.status, updatedAt: view.updatedAt,
      inputRevision: view.inputRevision, completedRevision: view.completedRevision ?? null,
      ...(view.opportunity ? { opportunity: { company: view.routine?.company, role: view.routine?.role,
        current: view.opportunity.current, asOf: view.opportunity.asOf ?? null } } : {}),
      ...(view.waitingFor ? { waitingFor: view.waitingFor.reason } : {}),
      ...(view.blocker ? { blocker: view.blocker.message } : {}),
      freshness: view.freshness ? { state: view.freshness.state, contextRevision: view.freshness.contextRevision,
        builtRevision: view.freshness.builtRevision, checkedAt: view.freshness.checkedAt, problems: view.freshness.problems } : { state: 'untracked' },
      artifacts: userArtifacts(view).map(a => ({ name: a.name, path: a.path, sha256: a.sha256 })),
    };
  });
  const feedback = { counts: Object.fromEntries(KINDS.map(kind => [kind, 0])), entries: [], invalid: 0, omitted: 0 };
  const seen = new Set();
  const targetKey = target => JSON.stringify([target.inputRevision, target.path, target.sha256]);
  const currentTargets = new Map(tasks.map(task => [task.id, new Set(currentFeedbackTargets(task).map(targetKey))]));
  for (const task of tasks) for (const entry of task.feedback || []) {
    if (!entry?.id || !entry.source?.id || typeof entry.source.text !== 'string' || !entry.source.text.trim()
      || !Number.isFinite(Date.parse(entry.source.at)) || !entry.target || !Array.isArray(entry.items)
      || !['recorded', 'revision_requested', 'historical'].includes(entry.disposition)) { feedback.invalid++; continue; }
    const key = `${task.id}:${entry.id}`;
    if (seen.has(key) || Date.parse(entry.source.at) < since || Date.parse(entry.source.at) > now) continue;
    seen.add(key);
    const items = entry.items.filter(item => KINDS.includes(item?.kind) && typeof item.text === 'string' && item.text.trim());
    for (const kind of new Set(items.map(item => item.kind))) feedback.counts[kind]++;
    if (!items.length) { feedback.invalid++; continue; }
    feedback.entries.push({ id: entry.id, taskId: task.id, title: task.title, source: entry.source,
      target: entry.target, targetIsCurrent: currentTargets.get(task.id).has(targetKey(entry.target)),
      disposition: entry.disposition, revisionTo: entry.revisionTo ?? null,
      items: items.map(item => ({ kind: item.kind, text: item.text, revise: item.revise,
        ...(item.edit ? { edit: { path: item.edit.path, sha256: item.edit.sha256 } } : {}) })) });
  }
  feedback.entries.sort((a, b) => b.source.at.localeCompare(a.source.at));
  const recentFeedback = limited(feedback.entries, 60, 16000);
  feedback.omitted = recentFeedback.omitted;
  feedback.entries = recentFeedback.selected;
  const methods = Object.keys(state.experiences || {}).map(id => experienceView(state, id)).filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const experiences = methods.map(method => ({ id: method.id, title: method.title, revision: method.revision,
    status: method.status, basis: method.basis, updatedAt: method.updatedAt, scope: method.scope,
    evidenceCount: method.evidence?.length || 0, ...(method.reason ? { reason: method.reason } : {}) }));
  const notifications = { window: 'event.createdAt', total: 0, acceptedParts: 0,
    counts: { wechat_accepted: 0, partially_accepted: 0, unknown: 0, pending: 0, withdrawn: 0 } };
  const eventIds = new Set();
  for (const task of tasks) for (const event of Object.values(task.events || {})) {
    const createdAt = Date.parse(event.createdAt);
    if (task.notify === false || event.kind !== 'completed' || !event.id || eventIds.has(event.id)
      || !(createdAt >= since && createdAt <= now) || event.delivery?.status === 'local') continue;
    eventIds.add(event.id); notifications.total++;
    const status = Object.hasOwn(notifications.counts, event.delivery?.status) ? event.delivery.status : 'pending';
    notifications.counts[status]++;
    notifications.acceptedParts += Array.isArray(event.delivery?.parts)
      ? event.delivery.parts.filter(part => part.status === 'wechat_accepted').length : status === 'wechat_accepted' ? 1 : 0;
  }
  const taskSelection = limited(summaries, 20, 12000), methodSelection = limited(experiences, 30, 6000);
  const data = { sourcePath: statePath, checkedAt: new Date(now).toISOString(), since: new Date(since).toISOString(),
    tasks: taskSelection.selected, feedback, experiences: methodSelection.selected, notifications,
    omitted: { tasks: taskSelection.omitted, experiences: methodSelection.omitted } };
  return { data, text: JSON.stringify(data, null, 2) };
}
