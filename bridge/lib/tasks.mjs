import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { withAutomationControlLock } from './automation-control.mjs';
import { readTaskJson, readTasks, writeTaskJson, taskPaths, validateTask, taskError } from './task-protocol.mjs';
import { jobPreparation, verifyJobPreparation } from './job-preparation.mjs';
import { initialTaskContext, replaceTaskSource, correctedTaskContext, contextProblems } from './task-context.mjs';
import { baselineArtifacts, opportunityProgress, opportunityOrder } from './opportunities.mjs';
import { validateExperienceChange, applyExperienceChange, selectExperiences, experienceProblems, experienceView } from './task-experience.mjs';
import { reviewStep, verifyExperienceReview } from './experience-review.mjs';
import { prepareTaskFeedback, rememberTaskResult, verifyUserEdit } from './task-feedback.mjs';
import { completionMessage } from './task-delivery.mjs';

const clone = value => structuredClone(value);
const terminalDelivery = new Set(['wechat_accepted', 'partially_accepted', 'unknown', 'withdrawn', 'local']);
function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return null; }
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
  }).trim() || '?'; } catch { return '?'; }
}
function stopOrphan(worker) {
  if (!worker?.identity || worker.identity === '?' || processIdentity(worker.pid) !== worker.identity) return;
  try { process.kill(-worker.pid, 'SIGKILL'); } catch { /* 已退出；只处理本次记录的 Codex 进程组 */ }
}
function regularFile(file, root) {
  let actual;
  try { actual = fs.realpathSync(file); } catch (error) {
    if (error.code === 'ENOENT') throw taskError('ARTIFACT_MISSING', `缺少产物：${path.basename(file)}`);
    throw error;
  }
  const base = fs.realpathSync(root);
  if (!actual.startsWith(base + path.sep) || !fs.lstatSync(file).isFile()) throw taskError('ARTIFACT_PATH', '产物必须是本次执行目录内的普通文件');
  return actual;
}
export function verifyTaskOutputs(step, attempt, artifactRoot = attempt.directory) {
  const base = fs.realpathSync(artifactRoot);
  const dir = fs.realpathSync(attempt.directory);
  if (dir !== base && !dir.startsWith(base + path.sep)) throw taskError('ARTIFACT_PATH', '执行目录不在任务产物目录内');
  return step.outputs.map(output => {
    const file = regularFile(path.join(attempt.directory, output.name), attempt.directory);
    if (fs.statSync(file).size > 100 * 1024 * 1024) throw taskError('ARTIFACT_TOO_LARGE', `产物超过 100MB：${output.name}`);
    const content = fs.readFileSync(file);
    if (content.length < output.minBytes) throw taskError('ARTIFACT_TOO_SMALL', `产物内容不足：${output.name}`);
    if (output.format !== 'file') {
      const text = content.toString('utf8');
      if (output.format === 'json') {
        try { JSON.parse(text); } catch { throw taskError('ARTIFACT_JSON_INVALID', `产物不是有效 JSON：${output.name}`); }
      }
      for (const required of output.contains) if (!text.includes(required)) throw taskError('ARTIFACT_CONTENT', `产物缺少验收项：${required}`);
    }
    return { name: output.name, path: file, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), ...(output.audience === undefined ? {} : { audience: output.audience }) };
  });
}
function verifyCheckpointArtifacts(task) {
  for (const checkpoint of task.checkpoints) for (const artifact of checkpoint.artifacts) {
    const file = regularFile(artifact.path, checkpoint.directory);
    const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actual !== artifact.sha256) throw taskError('ARTIFACT_CHANGED', `已核验产物发生变化：${artifact.name}`);
  }
}

