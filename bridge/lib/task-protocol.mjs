import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withAutomationControlLock } from './automation-control.mjs';
import { jobPreparation, validateJobRoutine } from './job-preparation.mjs';
import { validateSourceChange } from './task-context.mjs';
import { validateTracking, validateProgress } from './opportunities.mjs';
import { validateExperienceChange } from './task-experience.mjs';
import { validateTaskFeedback } from './task-feedback.mjs';

export function taskError(code, message) { return Object.assign(new Error(message), { code }); }
function withTaskSubmissionLock(file, fn) {
  const deadline = Date.now() + 1000;
  const delay = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { return withAutomationControlLock(file, fn); } catch (error) {
      if (error.code !== 'CONTROL_BUSY' || Date.now() >= deadline) throw error;
      Atomics.wait(delay, 0, 0, 10);
    }
  }
}
export function readTaskJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw taskError('TASK_STORE_INVALID', `任务文件无法读取：${file}`);
  }
}
export function writeTaskJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
export function taskPaths(options = {}, env = process.env) {
  const statePath = options.statePath || env.DAWN_TASKS_STATE;
  const controlPath = options.controlPath || env.DAWN_TASKS_CONTROL;
  const artifactRoot = options.artifactRoot || env.DAWN_TASKS_ARTIFACTS;
  if (![statePath, controlPath, artifactRoot].every(p => typeof p === 'string' && path.isAbsolute(p))) {
    throw taskError('MISSING_TASK_PATHS', '显式提供 DAWN_TASKS_STATE、DAWN_TASKS_CONTROL、DAWN_TASKS_ARTIFACTS 三个绝对路径');
  }
  if (statePath === controlPath) throw taskError('INVALID_TASK_PATHS', '状态与控制文件不能相同');
  return { statePath, controlPath, artifactRoot };
}
const text = (value, name, limit = 12000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw taskError('INVALID_TASK', `${name} 必须是非空文本，最多 ${limit} 字`);
  return value.trim();
};
export function taskId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value) || ['constructor', 'prototype'].includes(value)) throw taskError('INVALID_TASK_ID', '任务/步骤 ID 只使用小写英文、数字、横线或下划线，不能使用保留名');
  return value;
}
export function validateTask(value) {
  if (!value || typeof value !== 'object') throw taskError('INVALID_TASK', '需要任务 JSON');
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 8) throw taskError('INVALID_TASK', '任务需要 1–8 个有产物的步骤');
  const seen = new Set();
  const steps = value.steps.map(step => {
    const id = taskId(step.id);
    if (seen.has(id)) throw taskError('INVALID_TASK', '步骤 ID 重复');
    seen.add(id);
    if (!Array.isArray(step.outputs) || !step.outputs.length || step.outputs.length > 8) throw taskError('INVALID_TASK', '每步需要 1–8 个产物验收定义');
    const names = new Set();
    const outputs = step.outputs.map(output => {
      const name = text(output.name, '产物文件名', 120);
      if (['.', '..', 'checkpoint.json', 'checkpoint.tmp'].includes(name.toLowerCase()) || /[\\/\x00-\x1f]/.test(name) || names.has(name.toLowerCase())) throw taskError('INVALID_TASK', '产物必须使用不重复的单层文件名，不能占用检查点文件名');
      names.add(name.toLowerCase());
      const format = output.format || 'text';
      if (!['text', 'json', 'file'].includes(format)) throw taskError('INVALID_TASK', '产物 format 为 text/json/file');
      const minBytes = output.minBytes ?? 100;
      if (!Number.isInteger(minBytes) || minBytes < 1 || minBytes > 10_000_000) throw taskError('INVALID_TASK', 'minBytes 超出范围');
      const contains = output.contains || [];
      if (!Array.isArray(contains) || contains.length > 30 || contains.some(s => typeof s !== 'string' || !s || s.length > 500)) throw taskError('INVALID_TASK', 'contains 必须是最多 30 个必需文本');
      if (format === 'file' && contains.length) throw taskError('INVALID_TASK', '二进制产物不使用 contains');
      if (output.audience !== undefined && !['user', 'internal'].includes(output.audience)) throw taskError('INVALID_TASK', 'audience 为 user/internal');
      return { name, format, minBytes, contains, ...(output.audience === undefined ? {} : { audience: output.audience }) };
    });
    return { id, instruction: text(step.instruction, '步骤要求'), outputs };
  });
  const sources = value.sources || [];
  if (!Array.isArray(sources) || sources.length > 20 || sources.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw taskError('INVALID_TASK', 'sources 使用最多 20 个绝对文件路径');
  const routine = value.routine ? validateJobRoutine(value.routine) : null;
  if (routine) {
    const expected = [...new Set(routine.materials.map(m => m.path))].sort();
    if (JSON.stringify([...sources].sort()) !== JSON.stringify(expected)
      || ![2, 3].includes(steps.length) || (steps.length === 3 && steps[2].id !== 'experience-review') || steps[0].id !== 'evidence' || steps[1].id !== 'preparation'
      || !steps[1].outputs.some(o => o.name === '核验.json' && o.format === 'json')
      || !steps[1].outputs.some(o => o.name === '求职准备.md' && o.format === 'text')) throw taskError('INVALID_TASK', '求职流程须保留来源、两步结构及正文/核验产物；补充内容使用 input');
  }
  return {
    id: taskId(value.id), title: text(value.title, '任务名', 100), objective: text(value.objective, '目标'),
    scope: text(value.scope, '已授权范围'), origin: text(value.origin, '委托来源', 2000),
    profile: 'local_artifact', sources, steps, notify: value.notify !== false,
    ...(routine ? { routine } : {}),
  };
}
export function submitTaskCommand(command, options = {}) {
  const paths = taskPaths(options);
  // 旧 input 口令也接入同一机会记录，避免绕过来源、时序和进展去重。
  // 先读尚未消费的登记，再读状态，覆盖停机期间 track → input 的顺序。
  const trackedInput = command.action === 'input' && (readTaskJson(paths.controlPath, { requests: [] }).requests
    .some(r => r.action === 'track' && r.taskId === command.taskId) || readTasks(paths).tasks[command.taskId]?.opportunity);
  if (trackedInput) {
    const messages = options.userMessages ?? JSON.parse(process.env.DAWN_MEMORY_USER_MESSAGES || '[]');
    if (messages.length !== 1) throw taskError('OPPORTUNITY_SOURCE', '多条消息补充机会时使用 progress 并明确 sourceId');
    command = { ...command, action: 'progress', progress: { sourceId: messages[0].id, summary: command.text,
      changes: { preparation: command.text } } };
    options = { ...options, userMessages: messages };
  }
  if (!['create', 'prepare', 'track', 'progress', 'source', 'experience', 'feedback', 'notify', 'input', 'plan', 'pause', 'resume', 'cancel', 'wake'].includes(command.action)) throw taskError('INVALID_TASK_COMMAND', '未知任务命令');
  const experience = command.action === 'experience' ? validateExperienceChange(command.experience, options) : null;
  const feedback = command.action === 'feedback' ? validateTaskFeedback(command.feedback, options) : null;
  const source = command.action === 'source' ? validateSourceChange(command.source, options) : null;
  const tracking = command.action === 'track' ? validateTracking(command.tracking) : null;
  const progress = command.action === 'progress' ? validateProgress(command.progress, options) : null;
  const payload = ['prepare', 'track'].includes(command.action) ? validateTask(jobPreparation(command.preparation || command.tracking.preparation)) : command.action === 'create' ? validateTask(command.task) : null;
  const task = payload?.id || experience?.id || taskId(command.taskId);
  const input = ['input', 'plan'].includes(command.action) ? text(command.text, '补充要求') : undefined;
  if (command.action === 'plan' && (!Array.isArray(command.steps) || !command.steps.length || command.steps.length > 8)) throw taskError('INVALID_TASK', 'plan 需要 1–8 个剩余步骤');
  const key = command.action === 'wake' ? text(command.key, '唤醒事件', 100) : undefined;
  const eventId = command.action === 'notify' ? taskId(command.eventId) : undefined;
  const requestId = command.requestId ? taskId(command.requestId) : randomUUID();
  return withTaskSubmissionLock(paths.controlPath, () => {
    const control = readTaskJson(paths.controlPath, { version: 1, requests: [] });
    if (control.version !== 1 || !Array.isArray(control.requests)) throw taskError('TASK_CONTROL_INVALID', '任务控制文件无效');
    const existing = control.requests.find(r => r.requestId === requestId);
    if (existing) return existing;
    const request = { requestId, action: command.action, taskId: task, ...(payload ? { task: payload } : {}),
      ...(input ? { text: input } : {}), ...(key ? { key } : {}), ...(eventId ? { eventId } : {}), requestedAt: new Date().toISOString() };
    if (source) request.source = source;
    if (experience) request.experience = experience;
    if (feedback) request.feedback = feedback;
    if (tracking) request.tracking = tracking;
    if (progress) request.progress = progress;
    if (command.action === 'plan') request.steps = command.steps;
    control.requests.push(request);
    writeTaskJson(paths.controlPath, control);
    return request;
  });
}
export function readTasks(options = {}) {
  const { statePath } = taskPaths(options);
  const state = readTaskJson(statePath, { version: 1, tasks: {}, receipts: {} });
  if (state.version !== 1 || !state.tasks || !state.receipts) throw taskError('TASK_STORE_INVALID', '任务状态格式无效');
  return state;
}
