import { createHash } from 'node:crypto';
import { currentTaskView } from './task-context.mjs';

export function jobRelevant(text, tasks) {
  const query = text.toLowerCase();
  return /求职|招聘|岗位|面试|简历|\bjd\b/i.test(text) || tasks.filter(t => t.routine?.name === 'job-preparation' || t.routine?.company).some(t =>
    [t.id, t.routine?.company, t.title].filter(Boolean).some(name => query.includes(name.toLowerCase())));
}

export function buildChatPrompt({ prompts, memory, issue = '', recalled = '', snapshot = { tasks: {} }, experienceText = '', now = Date.now(), sessionId, previousTaskRevision }) {
  const stamp = p => {
    const d = new Date(p.at + 8 * 3600e3).toISOString();
    const late = now - p.at > 3 * 60e3 ? `，${Math.max(1, Math.round((now - p.at) / 60e3))} 分钟前发的` : '';
    return `[微信消息 · 北京时间 ${d.slice(5, 10)} ${d.slice(11, 16)}${late}]`;
  };
  const active = Object.values(snapshot.tasks || {}).filter(t => t.status !== 'cancelled');
  const tasks = [...active].sort((a, b) => Number(a.status === 'completed') - Number(b.status === 'completed') || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8)
    .map(t => ({ id: t.id, title: t.title, status: t.status, nextStep: t.steps[t.stepIndex]?.id, waitingFor: t.waitingFor, inputRevision: t.inputRevision,
      progress: Object.values(t.events).slice(-3).map(e => [e.id, e.kind, e.inputRevision, e.delivery.status]),
      ...(t.context ? { contextRevision: t.context.revision, freshness: currentTaskView(t, memory.records, now, snapshot).freshness.state } : {}) }));
  const taskRevision = createHash('sha256').update(JSON.stringify(tasks)).digest('hex');
  const changed = !sessionId || taskRevision !== previousTaskRevision;
  const taskLine = changed && (tasks.length || previousTaskRevision) ? `[任务状态] ${tasks.length ? tasks.map(t => `${t.id} ${t.title}（${t.status}；${t.waitingFor?.reason || t.nextStep || '步骤已完成'}）`).join('、') : '暂无有效任务'}。详情与现行成果用 $DAWN_WORKSPACE/tools/tasks.mjs list/show 查询。\n\n` : '';
  const relevant = jobRelevant(prompts.map(p => p.text).join(' '), active);
  const work = taskLine + (relevant ? `${experienceText}[求职流程] 按 $DAWN_WORKSPACE/.agents/skills/dawn-jobs/SKILL.md 处理现行资料、进展和成果反馈；细则在 $DAWN_WORKSPACE/routines/job-preparation.md。\n\n` : '');
  const onlyAttachments=!prompts.some(p=>(p.userText??p.text).trim());
  const messages = prompts.map(p => `${stamp(p)}\n${p.text}${p.busyAttachment?'\n这是你处理上一条时补发的附件。'+(onlyAttachments?((p.attachments||[]).some(a=>!a.path)?'说明收到了几个、哪几个没收到，请用户重发失败的附件。':'上一条已交代用途就照做，没有交代就只回一句收到，不解读、不描述。'):''):''}`).join('\n\n');
  const tail = recalled + work + messages;
  return { text: issue + (sessionId ? '' : memory.text) + tail, freshText: issue + memory.text + (sessionId && !changed ? `[任务状态] 用 $DAWN_WORKSPACE/tools/tasks.mjs list/show 核对当前任务。\n\n` : '') + tail, taskRevision };
}
