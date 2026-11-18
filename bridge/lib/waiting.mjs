import { createHash } from 'node:crypto';
const day = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
export function nextWeekReview(now = Date.now()) {
  const weekday = new Date(now + 8 * 3600e3).getUTCDay() || 7;
  return day(now + (15 - weekday) * 86400e3);
}
export function waitingItems(text) {
  const items = [];
  for (const line of text.split('\n').filter(line => line.includes('[等待:'))) {
    const m = line.match(/^- \[等待:([a-z0-9][a-z0-9-]{0,59})\] 等谁：([^；\n]{1,80})；等什么：([^；\n]{1,300})；复查：(\d{4}-\d{2}-\d{2})（Dawn安排）$/);
    if (!m || !Number.isFinite(Date.parse(m[4])) || new Date(m[4]).toISOString().slice(0,10) !== m[4] || items.some(it => it.id === m[1])) throw Object.assign(new Error('等待项需唯一稳定ID、等谁、等什么和有效复查日期（Dawn安排）'),{code:'INVALID_WAITING'});
    items.push({id:m[1],who:m[2].trim(),what:m[3].trim(),reviewOn:m[4]});
  }
  return items;
}
export function syncWaitingReminders(text, previous) {
  const waiting = waitingItems(text);
  if (!Array.isArray(previous)) throw new Error('reminders.json 需要数组');
  return [...previous.filter(r => !r.waitingKey), ...waiting.map(it => {
    const id = `waiting-${it.id}`, waitingKey = createHash('sha256').update(JSON.stringify([it.id,it.reviewOn])).digest('hex');
    const old = previous.find(r => r.id === id && r.waitingKey === waitingKey);
    return {...(old || {id,waitingKey,type:'followup',at:`${it.reviewOn}T09:00:00+08:00`}),text:`${it.who}：${it.what}。今天是 Dawn 安排的复查日，有进展再接着更新。`};
  })];
}
export function waitingReminderCurrent(meta, reminders) {
  return !meta.waitingKey || reminders.some(r => r.id === meta.id && r.waitingKey === meta.waitingKey && r.at === meta.at);
}
export function syncWaitingEdits(text, read, edits) {
  const previous = read('reminders.json'), next = syncWaitingReminders(text, previous ? JSON.parse(previous) : []);
  if (previous || next.length) edits.set('reminders.json',JSON.stringify(next,null,2)+'\n');
}
