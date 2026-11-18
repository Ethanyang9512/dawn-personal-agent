import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mediaFingerprint } from './conversation-memory.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
export function prepareProactiveItems(meta, items, workspace) {
  const parts = items.map((item, i) => {
    const part = {...item,partId:`part:${i}`};
    if (item.kind !== 'file' || !fs.existsSync(item.path)) return part;
    const bytes = fs.readFileSync(item.path); part.artifactHash=hash(bytes);
    if (meta.type === 'digest') {
      const directory=path.join(workspace,'发出/digest/.delivery',meta.id);fs.mkdirSync(directory,{recursive:true});
      const snapshot=path.join(directory,`part-${i}-${part.artifactHash}${path.extname(item.path)}`);
      if (!fs.existsSync(snapshot) || hash(fs.readFileSync(snapshot))!==part.artifactHash) {
        const temp=`${snapshot}.${process.pid}.tmp`, fd=fs.openSync(temp,'w',0o600);
        try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
        fs.renameSync(temp,snapshot);
      }
      part.path=snapshot;
    }
    return part;
  });
  let titles = [];
  if (meta.type === 'digest') {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(workspace, '发出/digest', meta.id, 'render-data.json'), 'utf8'));
      titles = ['ai','world','tech'].flatMap(section => (data.items || []).filter(it => it.section === section).map(it => it.title));
    } catch { /* 没有正文时不凭过期历史猜标题。 */ }
    let image = 0;
    for (const item of parts) item.partId = item.kind === 'file' && /\.(png|jpe?g)$/i.test(item.path) ? `image:${++image}` : 'intro';
    parts.sort((a,b) => Number(a.partId === 'intro') - Number(b.partId === 'intro'));
  }
  const groupId = `${meta.type}:${meta.id}:${hash(JSON.stringify([meta.key || meta.id,parts.map(it => [it.partId,it.text,it.artifactHash])])).slice(0,16)}`;
  const expectedParts = meta.type === 'digest' ? ['image:1','image:2', ...(parts.some(it => it.partId === 'intro') ? ['intro'] : [])] : parts.map(it => it.partId);
  return parts.map(item => ({ ...item, proactive: { ...meta, groupId, expectedParts, titles } }));
}
export function proactiveRecord(item) {
  const m = item.proactive, accepted = item.acceptedReceipt;
  if (!m || !accepted) return null;
  const title = { digest: `${m.id}日报`, review: '周复盘', reminder: '提醒', followup: '到期跟进', automation: '提醒/监测通知', task: '任务通知' }[m.type] || '主动通知';
  const flatten = item => item.events ? item.events.flatMap(flatten) : [item];
  const origins = flatten(m).map(e => ({type:e.type, taskId:e.taskId || e.id, eventId:e.eventId || null, text:e.text || ''}));
  const context = m.type === 'digest' ? `\n条目顺序：\n${(m.titles || []).map((t,i) => `${i+1}. ${t}`).join('\n')}` : '';
  return { role: 'proactive', sourceId: item.clientId, at: accepted.at,
    text: `${title}（微信已受理${item.proactiveDegraded ? '失败说明' : item.partId?.startsWith('image:') ? '第'+item.partId.slice(6)+'张图' : item.kind === 'file' ? '附件' : '正文'}；来源ID：${origins.map(e=>e.taskId).filter(Boolean).join('、') || m.groupId}）\n${item.kind === 'text' ? item.text : m.text || path.basename(item.path)}${context}`,
    source: { kind: 'proactive', type: m.type, groupId: m.groupId || m.key || m.id, partId: item.partId || item.taskPartIndex || 'body',
      messageId: accepted.messageId, fingerprint: mediaFingerprint(item.wx), artifactHash: item.artifactHash || item.taskArtifactSha256 || null, taskId: m.taskId || m.id || null, origins } };
}
export function updateProactiveReceipt(receipts, item) {
  const m = item.proactive, at = item.acceptedReceipt.at, key = `${m.type}:${m.id || m.groupId}`;
  const entry = receipts[key] ||= { type:m.type, id:m.id || m.groupId, acceptedCount:0, clientIds:[], firstAcceptedAt:at };
  entry.parts ||= [];
  if (!entry.clientIds.includes(item.clientId)) {
    entry.clientIds.push(item.clientId); entry.acceptedCount++; entry.lastAcceptedAt = at;
    entry.parts.push({ groupId:m.groupId || m.key || m.id, partId:item.partId || item.taskPartIndex || 'body', kind:item.kind,
      artifactHash:item.artifactHash || null, clientId:item.clientId, messageId:item.acceptedReceipt.messageId, acceptedAt:at, degraded:!!item.proactiveDegraded });
  }
  const groupId = m.groupId || m.key || m.id, parts = entry.parts.filter(p => p.groupId === groupId);
  const complete = part => parts.some(p => p.partId === part && !p.degraded);
  entry.current = { groupId, artifactHashes:parts.filter(p=>p.kind==='file'&&!p.degraded).map(p=>p.artifactHash).filter(Boolean), expectedParts:m.expectedParts || [], acceptedParts:parts.map(p => p.partId),
    imagesAccepted:m.type === 'digest' ? ['image:1','image:2'].every(complete) : undefined,
    complete:(m.expectedParts || (m.type === 'digest' ? ['image:1','image:2'] : ['body'])).every(complete), degraded:parts.some(p => p.degraded) };
  return entry;
}