export function createTaskRuntime(options) {
  const paths = taskPaths(options);
  const now = () => new Date(options.now ? options.now() : Date.now()).toISOString();
  const log = options.log || (() => {});
  const lockPath = `${paths.statePath}.owner`;
  const owner = { pid: process.pid, identity: processIdentity(process.pid), token: randomUUID() };
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const previous = readTaskJson(lockPath, null);
  if (previous?.identity && previous.identity === processIdentity(previous.pid)) throw taskError('TASK_RUNTIME_BUSY', '已有任务运行器持有状态文件');
  if (previous) fs.unlinkSync(lockPath);
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(lock, JSON.stringify(owner)); fs.closeSync(lock);
  let state;
  try { state = readTasks(paths); } catch (error) { fs.unlinkSync(lockPath); throw error; }
  let active = null, timer = null, stopping = false, syncing = false;
  const notifying = new Set();
  const save = () => writeTaskJson(paths.statePath, state);
  const contextChanged = attempt => attempt.jobContextRevision == null && options.contextRevision && attempt.contextRevision !== options.contextRevision();
  const eventFor = id => Object.values(state.tasks).flatMap(t => Object.values(t.events)).find(e => e.id === id);
  const invalidateEvents = task => { for (const event of Object.values(task.events)) event.withdrawRequestedAt ||= now(); };
  function event(task, kind, summary) {
    // 同一业务进展与尝试次数无关。完成按版本；阻塞按步骤/错误；问题按步骤/原问题。
    const detail = kind === 'completed' ? '' : `${task.stepIndex}:${kind === 'blocked' ? task.blocker.code : summary.trim().replace(/\s+/g, ' ')}`;
    const progressKey = `${task.id}:${task.inputRevision}:${kind}:${detail}`;
    const id = `pt_${createHash('sha256').update(progressKey).digest('hex').slice(0, 28)}`;
    // 升级前的完成事件保持原 ID 和投递回执，不能为同一成果重建一条。
    if (kind === 'completed' && Object.values(task.events).some(e => e.kind === kind && e.inputRevision === task.inputRevision)) return;
    if (!task.events[id]) task.events[id] = {
      id, progressKey, taskId: task.id, kind, createdAt: now(), inputRevision: task.inputRevision,
      text: kind === 'completed' ? completionMessage(task, summary) : `任务「${task.title}」${kind === 'waiting' ? '需要补充信息' : '暂时停在这里'}。\n${summary.slice(0, 600)}`,
      delivery: { status: task.notify ? 'pending' : 'local', updatedAt: now() },
    };
  }
  function block(task, error) {
    task.status = 'blocked'; task.blocker = { code: error.code || 'TASK_STEP_FAILED', message: String(error.message || error).slice(0, 300), at: now() };
    event(task, 'blocked', task.blocker.message);
  }
  function updateContext(task, context, reason) {
    rememberTaskResult(task);
    task.context = context;
    task.inputs.push({ id: `context-${context.revision}`, revision: ++task.inputRevision, receivedAt: now(), kind: 'context', text: reason });
    task.stepIndex = 0; task.checkpoints = []; task.resultArtifacts = [];
    if (task.status !== 'paused') task.status = task.opportunity?.current.stage === 'closed' ? 'waiting' : 'queued';
    if (task.status === 'waiting') task.waitingFor = { type: 'event', key: 'opportunity-progress', reason: '机会已结束，等待用户重新推进' };
    else delete task.waitingFor;
    delete task.blocker; task.updatedAt = now(); invalidateEvents(task);
    if (active?.taskId === task.id) active.handle.cancel();
  }
  function blockContext(task, error) {
    if (active?.taskId === task.id) task.attempts.find(a => a.id === active.attemptId).contextInvalidated = true;
    if (task.status !== 'paused') return block(task, error);
    task.blocker = { code: error.code, message: error.message, at: now() };
  }
  function reconcileContexts() {
    if (!options.contextEnabled) return;
    const tasks = Object.values(state.tasks).filter(task => task.routine?.name === 'job-preparation' && task.status !== 'cancelled');
    if (!tasks.length) return;
    let records;
    try { records = options.memoryRecords?.() || []; } catch (error) {
      for (const task of tasks) if (task.blocker?.code !== 'MEMORY_UNAVAILABLE') {
        invalidateEvents(task);
        if (active?.taskId === task.id) active.handle.cancel();
        blockContext(task, taskError('MEMORY_UNAVAILABLE', '当前记忆不可读，相关材料等待恢复核对')); save();
      }
      return;
    }
    for (const task of tasks) {
      try {
        if (!task.context) { task.context = initialTaskContext(task, paths.artifactRoot, now()); save(); }
        const next = correctedTaskContext(task, records, now());
        if (next) { updateContext(task, next, '关联的用户事实已纠正、撤销或过期。按 context.facts 的当前有效值修订所有受影响段落，旧资料中的冲突值失效。'); save(); }
        const problems = contextProblems(task, records, Date.parse(now())).filter(p => p.kind === 'source');
        if (problems.length && task.blocker?.code !== 'CONTEXT_SOURCE') {
          invalidateEvents(task);
          if (active?.taskId === task.id) active.handle.cancel();
          blockContext(task, taskError('CONTEXT_SOURCE', problems.map(p => p.reason + '：' + p.path).join('；')));
          save();
        } else if (!problems.length && ['CONTEXT_SOURCE', 'MEMORY_UNAVAILABLE'].includes(task.blocker?.code)) {
          if (task.status !== 'paused') task.status = task.resultArtifacts.length && task.completedRevision === task.inputRevision ? 'completed' : 'queued';
          for (const e of Object.values(task.events)) if (e.kind === 'blocked') e.withdrawRequestedAt ||= now();
          delete task.blocker; save();
        }
      } catch (error) { if (task.blocker?.code !== error.code) { blockContext(task, error); save(); } }
    }
  }
  function reconcileExperiences() {
    if (!options.experienceEnabled) return;
    for (const task of Object.values(state.tasks)) {
      if (!task.context || task.status === 'cancelled' || !experienceProblems(task, state).length) continue;
      const changed = experienceProblems(task, state);
      const current = (task.experienceRefs || []).map(ref => experienceView(state, ref.id));
      const refs = current.filter(ref => ref && ['active', 'candidate'].includes(ref.status)).map(ref => ({ id: ref.id, revision: ref.revision, title: ref.title, status: ref.status, method: ref.method, when: ref.when, scope: ref.scope, basis: ref.basis }));
      const context = { ...task.context, revision: task.context.revision + 1, changedAt: now(),
        history: [...task.context.history, { revision: task.context.revision, sources: task.context.sources, facts: task.context.facts, replacedAt: now(), reason: 'experience_correction' }] };
      updateContext(task, context, '本次引用的方法已纠正、撤回或证据失效。只按 experienceRefs 的当前方法修订相关内容；旧成果中的已替代做法不再沿用。');
      if (task.opportunity?.current.stage === 'closed' && task.status !== 'paused') {
        task.status = 'waiting'; task.waitingFor = { type: 'event', key: 'opportunity-progress', reason: '机会已结束，等待用户重新推进' };
      }
      task.experienceChanges = changed.map(problem => {
        const prior = task.experienceRefs.find(ref => ref.id === problem.id), next = experienceView(state, problem.id);
        return { id: problem.id, title: prior?.title, status: next?.status || 'unavailable', reason: next?.reason || problem.reason };
      });
      task.experienceRefs = refs; task.experienceInputRevision = task.inputRevision; save();
    }
  }
  function recordExperience(change) {
    if (change.operation === 'record') for (const evidence of change.evidence || []) {
      const task = state.tasks[evidence.taskId];
      if (task?.context && (contextProblems(task, options.memoryRecords?.() || []).length || experienceProblems(task, state).length)) throw taskError('EXPERIENCE_EVIDENCE', '当前任务依赖已变化，先修订材料再积累经验');
    }
    const entry = applyExperienceChange(state, change, now());
    if (change.operation === 'record') for (const evidence of change.evidence) {
      const task = state.tasks[evidence.taskId];
      task.experienceRefs ||= [];
      if (!task.experienceRefs.some(ref => ref.id === entry.id)) task.experienceRefs.push({ id: entry.id, revision: entry.revision, title: entry.title, status: entry.status,
        when: entry.when, method: entry.method, scope: entry.scope, basis: entry.basis, applied: true });
    }
    return entry;
  }
  function learnFromResult(task, attempt) {
    if (!options.experienceEnabled || task.routine?.name !== 'job-preparation' || task.status !== 'completed') return;
    const report = readTaskJson(path.join(attempt.directory, '核验.json'), {});
    const file = task.resultArtifacts.find(a => a.name === '求职准备.md').path;
    const changes = [];
    for (const ref of task.experienceRefs || []) {
      const check = report.experienceChecks?.find(c => c.id === ref.id);
      ref.applied = check?.applied === true;
      if (ref.applied) changes.push({ ...ref, operation: 'record', expectedRevision: ref.revision, evidence: [{ taskId: task.id, inputRevision: task.inputRevision, path: file, quote: check.quote, criterion: check.reason }] });
    }
    for (const observation of (Array.isArray(report.experienceObservations) ? report.experienceObservations : []).slice(0, 3).filter(o => o && typeof o === 'object')) changes.push({ ...observation, operation: 'record', expectedRevision: state.experiences?.[observation.id]?.revision || 0,
      evidence: [{ taskId: task.id, inputRevision: task.inputRevision, path: file, quote: observation.quote, criterion: observation.criterion }] });
    const result = { recorded: [], errors: [] };
    for (const change of changes) {
      try { const entry = recordExperience(validateExperienceChange(change, { userMessages: [] })); result.recorded.push({ id: entry.id, revision: entry.revision, status: entry.status }); }
      catch (error) { result.errors.push({ id: change.id, code: error.code || 'EXPERIENCE_INVALID' }); }
    }
    if (changes.length) task.experienceLearning = result;
  }
  function applyCommand(request) {
    let task = state.tasks[request.taskId];
    if (request.action === 'feedback') {
      const { entry, duplicate, revise } = prepareTaskFeedback(task, request.feedback, state.tasks, paths.artifactRoot, now());
      if (duplicate) return task;
      if (revise) {
        rememberTaskResult(task);
        task.inputs.push({ id: entry.id, kind: 'feedback', receivedAt: now(), revision: ++task.inputRevision,
          text: `用户对已交付材料的反馈（分类保留，采用不等于方法确认）：${JSON.stringify(entry.items.filter(item => item.revise).map(item => ({ kind: item.kind, text: item.text })))}。按这些具体要求修订；用户改稿使用本轮 userEdit 指定快照。新资料与当前有效事实优先，不把材料反馈自动写成个人事实、JD 或长期方法。` });
        task.stepIndex = Math.min(task.stepIndex, 1); task.checkpoints = task.checkpoints.filter(c => c.stepIndex < task.stepIndex); task.resultArtifacts = [];
        if (task.status !== 'paused') {
          task.status = task.opportunity?.current.stage === 'closed' ? 'waiting' : 'queued';
          if (task.status === 'waiting') task.waitingFor = { type: 'event', key: 'opportunity-progress', reason: '机会已结束，等待用户重新推进' };
          else delete task.waitingFor;
        }
        delete task.blocker; invalidateEvents(task); entry.revisionTo = task.inputRevision;
        for (const item of entry.items.filter(item => item.edit)) (task.userEdits ||= []).push({ feedbackId: entry.id, source: entry.source, target: entry.target,
          ...item.edit, receivedAt: entry.receivedAt, revisionTo: task.inputRevision });
        if (active?.taskId === task.id) active.handle.cancel();
      }
      (task.feedback ||= []).push(entry); task.updatedAt = now();
      return task;
    }
    if (request.action === 'source') {
      if (!task || task.status === 'cancelled' || !task.routine) throw taskError('CONTEXT_TARGET', '没有可更新的求职任务');
      task.context ||= initialTaskContext(task, paths.artifactRoot, now());
      const next = replaceTaskSource(task, request.source, state.tasks, paths.artifactRoot, now());
      if (next) {
        const definition = jobPreparation({ ...task.routine, origin: task.origin, notify: task.notify, materials: next.sources.map(s => ({ kind: s.kind, path: s.path, asOf: s.asOf, ...(s.validUntil ? { validUntil: s.validUntil } : {}) })) });
        task.routine = definition.routine; task.sources = definition.sources;
        updateContext(task, next, `资料更新：${request.source.kind}，日期 ${request.source.asOf}，来源消息 ${request.source.source.id}。以 context 的对应类型快照替代旧资料；重新核对岗位判断、经历匹配、面试准备和材料清单。`);
      }
      return task;
    }
    if (request.action === 'track') {
      if (task?.opportunity) return task;
      if (task && (task.status === 'cancelled' || task.routine?.name !== 'job-preparation')) throw taskError('OPPORTUNITY_TARGET', '该任务无法登记为求职机会');
      const artifacts = baselineArtifacts(request.tracking); // 先验证材料，失败不能留下半条任务。
      const fresh = !task;
      task ||= applyCommand({ ...request, action: 'create' });
      task.opportunity = { revision: 1, current: request.tracking.current, asOf: request.tracking.asOf, history: [], baselineArtifacts: artifacts };
      if (fresh) {
        task.status = 'waiting'; task.waitingFor = { type: 'event', key: 'opportunity-progress', reason: '等待新的求职进展' };
        task.previousResult = { inputRevision: null, artifacts };
      }
      return task;
    }
    if (request.action === 'progress') {
      if (!task || task.status === 'cancelled') throw taskError('OPPORTUNITY_TARGET', '机会不存在或任务已取消');
      const update = opportunityProgress(task, request.progress, state.tasks, now());
      if (update.changed) {
        task = applyCommand({ ...request, action: 'input', text: `机会进展（来源 ${request.progress.source.id}，发生于 ${request.progress.occurredAt}）：${request.progress.summary}\n当前有效机会状态：${JSON.stringify(update.opportunity.current)}\n以此修订原准备包；保留仍适用的内容，面试日期按北京时间表达。旧进展只作历史，不能覆盖当前状态。` });
        if (task.status !== 'paused') {
          if (update.opportunity.current.stage === 'closed') {
            task.status = 'waiting'; task.waitingFor = { type: 'event', key: 'opportunity-progress', reason: '机会已结束，等待用户重新推进' };
          } else {
            task.status = 'queued'; delete task.waitingFor;
          }
        }
      }
      task.opportunity = update.opportunity; task.updatedAt = now();
      return task;
    }
    if (request.action === 'prepare') {
      const definition = validateTask(request.task);
      if (!task) return applyCommand({ ...request, action: 'create', task: definition });
      if (task.status === 'cancelled') throw taskError('TASK_CANCELLED', '本轮准备已取消；新的委托需要新任务 ID');
      if (task.routine?.name !== 'job-preparation') throw taskError('TASK_EXISTS', '同 ID 已用于其他任务');
      if (task.context && JSON.stringify(definition.routine.materials) !== JSON.stringify(task.routine.materials)) throw taskError('CONTEXT_SOURCE', '已关联资料使用 source 登记版本，不能通过旧 prepare 配置覆盖');
      if (task.notify !== definition.notify) {
        task.notify = definition.notify; task.updatedAt = now();
        if (!task.notify) invalidateEvents(task);
      }
      if (task.routine.fingerprint === definition.routine.fingerprint) return task;
      // 完整配置的新快照也作为一条输入保留，旧输入仍在，新要求显式覆盖冲突。
      if (task.context) {
        const next = { ...task.context, revision: task.context.revision + 1, changedAt: now(),
          history: [...task.context.history, { revision: task.context.revision, sources: task.context.sources, facts: task.context.facts, replacedAt: now(), reason: 'prepare' }] };
        updateContext(task, next, '求职准备配置更新，按新的资料与要求重新核对证据和准备材料。');
        task.routine = definition.routine; task.sources = definition.sources; task.objective = definition.objective;
        return task;
      }
      task.routine = definition.routine; task.sources = definition.sources; task.objective = definition.objective;
      return applyCommand({ ...request, action: 'input', text: `求职准备配置更新，以此覆盖旧配置中的冲突要求：\n${definition.routine.requirements}\n资料名单与日期以 routine 的最新快照为准（${definition.routine.fingerprint}）。` });
    }
    if (request.action === 'create') {
      if (task) throw taskError('TASK_EXISTS', '已有同 ID 任务；补充要求请用 input');
      const definition = validateTask(request.task);
      task = state.tasks[definition.id] = { ...definition, status: 'queued', inputRevision: 1, stepIndex: 0,
        createdAt: now(), updatedAt: now(), inputs: [], checkpoints: [], attempts: [], events: {}, resultArtifacts: [] };
    } else {
      if (!task) throw taskError('TASK_NOT_FOUND', '任务不存在');
      if (request.action === 'notify') {
        const e = task.events[request.eventId];
        if (!e) throw taskError('TASK_EVENT_NOT_FOUND', '进展不存在；跟进必须引用已有 eventId');
        // 通知补发沿用原事件与 clientId；已受理/未知/撤回均不重发。
        // pending/queued 的恢复由 notify() 对账完成，无需另建事件。
        return task;
      }
      if (task.status === 'cancelled') {
        if (request.action === 'cancel') return task;
        throw taskError('TASK_CANCELLED', '已取消任务不能恢复；新委托使用新 ID');
      }
      if (request.action === 'plan') {
        const index = task.routine ? Math.min(task.stepIndex, 1) : task.status === 'completed' ? task.steps.length - 1 : task.stepIndex;
        const revised = validateTask({ ...task, steps: [...task.steps.slice(0, index), ...request.steps] });
        if (!request.text?.trim()) throw taskError('INVALID_TASK_INPUT', '需要说明计划变更对应的用户要求');
        rememberTaskResult(task);
        task.steps = revised.steps; task.stepIndex = index; task.resultArtifacts = [];
        task.checkpoints = task.checkpoints.filter(c => c.stepIndex < index);
        task.inputs.push({ id: request.requestId, text: request.text, kind: 'plan', receivedAt: now(), revision: ++task.inputRevision });
        if (task.status !== 'paused') task.status = 'queued';
        delete task.waitingFor; delete task.blocker; invalidateEvents(task);
        if (active?.taskId === task.id) active.handle.cancel();
      } else if (request.action === 'input') {
        if (!request.text?.trim() || request.text.length > 12000) throw taskError('INVALID_TASK_INPUT', '补充要求为空或过长');
        if (task.routine && task.inputs.at(-1)?.text.trim() === request.text.trim()) return task;
        task.inputs.push({ id: request.requestId, text: request.text, receivedAt: now(), revision: ++task.inputRevision });
        invalidateEvents(task);
        if (task.status === 'completed') {
          rememberTaskResult(task);
          task.stepIndex = task.routine ? 1 : task.steps.length - 1;
          task.checkpoints = task.checkpoints.filter(c => c.stepIndex < task.stepIndex);
          task.status = 'queued'; task.resultArtifacts = [];
        } else if (!['paused', 'waiting'].includes(task.status) || task.waitingFor?.type === 'user') {
          task.status = 'queued'; delete task.waitingFor;
        }
        if (task.routine && task.stepIndex > 1) {
          task.stepIndex = 1; task.checkpoints = task.checkpoints.filter(c => c.stepIndex < 1);
        }
        delete task.blocker;
        if (active?.taskId === task.id) active.handle.cancel();
      } else if (request.action === 'cancel' || request.action === 'pause') {
        task.status = request.action === 'cancel' ? 'cancelled' : 'paused';
        invalidateEvents(task);
        if (active?.taskId === task.id) active.handle.cancel();
      } else if (request.action === 'resume') {
        if (task.status === 'completed') throw taskError('TASK_COMPLETED', '任务已完成；新增要求使用 input');
        task.status = 'queued'; task.lastWake = { type: 'resume', at: now() }; delete task.waitingFor; delete task.blocker; invalidateEvents(task);
      } else if (request.action === 'wake') {
        if (task.status !== 'waiting' || task.waitingFor?.type !== 'event' || task.waitingFor.key !== request.key) throw taskError('TASK_WAKE_MISMATCH', '当前没有等待该事件');
        task.status = 'queued'; task.lastWake = { type: 'event', key: request.key, at: now() }; delete task.waitingFor; invalidateEvents(task);
      } else throw taskError('INVALID_TASK_COMMAND', '未知任务命令');
      task.updatedAt = now();
    }
    return task;
  }
  function consumeCommands() {
    withAutomationControlLock(paths.controlPath, () => {
      const control = readTaskJson(paths.controlPath, { version: 1, requests: [] });
      if (control.version !== 1 || !Array.isArray(control.requests)) throw taskError('TASK_CONTROL_INVALID', '任务控制文件无效');
      if (!control.requests.length) return;
      for (const request of control.requests) {
        if (state.receipts[request.requestId]) continue;
        try {
          if (request.action === 'experience') {
            const entry = recordExperience(request.experience);
            state.receipts[request.requestId] = { status: 'accepted', experienceId: entry.id, revision: entry.revision, experienceStatus: entry.status, at: now() };
            continue;
          }
          const repeatedProgress = request.action === 'progress' && state.tasks[request.taskId]?.opportunity?.history.some(e => e.source.id === request.progress.source.id);
          const task = applyCommand(request);
          state.receipts[request.requestId] = { status: 'accepted', taskId: task.id, taskStatus: task.status, inputRevision: task.inputRevision,
            ...(request.action === 'feedback' ? { feedbackId: task.feedback.find(f => f.source.id === request.feedback.source.id).id,
              disposition: task.feedback.find(f => f.source.id === request.feedback.source.id).disposition,
              revisionTo: task.feedback.find(f => f.source.id === request.feedback.source.id).revisionTo } : {}),
            ...(request.action === 'progress' ? { opportunityRevision: task.opportunity.revision,
              disposition: repeatedProgress ? 'duplicate' : task.opportunity.history.find(e => e.source.id === request.progress.source.id).disposition } : {}),
            ...(request.action === 'notify' ? { eventId: request.eventId, delivery: task.events[request.eventId].delivery.status } : {}), at: now() };
        } catch (error) {
          state.receipts[request.requestId] = { status: 'rejected', taskId: request.taskId, error: error.code || 'INVALID_TASK_COMMAND', message: error.message, at: now() };
        }
      }
      save(); // 先持久化任务与回执，再移除请求；崩溃重放按 requestId 去重。
      writeTaskJson(paths.controlPath, { version: 1, requests: [] });
    });
  }
  function withdrawEvents() {
    const removed = Object.values(state.tasks).flatMap(task => Object.values(task.events))
      .filter(e => e.withdrawRequestedAt || ['wechat_accepted', 'partially_accepted', 'withdrawn'].includes(e.delivery.status));
    if (!removed.length) return;
    const inFlight = new Set(options.withdrawNotifications?.(new Set(removed.map(e => e.id))) || []);
    let changed = false;
    for (const e of removed) {
      if (e.withdrawRequestedAt && !inFlight.has(e.id) && !terminalDelivery.has(e.delivery.status)) {
        e.delivery.status = e.delivery.requestPending || e.delivery.lastError === 'network' ? 'unknown' : 'withdrawn';
        e.delivery.updatedAt = now(); changed = true;
      }
    }
    if (changed) save();
  }
  function sync() {
    if (syncing || stopping) return;
    syncing = true;
    try { consumeCommands(); reconcileContexts(); reconcileExperiences(); withdrawEvents(); } finally { syncing = false; }
  }
  function readReport(task, attempt) {
    const file = path.join(attempt.directory, 'checkpoint.json');
    if (!fs.existsSync(file)) return null;
    regularFile(file, attempt.directory);
    if (fs.statSync(file).size > 64000) throw taskError('CHECKPOINT_INVALID', '检查点过大');
    const report = readTaskJson(file, null);
    if (report.attemptId !== attempt.id || report.inputRevision !== attempt.inputRevision || !['done', 'waiting'].includes(report.status)
      || typeof report.summary !== 'string' || !report.summary.trim() || report.summary.length > 2000) throw taskError('CHECKPOINT_INVALID', '检查点身份或内容无效');
    if (report.status === 'waiting') {
      const wait = report.waitingFor;
      if (!wait || !['user', 'time', 'event'].includes(wait.type) || typeof wait.reason !== 'string' || !wait.reason.trim() || wait.reason.length > 1000
        || (wait.type === 'time' && (!Number.isFinite(Date.parse(wait.at)) || Date.parse(wait.at) <= Date.parse(attempt.startedAt))) || (wait.type === 'event' && !/^[a-z0-9_-]{1,100}$/.test(wait.key || ''))) {
        throw taskError('CHECKPOINT_INVALID', '等待条件无效');
      }
      return { report, artifacts: [] };
    }
    const artifacts = verifyTaskOutputs(task.steps[attempt.stepIndex], attempt, paths.artifactRoot);
    verifyJobPreparation(task, attempt);
    if (task.steps[attempt.stepIndex].id === 'experience-review') verifyExperienceReview(task, attempt);
    return { report, artifacts };
  }
  function acceptReport(current, sourceAttempt) {
    if (sourceAttempt.contextInvalidated || sourceAttempt.inputRevision !== current.inputRevision || ['cancelled', 'paused'].includes(current.status)) return false;
    if (options.experienceEnabled && experienceProblems(current, state).length) return false;
    verifyUserEdit(current);
    if (contextChanged(sourceAttempt) || (current.context && (sourceAttempt.jobContextRevision !== current.context.revision || contextProblems(current, options.memoryRecords?.() || []).length))) return false;
    verifyCheckpointArtifacts(current);
    const task = clone(current);
    const attempt = task.attempts.find(a => a.id === sourceAttempt.id);
    const checked = readReport(task, attempt);
    if (!checked) return false;
    const { report, artifacts } = checked;
    attempt.status = report.status === 'done' ? 'completed' : 'waiting'; attempt.endedAt = now();
    task.updatedAt = now(); delete task.blocker;
    if (report.status === 'waiting') {
      task.status = 'waiting'; task.waitingFor = report.waitingFor;
      task.lastCheckpoint = { path: path.join(attempt.directory, 'checkpoint.json'), summary: report.summary };
      if (report.waitingFor.type === 'user') event(task, 'waiting', report.waitingFor.reason);
    } else {
      task.checkpoints.push({ stepIndex: attempt.stepIndex, stepId: task.steps[attempt.stepIndex].id,
        attemptId: attempt.id, inputRevision: attempt.inputRevision, directory: attempt.directory,
        artifacts: artifacts.map(a => ({ ...a, verifiedAt: now() })), summary: report.summary, verifiedAt: now() });
      task.stepIndex = attempt.stepIndex + 1;
      delete task.waitingFor; delete task.lastCheckpoint;
      if (task.stepIndex === task.steps.length) {
        const review = task.steps[attempt.stepIndex].id === 'experience-review';
        const publish = review ? task.checkpoints.find(c => c.stepId === 'preparation').artifacts : artifacts;
        if (review) task.experienceReview = { ...verifyExperienceReview(task, attempt), reviewPath: path.join(attempt.directory, '经验复核.json') };
        const directory = path.join(paths.artifactRoot, task.id, '成果', `r${task.inputRevision}`);
        fs.mkdirSync(directory, { recursive: true });
        if (!fs.realpathSync(directory).startsWith(fs.realpathSync(paths.artifactRoot) + path.sep)) throw taskError('ARTIFACT_PATH', '成果目录不在任务目录内');
        task.resultArtifacts = publish.map(artifact => {
          const output = path.join(directory, artifact.name);
          const temporary = `${output}.${attempt.id}.tmp`;
          fs.copyFileSync(artifact.path, temporary);
          try {
            if (createHash('sha256').update(fs.readFileSync(temporary)).digest('hex') !== artifact.sha256) throw taskError('ARTIFACT_CHANGED', '产物在发布前发生变化');
            try { fs.linkSync(temporary, output); } catch (error) {
              if (error.code !== 'EEXIST') throw error;
              if (!fs.lstatSync(output).isFile() || createHash('sha256').update(fs.readFileSync(output)).digest('hex') !== artifact.sha256) throw taskError('RESULT_CONFLICT', '成果位置已有不同内容，保留原文件');
            }
          } finally { fs.unlinkSync(temporary); }
          return { ...artifact, path: output, verifiedAt: now() };
        });
        if (task.context) { task.context.builtRevision = task.context.revision; task.context.baseline = false; }
        task.status = 'completed'; task.completedAt = now(); task.completedRevision = task.inputRevision;
        event(task, 'completed', review ? task.checkpoints.find(c => c.stepId === 'preparation').summary : report.summary);
      } else task.status = 'queued';
    }
    state.tasks[task.id] = task;
    if (task.status === 'completed') learnFromResult(task, task.attempts.find(a => a.id === task.checkpoints.find(c => c.stepId === 'preparation')?.attemptId) || attempt);
    save(); return true;
  }
  // 重启只恢复中断的执行；明确 blocked/paused/waiting 不会被重启偷偷重新启动。
  try {
    consumeCommands(); reconcileContexts(); reconcileExperiences(); // 停机期间的取消和纠正，先于旧检查点生效。
    for (const task of Object.values(state.tasks)) {
      for (const attempt of task.attempts.filter(a => a.status === 'running')) {
        stopOrphan(attempt.worker);
        try {
          if (!acceptReport(task, attempt)) {
            attempt.status = 'interrupted'; attempt.endedAt = now();
            if (task.status === 'running') task.status = 'queued';
          }
        } catch (error) { attempt.status = 'failed'; attempt.endedAt = now(); block(task, error); }
      }
    }
    save(); sync();
  } catch (error) { fs.unlinkSync(lockPath); throw error; }
  function settle() {
    if (!active?.result) return;
    const { taskId, attemptId, result } = active;
    const task = state.tasks[taskId];
    const attempt = task.attempts.find(a => a.id === attemptId);
    active = null;
    attempt.sessionId = result.sessionId || null;
    if (attempt.contextInvalidated || attempt.inputRevision !== task.inputRevision || ['cancelled', 'paused', 'blocked'].includes(task.status)) {
      attempt.status = 'superseded'; attempt.endedAt = now(); save(); return;
    }
    try {
      if (contextChanged(attempt)) {
        attempt.status = 'superseded'; attempt.endedAt = now(); task.status = 'queued';
        task.lastWake = { type: 'memory_correction', at: now() }; save(); return;
      }
      if (!acceptReport(task, attempt)) {
        attempt.status = 'failed'; attempt.endedAt = now();
        block(task, taskError(result.timedOut ? 'TASK_TIMEOUT' : 'CHECKPOINT_MISSING', '这一步没有留下可验收的检查点；成果保留，可补充要求或恢复任务。'));
      }
    } catch (error) { attempt.status = 'failed'; attempt.endedAt = now(); block(task, error); }
    save();
  }
  function launch(task) {
    let contextRevision;
    try { verifyCheckpointArtifacts(task); verifyUserEdit(task); contextRevision = options.contextRevision?.() || null; } catch (error) { block(task, error); save(); return; }
    if (options.experienceEnabled && task.routine?.name === 'job-preparation' && task.experienceInputRevision !== task.inputRevision) {
      const selected = selectExperiences(state, task);
      task.experienceChanges = (task.experienceRefs || []).map(ref => ({ prior: ref, current: experienceView(state, ref.id) }))
        .filter(({ current }) => !current || !['active', 'candidate'].includes(current.status))
        .map(({ prior, current }) => ({ id: prior.id, title: prior.title, status: current?.status || 'unavailable', reason: current?.reason || '原方法已不可用' }));
      task.experienceRefs = selected; task.experienceInputRevision = task.inputRevision;
    }
    if (options.experienceEnabled && task.routine?.name === 'job-preparation' && !task.steps.some(s => s.id === 'experience-review')) task.steps.push(clone(reviewStep));
    const step = task.steps[task.stepIndex];
    const id = randomUUID();
    const directory = path.join(paths.artifactRoot, task.id, '执行记录', step.id, id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const attempt = { id, stepIndex: task.stepIndex, inputRevision: task.inputRevision, directory, contextRevision, jobContextRevision: task.context?.revision,
      experienceRefs: (task.experienceRefs || []).map(ref => ({ id: ref.id, revision: ref.revision })),
      startedAt: now(), status: 'running', sessionId: null };
    task.attempts.push(attempt); task.status = 'running'; task.updatedAt = now(); save();
    try {
      const handle = options.runStep({ task: clone(task), step: clone(step), attempt: clone(attempt), paths,
        onSession: sessionId => { if (!stopping) { attempt.sessionId = sessionId; save(); } },
      });
      active = { taskId: task.id, attemptId: id, handle, result: null };
      if (handle.pid) { attempt.worker = { pid: handle.pid, identity: processIdentity(handle.pid) }; save(); }
      handle.done.then(result => { if (active?.attemptId === id) active.result = result; }, error => {
        if (active?.attemptId === id) active.result = { isError: true, errorText: error.message };
      });
      log({ event: 'task_step_started', taskId: task.id, stepId: step.id, attemptId: id });
    } catch (error) { attempt.status = 'failed'; attempt.endedAt = now(); block(task, error); save(); }
  }
  function notify() {
    if (!options.emitNotification) return;
    for (const task of Object.values(state.tasks)) for (const e of Object.values(task.events)) {
      if (!e.withdrawRequestedAt && !terminalDelivery.has(e.delivery.status) && e.delivery.status !== 'pending'
        && options.hasNotification && !options.hasNotification(e.id)) {
        e.delivery.status = e.delivery.requestPending || e.delivery.lastError === 'network' ? 'unknown' : 'pending';
        e.delivery.updatedAt = now(); save();
      }
      if (e.withdrawRequestedAt || e.delivery.status !== 'pending' || notifying.has(e.id)) continue;
      notifying.add(e.id);
      Promise.resolve().then(() => e.withdrawRequestedAt ? null : options.emitNotification(clone(e))).then(result => {
        if (result && e.delivery.status === 'pending') markDelivery(e.id, result.status || 'queued');
      }).catch(error => log({ event: 'task_notification_error', taskId: task.id, code: error.code || 'emit_failed' }))
        .finally(() => { notifying.delete(e.id); if (!stopping) withdrawEvents(); });
    }
  }
  function tick() {
    if (stopping) return;
    sync(); settle();
    if (active) {
      const attempt = state.tasks[active.taskId].attempts.find(a => a.id === active.attemptId);
      try { if (contextChanged(attempt)) active.handle.cancel(); } catch { active.handle.cancel(); }
    }
    for (const task of Object.values(state.tasks)) if (task.status === 'waiting' && task.waitingFor?.type === 'time' && Date.parse(task.waitingFor.at) <= Date.parse(now())) {
      task.status = 'queued'; task.lastWake = { type: 'time', at: now(), scheduledFor: task.waitingFor.at }; delete task.waitingFor; save();
    }
    notify();
    if (active || options.canStart?.() === false) return;
    const task = Object.values(state.tasks).filter(t => t.status === 'queued').sort(opportunityOrder)[0];
    if (task) launch(task);
  }
  function markDelivery(id, status, details = {}) {
    const e = eventFor(id);
    if (!e) return false;
    if (status === 'delivered') status = details.messageId ? 'wechat_accepted' : 'unknown';
    if (status === 'suspect-dropped') status = 'unknown';
    const fullyWithdrawn = status === 'withdrawn' && Array.isArray(details.parts) && details.parts.length > 0
      && !details.requestPending && details.parts.every(part => part.status === 'withdrawn' && !part.requestPending);
    if (e.withdrawRequestedAt && !['wechat_accepted', 'partially_accepted', 'unknown'].includes(status) && !fullyWithdrawn) return false;
    if (e.delivery.status === 'wechat_accepted' && status !== 'wechat_accepted') return false;
    if (e.delivery.status === 'partially_accepted' && !['partially_accepted', 'wechat_accepted'].includes(status)) return false;
    e.delivery = { ...e.delivery, ...details, status, updatedAt: now() }; save(); return true;
  }
  function start() {
    if (timer) return;
    tick(); timer = setInterval(() => { try { tick(); } catch (error) { log({ event: 'task_tick_error', code: error.code || 'runtime_error' }); } }, options.intervalMs || 1000);
    timer.unref();
  }
  async function stop() {
    if (stopping) return;
    stopping = true; clearInterval(timer); timer = null;
    if (active) {
      active.handle.cancel();
      await Promise.race([active.handle.done, new Promise(resolve => { const t = setTimeout(resolve, 5000); t.unref(); })]);
      // running 检查点留给下次启动核对；不能将服务退出当成用户取消。
    }
    save();
    if (readTaskJson(lockPath, null)?.token === owner.token) fs.unlinkSync(lockPath);
  }
  return { start, stop, tick, sync, markDelivery, snapshot: () => clone(state), event: id => clone(eventFor(id) || null) };
}
