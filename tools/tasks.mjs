#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readTasks, submitTaskCommand, taskPaths, taskError } from '../bridge/lib/task-protocol.mjs';
import { currentTaskView } from '../bridge/lib/task-context.mjs';
import { memoryPaths, readMemory } from '../bridge/lib/memory.mjs';
import { experienceView } from '../bridge/lib/task-experience.mjs';
import { feedbackEntries } from '../bridge/lib/task-feedback.mjs';
import { userArtifacts } from '../bridge/lib/task-delivery.mjs';
import { opportunityDecision } from '../bridge/lib/opportunities.mjs';
export { readTasks, submitTaskCommand };

async function main(args) {
  const paths = taskPaths();
  const [action, id, ...rest] = args;
  const state = readTasks(paths);
  const jsonArg = value => JSON.parse(value === '-' ? fs.readFileSync(0, 'utf8') : value?.startsWith('@') ? fs.readFileSync(value.slice(1), 'utf8') : value || '{}');
  if (action === 'decision') {
    const task = state.tasks[id];
    if (!task) throw taskError('TASK_NOT_FOUND', '任务尚未登记或 ID 不存在');
    const memory = readMemory();
    return opportunityDecision(task,{...memoryPaths(),indexPath:process.env.DAWN_CONVERSATIONS_INDEX,records:memory.records,factsRevision:memory.revision},
      rest.length ? jsonArg(rest[0]) : undefined);
  }
  const view = task => {
    const current = currentTaskView(task, task.context ? readMemory().records : [], Date.now(), state);
    current.resultArtifacts = userArtifacts(current);
    if (current.baselineArtifacts) current.baselineArtifacts = current.resultArtifacts;
    return current;
  };
  if (action === 'feedbacks') {
    if (!state.tasks[id]) throw taskError('TASK_NOT_FOUND', '任务尚未登记或 ID 不存在');
    return feedbackEntries(state.tasks[id], { history: rest.includes('--history') });
  }
  if (action === 'experiences') {
    if (id) {
      const entry = experienceView(state, id, { history: rest.includes('--history') });
      if (!entry) throw taskError('EXPERIENCE_NOT_FOUND', '经验尚未登记');
      return entry;
    }
    return Object.keys(state.experiences || {}).map(key => experienceView(state, key));
  }
  if (action === 'list') return Object.values(state.tasks).map(view).map(task => ({
    id: task.id, title: task.title, status: task.status, inputRevision: task.inputRevision,
    nextStep: task.steps[task.stepIndex]?.id || null, waitingFor: task.waitingFor || null,
    freshness: task.freshness,
    experienceRefs: task.experienceRefs, feedbackSummary: task.feedbackSummary,
    artifacts: task.resultArtifacts || [], blocker: task.blocker || null,
    routine: task.routine || null, opportunity: task.opportunity ? { current: task.opportunity.current, asOf: task.opportunity.asOf, revision: task.opportunity.revision } : null,
    progress: Object.values(task.events).map(e => ({ eventId: e.id, kind: e.kind, inputRevision: e.inputRevision, delivery: e.delivery.status })),
  }));
  if (action === 'show') {
    const task = state.tasks[id];
    if (!task) throw taskError('TASK_NOT_FOUND', '任务尚未登记或 ID 不存在');
    return rest.includes('--history') ? { historical: true, current: view(task), history: task } : view(task);
  }
  let command;
  if (action === 'experience') {
    command = { action, experience: jsonArg(id) };
  } else if (action === 'feedback') {
    command = { action, taskId: id, feedback: jsonArg(rest[0]) };
  } else if (action === 'create') {
    command = { action, task: jsonArg(id) };
  } else if (action === 'prepare') {
    command = { action, preparation: jsonArg(id) };
  } else if (action === 'track') {
    command = { action, tracking: jsonArg(id) };
  } else if (action === 'source') {
    command = { action, taskId: id, source: jsonArg(rest[0]) };
  } else if (action === 'progress') {
    command = { action, taskId: id, progress: jsonArg(rest[0]) };
  } else if (action === 'notify') {
    command = { action, taskId: id, eventId: rest[0] };
  } else if (action === 'plan') {
    const change = jsonArg(rest[0]);
    command = { action, taskId: id, text: change.text, steps: change.steps };
  } else command = { action, taskId: id, ...(action === 'input' ? { text: rest.join(' ') } : {}), ...(action === 'wake' ? { key: rest.join(' ') } : {}) };
  if (process.env.DAWN_TASK_ORIGIN) command.requestId = `req_${createHash('sha256').update(`${process.env.DAWN_TASK_ORIGIN}\n${JSON.stringify(command)}`).digest('hex')}`;
  const request = submitTaskCommand(command, paths);
  // 桥在线时回传实际接收结果；离线时只报告已登记，不冒充已执行。
  for (let i = 0; i < 25; i++) {
    const receipt = readTasks(paths).receipts[request.requestId];
    if (receipt) return { requestId: request.requestId, ...receipt };
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return { requestId: request.requestId, taskId: request.taskId, status: 'registered', note: '请求已登记，等待 Dawn 运行器处理' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result, null, 2)); if (result.status === 'rejected') process.exitCode = 1; }).catch(error => {
    console.error(JSON.stringify({ error: error.code || 'TASK_COMMAND_FAILED', message: error.message }));
    process.exitCode = 1;
  });
}
