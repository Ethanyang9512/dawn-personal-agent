#!/usr/bin/env node
// Dawn 微信桥：微信 ClawBot（iLink Bot API）⇄ 本机 Codex exec
// 设计依据见 README.md。要点：只认扫码本人；按 message_id 去重；
// 每条入站最多回约 10 条；只能在用户发消息后回复；-14 要重新扫码；收消息和跑 Codex 互不阻塞。
import { codexHome, dataHome, workspaceHome } from './lib/locations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { writeDurableJson } from './lib/durable-json.mjs';
import { runDurableChat, answerChatApproval } from './lib/durable-chat.mjs';
import { saveWithRetry, cleanChatRuns } from './lib/runtime-maintenance.mjs';
import { ILink, STALE_TOKEN, newRunId, newClientId } from './lib/ilink.mjs';
import { backendOptions } from './lib/backend.mjs';
import { buildChatPrompt } from './lib/chat-prompt.mjs';
import { imageInputs, imageNotes } from './lib/inbound-attachments.mjs';
import { prepareProactiveItems, proactiveRecord, updateProactiveReceipt } from './lib/proactive-delivery.mjs';
import { createTaskRuntime } from './lib/tasks.mjs';
import { createTaskRunner } from './lib/task-runner.mjs';
import { submitTaskCommand } from './lib/task-protocol.mjs';
import { currentTaskView } from './lib/task-context.mjs';
import { userArtifacts } from './lib/task-delivery.mjs';
import { reduceTaskDelivery } from './lib/task-delivery-receipt.mjs';
import { selectExperiences, experienceView } from './lib/task-experience.mjs';
import { memoryContext } from './lib/memory.mjs';
import { mutateMemory } from './lib/memory.mjs';
import { waitingReminderCurrent } from './lib/waiting.mjs';
import { maintainMemory, maintenanceStatus } from './lib/memory-maintenance.mjs';
import { captureConversation, conversationContext, rebuildConversations, resolveProactiveReference } from './lib/conversation-memory.mjs';
import { startConversationCuration } from './lib/conversation-curation.mjs';
import { importConversationLogs } from './lib/conversation-import.mjs';
import { maintainNotebook } from './lib/dawn-notebook.mjs';
import { formatForWeixin, chunkText, publicNarration as clipNarration } from './lib/textfmt.mjs';
import { readJson, writeJson, acquireLock, releaseLock } from './lib/store.mjs';
import { createAlerter } from './lib/alert.mjs';
import { buildSelfStatus, writeSelfStatus } from './lib/self-status.mjs';
import { createAutomationRuntime } from './lib/automations.mjs';
import {
  createAutomationAdapters,
  deliveryEventIds,
  groupAutomationItems,
  recoverAutomationOutgoing,
  withdrawAutomationEvents,
} from './lib/automation-bridge.mjs';

const HOME = dataHome();
const P = {
  config: path.join(HOME, 'config.json'),
  account: path.join(HOME, 'state', 'account.json'),
  state: path.join(HOME, 'state', 'bridge-state.json'),
  lock: path.join(HOME, 'state', 'bridge.lock'),
  health: path.join(HOME, 'state', 'health.json'),
  log: path.join(HOME, 'logs', 'bridge.log'),
};

const DEFAULTS = {
  workspace: workspaceHome(),
  backend: 'codex',
  codexBin: 'codex',
  codexHome: codexHome(),
  memoryInject: true, // 新会话注入 now/profile；记忆变化沿用既有换会话机制
  memoryMaintenance: true, // 每个北京时间日首次空闲整理明确登记的完成项
  conversationMemory: true,
  conversationCuration: true,
  obsidianVault: null,
  sessionMaxTurns: 32,
  model: null,
  effort: 'high',
  proxy: null,
  replyLimitPerMessage: 9,
  chunkChars: 1800,
  mergeSeconds: 1,
  ackAfterSeconds: 45,
  attachmentAckSeconds: 60,
  inlineImageMaxAgeMinutes: 10,
  progressEveryMinutes: 15,
  maxProgressMessages: 2,
  idleTimeoutMinutes: 30,
  maxRunMinutes: 180,
  sessionIdleResetHours: 12,
  typingMaxMinutes: 10,
  maxFileMB: 100,
  rateLimitCooldownSeconds: 150,
  networkRetrySeconds: 30,
  busyRetrySeconds: 180, // 服务繁忙且未执行工具时的自动重试等待
  pythonBin: 'python3',
  reminders: true, // 到点提醒：memory/reminders.json（Dawn 自己维护）
  quietStartHour: 23, quietEndHour: 8, // 夜间静默（北京时间），相等表示关闭；到点的事顺延到早上
  followupPerDay: 2, // 跟进类主动推送每日上限（用户指定的到点提醒和日报不占这个额度）
  proactivePerDay: 5, // 普通主动消息每日总预算；0 = 不主动发普通内容，亲自提醒和高优先级监测除外
  followupIdleDays: 3, // 用户超过 N 天没来消息，跟进类暂停；0 = 不按这个降频
  remindersIntervalSeconds: 30,
  proactiveWindowHours: 24, // 主动消息只在这个窗口内尝试发送；过了就顺延、降级或合并到下次对话
  alert: { mac: false, feishu: { enabled: false } },
  test: {},
};
const cfg = { ...DEFAULTS, ...readJson(P.config, {}) };

// ---------------- 日志 ----------------
fs.mkdirSync(path.dirname(P.log), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.dirname(P.state), { recursive: true, mode: 0o700 });
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    if (fs.existsSync(P.log) && fs.statSync(P.log).size > 5 * 1024 * 1024) fs.renameSync(P.log, P.log + '.1');
    fs.appendFileSync(P.log, line, { mode: 0o600 });
  } catch { /* 写日志失败不影响主流程 */ }
  if (process.env.DAWN_DEBUG) process.stdout.write(line);
}
const mask = (id) => (id ? `${String(id).slice(0, 6)}…` : '-');

// ---------------- 状态 ----------------
function loadState() {
  if (!fs.existsSync(P.state)) return {};
  try { return JSON.parse(fs.readFileSync(P.state, 'utf8')); } catch (e) {
    // 收件/执行去重账不能清空重建，否则历史消息可能再次执行。
    log(`状态文件解析失败（${e.message}），停止启动并保留原文件`);
    throw e;
  }
}
const state = loadState();
state.cursor ||= '';
state.seen ||= {};
state.users ||= {};
state.outbox ||= {};
state.jobs ||= {};
state.waiting ||= {};
state.inflight ||= {};
state.inbox ||= {};
state.deliveries ||= {};
const inboundContext = new AsyncLocalStorage();
state.remindersDone ||= {};
state.proactive ||= { date: '', count: 0 };
let lastPrune = 0;
const persistenceAlerts = {};
function save() {
  const now = Date.now();
  if (now - lastPrune > 3600e3) {
    lastPrune = now;
    for (const [k, t] of Object.entries(state.seen)) if (now - t > 72 * 3600e3) delete state.seen[k];
  }
  const result=saveWithRetry(P.state,state,{onFailure:error=>{
    health.persistenceError={at:Date.now(),code:error.code||error.name};
    try{writeJson(P.health,health);}catch{}
    createAlerter({cfg,state:persistenceAlerts,saveState:()=>{},log:text=>{try{log(text);}catch{console.error(text);}}})('state-write','Dawn 状态暂时无法写盘，收发已暂停，磁盘恢复后继续。',{minIntervalMs:10*60e3}).catch(()=>{});
  }});
  if(result.attempts>1){delete health.persistenceError;writeHealth(true);}
}
const health = { pid: process.pid, startedAt: Date.now(), backend: cfg.backend, model: cfg.model, effort: cfg.effort, mergeSeconds: cfg.mergeSeconds, ackAfterSeconds: cfg.ackAfterSeconds, configHash:createHash('sha256').update(JSON.stringify(cfg)).digest('hex') };
let lastHealthWrite = 0;
function writeHealth(force = false) {
  const now = Date.now();
  if (!force && now - lastHealthWrite < 60e3) return;
  lastHealthWrite = now;
  health.jobsRunning = Object.keys(jobs).length;
  health.inbox = Object.values(state.inbox).reduce((counts, entry) => {
    counts[entry.status] = (counts[entry.status] || 0) + 1; return counts;
  }, {});
  try { writeJson(P.health, health); } catch { /* ignore */ }
  refreshSelfStatus();
}

const alert = createAlerter({ cfg, state, saveState: save, log });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bj = (t, withDate = true) => {
  const d = new Date(t + 8 * 3600e3).toISOString();
  return withDate ? `${d.slice(5, 10)} ${d.slice(11, 16)}` : d.slice(11, 16);
};
const mins = (since) => Math.max(1, Math.round((Date.now() - since) / 60e3));
let lastJobResult = null;

function waitReasonFor(type, id) {
  if (!owner) return 'unknown';
  const user = state.users[owner] || {};
  const items = [...(state.outbox[owner] || []), ...(user.staleProactive || [])]
    .filter((item) => item.proactive?.type === type && item.proactive?.id === id);
  if (!items.length) return 'unknown';
  const now = Date.now();
  if (user.cooldownUntil && user.cooldownUntil > now) return 'cooldown';
  if (items.some((item) => item.netFails || item.freshFails || item.attempts || (item.notBefore && item.notBefore > now))) return 'retry';
  if (items.some((item) => item.deferredQuiet || (isQuietNow(now) && followsQuiet(item)))) return 'quiet';
  if (items.some((item) => user.staleProactive?.includes(item) || (type === 'digest' && now > Date.parse(`${id}T23:00:00+08:00`)))) return 'window';
  if ((user.sent || 0) >= cfg.replyLimitPerMessage || items.some((item) => usesProactiveDailyBudget(item) && proactiveDailyLeft() < 1)) return 'budget';
  if (jobs[owner] || pendingStart[owner]) return 'busy';
  return 'unknown';
}

function refreshSelfStatus() {
  try {
    const history = readJson(path.join(HOME, 'digest', 'state', 'history.json'), {});
    const day = history.days?.at(-1) || {};
    const receipt = (type, id) => state.proactiveReceipts?.[`${type}:${id}`] || { acceptedCount: 0, lastAcceptedAt: null };
    const reviewDir = path.join(cfg.workspace, '发出', 'review');
    const reviewFile = fs.existsSync(reviewDir) ? fs.readdirSync(reviewDir).filter((name) => /^weekly-.*\.md$/.test(name)).sort().at(-1) : null;
    const reviewId = reviewFile ? reviewFile.slice(0, -3).replace(/^weekly-/, 'weekly-review-') : null;
    const outbox = (type, id) => state.proactiveOutbox?.[`${type}:${id}`] || {};
    const snapshot = buildSelfStatus({
      health,
      currentJob: owner ? jobs[owner] : null,
      lastJob: lastJobResult,
      digest: {
        date: day.date || null,
        generatedAt: day.generatedAt || null,
        outboxedAt: day.outboxedAt || null,
        artifacts: day.date ? ['page1.png', 'page2.png'].map((name) => path.join(cfg.workspace, '发出', 'digest', day.date, name)) : [],
        waitReason: day.date ? waitReasonFor('digest', day.date) : 'unknown',
      },
      review: {
        date: reviewId,
        generatedAt: reviewFile ? fs.statSync(path.join(reviewDir, reviewFile)).mtime.toISOString() : null,
        outboxedAt: outbox('review', reviewId).lastOutboxedAt || null,
        artifacts: reviewFile ? [path.join(reviewDir, reviewFile)] : [],
        waitReason: reviewId ? waitReasonFor('review', reviewId) : 'unknown',
      },
      delivery: {
        digest: day.date ? receipt('digest', day.date) : undefined,
        review: reviewId ? receipt('review', reviewId) : undefined,
      },
      artifactRoot: path.join(cfg.workspace, '发出'),
    });
    const file = cfg.selfStatusPath || path.join(cfg.workspace, 'state', 'self-status.json');
    const result = writeSelfStatus(file, snapshot);
    if (!result.ok) log('self status write failed: write_failed');
  } catch (error) {
    log(`self status refresh failed: ${error.code || 'refresh_failed'}`);
  }
}

// ---------------- 运行期变量 ----------------
let il = null;
let account = null;
let owner = null;
let stopping = false;
let pollTimeout = 35000;
let pollFails = 0;
let firstFailAt = 0;
let staleRetried = false;
let automationRuntime = null;
let taskRuntime = null;
let inboxReady = false;
const TASK_PATHS = {
  statePath: cfg.taskStatePath || path.join(cfg.workspace, 'state', 'tasks.json'),
  controlPath: cfg.taskControlPath || path.join(cfg.workspace, 'state', 'task-control.json'),
  artifactRoot: cfg.taskArtifactRoot || path.join(cfg.workspace, '发出', 'tasks'),
};
const MEMORY_PATHS = { memoryDir: path.join(cfg.workspace, 'memory'), journalPath: path.join(cfg.workspace, 'state', 'memory-transaction.json') };
const CONVERSATION_PATHS = { memoryDir: MEMORY_PATHS.memoryDir, indexPath: path.join(cfg.workspace, 'state', 'conversations.sqlite') };
let conversationDirty = true, conversationActivity = Date.now(), conversationImportAt = 0, conversationCuration = null, notebookFactsRevision = null;
const automationSends = new Set(); // 已交给微信的对象保持原样，等待真实回执。
const AUTOMATIONS_ENABLED = cfg.automations !== false && cfg.automations?.enabled !== false;
const AUTOMATION_PATHS = {
  config: cfg.automationConfigPath || path.join(cfg.workspace, 'memory', 'automations.json'),
  state: cfg.automationStatePath || path.join(cfg.workspace, 'state', 'automations.json'),
  control: cfg.automationControlPath || path.join(cfg.workspace, 'state', 'automation-control.json'),
};
const jobs = {}; // u -> 正在跑的任务
const queue = {}; // u -> 任务进行中又收到的消息 [{text, at}]
const pendingStart = {}; // u -> 合并几秒内连发的消息
const chains = {}; // u -> 串行处理入站
const flushing = {};
const flushTimers = {};

// 完整消息和解析后的附件路径一起保存，恢复时不重新解释已执行的消息。
function syncWaiting(u) {
  for (const prompt of [...(pendingStart[u]?.prompts || []), ...(queue[u] || [])]) {
    const entry = state.inbox[prompt.id];
    if (entry) Object.assign(entry, { prompt, status: 'queued' });
  }
  save();
}

function loadAccount() {
  const a = readJson(P.account, null);
  if (!a?.token) return false;
  if (il && a.token === account?.token && a.savedAt === account?.savedAt) return true;
  if (state.botId && state.botId !== a.botId) {
    // 重新扫码换了 bot 身份：旧游标、旧 context_token、旧上传参数都作废，等用户先发一条消息
    log('bot 身份变了，重置游标和会话凭据');
    state.cursor = '';
    for (const user of Object.values(state.users)) { delete user.ctx; delete user.cooldownUntil; user.sent = 0; user.rl = 0; }
    for (const q of Object.values(state.outbox)) for (const it of q) delete it.wx;
  }
  state.botId = a.botId;
  save();
  account = a;
  il = new ILink({ token: a.token, baseUrl: a.baseUrl, fixedBase: cfg.test?.fixedBase, cdnBase: cfg.test?.cdnBase });
  owner = a.userId ? a.userId.toLowerCase() : null;
  if (!owner) log('警告：账号里没有扫码人 ID，所有消息都会被丢弃');
  health.needLogin = false;
  health.needRelogin = false;
  staleRetried = false;
  if (state.alerts) delete state.alerts.relogin; // 下次再掉线要能再提醒
  log(`account loaded bot=${mask(a.botId)} owner=${mask(a.userId)}`);
  il.notify('start').then((r) => log(`notifystart ${JSON.stringify(r).slice(0, 120)}`));
  writeHealth(true);
  return true;
}

// ---------------- 收消息 ----------------
async function pollOnce() {
  let r;
  try {
    r = await il.getUpdates(state.cursor, pollTimeout + 10000);
  } catch (e) {
    return onPollFail(e.message);
  }
  if (stopping) return;
  // 服务器本该在约定时长内回包；客户端多等了 10 秒还没回，说明连接坏了
  if (r.timedOut) return onPollFail('长轮询超时，服务器没回包');
  const code = Number(r.errcode || r.ret || 0);
  if (code === STALE_TOKEN) return onStale('getupdates');
  if (code !== 0) return onPollFail(`ret=${r.ret} errcode=${r.errcode} ${r.errmsg || ''}`);
  const recovered = pollFails > 0 || firstFailAt > 0;
  pollFails = 0;
  firstFailAt = 0;
  staleRetried = false;
  health.lastPollOkAt = Date.now();
  if (recovered) for (const u of Object.keys(state.outbox)) { clearNetBackoff(u); flushOutbox(u); } // 网络恢复了，别等退避定时器
  health.lastError = null;
  writeHealth();
  if (r.longpolling_timeout_ms) pollTimeout = Math.min(Math.max(Number(r.longpolling_timeout_ms), 10000), 120000);
  for (const m of r.msgs || []) intake(m);
  // 每条完整消息已刷盘，才能提交本批游标。中途退出靠收件账去重并续办。
  if (r.get_updates_buf && r.get_updates_buf !== state.cursor) {
    state.cursor = r.get_updates_buf;
    save();
  }
}

async function onPollFail(msg) {
  pollFails += 1;
  firstFailAt ||= Date.now();
  health.lastError = msg;
  writeHealth(true);
  log(`poll fail #${pollFails}: ${msg}`);
  if (Date.now() - firstFailAt > 10 * 60e3) {
    alert('network', `Dawn 连不上微信服务器已超过 10 分钟（${msg.slice(0, 80)}）。请检查本机到微信的网络连接。`);
  }
  if (pollFails >= 3) { pollFails = 0; await sleep(30000); } else await sleep(2000);
}

async function onStale(where) {
  log(`-14 token 失效（${where}）`);
  if (!staleRetried) {
    staleRetried = true;
    await il.notify('start');
    await sleep(3000);
    return;
  }
  health.needRelogin = true;
  writeHealth(true);
  await alert('relogin', 'Dawn 微信掉线了，需要重新扫码。到电脑上跟 Codex 说「Dawn 重新扫码」。');
}

function msgKey(m) {
  if (m.message_id != null) return `${m.from_user_id}:${m.message_id}`;
  if (m.seq != null) return `${m.from_user_id}:seq${m.seq}`;
  return `${m.from_user_id}:h${createHash('sha1').update(JSON.stringify(m.item_list || []) + (m.create_time_ms || '')).digest('hex')}`;
}

function inboxKey(m) { return `${account.botId}:${msgKey(m)}`; }

function finishInbound(entry, status = 'done') {
  entry.status = status; entry.finishedAt = Date.now();
  if (status !== 'blocked') { delete entry.message; delete entry.prompt; delete entry.parsed; }
}

const waitingAttachments = u => Object.values(state.inbox).filter(e => e.u === u && e.status === 'waiting_attachment').sort((a,b)=>a.receivedAt-b.receivedAt);
async function inboundDrained(u) { let pending; do { pending=chains[u]; await pending?.catch(()=>{}); } while(pending!==chains[u]); }
const attachmentHold = u => Object.values(state.inbox).some(e => e.u === u && ((e.status === 'waiting_attachment' && !e.attachmentHoldReleased) || (e.wasWaitingAttachment && ['queued','running'].includes(e.status))
  || (e.status==='received' && !e.attachmentHoldReleased && e.message?.item_list?.some(i=>[2,4,5].includes(Number(i.type))) && !e.message.item_list.some(i=>(i.text_item?.text||i.voice_item?.text||'').trim()))));
function receiptCurrent(u, id) {
  const e=state.inbox[id];
  return e?.status === 'waiting_attachment' && Date.now()-e.receivedAt<=10*60000 && !Object.values(state.inbox).some(x=>x.u===u && x.receivedAt>e.receivedAt && ['received','queued','running'].includes(x.status));
}
function checkAttachments(flush = true) {
  if (stopping || !inboxReady) return;
  const now=Date.now(); let changed=false, released=false;
  for (const e of Object.values(state.inbox).filter(e=>e.u===owner && (e.status==='waiting_attachment'||(e.status==='received'&&e.message?.item_list?.some(i=>[2,4,5].includes(Number(i.type))))))) {
    if(!e.attachmentHoldReleased && now-e.receivedAt>=(cfg.attachmentAckSeconds+(e.status==='received'?60:0))*1000){e.attachmentHoldReleased=true;changed=released=true;}
    if(e.status==='waiting_attachment' && now-e.receivedAt>12*3600e3){finishInbound(e);e.attachmentExpired=true;changed=released=true;}
  }
  const pending=waitingAttachments(owner),first=pending[0];
  if(first && !pending.some(e=>e.attachmentAckAt) && now-first.receivedAt>=cfg.attachmentAckSeconds*1000 && receiptCurrent(owner,first.id) && !jobs[owner] && (first.attachmentAckAttempts||0)<3 && now-(first.attachmentAckAttemptAt||0)>=30000 && !(state.outbox[owner]||[]).some(x=>x.attachmentReceipt)){
    const failed=pending.flatMap(e=>e.parsed.attachments).filter(a=>!a.path).length;
    const text=(pending.every(e=>e.parsed.attachments.every(a=>a.type===2))?'图收到了，你说要做什么。':'附件收到了，你说要做什么。')+(failed?`其中 ${failed} 个附件没下载成功。`:'');
    enqueue(owner,[{kind:'text',text,attachmentReceipt:first.id,clientId:first.attachmentAckClientId||=newClientId()}],{ephemeral:true,front:true});changed=released=true;
  }
  if(changed)save();
  if(released && flush)flushOutbox(owner);
}

async function inboxTestGate(phase) {
  const gate = cfg.test?.inboxGate;
  if (gate?.phase !== phase || !/^http:\/\/127\.0\.0\.1:\d+$/.test(cfg.test?.fixedBase || '') || !process.env.DAWN_HOME) return;
  const marker = path.join(HOME, 'state', `test-inbox-${phase}.json`);
  writeDurableJson(marker, { phase, pid: process.pid });
  while (!stopping && !fs.existsSync(`${marker}.release`)) await sleep(50);
}

const scheduledInbound = new Set();
function scheduleInbound(entry) {
  if (scheduledInbound.has(entry.id)) return;
  scheduledInbound.add(entry.id);
  const u = entry.u;
  chains[u] = (chains[u] || Promise.resolve()).then(() => inboundContext.run(entry, async () => {
    await inboxTestGate('received');
    if (stopping) return;
    if (state.deliveries[`in:${entry.id}`]) { finishInbound(entry); save(); return; }
    await handle(u, entry.message);
    if (entry.status === 'received') { finishInbound(entry); save(); }
  })).catch(e => { entry.retryAfter = Date.now() + 30000; save(); log(`handle error: ${e.stack || e.message}`); })
    .finally(() => scheduledInbound.delete(entry.id));
}

function intake(m) {
  if (m.message_type != null && Number(m.message_type) !== 1) return; // 2 = bot 自己发的
  if (m.group_id) { log('skip group message'); return; }
  const raw = m.from_user_id;
  if (!raw) return;
  const u = raw.toLowerCase();
  const key = inboxKey(m);
  if (state.inbox[key] || state.seen[msgKey(m)]) { log(`dup ${mask(raw)} ${String(m.message_id || '').slice(-6)}`); return; }
  if (u !== owner) { log(`drop non-owner ${mask(raw)}`); save(); return; }
  const user = (state.users[u] ||= {});
  user.raw = raw;
  if (m.context_token) user.ctx = m.context_token;
  user.sent = 0; // 新入站 = 新的回复额度
  user.toldMore = false;
  user.windowSuspect = false;
  user.inAt = Date.now();
  clearNetBackoff(u);
  const entry = state.inbox[key] = { id: key, u, botId: account.botId, receivedAt: Date.now(), status: 'received', busyArrival: !!jobs[u], message: m };
  save();
  log(`in ${mask(raw)} id=${String(m.message_id || '').slice(-6)} items=${(m.item_list || []).map((i) => i.type).join(',')}`);
  scheduleInbound(entry);
}

// ---------------- 解析入站 ----------------
function itemBody(it) {
  const t = Number(it?.type);
  if (t === 1) return it.text_item?.text || '';
  if (t === 3) return it.voice_item?.text || '[语音]';
  if (t === 2) return '[图片]';
  if (t === 4) return `[文件 ${it.file_item?.file_name || ''}]`.replace(' ]', ']');
  if (t === 5) return '[视频]';
  return '';
}

function sniffExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.slice(0, 3).toString() === 'GIF') return '.gif';
  if (buf.slice(8, 12).toString() === 'WEBP') return '.webp';
  return '.bin';
}

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p); i++) {
    const ext = path.extname(name);
    p = path.join(dir, `${path.basename(name, ext)}-${i}${ext}`);
  }
  return p;
}

const bjDay = (t) => new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
const bjClock = (t) => new Date(t + 8 * 3600e3).toISOString().slice(11, 19).replace(/:/g, '');

async function saveMedia(it, attachments) {
  const t = Number(it.type);
  const attachment={type:t}; attachments.push(attachment);
  const kind = t === 2 ? '一张图片' : t === 5 ? '一段视频' : `文件「${it.file_item?.file_name || '未命名'}」`;
  const now = Date.now();
  const dir = path.join(cfg.workspace, '收件', bjDay(now));
  try {
    const sub = t === 2 ? it.image_item : t === 5 ? it.video_item : it.file_item;
    const media = sub?.media;
    if (!media || (!media.full_url && !media.encrypt_query_param)) return `（用户发来${kind}，但没拿到下载地址）`;
    const declared = Number(sub.len || sub.video_size || sub.mid_size || 0);
    if (declared > cfg.maxFileMB * 1024 * 1024) { attachment.tooLarge=true;return `（用户发来${kind}，超过 ${cfg.maxFileMB}MB，没有下载）`; }
    if (t !== 2 && !media.aes_key) return `（用户发来${kind}，缺少解密密钥，没法下载）`;
    const buf = await il.downloadMedia(media, t === 2 ? it.image_item?.aeskey : null);
    if(buf.length>cfg.maxFileMB*1024*1024){attachment.tooLarge=true;return `（附件超过 ${cfg.maxFileMB}MB，没有保存）`;}
    fs.mkdirSync(dir, { recursive: true });
    let name;
    if (t === 2) name = `${bjClock(now)}-图片${sniffExt(buf)}`;
    else if (t === 5) name = `${bjClock(now)}-视频.mp4`;
    else name = `${bjClock(now)}-${path.basename(String(it.file_item?.file_name || '文件')).replace(/[\/\\:\0]/g, '_')}`;
    const file = uniquePath(dir, name);
    fs.writeFileSync(file, buf);
    attachment.path=file;
    log(`saved media ${buf.length}B`);
    return `（用户发来${kind}，已存到：${file}）`;
  } catch (e) {
    log(`media download failed: ${e.message}`);
    return `（用户发来${kind}，但下载失败：${e.message}）`;
  }
}

// 只取文字，不下载媒体：用来先认口令
function quickText(m) {
  const items = m.item_list || [];
  if (items.some((it) => [2, 4, 5].includes(Number(it.type)))) return null;
  return items.map((it) => (Number(it.type) === 1 ? it.text_item?.text : Number(it.type) === 3 ? it.voice_item?.text : '') || '').join('\n');
}

async function parseInbound(m) {
  const texts = [];
  const notes = [], references = [], attachments = [];
  let voiceNoText = false;
  let unknown = false;
  for (const it of m.item_list || []) {
    const t = Number(it.type);
    if (t === 1) { if (it.text_item?.text) texts.push(it.text_item.text); }
    else if (t === 3) { if (it.voice_item?.text) texts.push(it.voice_item.text); else voiceNoText = true; }
    else if (t === 2 || t === 4 || t === 5) notes.push(await saveMedia(it, attachments));
    else unknown = true;
    if (it.ref_msg) {
      const sent = cfg.conversationMemory ? resolveProactiveReference(it.ref_msg, CONVERSATION_PATHS) : null;
      if (sent) references.push(sent.id);
      const q = sent ? `Dawn主动发出的原消息：${sent.text}` : [it.ref_msg.title, itemBody(it.ref_msg.message_item)].filter(Boolean).join(' | ').slice(0, 500);
      notes.unshift(q ? `（这条引用了一条消息：${q}）` : '（这条引用了一条消息，内容没拿到）');
    }
  }
  return { text: texts.join('\n'), notes, references, attachments, voiceNoText, unknown };
}

// ---------------- 口令 ----------------
const COMMANDS = {
  new: ['新对话', '/new', '/reset', '重新开始'],
  stop: ['停', '停止', '取消', '别做了', '/stop', '/cancel'],
  status: ['状态', '进度', '/status'],
  help: ['帮助', '/help', '?', '？'],
  cont: ['继续', '接着发', '/continue'],
};
function matchCommand(t) {
  if (t == null) return null;
  const s = t.trim().replace(/[。！!，,.\s]+$/g, '').toLowerCase();
  for (const [k, words] of Object.entries(COMMANDS)) if (words.includes(s)) return k;
  return null;
}
const HELP = [
  `我是 Dawn，背后是你电脑上的 ${backendName()}。直接说事就行。`,
  '几个口令（整条只写这几个字）：',
  '• 新对话：忘掉前面的，重新开始',
  '• 停：停下正在做的事',
  '• 状态：看有什么等你回复、我在做什么、额度还剩多少',
  '• 继续：取回没发完的消息，或让我接着做上次没做完的事',
  `每条消息我最多回 ${cfg.replyLimitPerMessage} 条，长内容会做成文件发你。`,
].join('\n');

const TASK_STATUS = { queued: '已排队', running: '执行中', waiting: '等待中', paused: '已暂停', blocked: '需要处理', completed: '已完成', cancelled: '已取消' };
function statusText(u) {
  const j = jobs[u];
  const user = state.users[u] || {};
  const lines = ['Dawn 状态'];
  if (j?.approval) lines.push(`• 等你选择是否允许本次使用「${j.approval.name || j.approval.app}」，回复「允许」或「拒绝」即可。`);
  const rank = t => t.status === 'waiting' && t.waitingFor?.type === 'user' ? 0
    : ({blocked:1,running:2,queued:3,waiting:4,paused:5}[t.status] ?? 6);
  const openTasks = Object.values(taskRuntime?.snapshot().tasks || {}).filter(t => !['completed','cancelled'].includes(t.status))
    .sort((a,b) => rank(a)-rank(b) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  for (const task of openTasks.slice(0,5)) {
    const wait = task.status === 'waiting' ? task.waitingFor : null;
    const time = Date.parse(wait?.at);
    let label = TASK_STATUS[task.status] || '工作任务';
    if (wait?.type === 'user') label = '等你回复';
    if (wait?.type === 'event') label = '等新进展';
    if (wait?.type === 'time' && Number.isFinite(time)) label = `等到北京时间 ${new Date(time + 8 * 3600e3).toISOString().slice(0,16).replace('T',' ')}`;
    if (task.status === 'blocked') label = '执行遇阻';
    const detail = wait?.reason || (task.status === 'blocked' ? '可查看这个任务的中断记录' : task.steps[task.stepIndex]?.instruction);
    lines.push(`• ${label} · 「${task.title}」${detail ? '，'+detail.slice(0,100) : ''}`);
  }
  if (openTasks.length > 5) lines.push(`• 另有 ${openTasks.length-5} 项进行中或已暂停的委托，可问我全部任务。`);
  lines.push(j ? `• 正在做：已 ${mins(j.startedAt)} 分钟，${j.steps} 步，最近在${j.lastTool || '思考'}${j.narration ? `\n  「${clipNarration(j.narration)}」` : ''}` : '• 聊天空闲');
  const waiting = (queue[u]?.length || 0) + (pendingStart[u]?.prompts.length || 0);
  if (waiting) lines.push(`• 排队：${waiting} 条`);
  const attachments=waitingAttachments(u).reduce((n,e)=>n+(e.parsed.attachments?.length||1),0);
  if(attachments)lines.push(`• ${attachments} 个附件在等你说明用途`);
  const blocked = Object.values(state.inbox).filter(e => e.u === u && e.status === 'blocked').length;
  if (blocked) lines.push(`• 已保留 ${blocked} 条执行中断的消息，需核对执行记录后续办`);
  lines.push(user.sid ? `• 对话：接着上次（上次是 ${bj(user.sidAt)}；发「新对话」重开）` : '• 对话：下一条开新对话');
  const rl = state.lastRateLimit;
  const w = rl?.unifiedWindows;
  if (w?.five_hour || w?.seven_day) {
    const pct = (x) => (x?.utilization != null ? `${Math.round(x.utilization * 100)}%` : '?');
    lines.push(`• 额度：5 小时窗口已用 ${pct(w.five_hour)}，本周已用 ${pct(w.seven_day)}（${bj(rl.at)} 的读数）`);
  }
  if (cfg.model) {
    lines.push(`• 后端：${backendName()} ${cfg.model.replace(/^.*\//, '')}（effort ${cfg.effort || '默认'}）`);
  }
  const pending = (state.outbox[u] || []).filter((x) => !x.ephemeral).length;
  if (pending) lines.push(`• 还有 ${pending} 条没发出`);
  return lines.join('\n');
}

// ---------------- 处理一条入站 ----------------
async function handle(u, m) {
  const entry = inboundContext.getStore();
  const at = Number(m.create_time_ms) || entry.receivedAt;
  conversationActivity = Date.now();
  conversationCuration?.cancel();
  const approval = jobs[u]?.approval;
  const answer = (quickText(m) || '').trim();
  const taskView = /^查看任务\s+([a-z0-9][a-z0-9_-]{0,79})$/.exec(answer);
  if (taskView && taskRuntime) {
    const snapshot = taskRuntime.snapshot(), stored = snapshot.tasks[taskView[1]];
    if (!stored) return replyAndLate(u, '没找到这个工作任务。', { front: true });
    const task = currentTaskView(stored, currentMemory().records, Date.now(), snapshot);
    const stale = task.freshness && !['current', 'baseline'].includes(task.freshness.state);
    const summary = task.routine ? stored.checkpoints.find(c => c.stepId === 'preparation')?.summary : stored.checkpoints.at(-1)?.summary;
    const text = `「${task.title}」${stale ? '正在按当前资料和方法修订' : TASK_STATUS[task.status]}。\n${task.waitingFor?.reason || task.blocker?.message || (stale ? task.freshness.problems.map(p => p.reason).join('；') : summary) || task.objective}`;
    const files = userArtifacts(task).map(a => `[[发送文件: ${a.path}]]`).join('\n');
    const items = await composeReply({ text: `${text}\n${files}`, texts: [], isError: false }, '');
    enqueue(u, items, { front: true }); await flushOutbox(u); return flushLateProactive(u);
  }
  const taskCommand = /^(补充任务|取消任务|暂停任务|恢复任务)\s+([a-z0-9][a-z0-9_-]{0,79})(?:\s+([\s\S]+))?$/.exec(answer);
  if (taskCommand && taskRuntime) {
    const action = { 补充任务: 'input', 取消任务: 'cancel', 暂停任务: 'pause', 恢复任务: 'resume' }[taskCommand[1]];
    try {
      const request = submitTaskCommand({ action, taskId: taskCommand[2], text: taskCommand[3],
        requestId: `in_${createHash('sha256').update(entry.id).digest('hex')}` }, { ...TASK_PATHS,
          userMessages: [{ id: m.message_id || entry.id, text: answer, at: new Date(at).toISOString() }] });
      taskRuntime.sync();
      const receipt = taskRuntime.snapshot().receipts[request.requestId];
      await inboxTestGate('command');
      if (stopping) return;
      return replyAndLate(u, receipt.status === 'accepted' ? `已${{ input: '补充要求', cancel: '取消任务', pause: '暂停任务', resume: '恢复任务' }[action]}：${taskCommand[2]}。` : receipt.message, { front: true });
    } catch (error) { return replyAndLate(u, error.message, { front: true }); }
  }
  if (entry.approvalAnswer || (approval && ['允许', '拒绝'].includes(answer))) {
    entry.approvalAnswer ||= { directory: approval.directory, id: approval.id, accepted: answer === '允许' };
    save();
    const decision = entry.approvalAnswer;
    answerChatApproval(decision.directory, decision.id, decision.accepted);
    if (approval?.id === decision.id) approval.resolve(decision.accepted);
    return replyAndLate(u, decision.accepted ? '好，本次任务可以使用这个应用。' : '好，这次不使用这个应用。', { front: true });
  }
  // 口令先认、回复插到最前面，不排在补发和下载后面
  const cmd = matchCommand(quickText(m));
  if (cmd && cmd !== 'cont') {
    if (cmd === 'new') {
      if (jobs[u]) return replyAndLate(u, '还有一件在做。先发「停」，再开新对话。', { front: true });
      for(const e of waitingAttachments(u)){finishInbound(e,'cancelled');e.contextCleared=true;}
      state.users[u].sid = null;
      save();
      return replyAndLate(u, '好，开新对话。', { front: true });
    }
    if (cmd === 'stop') {
      entry.stopTargets ||= {
        runId: jobs[u]?.runId || null,
        queued: [...(queue[u] || []), ...(pendingStart[u]?.prompts || [])].map(p => p.id),
        taskId: !jobs[u] ? Object.values(taskRuntime?.snapshot().tasks || {}).find(t => t.status === 'running')?.id : null,
      };
      save();
      if (cfg.test?.inboxGate?.phase === 'stop') {
        await inboxTestGate('stop');
        if (stopping) return;
      }
      const targets = entry.stopTargets, n = targets.queued.length;
      for (const id of targets.queued) if (state.inbox[id]) finishInbound(state.inbox[id], 'cancelled');
      if (pendingStart[u]) {
        clearTimeout(pendingStart[u].timer);
        queue[u] = [...(queue[u] || []), ...pendingStart[u].prompts];
        delete pendingStart[u];
      }
      queue[u] = (queue[u] || []).filter(p => !targets.queued.includes(p.id));
      syncWaiting(u);
      if (targets.runId) {
        if (jobs[u]?.runId === targets.runId) {
          state.jobs[u].cancelRequested = true; save(); jobs[u].run?.cancel();
        }
        return replyAndLate(u, n ? `停下了，排着的 ${n} 条也清掉了。` : '好，停下了。', { front: true });
      }
      const work = taskRuntime?.snapshot().tasks[targets.taskId];
      if (work) {
        submitTaskCommand({ action: 'cancel', taskId: work.id, requestId: `in_${createHash('sha256').update(entry.id).digest('hex')}` }, TASK_PATHS); taskRuntime.sync();
        return replyAndLate(u, `已停止「${work.title}」，已有文件保留。`, { front: true });
      }
      const idle = n ? `清掉了还没开始的 ${n} 条。` : '现在没有聊天任务在做。';
      return replyAndLate(u, `${idle}长期任务没有停；要取消请说「取消 具体任务名」，或先问「任务列表」。`, { front: true });
    }
    if (cmd === 'status') return replyAndLate(u, statusText(u), { front: true });
    if (cmd === 'help') return replyAndLate(u, HELP, { front: true });
  }

  if (cmd === 'cont' && !jobs[u] && !pendingStart[u]) {
    const pending = (state.outbox[u] || []).some((x) => !x.ephemeral);
    const stale = state.users[u].staleProactive || [];
    if (entry.continuationDelivery && !pending && !stale.length) return;
    if (pending || stale.length) {
      entry.continuationDelivery=true; save();
      if (stale.length) {
        state.outbox[u] = [...(state.outbox[u] || []), ...stale];
        state.users[u].staleProactive = [];
        save();
      }
      const before = state.users[u].sent || 0;
      await flushOutbox(u);
      await flushLateProactive(u);
      await inboxTestGate('continued');
      if ((state.users[u].sent || 0) > before) return; // 真发出东西才算回应；静默或过期发不出时照常交给模型
    }
  }
  const hadPending = (state.outbox[u] || []).some((x) => !x.ephemeral && !x.proactive); // 其他消息先补回答欠账；主动内容合并到答完之后
  if (hadPending) await flushOutbox(u);

  const parsed = entry.parsed || await parseInbound(m);
  entry.parsed = parsed; save();
  await inboxTestGate('parsed');
  if (stopping) return;
  if (parsed.voiceNoText && !parsed.text && !parsed.notes.length) return replyAndLate(u, '这条语音没转出文字，麻烦打字发我。');
  if (parsed.unknown && !parsed.text && !parsed.notes.length) return replyAndLate(u, '这类消息（比如链接卡片、聊天记录）我这边看不到内容。复制文字或截图发我吧。');
  let text = [parsed.text, ...parsed.notes].filter(Boolean).join('\n\n');
  if (!text.trim()) return flushLateProactive(u);
  if (!parsed.text && parsed.notes.length) text = `（这条微信只有附件，没有文字）\n${text}`;
  if (cfg.conversationMemory) { const capturedMemory=currentMemory();captureConversation({ sourceId: entry.id, role: 'user', at: new Date(at).toISOString(),
    text: [parsed.text,...parsed.notes.filter(n=>!n.includes('Dawn主动发出的原消息：'))].filter(Boolean).join('\n\n') || '（用户引用了一条消息）',replyTo:parsed.references || [],
    factsRevision: capturedMemory.factsRevision, factVersions: Object.fromEntries(capturedMemory.records.filter(r=>r.status==='active').map(r=>[r.id,r.revision])) }, CONVERSATION_PATHS); }
  conversationDirty = true;
  const prompt = entry.prompt || { text, userText: parsed.text, at, id: entry.id, receivedAt: entry.receivedAt, imageAt: entry.receivedAt, attachments: parsed.attachments || [] };
  const onlyAttachment=!parsed.text.trim() && prompt.attachments.length;
  if(onlyAttachment && !pendingStart[u] && !prompt.attachments.some(a=>a.path)){
    const text=prompt.attachments.some(a=>a.tooLarge)?`附件超过 ${cfg.maxFileMB}MB 上限，没能接收。`:'附件没下载成功，请重发。';
    entry.attachmentFailed=entry.attachmentHoldReleased=true;finishInbound(entry);enqueue(u,[{kind:'text',text,attachmentFailure:entry.id}],{front:true});return flushOutbox(u);
  }
  if(onlyAttachment && !entry.busyArrival && !pendingStart[u]) {
    const prior=waitingAttachments(u); Object.assign(entry,{status:'waiting_attachment',prompt,wasWaitingAttachment:true,attachmentAckAt:prior.find(e=>e.attachmentAckAt)?.attachmentAckAt||null});save();return;
  }
  if(onlyAttachment && entry.busyArrival)prompt.busyAttachment=true;
  const additions=[];
  if(parsed.text.trim())for(const e of waitingAttachments(u)) {
    const age=entry.receivedAt-e.receivedAt;
    if(age>12*3600e3){finishInbound(e);e.attachmentExpired=true;continue;}
    const p={...e.prompt,imageAt:entry.receivedAt};
    if(age>cfg.inlineImageMaxAgeMinutes*60000)p.text=`${Math.floor(age/60000)}分钟前发过附件，没说用途：${p.attachments.map(a=>a.path||'附件未下载成功').join('、')}`;
    additions.push(p);
  }
  additions.push(prompt);

  if (jobs[u]) {
    (queue[u] ||= []).push(...additions);
    syncWaiting(u);
    return reply(u, `收到，排在手上这件后面（已做 ${mins(jobs[u].startedAt)} 分钟）。要打断就发「停」。`, { ephemeral: true });
  }
  // 微信里常把一句话拆成几条连发：等几秒，合并成一次
  const ps = (pendingStart[u] ||= { prompts: [], firstAt: Date.now() });
  ps.prompts.push(...additions);
  syncWaiting(u);
  clearTimeout(ps.timer);
  const wait = Math.max(0, Math.min(cfg.mergeSeconds * 1000, ps.firstAt + 10000 - Date.now()));
  const timer = setTimeout(() => inboundDrained(u).then(() => {
    if(stopping || pendingStart[u]!==ps || ps.timer!==timer)return;
    delete pendingStart[u];
    startJob(u, ps.prompts).catch((e) => log(`job error: ${e.stack || e.message}`));
  }), wait);
  ps.timer=timer;
}

// ---------------- 跑后端（Codex） ----------------
function backendName() { return 'Codex'; }

function isQuotaLimited(res) {
  if (!res.isError) return false;
  const st = res.rateLimit?.status;
  return (st && !/^allowed/.test(st)) || /hit your .*limit|usage limit|session limit|weekly limit/i.test(res.errorText || '');
}

// Codex 报错分类：内容拒绝不重试；busy 服务繁忙（可自动重试）、auth 登录失效（飞书告警）、quota 额度、other 其他
function classifyError(res) {
  const t = `${res.errorText || ''}\n${res.stderr || ''}`;
  if (/provider\.filtered|Provider safety policy/i.test(t)) return 'filtered';
  if (/high risk|content_filter/i.test(t)) return 'rejected';
  if (/Failed to authenticate|OAuth session expired|unauthorized|not logged in|login required|invalid.*(token|credential)|401\b/i.test(t)) return 'auth';
  if (/overloaded|currently overloaded|rate_limit|429\b|service.*busy|engine.*busy/i.test(t)) return 'busy';
  if (isQuotaLimited(res)) return 'quota';
  return 'other';
}

const BACKEND_ISSUES = {
  filtered: {
    label: '请求被提供方安全筛选拦下',
    user: '这次请求被后端的安全筛选拦下，没生成回复。可以换个说法再试。',
  },
  rejected: {
    label: '请求因内容安全规则被拒绝',
    user: '这次请求被后端的内容安全规则拒绝，没生成回复。可以调整后再试。',
  },
  auth: { label: '后端登录失效' },
  busy: { label: '后端服务繁忙' },
  quota: { label: '后端额度用完' },
  other: {
    label: '后端处理失败',
    user: '出错了：这次后端处理没有完成，没拿到可用回复。请稍后发「继续」重试；反复出现请到电脑上查 Dawn 日志。',
  },
};

function consumeBackendIssue(u) {
  const issue = state.users[u]?.backendIssue;
  if (!issue) return '';
  delete state.users[u].backendIssue;
  save();
  const label = BACKEND_ISSUES[issue.kind]?.label || BACKEND_ISSUES.other.label;
  const noRetry = issue.kind === 'filtered' || issue.kind === 'rejected' ? '，桥未自动重试' : '';
  return `[上轮故障记录] 上一轮${label}，未生成可用回复${noRetry}。这是已发生事实，不是本轮新任务。\n`;
}

// 长期记忆：每轮只注入精简的当前状态和偏好（对标 Instinct 的"注入当前状态而非全部聊天"）
// 文件由 Dawn 自己维护（见 $DAWN_WORKSPACE/AGENTS.md），读取失败/为空就不注入，不影响主流程
function currentMemory() {
  if (!cfg.memoryInject) return { text: '', revision: 'disabled', records: [] };
  try {
    const memory = memoryContext(MEMORY_PATHS);
    memory.factsRevision = memory.revision;
    memory.revision += `:archive-${maintenanceStatus(MEMORY_PATHS).generation}:${createHash('sha256').update(memory.text).digest('hex')}`;
    return memory;
  } catch (error) {
    log(`memory unavailable: ${error.code || 'read_failed'}`);
    return { revision: 'unavailable', records: [], text: '[当前记忆不可用] 不回用旧聊天、日志或旧文件中的偏好；本轮按用户明确提供的信息处理，需要记忆的事实先核对。\n\n' };
  }
}
function currentExperiences(snapshot) {
  try {
    const entries = new Map();
    for (const task of Object.values(snapshot.tasks || {}).filter(t => t.status !== 'cancelled')) {
      for (const entry of selectExperiences(snapshot, task)) entries.set(entry.id, entry);
    }
    const methods = [...entries.values()].slice(0, 6);
    const versions = Object.keys(snapshot.experiences || {}).sort().map(id => { const entry = experienceView(snapshot, id); return [id, entry?.revision, entry?.status]; });
    return { revision: createHash('sha256').update(JSON.stringify(versions)).digest('hex'), text: methods.length
      ? `[可复用的求职方法：当前版本]\n${JSON.stringify(methods)}\n按当前任务判断是否适用；candidate 是待复跑候选，不是用户认可。用户纠正做法时先读 $DAWN_WORKSPACE/routines/job-preparation.md，使用 tasks.mjs experience 写入当前消息来源，不能只在聊天里改口。查询细节用 experiences；旧版仅显式 --history 查询，不能当现行方法。\n\n` : '' };
  } catch { return { revision: 'unavailable', text: '[经验暂不可用] 本轮按当前任务要求执行，不从旧会话恢复已缓存的方法。\n\n' }; }
}

// 每轮结束后给记忆库留痕（Git 仓库存在才提交；失败只记日志，不影响回复）
function commitMemory() {
  const dir = path.join(cfg.workspace, 'memory');
  if (!fs.existsSync(path.join(dir, '.git'))) return;
  execFile('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, 'add', '-A'], (e) => {
    if (e) { log(`memory git add failed: ${e.message}`); return; }
    execFile('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, 'diff', '--cached', '--quiet'], (e2) => {
      if (!e2) return;
      if (e2.code !== 1) { log(`memory git diff failed: ${e2.message}`); return; }
      execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Dawn', '-c', 'user.email=dawn@localhost', '-C', dir, 'commit', '-q', '-m', `dawn 记忆更新 ${new Date().toISOString()}`], (e3) => {
        if (e3 && !/nothing to commit/.test(String(e3.message))) log(`memory git commit failed: ${e3.message}`);
      });
    });
  });
}

let lastRunCleanup = 0;
function checkMemoryMaintenance() {
  if (stopping || !inboxReady || !cfg.memoryInject || !cfg.memoryMaintenance || Object.keys(jobs).length
    || Object.values(state.inbox || {}).some(e => ['received', 'queued', 'running'].includes(e.status))
    || Object.values(taskRuntime?.snapshot().tasks || {}).some(t => t.status === 'running')) return;
  if(Date.now()-lastRunCleanup>3600e3){
    lastRunCleanup=Date.now();
    try{const result=cleanChatRuns(path.join(HOME,'state/chat-runs'),state);if(result.removed||result.redacted)log(`chat-runs maintenance ${JSON.stringify(result)}`);}
    catch(e){log('chat-runs cleanup failed: '+e.message);}
  }
  if (!fs.existsSync(path.join(MEMORY_PATHS.memoryDir, 'now.md'))) return;
  try {
    const result = maintainMemory(MEMORY_PATHS);
    if (result.status === 'checked') {
      log(`memory maintenance moved=${result.moved} chars=${result.beforeChars}->${result.afterChars} stale=${result.staleDeclaration}`);
      commitMemory();
    }
  } catch (e) { log(`memory maintenance failed: ${e.message}`); }
}

function checkConversationMaintenance() {
  if (stopping || !inboxReady || !cfg.conversationMemory) return;
  const busy = Object.keys(jobs).length || Object.keys(pendingStart).length
    || Object.values(state.inbox || {}).some(e => ['received','queued','running'].includes(e.status))
    || Object.values(taskRuntime?.snapshot().tasks || {}).some(t => t.status === 'running');
  if (busy) { conversationCuration?.cancel(); return; }
  try {
    const factsRevision = currentMemory().factsRevision;
    if (factsRevision !== notebookFactsRevision) conversationDirty = true;
    if (Date.now() - conversationImportAt >= 30 * 60e3) {
      const imported = importConversationLogs(CONVERSATION_PATHS);
      conversationDirty ||= !!(imported.imported || imported.changed); conversationImportAt = Date.now();
    }
    if (conversationDirty) {
      if (cfg.obsidianVault) {
        const result = maintainNotebook({ ...MEMORY_PATHS, ...CONVERSATION_PATHS, vaultDir: cfg.obsidianVault });
        if (result.conflicts.length) log('notebook preserved manual edits: ' + result.conflicts.join('；'));
      }
      conversationDirty = false; notebookFactsRevision = factsRevision; commitMemory();
    }
    if (!cfg.conversationCuration || conversationCuration || Date.now() - conversationActivity < 5 * 60e3) return;
    const run = startConversationCuration(cfg, CONVERSATION_PATHS); if (!run) return;
    conversationCuration = run;
    run.done.then(result => { log(`conversation curation ${result.status} inputChars=${result.inputChars || 0}`); conversationDirty = true; })
      .finally(() => { conversationCuration = null; });
  } catch (error) { log(`conversation maintenance failed: ${error.code || 'failed'}`); }
}

function reportConversationSkips(items = []) {
  const names=[...new Set(items.map(x=>x.path))].sort(); if(!names.length)return;
  log('conversation skipped: '+names.join('；'));
  alert('conversation-data:'+createHash('sha256').update(names.join('\n')).digest('hex').slice(0,16),`Dawn 聊天资料有损坏项，共 ${names.length} 个，前 5 个是：${names.slice(0,5).join('；')}。其余资料照常使用。`,{minIntervalMs:7*24*3600e3}).catch(()=>{});
}
// 提示词：带上每条消息自己的发送时间；排队或补收的，注明过了多久
function buildPrompt(u, prompts, memory, sessionId) {
  const issue = consumeBackendIssue(u);
  const terminal=Object.values(state.inbox).filter(e=>e.u===u&&['done','cancelled','blocked'].includes(e.status)&&!e.contextCleared);
  const unanswered=terminal.map(e=>({id:e.id,reason:e.attachmentExpired?'附件已过期，没有随消息附上':e.attachmentFailed?'附件没有下载成功，已经请我重发':e.status==='cancelled'?'已被我叫停；我没有要求，就不要接着做':e.status==='blocked'?'先核对已经做到哪一步，不要直接重做':'上一轮没有答完'}));
  const unavailable=Object.values(state.inbox).filter(e=>e.u===u&&(!['done','cancelled','blocked'].includes(e.status)||e.contextCleared)).map(e=>'wechat:'+e.id);
  const recall = sid => {
    if (cfg.memoryInject && cfg.conversationMemory && !memory.revision.startsWith('unavailable')) {
      try { const result = conversationContext({ query: prompts.map(p => p.userText ?? p.text).join('\n'), exclude: [...unavailable,...prompts.map(p => `wechat:${p.id}`)], unanswered, seenIds: sid ? state.users[u].conversationSeen || [] : [], newSession: !sid, maxChars: 2400 }, { ...CONVERSATION_PATHS, factsRevision: memory.factsRevision, records: memory.records }); reportConversationSkips(result.skipped); return result; }
      catch (error) { log(`conversation recall unavailable: ${error.code || 'failed'}`); alert('conversation-recall','Dawn 本轮历史读取失败：'+(error.code||error.name),{minIntervalMs:6*3600e3}).catch(()=>{}); }
    }
    return {text:'',ids:[]};
  };
  const recalled=recall(sessionId), fresh=sessionId?recall(null):recalled;
  const args={ prompts, memory, issue, previousTaskRevision: state.users[u].taskContextRevision,
    snapshot: taskRuntime?.snapshot() || { tasks: {} }, experienceText: currentExperiences(taskRuntime?.snapshot() || { tasks: {} }).text };
  return {...buildChatPrompt({...args,sessionId,recalled:recalled.text}), freshText:buildChatPrompt({...args,sessionId:null,recalled:fresh.text}).text, recalledIds:recalled.ids, freshRecalledIds:fresh.ids};
}

async function startJob(u, prompts, recovered = null) {
  if (stopping) return;
  conversationCuration?.cancel();
  if (jobs[u]) { (queue[u] ||= []).push(...prompts); syncWaiting(u); return; } // 同一个人同时只跑一件
  if (!recovered && state.jobs[u]) {
    (queue[u] ||= []).push(...prompts); syncWaiting(u);
    return startJob(u, state.jobs[u].prompts, state.jobs[u]);
  }
  if(!recovered && queue[u]?.length)prompts=[...queue[u].splice(0),...prompts];
  syncWaiting(u);
  const user = state.users[u];
  let sid = user.sid || null;
  const executionCwd = path.join(cfg.workspace, 'work');
  if (user.sidCwd !== executionCwd) sid = null;
  // 没有后端标签的旧会话按迁移前配置保留；切换后不跨 CLI 续聊。
  if ((user.sidBackend && user.sidBackend !== cfg.backend) || (!user.sidBackend && cfg.backend === 'codex')) sid = null;
  let note = '';
  if (sid && cfg.sessionIdleResetHours > 0 && Date.now() - (user.sidAt || 0) > cfg.sessionIdleResetHours * 3600e3) {
    sid = null;
    note = `（距离上次聊天超过 ${cfg.sessionIdleResetHours} 小时，这是新对话）`;
  }
  const memory = currentMemory();
  if (sid && cfg.sessionMaxTurns > 0 && (user.sidTurns || 0) >= cfg.sessionMaxTurns) sid = null;
  const snapshot = taskRuntime?.snapshot() || { tasks: {} };
  const contextKey = Object.values(snapshot.tasks).filter(t => t.context && t.status !== 'cancelled').map(t => { const v = currentTaskView(t, memory.records, Date.now(), snapshot); return [t.id, t.context.revision, v.freshness.state]; });
  if (contextKey.length) memory.revision += ':' + createHash('sha256').update(JSON.stringify(contextKey)).digest('hex');
  memory.revision += ':' + currentExperiences(snapshot).revision + ':prompt-v7:' + cfg.model;
  if ((user.memoryRevision || memory.records.length) && user.memoryRevision !== memory.revision) sid = null;
  const assembled = recovered ? null : buildPrompt(u, prompts, memory, sid);
  const record = recovered || { runId: newRunId(), startedAt: Date.now(), prompts, executionCwd,
    prompt: assembled.text, freshPrompt: sid ? assembled.freshText : null, taskContextRevision: assembled.taskRevision,
    sid, note, attempt: 0, recalledIds: assembled.recalledIds, freshRecalledIds: assembled.freshRecalledIds,
    conversationFactVersions: Object.fromEntries(memory.records.filter(r=>r.status==='active').map(r=>[r.id,r.revision])), images: imageInputs(prompts,cfg.workspace,cfg.inlineImageMaxAgeMinutes), memoryRevision: memory.revision, factsRevision: memory.factsRevision,
    factVersions: Object.fromEntries(memory.records.map(r => [r.id, r.revision])) };
  // 接回的会话仍对应启动时的记忆，不能贴上重启后的新版本标签。
  user.memoryRevision = record.memoryRevision || memory.revision;
  sid = record.sid; note = record.note;
  if (!sid) { user.sid = null; user.sidTurns = 0; delete user.taskContextRevision; }
  let prompt = record.prompt;
  const job = { runId: record.runId, startedAt: record.startedAt, steps: 0, lastTool: null, progressSent: 0, done: false };
  jobs[u] = job;
  state.jobs[u] = record;
  for (const p of prompts) if (state.inbox[p.id]) Object.assign(state.inbox[p.id], { status: 'running', jobId: job.runId });
  save();
  writeHealth(true);
  log(`job start ${job.runId.slice(0, 8)} resume=${sid ? sid.slice(0, 8) : 'new'} len=${prompt.length}`);

  await inboxTestGate('claimed');
  if (stopping) return;

  typingStart(u, job);
  // 微信不能改已发的消息、没有真流式：用 Codex 自己说的"正在做什么"当确认和进度，比固定话术有信息量
  job.ackTimer = setTimeout(() => {
    if (job.done) return;
    const now = clipNarration(job.narration);
    reply(u, formatForWeixin(now || '正在处理你刚才的请求。'), { runId: job.runId, ephemeral: true });
  }, cfg.ackAfterSeconds * 1000);
  job.progressTimer = setInterval(() => {
    if (job.done || job.progressSent >= cfg.maxProgressMessages) return;
    job.progressSent += 1;
    const now = clipNarration(job.narration) || '正在处理你刚才的请求。';
    reply(u, formatForWeixin(`还在做（已 ${mins(job.startedAt)} 分钟）：${now}\n想停发「停」。`), { runId: job.runId, ephemeral: true });
  }, cfg.progressEveryMinutes * 60e3);

  const exec = (s) => {
    const directory = path.join(HOME, 'state', 'chat-runs', `${job.runId}-${record.attempt}`);
    if (record.cancelRequested) {
      writeDurableJson(path.join(directory, 'cancel.json'), { at: Date.now() });
      if (!fs.existsSync(path.join(directory, 'request.json'))) return Promise.resolve({ text: '', texts: [], cancelled: true, steps: 0 });
    }
    const options = backendOptions(cfg);
    job.run = runDurableChat({
      directory,
      ...options, cwd: executionCwd,
      writableRoots: [path.join(cfg.workspace, 'memory'), path.join(cfg.workspace, 'state'), path.join(cfg.workspace, '发出'),
        ...(cfg.obsidianVault ? [path.join(cfg.obsidianVault, '30_Resources', 'Dawn')] : [])], prompt:prompt+imageNotes(record.prompts||[],record.images||[]), sessionId: s, images: record.images || [],
      env: { ...options.env, DAWN_WORKSPACE: cfg.workspace, DAWN_TASKS_STATE: TASK_PATHS.statePath, DAWN_TASKS_CONTROL: TASK_PATHS.controlPath, DAWN_TASKS_ARTIFACTS: TASK_PATHS.artifactRoot,
        DAWN_AUTOMATIONS_CONFIG: AUTOMATION_PATHS.config, DAWN_AUTOMATIONS_STATE: AUTOMATION_PATHS.state, DAWN_AUTOMATIONS_CONTROL: AUTOMATION_PATHS.control,
        DAWN_PROJECT_SOURCES_PATH: path.join(cfg.workspace, 'memory', 'project-sources.json'), DAWN_SELF_STATUS_PATH: cfg.selfStatusPath || path.join(cfg.workspace, 'state', 'self-status.json'),
        DAWN_TASK_ORIGIN: JSON.stringify(prompts.map(p => p.id || `${p.at}:${p.text}`)),
        DAWN_MEMORY_DIR: MEMORY_PATHS.memoryDir, DAWN_MEMORY_JOURNAL: MEMORY_PATHS.journalPath,
        DAWN_MEMORY_FACT_VERSIONS: JSON.stringify(record.factVersions || {}),
        DAWN_CONVERSATIONS_INDEX: CONVERSATION_PATHS.indexPath,
        ...(cfg.obsidianVault ? { DAWN_VAULT_DIR: cfg.obsidianVault } : {}),
        DAWN_MEMORY_USER_MESSAGES: JSON.stringify(prompts.map(p => ({ id: p.id || `${p.at}:${p.text}`, text: p.userText ?? p.text, at: new Date(p.at).toISOString() }))),
      },
      idleMs: cfg.idleTimeoutMinutes * 60e3, maxMs: cfg.maxRunMinutes * 60e3,
      onApproval: ({ id, directory, app, name, signal }) => new Promise(resolve => {
        if (signal.aborted) return resolve(false);
        const settle = accepted => {
          signal.removeEventListener('abort', cancel);
          if (job.approval?.resolve === settle) delete job.approval;
          resolve(accepted);
        };
        const cancel = () => settle(false);
        job.approval = { id, directory, app, name, resolve: settle };
        signal.addEventListener('abort', cancel, { once: true });
        reply(u, `这一步需要使用「${name}」（${app}）。回复「允许」后，Dawn 可以在本次任务中操作这个应用；回复「拒绝」则跳过。`, { runId: job.runId, deliveryKey: `approval:${id}` }).catch(cancel);
      }),
      onProgress: (p) => { job.steps = p.steps; job.lastTool = p.lastTool; if (p.lastText) job.narration = p.lastText; },
    });
    return job.run.done;
  };
  let res = await exec(sid);
  if (res.isError && sid && !res.cancelled && res.steps === 0 && /No conversation found|Session .* not found|No session found|thread .* not found/i.test(`${res.errorText}\n${res.stderr}`)) {
    log('resume 失败，开新会话重跑');
    note = '（上次的对话找不到了，这是新对话）';
    record.sid = null; record.recalledIds=record.freshRecalledIds || []; record.note = note; record.prompt = prompt = record.freshPrompt || record.prompt; record.attempt++; save();
    res = await exec(null);
  }
  if(res.isError && res.imageInputFailed && classifyError(res)==='other' && res.steps===0 && !res.cancelled && record.images?.length && !record.imageRetried) {
    record.imageRetried=true; record.recalledIds=record.freshRecalledIds || []; record.images=[]; record.sid=null; record.prompt=prompt=record.freshPrompt||record.prompt;record.attempt++;save();res=await exec(null);
  }
  // 服务繁忙且这一轮还没执行过任何工具：3 分钟后自动重试一次（执行过工具的不自动重做，避免重复操作）
  if (res.isError && classifyError(res) === 'busy' && res.steps === 0 && !res.cancelled && !record.busyRetried) {
    record.busyRetried = true;
    log('服务繁忙（未执行工具），自动重试一次');
    await sleep(cfg.busyRetrySeconds * 1000);
    if (!res.cancelled && !stopping) { record.attempt++; save(); res = await exec(record.sid); }
  }
  if (res.isError && classifyError(res) === 'auth') {
    alert('backend-auth', `Dawn 的 ${backendName()} 登录失效了，请到电脑上处理（重登或检查凭证）。`);
  }
  if (res.runtimeWarnings?.length) alert('codex-runtime', `Dawn 工具自检：${res.runtimeWarnings.join('；')}。请在桌面核对 Codex 升级后的配置。`);
  if (res.surfaceWarnings?.length) alert('codex-surface', `Dawn 工具清单变化：${res.surfaceWarnings.join('；')}`, { minIntervalMs: 24 * 3600e3 });
  const errorKind = res.isError && !res.cancelled ? classifyError(res) : null;
  if (errorKind) {
    user.backendIssue = { kind: errorKind, at: Date.now() };
    save();
    const detail = errorKind === 'other' ? ` | ${String(res.errorText || res.stderr || '无错误文本').replace(/\/[^\s'"]+/g, '<路径>').replace(/\s+/g, ' ').slice(0, 160)}` : '';
    log(`backend issue ${errorKind}: ${BACKEND_ISSUES[errorKind]?.label || BACKEND_ISSUES.other.label}${detail}`);
  }

  job.done = true;
  clearTimeout(job.ackTimer);
  clearInterval(job.progressTimer);
  typingStop(u, job);
  log(`job end ${job.runId.slice(0, 8)} err=${res.isError} cancelled=${res.cancelled} timeout=${res.timedOut} steps=${res.steps} len=${res.text.length}`);
  lastJobResult = { endedAt: Date.now(), isError: res.isError, cancelled: res.cancelled, timedOut: res.timedOut, steps: res.steps };
  if (stopping) { if(jobs[u]===job)delete jobs[u]; return; } // 原执行记录和独立 worker 留给下一进程接回。
  await inboxTestGate('result');
  if (stopping) return;
  if (record.cancelRequested) res.cancelled = true;
  if (res.sessionId) { user.sidTurns = res.sessionId === user.sid ? (user.sidTurns || 0) + 1 : 1; user.sid = res.sessionId; user.sidAt = Date.now(); user.sidBackend = cfg.backend; user.sidCwd = record.executionCwd || cfg.workspace; }
  if (!res.isError && !res.cancelled && res.sessionId) user.taskContextRevision = record.taskContextRevision;
  else { user.sid = null; delete user.taskContextRevision; }
  if (res.rateLimit) state.lastRateLimit = { ...res.rateLimit, at: Date.now() };
  try {
    // 回复排好（含渲染卡片）之前仍算"在做"；重启接回结果文件，不再调用模型。
    let items = null;
    if (!res.cancelled) {
      try { items = res.recoveryRequired ? [{ kind: 'text', text: res.errorText }] : await composeReply(res, note); } catch (e) {
        log(`compose error: ${e.stack || e.message}`);
        const raw = formatForWeixin(res.text || res.errorText || '（回复生成出错）');
        items = chunkText(raw, cfg.chunkChars).map((t) => ({ kind: 'text', text: t }));
      }
    }
    if (stopping) { if(jobs[u]===job)delete jobs[u]; return; }
    if (record.cancelRequested) { res.cancelled = true; items = null; }
    state.outbox[u] = (state.outbox[u] || []).filter((x) => !(x.ephemeral && x.runId === job.runId));
    if (items?.length && cfg.conversationMemory && !res.isError) {
      record.completedAt ||= new Date().toISOString();save();
      const versions=record.conversationFactVersions && {...record.conversationFactVersions};
      if(versions)for(const f of currentMemory().records)if(f.source.kind==='user' && prompts.some(p=>p.id===f.source.reference)) {
        if(f.status==='active')versions[f.id]=f.revision;else delete versions[f.id];
      }
      const answer=captureConversation({ sourceId: job.runId, role: 'assistant',
        at: new Date(record.startedAt).toISOString(), text: res.text?.trim() || items.map(x=>x.text||`已交付文件：${x.path||x.name||x.kind}`).join("\n"), factsRevision: record.factsRevision, contextRevision: record.memoryRevision, factVersions:versions, completedAt:record.completedAt, contextIds:record.recalledIds||[],
        replyTo: prompts.map(p => createHash('sha256').update(`wechat:${p.id}`).digest('hex')) }, CONVERSATION_PATHS);
      user.conversationSeen=[...new Set([...(record.sid?user.conversationSeen||[]:[]),...(record.recalledIds||[]),...answer.replyTo,answer.id])];
    }
    if (items) enqueue(u, items, { runId: job.runId, deliveryKey: `job:${job.runId}` });
    await inboxTestGate('published');
    if (stopping) return;
    for (const p of prompts) if (state.inbox[p.id]) finishInbound(state.inbox[p.id], res.recoveryRequired ? 'blocked' : res.cancelled ? 'cancelled' : 'done');
    save();
    if (items) await flushOutbox(u); // 先发当前回答，再统一 drain 主动内容
    const summaries = await collectProactiveSummary(u); // 主动内容排在答案后面；监测事件保留完整文本
    if (summaries.length) {
      enqueue(u, summaries);
      for (const item of summaries) markAutomationDelivery(item, 'queued');
    }
    await inboundDrained(u);
    if(jobs[u]===job)delete jobs[u];
    if(state.jobs[u]?.runId===record.runId)delete state.jobs[u];
    save();
    writeHealth(true);
    if (summaries.length) await flushOutbox(u);
    conversationActivity = Date.now(); conversationDirty = true;
    commitMemory(); // 每轮结束给记忆库留 Git 痕（异步，不阻塞下一条）
  } finally {
    await inboundDrained(u);
    if(jobs[u]===job)delete jobs[u];
    const q = queue[u];
    if (state.jobs[u]?.runId === record.runId && !stopping) {
      // 结果已由独立运行器落盘。保存/投递出错时接回同一结果，不能让下一条覆盖恢复入口。
      setTimeout(() => {
        if (!stopping && !jobs[u] && state.jobs[u]?.runId === record.runId) startJob(u, record.prompts, record).catch(e => log(`job finalize retry: ${e.code || 'failed'}`));
      }, 5000).unref();
    } else if (q?.length && !stopping && !jobs[u] && !state.jobs[u]) {
      const next = q.splice(0);
      startJob(u, next).catch((e) => log(`job error: ${e.stack || e.message}`));
    }
  }
}

// 发文件标记：[[发送文件: 路径]]，允许两侧带反引号、写在列表里或句中
const FILE_RE = /[ \t]*(?:^[ \t]*[-*•][ \t]+)?`?\[\[\s*发送文件\s*[:：]\s*([^\]\n]+?)\s*\]\]`?/gm;
function isBlockedPath(f) {
  // Only explicitly deliverable workspace roots may supply outgoing attachments.
  const allowed = ['发出', 'work'].some(dir => {
    const root = path.join(cfg.workspace, dir);
    if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) return false;
    const relative = path.relative(fs.realpathSync(root), f);
    return relative && !relative.startsWith('..' + path.sep) && relative !== '..'
      && !path.isAbsolute(relative) && relative.split(path.sep).every(part => !part.startsWith('.'));
  });
  if (!allowed) return true;
  const name = path.basename(f);
  return /^\.env|credential|id_rsa|id_ed25519|\.pem$|\.p12$/i.test(name) || /(^|[._-])(token|secret)s?([._-]|$)/i.test(name);
}
function pickFiles(text) {
  const files = [];
  const refused = [];
  const body = text.replace(FILE_RE, (_, p) => {
    let f = p.trim().replace(/^["'`]|["'`]$/g, '').replace(/^~(?=\/)/, os.homedir());
    f = path.resolve(cfg.workspace, f);
    let why = null;
    try {
      f = fs.realpathSync(f);
      const st = fs.statSync(f);
      if (!st.isFile()) why = '不是文件';
      else if (st.size > cfg.maxFileMB * 1024 * 1024) why = `超过 ${cfg.maxFileMB}MB`;
    } catch { why = '找不到'; }
    if (!why && isBlockedPath(f)) why = '位于交付目录之外或属于受保护文件';
    if (why) refused.push(`${path.basename(f)}（${why}）`); else if (!files.includes(f)) files.push(f);
    return '';
  });
  return { body, files, refused };
}

// 卡片：[[卡片: 标题 | 颜色]] …Markdown… [[/卡片]]，桥渲染成飞书卡片样式的图片发出；渲染失败就按文字发
const CARD_RE = /\[\[\s*卡片\s*(?:[:：]\s*([^\]|｜\n]*?))?\s*(?:[|｜]\s*([^\]\n]*?)\s*)?\]\]\n?([\s\S]*?)\n?\[\[\s*\/\s*卡片\s*\]\]/g;
const TONE_ALIAS = { blue: 'blue', green: 'green', orange: 'orange', red: 'red', grey: 'grey', gray: 'grey', 蓝: 'blue', 蓝色: 'blue', 绿: 'green', 绿色: 'green', 橙: 'orange', 橙色: 'orange', 红: 'red', 红色: 'red', 灰: 'grey', 灰色: 'grey' };
const toneOf = (t) => TONE_ALIAS[String(t || '').trim().toLowerCase()] || 'blue';
const CARD_TOOL = path.join(import.meta.dirname, 'tools', 'card.py');
let cardSeq = 0;
function renderCard(md, title, tone) {
  return new Promise((resolve) => {
    let src, dst;
    try {
      const dir = path.join(cfg.workspace, '发出', '卡片');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = `${bjDay(Date.now())}-${bjClock(Date.now())}-${++cardSeq}`;
      src = path.join(os.tmpdir(), `dawn-card-${process.pid}-${stamp}.md`);
      dst = path.join(dir, `${stamp}.png`);
      fs.writeFileSync(src, md);
    } catch (e) { log(`card prepare failed: ${e.message}`); resolve(null); return; }
    const args = [CARD_TOOL, src, dst, `--tone=${tone || 'blue'}`];
    if (title) args.push(`--title=${title}`);
    execFile(cfg.pythonBin, args, { timeout: 90000 }, (err, _out, stderr) => {
      try { fs.unlinkSync(src); } catch { /* ignore */ }
      if (err || !fs.existsSync(dst)) { log(`card render failed: ${(stderr || err?.message || '').toString().slice(0, 200)}`); resolve(null); }
      else resolve(dst);
    });
  });
}

async function composeReply(res, note) {
  let text;
  if (res.timedOut === 'idle') text = `停下了：连续 ${cfg.idleTimeoutMinutes} 分钟没有任何进展（可能卡在等输入的命令上）。做到一半的东西还在电脑上，要接着做就发「继续」。`;
  else if (res.timedOut === 'max') text = `停下了：这件事做了 ${cfg.maxRunMinutes} 分钟，到了单次上限。要接着做就发「继续」。`;
  else if (isQuotaLimited(res)) {
    const at = res.rateLimit?.resetsAt ? bj(res.rateLimit.resetsAt * 1000) : null;
    text = `${backendName()} 额度用完了${at ? `，北京时间 ${at} 恢复` : ''}。到时候发「继续」我接着做。`;
  } else if (res.isError && classifyError(res) === 'auth') text = `我的 ${backendName()} 登录失效了，需要在电脑上重新登录。修好后发「继续」。`;
  else if (res.isError && classifyError(res) === 'busy') text = '服务现在有点忙（过载）。等一两分钟发「继续」，我接着做。';
  else if (res.isError && classifyError(res) === 'filtered') text = BACKEND_ISSUES.filtered.user;
  else if (res.isError && classifyError(res) === 'rejected') text = BACKEND_ISSUES.rejected.user;
  else if (res.isError) text = BACKEND_ISSUES.other.user;
  else text = res.text || '（这次没有文字回复）';

  // 最后一段只剩发文件标记、话都说在工具调用之前：把这一轮说过的话一起发，免得用户只收到文件
  const onlyMarkers = (t) => !pickFiles(t.replace(CARD_RE, 'x')).body.trim();
  if (!res.isError && onlyMarkers(text) && res.texts?.length > 1) {
    const before = res.texts.slice(0, -1).join('\n\n');
    text = `${[...before].length > 3000 ? `${[...before].slice(0, 3000).join('')}…` : before}\n\n${text}`;
  }

  // 按卡片切段：文字段照常排版切条，卡片段渲染成图，顺序不变
  const segs = [];
  let last = 0, m;
  while ((m = CARD_RE.exec(text))) {
    segs.push({ kind: 'text', s: text.slice(last, m.index) });
    segs.push({ kind: 'card', title: (m[1] || '').trim(), tone: toneOf(m[2]), md: m[3] });
    last = m.index + m[0].length;
  }
  segs.push({ kind: 'text', s: text.slice(last) });

  const items = [];
  const files = [];
  const refused = [];
  let cards = 0;
  for (const seg of segs) {
    if (seg.kind === 'card') {
      const inCard = pickFiles(seg.md); // 发文件标记写进了卡片：照样发文件，不画进图里
      files.push(...inCard.files.filter((f) => !files.includes(f)));
      refused.push(...inCard.refused);
      if (!inCard.body.trim()) continue;
      const asText = formatForWeixin(`${seg.title ? `**${seg.title}**\n` : ''}${inCard.body}`);
      const img = ++cards <= 3 ? await renderCard(inCard.body, seg.title, seg.tone) : null;
      // 图片发不出去（有的账号拿不到上传地址）时，退回按文字发卡片内容
      if (img) items.push({ kind: 'file', path: img, fallbackText: asText });
      else items.push(...chunkText(asText, cfg.chunkChars).map((x) => ({ kind: 'text', text: x })));
      continue;
    }
    const pf = pickFiles(seg.s);
    files.push(...pf.files.filter((f) => !files.includes(f)));
    refused.push(...pf.refused);
    const t = formatForWeixin(pf.body).trim();
    if (t) items.push(...chunkText(t, cfg.chunkChars).map((x) => ({ kind: 'text', text: x })));
  }
  if (refused.length) items.push({ kind: 'text', text: `（有文件没发：${[...new Set(refused)].join('；')}）` });
  if (note) {
    if (items[0]?.kind === 'text') items[0].text = `${note}\n${items[0].text}`;
    else items.unshift({ kind: 'text', text: note });
  }
  for (const f of files) items.push({ kind: 'file', path: f });
  if (!items.length) items.push({ kind: 'text', text: '（做完了，没有要说的）' });
  return items;
}

// ---------------- 输入状态 ----------------
async function typingStart(u, job) {
  const user = state.users[u];
  if (!user?.ctx) return;
  const ticket = await il.getTypingTicket(user.raw, user.ctx);
  if (!ticket || job.done) return;
  job.ticket = ticket;
  let fails = 0;
  const tick = async () => {
    if (job.done) return;
    const ok = await il.sendTyping(user.raw, ticket, 1);
    fails = ok ? 0 : fails + 1;
    if (fails >= 2) clearInterval(job.typingTimer);
  };
  await tick();
  if (job.done) return;
  job.typingTimer = setInterval(tick, 5000);
  job.typingStopTimer = setTimeout(() => typingStop(u, job), cfg.typingMaxMinutes * 60e3);
}

function typingStop(u, job) {
  clearInterval(job.typingTimer);
  clearTimeout(job.typingStopTimer);
  if (job.ticket && !job.typingStopped) {
    job.typingStopped = true;
    il.sendTyping(state.users[u].raw, job.ticket, 2);
  }
}

// ---------------- 发消息（按每条入站的条数额度） ----------------
// 条目：{kind:'text'|'file', text|path, clientId, runId, ephemeral?, isNote?}
// ephemeral（"在做了"、进度、排队提示）过时就没用了：额度紧张或发不出去时直接丢，不占补发名额
function enqueue(u, items, { runId, front = false, ephemeral = false, deliveryKey } = {}) {
  const inbound = inboundContext.getStore();
  if (!deliveryKey && !runId && !ephemeral && inbound && items.every(it => !it.proactive && !it.taskEventId)) deliveryKey = `in:${inbound.id}`;
  if (deliveryKey && state.deliveries[deliveryKey]) return;
  const q = (state.outbox[u] ||= []);
  const add = items.map((it) => ({ ...it, runId, clientId: it.clientId || newClientId(), ...(ephemeral ? { ephemeral: true } : {}) }));
  if (front) q.unshift(...add); else q.push(...add);
  if (deliveryKey) state.deliveries[deliveryKey] = { at: Date.now(), clientIds: add.map(it => it.clientId) };
  save();
}

function reply(u, text, opts = {}) {
  enqueue(u, [{ kind: 'text', text }], opts);
  return flushOutbox(u);
}

function markAutomationDelivery(item, status, details = {}) {
  for (const eventId of deliveryEventIds(item)) automationRuntime?.markDelivery({
    eventId, status, requestPending: automationSends.has(item), ...details,
  });
  if (item.taskEventId && taskRuntime) {
    const result = reduceTaskDelivery(taskRuntime.event(item.taskEventId)?.delivery, item, status, { requestPending: automationSends.has(item), ...details });
    taskRuntime.markDelivery(item.taskEventId, result.status, result.details);
  }
  refreshSelfStatus();
}

function deferHighPriorityAutomation(u, head) {
  if (!deliveryEventIds(head).length || head.proactive?.deliveryPolicy?.priority !== 'high') return false;
  replaceItem(u, head);
  const user = state.users[u];
  const stale = user.staleProactive ||= [];
  if (!stale.includes(head)) stale.push(head);
  save();
  return true;
}

async function flushLateProactive(u) {
  const summaries = await collectProactiveSummary(u);
  if (!summaries.length) return;
  enqueue(u, summaries);
  for (const item of summaries) markAutomationDelivery(item, 'queued');
  await flushOutbox(u);
}

async function replyAndLate(u, text, opts = {}) {
  await reply(u, text, opts); // 当前问题的答案始终先于迟到的主动内容
  await flushLateProactive(u);
}

function scheduleFlush(u, ms) {
  clearTimeout(flushTimers[u]);
  flushTimers[u] = setTimeout(() => flushOutbox(u), ms);
}

function flushOutbox(u) {
  checkAttachments(false);
  if (flushing[u]) return flushing[u].then(() => (state.outbox[u]?.length ? flushOutbox(u) : undefined));
  flushing[u] = doFlush(u).catch((e) => log(`flush error: ${e.stack || e.message}`)).finally(() => { flushing[u] = null; });
  return flushing[u];
}

function dropEphemeral(u) {
  const q = state.outbox[u] || [];
  const kept = q.filter((x) => !x.ephemeral);
  if (kept.length !== q.length) { state.outbox[u] = kept; save(); }
  return state.outbox[u];
}

function mediaTypeOf(f) {
  const ext = path.extname(f).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 1;
  if (['.mp4', '.mov'].includes(ext)) return 2;
  return 3;
}

async function buildFileItem(u, it) {
  if (it.wx) return it.wx;
  const buf = fs.readFileSync(it.path);
  const mt = mediaTypeOf(it.path);
  const up = await il.uploadMedia(state.users[u].raw, buf, mt);
  const media = { encrypt_query_param: up.encrypt_query_param, aes_key: up.aes_key, encrypt_type: 1 };
  if (mt === 1) it.wx = { type: 2, image_item: { media, mid_size: up.cipherSize } };
  else if (mt === 2) it.wx = { type: 5, video_item: { media, video_size: up.cipherSize } };
  else it.wx = { type: 4, file_item: { media, file_name: path.basename(it.path), len: String(up.rawSize) } };
  save();
  return it.wx;
}

// 一段文字在微信里怎么都发不出去时，存到电脑上，换成一句说明
function parkUndeliverable(item) {
  if (item.kind !== 'text') return `（文件发不出去，在电脑上：${item.path}）`;
  const dir = path.join(cfg.workspace, '发出');
  fs.mkdirSync(dir, { recursive: true });
  const f = uniquePath(dir, `未送达-${bjDay(Date.now())}-${bjClock(Date.now())}.txt`);
  fs.writeFileSync(f, item.text);
  return `（有一段内容在微信里发不出去，已存到电脑上：${f}）`;
}

// 能收到消息说明网络通了：清掉因网络失败排的退避，马上补发（prepare-failed 的 5 秒、业务错误的 30 秒照旧）
function clearNetBackoff(u) {
  for (const it of state.outbox[u] || []) if (it.netFails) { it.netFails = 0; delete it.notBefore; }
}

function replaceItem(u, head, ...items) {
  // 按对象找位置：发送途中可能有口令回复插到了最前面，不能按下标删
  const q = state.outbox[u] || [];
  const i = q.indexOf(head);
  if (i >= 0) q.splice(i, 1, ...items);
  save();
}

function noteItem(head, text, level) {
  return { kind: 'text', text, runId: head.runId, clientId: newClientId(), ...(head.proactive ? { proactive:head.proactive, partId:head.partId, proactiveDegraded:true } : {}), noteLevel: level, wasFile: head.wasFile || head.kind === 'file' };
}

function retryLater(u, head, ms) {
  head.notBefore = Date.now() + ms; // 记下最早什么时候能再发，别的触发不能提前重试
  save();
  scheduleFlush(u, ms);
}

const backoff = (n) => Math.min(cfg.networkRetrySeconds * 1000 * 2 ** (n - 1), 600e3);
const NETLIKE = /fetch failed|timeout|aborted|ECONN|ENOTFOUND|EAI_AGAIN|HTTP 5\d\d/i;
const fixedNote = (head) => (head.wasFile
  ? '（有个文件在微信里发不出去，还在电脑上原来的位置）'
  : `（有一段内容在微信里发不出去，已存在电脑的 ${path.join(cfg.workspace, '发出')} 里）`);

// "刚收到新消息"的窗口：本窗口还没成功发出过、离入站不到 90 秒、也没有窗口已坏的迹象（"在做了"之类发失败过）
function freshWindow(user) {
  return (user.sent || 0) === 0 && !user.windowSuspect && Date.now() - (user.inAt || 0) < 90e3;
}

// 发不出去的条目换成什么：卡片图换成卡片的文字（切条），其他存到电脑上换成一句说明
function parkItems(head) {
  if (head.kind !== 'text' && head.fallbackText) {
    return chunkText(head.fallbackText, cfg.chunkChars).map((t) => ({ kind: 'text', text: t, runId: head.runId, clientId: newClientId() }));
  }
  return [noteItem(head, parkUndeliverable(head), 1)];
}

function isQuietNow(now = Date.now()) {
  if (cfg.quietStartHour === cfg.quietEndHour) return false;
  const hour = Math.floor((now + 8 * 3600e3) / 3600e3) % 24;
  return cfg.quietStartHour > cfg.quietEndHour
    ? hour >= cfg.quietStartHour || hour < cfg.quietEndHour
    : hour >= cfg.quietStartHour && hour < cfg.quietEndHour;
}

function quietEndMs(now) {
  const day = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
  const hour = String(cfg.quietEndHour).padStart(2, '0');
  const end = Date.parse(`${day}T${hour}:00:00+08:00`);
  return end > now ? end : end + 86400e3;
}

function followsQuiet(item) {
  const meta = item.proactive;
  if (!meta) return false;
  if (meta.type !== 'automation') return true;
  return meta.deliveryPolicy?.quiet === 'follow'
    || (meta.events || []).some((event) => event.deliveryPolicy?.quiet === 'follow');
}

function isUrgentAutomation(item) {
  if (item?.proactive?.type !== 'automation') return false;
  return deliveryEventIds(item).some((eventId) => automationEvent(eventId)?.deliveryPolicy?.priority === 'high');
}

function usesProactiveDailyBudget(item) {
  const meta = item.proactive;
  if (!meta || item.ephemeral || meta.type === 'reminder') return false;
  if (meta.type !== 'automation') return true;
  return meta.deliveryPolicy?.priority !== 'high'
    && !(meta.events || []).some((event) => event.deliveryPolicy?.priority === 'high');
}

function proactiveDailyLeft() {
  const used = state.proactive.deliveryDate === bjDay(Date.now()) ? (state.proactive.deliveryCount || 0) : 0;
  return Math.max(0, cfg.proactivePerDay - used);
}

function countProactiveDelivery(item) {
  if (item.proactive?.late || !usesProactiveDailyBudget(item)) return;
  const today = bjDay(Date.now());
  if (state.proactive.deliveryDate !== today) {
    state.proactive.deliveryDate = today;
    state.proactive.deliveryCount = 0;
  }
  state.proactive.deliveryCount += 1;
}

function recordProactiveReceipt(head) {
  if (!head.proactive || !head.acceptedReceipt) return;
  updateProactiveReceipt(state.proactiveReceipts ||= {}, head);
  if (cfg.conversationMemory) captureConversation(proactiveRecord(head), CONVERSATION_PATHS);
  save(); refreshSelfStatus();
}

async function doFlush(u) {
  const user = state.users[u];
  const limit = cfg.replyLimitPerMessage;
  while ((state.outbox[u] || []).length && il && !health.needRelogin && !stopping) {
    automationRuntime?.refreshConfig(); // 每次提交微信前复核取消，不能只等调度 tick。
    taskRuntime?.sync();
    if (!user?.ctx) { log('还没有 context_token，等用户先发消息'); return; }
    if (user.cooldownUntil && Date.now() < user.cooldownUntil) { scheduleFlush(u, user.cooldownUntil - Date.now()); return; }
    const accepted = (state.outbox[u] || []).find(item => item.acceptedReceipt);
    if (accepted) { recordProactiveReceipt(accepted); markAutomationDelivery(accepted, 'wechat_accepted', accepted.acceptedReceipt); replaceItem(u, accepted); continue; }
    const obsolete = (state.outbox[u] || []).find(item => !currentWaiting(item));
    if (obsolete) { replaceItem(u, obsolete); continue; }
    const left = limit - (user.sent || 0);
    let q = state.outbox[u];
    if (left <= 2) q = dropEphemeral(u); // 最后几个名额留给正经内容
    if (!q.length) return;
    const obsoleteReceipt=q.find(x=>x.attachmentReceipt&&!receiptCurrent(u,x.attachmentReceipt));
    if(obsoleteReceipt){replaceItem(u,obsoleteReceipt);continue;}
    if (left <= 0) {
      const proactiveItems = q.filter((x) => x.proactive && !x.ephemeral);
      if (proactiveItems.length) { // 名额满时主动内容不占位，合并到下次对话末尾
        for (const item of proactiveItems) markAutomationDelivery(item, 'deferred_window', { reason: 'reply_budget' });
        (user.staleProactive ||= []).push(...proactiveItems);
        state.outbox[u] = q.filter((x) => !x.proactive || x.ephemeral);
        save();
      }
      log(`本条入站的回复额度用完，还有 ${q.length} 条等用户发消息`);
      if (!user.toldMore) { user.toldMore = true; save(); alert('undelivered', 'Dawn 有回复在微信里还没发出去（微信只允许在你每发一条消息后回复有限的几条）。在微信里给 Dawn 发一句「继续」就能收到。', { minIntervalMs: 3600e3 }); }
      return;
    }
    let head = q[0];
    const quiet = isQuietNow();
    const quietUntil = quiet ? quietEndMs(Date.now()) : 0;
    let deliveryChanged = false;
    for (const candidate of q) {
      if (candidate.deferredQuiet && !quiet) {
        delete candidate.deferredQuiet;
        delete candidate.notBefore;
        markAutomationDelivery(candidate, 'queued');
        deliveryChanged = true;
      }
      if (quiet && followsQuiet(candidate)) {
        if (!candidate.deferredQuiet) {
          candidate.deferredQuiet = true;
          candidate.notBefore = Math.max(candidate.notBefore || 0, quietUntil);
          markAutomationDelivery(candidate, 'deferred_quiet', { reason: 'quiet' });
          deliveryChanged = true;
        }
        scheduleFlush(u, Math.max(0, (candidate.notBefore || quietUntil) - Date.now()));
      }
    }
    if (deliveryChanged) save();
    const busy = jobs[u] || pendingStart[u];
    const flushAt = Date.now();
    const blocked = (candidate) => {
      if(candidate.proactive && q.some(x=>x.attachmentFailure))return true;
      if (candidate.notBefore && flushAt < candidate.notBefore) return true;
      if (quiet && followsQuiet(candidate)) return true;
      if(attachmentHold(u) && candidate.proactive && candidate.proactive.type!=='reminder' && !isUrgentAutomation(candidate))return true;
      return busy && candidate.proactive && !isUrgentAutomation(candidate);
    };
    let sendable = q.findIndex((candidate) => !blocked(candidate));
    if (busy) {
      const urgent = q.findIndex((candidate) => !blocked(candidate) && isUrgentAutomation(candidate));
      if (urgent >= 0) sendable = urgent;
    }
    if (sendable < 0) {
      // 定时器可能比 notBefore 提前不足 1ms 唤醒；补排到期时间，避免重试永久搁置。
      const due = q.map(x => x.notBefore).filter(at => at > flushAt);
      if (due.length) scheduleFlush(u, Math.max(1, Math.min(...due) - Date.now()));
      return;
    }
    if (sendable > 0) {
      const deferred = q.splice(0, sendable);
      q.push(...deferred);
      head = q[0];
      save();
    }
    if (head.notBefore && Date.now() < head.notBefore) { scheduleFlush(u, head.notBefore - Date.now()); return; }

    if (head.proactive) {
      const m = head.proactive;
      if (m.waitingKey && !head.firstAttemptAt) {
        const current = JSON.parse(fs.readFileSync(path.join(cfg.workspace,'memory/reminders.json'),'utf8')).find(r=>r.id===m.id);
        if (current && m.text !== current.text) { m.text=current.text; head.text=`跟进一下：${current.text}`; save(); }
      }
      const hours = (Date.now() - (user.inAt || 0)) / 3600e3;
      const digestExpired = m.type === 'digest' && Date.now() > Date.parse(`${m.id}T23:00:00+08:00`);
      if (hours > cfg.proactiveWindowHours || (!m.late && digestExpired)) {
        markAutomationDelivery(head, 'deferred_window', { reason: digestExpired ? 'digest_expired' : 'proactive_window' });
        state.outbox[u].shift();
        if (m.type === 'followup' && hours > cfg.proactiveWindowHours) deferFollowup(m);
        else if (m.type === 'followup') log(`proactive followup ${m.id} 二次过期，不再推送`);
        else (user.staleProactive ||= []).push(head);
        save();
        log(`proactive ${m.type} ${m.id} 过期（${hours.toFixed(1)}h），转待汇总`);
        continue;
      }
      if (!m.late && usesProactiveDailyBudget(head)) {
        const dailyLeft = proactiveDailyLeft();
        const groupSize = m.key ? q.filter((item) => item.proactive?.key === m.key && !item.ephemeral).length : 1;
        if ((m.type === 'digest' ? 1 : groupSize) > dailyLeft) {
          markAutomationDelivery(head, 'deferred_window', { reason: 'daily_budget' });
          state.outbox[u].shift();
          (user.staleProactive ||= []).push(head);
          save();
          log(`proactive ${m.type} ${m.id} 每日总预算不足（剩 ${dailyLeft}），转待汇总`);
          continue;
        }
      }
      log(`proactive ${m.type} ${m.id} hours=${hours.toFixed(1)} 尝试发送`);
    }

    let item = head;
    let noteOnly = false;
    let tailed = false;
    if (left === 1 && q.length > 1 && !deliveryEventIds(head).length && !head.proactive) {
      const more = head.kind === 'text' ? q.length - 1 : q.length;
      const tail = `（后面还有 ${more} 条，回复「继续」接着发）`;
      if (head.kind === 'text') { item = { ...head, text: `${head.text}\n\n${tail}` }; tailed = true; }
      else { item = { kind: 'text', text: tail, clientId: (head.tailClientId ||= newClientId()), runId: head.runId }; noteOnly = true; }
    }

    if (head.proactive && !head.firstAttemptAt) { head.firstAttemptAt=new Date().toISOString(); save(); }
    let r;
    if (item.kind === 'file') {
      automationSends.add(head);
      try {
        if (head.artifactHash && createHash('sha256').update(fs.readFileSync(head.path)).digest('hex') !== head.artifactHash) throw new Error('图片版本已变化，需重新领取当前日报');
        if (head.taskEventId) {
          const event = taskRuntime?.event(head.taskEventId);
          const task = event && taskRuntime?.snapshot().tasks[event.taskId];
          const expected = head.taskArtifactSha256 || (task && userArtifacts(task).find(artifact => artifact.path === head.path)?.sha256);
          if (expected && createHash('sha256').update(fs.readFileSync(head.path)).digest('hex') !== expected) {
            throw new Error('成果内容已变化，需要核对后再发');
          }
        }
        const wx = await buildFileItem(u, head);
        taskRuntime?.sync();
        if (head.taskEventId && taskRuntime?.event(head.taskEventId)?.withdrawRequestedAt) {
          automationSends.delete(head);
          markAutomationDelivery(head, 'withdrawn', { reason: 'cancelled_before_send' });
          replaceItem(u, head); continue;
        }
        markAutomationDelivery(head, 'queued', { clientId: item.clientId });
        r = await il.sendItem(user.raw, user.ctx, wx, item.runId, item.clientId);
        taskRuntime?.sync();
      } catch (e) {
        automationSends.delete(head);
        log(`upload failed: ${e.message}`);
        const pollOk = health.lastPollOkAt && Date.now() - health.lastPollOkAt < 120e3 && !firstFailAt;
        if (NETLIKE.test(e.message) && ((head.netFails || 0) < 8 || !pollOk)) {
          markAutomationDelivery(head, 'retrying', { lastError: 'upload_network' });
          head.netFails = (head.netFails || 0) + 1; retryLater(u, head, backoff(head.netFails)); return;
        }
        markAutomationDelivery(head, 'failed', { lastError: 'upload_failed' });
        if (head.fallbackText) replaceItem(u, head, ...chunkText(head.fallbackText, cfg.chunkChars).map((t) => ({ kind: 'text', text: t, runId: head.runId, clientId: newClientId() })));
        else replaceItem(u, head, noteItem(head, `（文件没发出去：${e.message.slice(0, 80)}。在电脑上：${head.path}）`, 1));
        continue;
      } finally { automationSends.delete(head); }
    } else {
      automationSends.add(head);
      markAutomationDelivery(head, 'queued', { clientId: item.clientId });
      try {
        if(head.attachmentReceipt){const e=state.inbox[head.attachmentReceipt];e.attachmentAckAttempts=(e.attachmentAckAttempts||0)+1;e.attachmentAckAttemptAt=Date.now();save();}
        r = await il.sendText(user.raw, user.ctx, item.text, item.runId, item.clientId);
        automationRuntime?.refreshConfig();
        taskRuntime?.sync();
      } finally { automationSends.delete(head); }
    }
    log(`send ${item.kind}${head.ephemeral ? '(eph)' : ''} -> ${r.status}${r.errmsg ? ` (${r.errmsg})` : ''}`);
    const cancelledDuringSend = deliveryEventIds(head).some(id => automationEvent(id)?.delivery.cancelRequestedAt)
      || (head.taskEventId && taskRuntime?.event(head.taskEventId)?.withdrawRequestedAt);
    if (cancelledDuringSend && !r.ok && r.status !== 'suspect-dropped') {
      // 请求已发出，网络错误不能证明没送达；不重试已取消的正文，也不谎报撤回。
      markAutomationDelivery(head, 'unknown', { reason: 'cancelled_during_send', lastError: r.status, clientId: head.clientId });
      replaceItem(u, head);
      continue;
    }

    if (r.ok || r.status === 'suspect-dropped') {
      if(head.attachmentReceipt)for(const e of waitingAttachments(u))e.attachmentAckAt=Date.now();
      user.sent = (user.sent || 0) + 1;
      countProactiveDelivery(head);
      user.rl = 0;
      if (noteOnly || tailed) user.toldMore = true;
      if (r.status === 'suspect-dropped') {
        user.suspectRun = (user.suspectRun || 0) + 1;
        if (user.suspectRun >= 3) alert('dropped', 'Dawn 发往微信的消息显示成功、但没有回执（连续 3 条）。你那边要是没收到，多半是微信风控限了这条通道，一般几天内会自己恢复。', { minIntervalMs: 24 * 3600e3 });
      } else user.suspectRun = 0;
      if (noteOnly) { delete head.tailClientId; save(); return; }
      if (r.ok && head.proactive) { head.acceptedReceipt = { at: new Date().toISOString(), messageId: r.messageId, clientId: head.clientId }; save(); recordProactiveReceipt(head); }
      markAutomationDelivery(head, r.status, { messageId: r.messageId, clientId: head.clientId });
      if (r.status === 'suspect-dropped' && !cancelledDuringSend && deferHighPriorityAutomation(u, head)) continue;
      replaceItem(u, head);
      continue;
    }
    if (head.attachmentReceipt){replaceItem(u,head);scheduleFlush(u,30000);if(r.status==='stale-token')onStale('sendmessage');return;}
    if (r.status === 'stale-token') { markAutomationDelivery(head, 'retrying', { lastError: 'stale-token' }); onStale('sendmessage'); return; }
    if (head.ephemeral) {
      // 过时提示发不出去就算了；但失败本身是线索，照常冷却或标记
      replaceItem(u, head);
      if (r.status === 'prepare-failed') { user.windowSuspect = true; save(); continue; }
      if (r.status === 'rate-limited') { user.cooldownUntil = Date.now() + cfg.rateLimitCooldownSeconds * 1000; save(); scheduleFlush(u, cfg.rateLimitCooldownSeconds * 1000); return; }
      if (r.status === 'network') { scheduleFlush(u, cfg.networkRetrySeconds * 1000); return; }
      continue;
    }
    if (r.status === 'rate-limited') {
      markAutomationDelivery(head, 'retrying', { lastError: 'rate-limited' });
      user.rl = (user.rl || 0) + 1;
      if (user.rl >= 3) {
        // 连着几次限流，多半是这条入站的额度已经用完：别再试了，等用户下一条消息
        user.rl = 0;
        user.sent = limit;
        save();
        continue;
      }
      user.cooldownUntil = Date.now() + cfg.rateLimitCooldownSeconds * 1000;
      save();
      scheduleFlush(u, cfg.rateLimitCooldownSeconds * 1000);
      return;
    }
    if (r.status === 'prepare-failed') {
      markAutomationDelivery(head, 'retrying', { lastError: 'prepare-failed' });
      const recentIn = (user.sent || 0) === 0 && Date.now() - (user.inAt || 0) < 90e3;
      if (recentIn) {
        // 刚收到新消息、第一条就发不出去：先隔几秒再试一次，排除服务器抽风
        head.freshFails = (head.freshFails || 0) + 1;
        if (head.freshFails === 1) { retryLater(u, head, 5000); return; }
      }
      if (deliveryEventIds(head).length) {
        if (!freshWindow(user)) {
          markAutomationDelivery(head, 'deferred_window', { reason: 'prepare-failed' });
          user.sent = limit;
          save();
          continue;
        }
        head.attempts = (head.attempts || 0) + 1;
        if (head.attempts >= 3) {
          markAutomationDelivery(head, 'failed', { lastError: 'prepare-failed' });
          if (deferHighPriorityAutomation(u, head)) continue;
          replaceItem(u, head);
          continue;
        }
        retryLater(u, head, 30e3);
        return;
      }
      if (freshWindow(user)) {
        // 还是不行，又没有窗口已坏的迹象：多半是这条内容本身的问题（太长、被拦）
        if (head.noteLevel === 2) { log('连固定说明都发不出去，丢掉'); replaceItem(u, head); continue; }
        if (head.noteLevel === 1) { replaceItem(u, head, { ...noteItem(head, fixedNote(head), 2), wasFile: head.wasFile }); continue; }
        if (head.taskEventId) {
          markAutomationDelivery(head, 'failed', { lastError: 'prepare-failed' });
          replaceItem(u, head, ...parkItems(head));
        } else if (head.kind === 'text' && [...head.text].length > 300 && !head.halved) {
          const half = Math.ceil([...head.text].length / 2) + 20;
          const parts = chunkText(head.text, half).map((t) => ({ kind: 'text', text: t, runId: head.runId, clientId: newClientId(), halved: true }));
          log(`一条 prepare failed，对半切成 ${parts.length} 段重试`);
          replaceItem(u, head, ...parts);
        } else {
          log('一条内容反复 prepare failed，存到电脑上');
          replaceItem(u, head, ...parkItems(head));
        }
        continue;
      }
      // 回复窗口过期或条数用完：留着，等用户下一条消息再发
      user.sent = limit;
      save();
      continue;
    }
    if (r.status === 'network') {
      // 断网、超时、5xx：结果不确定，用同一个 client_id 退避重试，不丢。
      // 但长轮询一直是通的、只有这一条反复失败，多半是这条本身有问题：试 8 次（约 45 分钟）后存到电脑上
      markAutomationDelivery(head, 'retrying', { lastError: 'network' });
      head.netFails = (head.netFails || 0) + 1;
      const pollOk = health.lastPollOkAt && Date.now() - health.lastPollOkAt < 120e3 && !firstFailAt;
      if (head.netFails >= 8 && pollOk) {
        log('一条内容在网络正常时反复发送失败，存到电脑上');
        if (deliveryEventIds(head).length || head.taskEventId) {
          markAutomationDelivery(head, 'failed', { lastError: 'network' });
          if (deferHighPriorityAutomation(u, head)) continue;
          replaceItem(u, head);
        } else if (head.noteLevel === 2) replaceItem(u, head);
        else replaceItem(u, head, ...(head.noteLevel === 1 ? [{ ...noteItem(head, fixedNote(head), 2), wasFile: head.wasFile }] : parkItems(head)));
        continue;
      }
      retryLater(u, head, backoff(head.netFails));
      return;
    }
    // 明确的业务错误码：试 3 次，还不行就存到电脑上
    head.attempts = (head.attempts || 0) + 1;
    if (head.attempts >= 3) {
      log('发送 3 次被拒，存到电脑上');
      markAutomationDelivery(head, 'failed', { lastError: r.status });
      if (deferHighPriorityAutomation(u, head)) continue;
      if (deliveryEventIds(head).length || head.noteLevel) replaceItem(u, head); else replaceItem(u, head, ...parkItems(head));
      continue;
    }
    markAutomationDelivery(head, 'retrying', { lastError: r.status });
    retryLater(u, head, 30e3);
    return;
  }
}

// ---------------- 到点提醒与跟进（dawn-personal-agent 第二期） ----------------
// Dawn 在 memory/reminders.json 里写：[{id,at,text,type}]，type=reminder（到点提醒）或 followup（跟进）
// 到点提醒不占预算；followup 受每日上限、闲置降频和 proactive.json 的开关约束。投递复用 outgoing 通道。
function followupsEnabled() {
  try { const j = JSON.parse(fs.readFileSync(path.join(cfg.workspace, 'memory', 'proactive.json'), 'utf8')); return j.followups !== false; } catch { return true; }
}
function checkReminders() {
  if (!cfg.reminders || !owner || stopping || health.needRelogin) return;
  let list;
  try { list = JSON.parse(fs.readFileSync(path.join(cfg.workspace, 'memory', 'reminders.json'), 'utf8')); } catch { return; }
  if (!Array.isArray(list)) return;
  const now = Date.now();
  const hour = Math.floor((now + 8 * 3600e3) / 3600e3) % 24;
  const quiet = cfg.quietStartHour === cfg.quietEndHour ? false
    : cfg.quietStartHour > cfg.quietEndHour ? (hour >= cfg.quietStartHour || hour < cfg.quietEndHour)
    : (hour >= cfg.quietStartHour && hour < cfg.quietEndHour);
  if (quiet) return; // 到点的事不丢，早上静默结束后自然补发
  const today = bjDay(now);
  if (state.proactive.date !== today) state.proactive = { date: today, count: 0 };
  let changed = false;
  for (const r of list) {
    if (!r || !r.id || !r.at || !r.text) continue;
    const due = Date.parse(r.at);
    if (Number.isNaN(due) || due > now) continue;
    const fname = `r:${r.id}-${r.at}`.replace(/[^A-Za-z0-9_:.-]/g, '_'); // id+时间做键，顺延过/复用 id 的提醒不会被误跳过
    if (state.remindersDone[fname]) continue;
    const type = r.type === 'followup' ? 'followup' : 'reminder';
    if (type === 'followup') {
      if (!followupsEnabled()) continue;
      if (state.proactive.count >= cfg.followupPerDay) continue;
      if (cfg.followupIdleDays > 0 && now - (state.users[owner]?.inAt || 0) > cfg.followupIdleDays * 86400e3) continue;
    }
    const text = type === 'followup' ? `跟进一下：${r.text}` : `⏰ 提醒：${r.text}`;
    try {
      state.proactiveMeta ||= {};
      state.proactiveMeta[`${fname}.txt`] = { type, at: r.at, text: r.text, deferred: !!r.deferred, waitingKey: r.waitingKey };
      const tmp = path.join(OUTGOING, `${fname}.tmp`);
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, path.join(OUTGOING, `${fname}.txt`));
      state.remindersDone[fname] = now;
      if (type === 'followup') state.proactive.count += 1;
      changed = true;
      log(`提醒投递 ${fname}（${type}）`);
    } catch (e) { log(`提醒写入失败 ${fname}: ${e.message}`); }
  }
  if (changed) save();
}

// 跟进第一次错过窗口：顺延到第二天 09:00（只顺延一次，第二次过期就不再推送）
function currentWaiting(item) {
  const m = item.proactive;
  if (!m?.waitingKey) return true;
  try { return waitingReminderCurrent(m, JSON.parse(fs.readFileSync(path.join(cfg.workspace, 'memory/reminders.json'), 'utf8'))); }
  catch { return false; }
}
function deferFollowup(m) {
  try {
    const at = mutateMemory(MEMORY_PATHS, ({read}) => {
      const list = JSON.parse(read('reminders.json') || '[]');
      const entry = list.find(x => x?.id === m.id);
      if (!entry || entry.deferred || !waitingReminderCurrent(m,list)) return {edits:new Map(),result:null};
      entry.at = `${bjDay(Date.parse(m.at) + 86400e3)}T09:00:00+08:00`;
      entry.deferred = true;
      return {edits:new Map([['reminders.json',JSON.stringify(list,null,2)+'\n']]),result:entry.at};
    });
    if (at) log(`proactive followup ${m.id} 窗口已过，顺延到 ${at}`);
  } catch (e) { log(`followup 顺延失败 ${m.id}: ${e.message}`); }
}

// 主动内容排在回答之后，保留实际正文、图片分片和各来源身份。
async function collectProactiveSummary(u) {
  if (flushing[u]) await flushing[u]; // 不得移除正在发送的对象再以新 clientId 重发
  automationRuntime?.refreshConfig();
  taskRuntime?.sync();
  const user = state.users[u];
  const quiet = isQuietNow();
  const pending = (state.outbox[u] || []).filter((x) => x.proactive && !x.ephemeral && !x.deferredQuiet);
  const stale = (user.staleProactive || []).filter((x) => !x.deferredQuiet || !quiet);
  if (!pending.length && !stale.length) return [];
  state.outbox[u] = (state.outbox[u] || []).filter((x) => !x.proactive || x.ephemeral || x.deferredQuiet);
  user.staleProactive = (user.staleProactive || []).filter((x) => x.deferredQuiet && quiet);
  const all = [...stale, ...pending];
  const automation = all.filter((item) => deliveryEventIds(item).length);
  const taskItems = all.filter(item => item.taskEventId);
  const digestItems = all.filter(item => item.proactive?.type === 'digest').map(item => ({...item, proactive:{...item.proactive,late:true}}));
  const ordinary = all.filter((item) => !deliveryEventIds(item).length && !item.taskEventId && item.proactive?.type !== 'digest');
  const items = [...groupAutomationItems(automation), ...taskItems, ...digestItems,
    ...ordinary.map(item => ({...item, proactive:{...item.proactive,late:true}}))];
  log(`proactive 积压合并 ${ordinary.length} 条，监测事件 ${automation.length} 条`);
  return items;
}

// 主动消息的类型和来源元数据：日报/复盘/提醒/跟进/其他通知。用于有效期、顺延、合并和降级
function recordProactiveOutbox(type, id) {
  if (!id) return;
  state.proactiveOutbox ||= {};
  const now = new Date().toISOString();
  const entry = state.proactiveOutbox[`${type}:${id}`] ||= { firstOutboxedAt: now };
  entry.lastOutboxedAt = now;
}

function proactiveMetaFor(name, raw) {
  if (name.startsWith('digest-')) {
    const id = name.slice(7, -4);
    recordProactiveOutbox('digest', id);
    return { type: 'digest', id, at: Date.now(), key: name, text: raw.replace(/\[\[发送文件:[^\]]*\]\]/g, '').trim() };
  }
  if (name.startsWith('weekly-review-')) {
    const id = name.slice(0, -4);
    recordProactiveOutbox('review', id);
    return { type: 'review', id, at: Date.now(), key: name, text: raw.replace(/\[\[发送文件:[^\]]*\]\]/g, '').trim() };
  }
  if (name.startsWith('r:')) {
    const m = state.proactiveMeta?.[name] || {};
    return { type: m.type || 'reminder', id: name.slice(2).replace(/-\d{4}-\d{2}-\d{2}T.*$/, ''), at: m.at || Date.now(), text: m.text || raw.slice(0, 80), deferred: m.deferred, waitingKey: m.waitingKey, key: name };
  }
  return { type: 'notice', id: name, at: Date.now(), key: name, text: raw.replace(/\[\[发送文件:[^\]]*\]\]/g, '').trim() };
}

// ---------------- 可恢复工作任务：复用同一微信队列 ----------------
function withdrawTaskNotifications(ids) {
  const inFlight = new Set();
  let changed = false;
  const keep = item => {
    if (item.acceptedReceipt || !ids.has(item.taskEventId)) return true;
    if (item.acceptedReceipt || automationSends.has(item)) { inFlight.add(item.taskEventId); return true; }
    if (taskRuntime?.event(item.taskEventId)?.withdrawRequestedAt) markAutomationDelivery(item, 'withdrawn', { reason: 'cancelled' });
    changed = true; return false;
  };
  for (const u of Object.keys(state.outbox)) state.outbox[u] = state.outbox[u].filter(keep);
  for (const user of Object.values(state.users)) if (user.staleProactive) user.staleProactive = user.staleProactive.filter(keep);
  if (changed) save();
  return inFlight;
}
async function emitTaskNotification(event) {
  if (event.withdrawRequestedAt) return { status: 'withdrawn' };
  if (!owner || !state.users[owner]?.ctx) return { status: 'pending' };
  const existing = () => [...Object.values(state.outbox).flat(), ...Object.values(state.users).flatMap(u => u.staleProactive || [])]
    .some(item => item.taskEventId === event.id);
  if (!existing()) {
    const items = await composeReply({ text: event.text, texts: [], isError: false }, '');
    const current = taskRuntime?.event(event.id) || event;
    if (current.withdrawRequestedAt) return { status: 'withdrawn' };
    if (existing()) return { status: 'queued' };
    const resolved = file => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
    const present = new Set(items.filter(item => item.kind === 'file').map(item => resolved(item.path)));
    const task = taskRuntime?.snapshot().tasks[event.taskId];
    const expectedArtifacts = event.kind === 'completed' && task ? userArtifacts(task) : [];
    const expectedHashes = new Map(expectedArtifacts.map(artifact => [resolved(artifact.path), artifact.sha256]));
    const missing = expectedArtifacts.filter(artifact => {
      if (!present.has(resolved(artifact.path))) return true;
      try { return createHash('sha256').update(fs.readFileSync(artifact.path)).digest('hex') !== artifact.sha256; } catch { return true; }
    });
    const unavailable = new Set(missing.map(artifact => resolved(artifact.path)));
    const deliverable = items.filter(item => item.kind !== 'file' || !unavailable.has(resolved(item.path)));
    const changed = missing.filter(artifact => present.has(resolved(artifact.path)));
    if (changed.length) deliverable.push({ kind: 'text', text: `（有文件没发：${changed.map(artifact => artifact.name).join('、')} 的内容已变化，需核对后交付）` });
    const partCount = deliverable.length + missing.length;
    (state.outbox[owner] ||= []).push(...deliverable.map((item, index) => ({
      ...item, taskEventId: event.id, taskPartIndex: index, taskPartCount: partCount,
      ...(item.kind === 'file' && expectedHashes.has(resolved(item.path)) ? { taskArtifactSha256: expectedHashes.get(resolved(item.path)) } : {}),
      clientId: `dawn-${event.id}${index ? `-${index}` : ''}`,
      proactive: { type: 'task', id: event.taskId, key: event.id, at: Date.parse(event.createdAt), text: event.text, deliveryPolicy: { quiet: 'follow' } },
    })).filter(item => current.delivery.parts?.[item.taskPartIndex]?.status !== 'wechat_accepted'));
    save();
    for (const [offset, artifact] of missing.entries()) {
      const index = deliverable.length + offset;
      markAutomationDelivery({ taskEventId: event.id, taskPartIndex: index, taskPartCount: partCount, clientId: `dawn-${event.id}-${index}` },
        'failed', { lastError: 'artifact_unavailable', artifact: artifact.name });
    }
  }
  flushOutbox(owner);
  return { status: 'queued' };
}
function startTasks() {
  if (cfg.persistentTasks === false) return;
  taskRuntime = createTaskRuntime({
    ...TASK_PATHS, contextEnabled: true, experienceEnabled: true, memoryRecords: () => cfg.memoryInject === false ? [] : memoryContext(MEMORY_PATHS).records,
    runStep: createTaskRunner(cfg, { onRuntimeWarnings: issues => alert('codex-runtime', `Dawn 后台工具自检：${issues.join('；')}`) }),
    contextRevision: () => cfg.memoryInject === false ? 'disabled' : memoryContext(MEMORY_PATHS).revision,
    canStart: () => inboxReady && !stopping && !Object.keys(jobs).length && !Object.keys(pendingStart).length,
    emitNotification: emitTaskNotification, withdrawNotifications: withdrawTaskNotifications,
    hasNotification: id => [...Object.values(state.outbox).flat(), ...Object.values(state.users).flatMap(u => u.staleProactive || [])].some(item => item.taskEventId === id),
    log: entry => log(`task ${JSON.stringify(entry)}`),
    intervalMs: cfg.taskIntervalMs || 1000,
  });
  taskRuntime.start();
}

// ---------------- 长期主动任务：运行时、事件对账与真实投递 ----------------
function automationEvent(eventId) {
  const snapshot = automationRuntime?.getSnapshot();
  for (const taskState of Object.values(snapshot?.tasks || {})) {
    if (taskState.events?.[eventId]) return taskState.events[eventId];
  }
  return null;
}

function withdrawAutomationNotifications(cancelledIds, lookupEvent) {
  let changed = false;
  const inFlight = new Set();
  const prune = items => items.flatMap(item => {
    if (item.acceptedReceipt || automationSends.has(item)) {
      for (const id of deliveryEventIds(item)) inFlight.add(id);
      return [item];
    }
    const kept = withdrawAutomationEvents(item, cancelledIds, lookupEvent);
    if (kept.length === 1 && kept[0] === item) return kept;
    changed = true;
    return kept.map(part => ({ ...part, clientId: newClientId() }));
  });
  for (const [u, items] of Object.entries(state.outbox)) state.outbox[u] = prune(items);
  for (const user of Object.values(state.users)) if (user.staleProactive) user.staleProactive = prune(user.staleProactive);
  if (changed) save();
  return inFlight;
}

function automationMetaFor(eventId, raw) {
  const event = automationEvent(eventId);
  const detectedAt = event?.detectedAt || new Date().toISOString();
  return {
    type: 'automation', id: eventId, eventId,
    taskId: event?.taskId || 'unknown', detectedAt,
    at: Date.parse(detectedAt) || Date.now(),
    deliveryPolicy: event?.deliveryPolicy || {},
    key: `a:${eventId}.txt`, text: event?.text || raw,
  };
}

function automationRecords() {
  const records = [];
  try {
    for (const name of fs.readdirSync(OUTGOING)) {
      const match = /^a:([A-Za-z0-9_-]+)\.txt(\.sending)?$/.exec(name);
      if (match) records.push({ eventId: match[1], kind: match[2] ? 'sending' : 'outgoing', path: path.join(OUTGOING, name) });
    }
  } catch { /* 目录尚未创建 */ }
  for (const [u, items] of Object.entries(state.outbox)) {
    for (const item of items) for (const eventId of deliveryEventIds(item)) {
      records.push({ eventId, kind: 'outbox', groupId: item.proactive?.groupId, path: `outbox:${u}` });
    }
  }
  for (const [u, user] of Object.entries(state.users)) {
    for (const item of user.staleProactive || []) for (const eventId of deliveryEventIds(item)) {
      records.push({ eventId, kind: 'stale', groupId: item.proactive?.groupId, path: `stale:${u}` });
    }
  }
  return records;
}

async function reconcileAutomations() {
  if (automationRuntime) await automationRuntime.reconcileNotification(automationRecords());
}

function automationReference(eventId) {
  for (const [u, items] of Object.entries(state.outbox)) {
    const item = items.find((entry) => deliveryEventIds(entry).includes(eventId));
    if (item) return { kind: 'outbox', u, item };
  }
  for (const [u, user] of Object.entries(state.users)) {
    const item = (user.staleProactive || []).find((entry) => deliveryEventIds(entry).includes(eventId));
    if (item) return { kind: 'stale', u, item };
  }
  for (const suffix of ['.txt', '.txt.sending']) {
    const file = path.join(OUTGOING, `a:${eventId}${suffix}`);
    if (fs.existsSync(file)) return { kind: 'outgoing', path: file };
  }
  return null;
}

function automationWindowOpen(u) {
  const user = state.users[u];
  return !!user?.ctx && Date.now() - (user.inAt || 0) <= cfg.proactiveWindowHours * 3600e3
    && (user.sent || 0) < cfg.replyLimitPerMessage;
}

async function emitAutomationNotification(notification) {
  const { eventId, text } = notification;
  const existing = automationReference(eventId);
  if (existing?.kind === 'stale') {
    if (!automationWindowOpen(existing.u)) return { status: 'deferred_window' };
    const user = state.users[existing.u];
    user.staleProactive = (user.staleProactive || []).filter((item) => item !== existing.item);
    (state.outbox[existing.u] ||= []).push(existing.item);
    save();
    // 普通主动内容仍等回答末尾统一 drain；可信 high 事件可在忙碌时进入同一发送链。
    if (isUrgentAutomation(existing.item) || (!jobs[existing.u] && !pendingStart[existing.u])) flushOutbox(existing.u);
    return { status: 'queued' };
  }
  if (existing?.kind === 'outbox') return { status: 'retrying', deduped: true };
  if (existing) return { status: 'queued', deduped: true };
  const finalPath = path.join(OUTGOING, `a:${eventId}.txt`);
  const temporary = `${finalPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, finalPath);
  return { status: 'queued' };
}

async function startAutomations() {
  if (!AUTOMATIONS_ENABLED) return;
  const adapters = createAutomationAdapters({ cfg });
  automationRuntime = createAutomationRuntime({
    ...adapters,
    configPath: AUTOMATION_PATHS.config,
    statePath: AUTOMATION_PATHS.state,
    controlPath: AUTOMATION_PATHS.control,
    outgoingDir: OUTGOING,
    quietHours: { startHour: cfg.quietStartHour, endHour: cfg.quietEndHour },
    loopIntervalMs: cfg.automationLoopIntervalMs ?? 5000,
    stopTimeoutMs: cfg.automationStopTimeoutMs ?? 5000,
    isDeliveryWindowOpen: () => !!owner && automationWindowOpen(owner),
    emitNotification: emitAutomationNotification,
    withdrawNotifications: withdrawAutomationNotifications,
    log: (event) => log(`automation ${JSON.stringify(event).slice(0, 500)}`),
    alert: (event) => {
      const key = createHash('sha1').update(`${event.event || 'error'}:${event.taskId || 'global'}:${event.code || '-'}:${event.eventId || ''}`).digest('hex').slice(0, 12);
      const text = event.event === 'automation_delivery_doorbell'
        ? `Dawn 有一条重要提醒发不出去（${event.taskName || event.taskId || '任务'}）。在微信里给 Dawn 发任意一句话就能收到。`
        : `Dawn 长期任务需要注意（${event.event || 'error'}，${event.taskId || '-'}，${event.code || '-'}）。`;
      alert(`automation-${key}`, text);
    },
  });
  await reconcileAutomations();
  await automationRuntime.start();
}

// ---------------- 投递箱：本机别的程序要通知用户时，往 outgoing/ 放一个 .txt（先写临时名再改名） ----------------
// 内容和 Codex 的回复一样处理：可以带卡片和发文件标记。仍受"用户发消息后才能回、每条入站最多 9 条"的限制。
const OUTGOING = path.join(HOME, 'outgoing');
let outgoingBusy = false;
let outgoingWaitLogged = false;
let outgoingPromise = null;
async function doCheckOutgoing() {
  if (outgoingBusy || !il || !owner || stopping || health.needRelogin) return;
  const busy = jobs[owner] || pendingStart[owner];
  let names;
  try { names = fs.readdirSync(OUTGOING).filter((n) => n.endsWith('.txt')).sort(); } catch { return; }
  if (!names.length) return;
  if (!state.users[owner]?.ctx) {
    if (!outgoingWaitLogged) { outgoingWaitLogged = true; log('投递箱：用户还没发过消息，暂时发不了'); }
    return;
  }
  outgoingWaitLogged = false;
  outgoingBusy = true;
  try {
    for (const n of names) {
      const automation = /^a:([A-Za-z0-9_-]+)\.txt$/.exec(n);
      if (busy && (!automation || !isUrgentAutomation({ proactive: automationMetaFor(automation[1], '') }))) continue;
      const f = path.join(OUTGOING, n);
      try { if (Date.now() - fs.statSync(f).mtimeMs < 2000) continue; } catch { continue; } // 可能还没写完
      const sending = `${f}.sending`;
      try { fs.renameSync(f, sending); } catch (e) { log(`投递箱：${n} 改名失败（${e.message}），跳过`); continue; }
      let t = fs.readFileSync(sending, 'utf8').trim();
      if (t) {
        if (automation) {
          // 专用纯文本通道：必须在超长转文件和 composeReply 之前，不解析任何 [[...]]。
          const eventId = automation[1];
          const item = { kind: 'text', text: t, proactive: automationMetaFor(eventId, t), automation: { eventIds: [eventId] } };
          log(`outgoing automation event=${eventId} chars=${Array.from(t).length}`);
          enqueue(owner, [item]);
          markAutomationDelivery(item, 'queued');
        } else {
          if ([...t].length > 5400) {
            // 太长就存成文件发，正文只发开头
            const dir = path.join(cfg.workspace, '发出');
            fs.mkdirSync(dir, { recursive: true });
            const full = uniquePath(dir, `通知-${bjDay(Date.now())}-${bjClock(Date.now())}.txt`);
            fs.writeFileSync(full, t);
            t = `${[...t].slice(0, 400).join('')}…\n\n（全文较长，见文件）\n[[发送文件: ${full}]]`;
          }
          log(`outgoing ${t.length} chars`);
          const meta = proactiveMetaFor(n, t);
          const parts = prepareProactiveItems(meta, await composeReply({ text: t, isError: false, texts: [] }, ''), cfg.workspace);
          enqueue(owner, parts, { deliveryKey: `proactive:${parts[0]?.proactive.groupId}` });
        }
        flushOutbox(owner);
      }
      try { fs.unlinkSync(sending); } catch (e) { log(`投递箱：删不掉 ${n}.sending（${e.message}）`); }
    }
  } finally { outgoingBusy = false; }
}

function checkOutgoing() {
  if (outgoingPromise) return outgoingPromise;
  outgoingPromise = (async () => {
    automationRuntime?.refreshConfig();
    taskRuntime?.sync();
    try { await doCheckOutgoing(); } finally { await reconcileAutomations(); }
  })().finally(() => { outgoingPromise = null; });
  return outgoingPromise;
}

// ---------------- 启停 ----------------
function recoverJobs() {
  for (const [u, j] of Object.entries(state.jobs)) {
    if (j.prompts) continue; // 新版完整执行记录在账号加载后接回。
    enqueue(u, [{ kind: 'text', text: `（Dawn 重启了，上一件「${j.preview}…」被打断。需要的话再发一次。）` }]);
    delete state.jobs[u];
  }
  const users = new Set([...Object.keys(state.waiting), ...Object.keys(state.inflight)]);
  for (const u of users) {
    const list = [...Object.values(state.inflight[u] || {}), ...(state.waiting[u] || [])];
    if (list.length) enqueue(u, [{ kind: 'text', text: `（重启前还有 ${list.length} 条消息没来得及做：${list.map((x) => `「${x}…」`).join('')}。需要的话再发一次。）` }]);
    delete state.waiting[u];
    delete state.inflight[u];
  }
  save();
}

function recoverInbox() {
  const u = owner;
  if (!u) return;
  const current = Object.values(state.inbox).filter(e => e.u === u);
  state.outbox[u]=(state.outbox[u]||[]).filter(x=>!x.attachmentReceipt);
  // 停止意图已保存但效果尚未写完：先收敛取消，再恢复任何执行。
  for (const entry of current) if (entry.status === 'received' && entry.stopTargets) {
    for (const id of entry.stopTargets.queued) if (state.inbox[id]) finishInbound(state.inbox[id], 'cancelled');
    if (state.jobs[u]?.runId === entry.stopTargets.runId) state.jobs[u].cancelRequested = true;
  }
  save();
  const queued = current.filter(e => e.status === 'queued').map(e => e.prompt);
  queue[u] = queued;
  const running = state.jobs[u];
  if (running?.prompts && running.prompts.every(p => state.inbox[p.id]?.u === u)) {
    startJob(u, running.prompts, running).catch(e => log(`recover job error: ${e.message}`));
  } else if (queued.length) {
    queue[u] = [];
    pendingStart[u] = { prompts: queued, firstAt: Date.now() };
  }
  for (const entry of current) if (entry.status === 'received') scheduleInbound(entry);
  inboundDrained(u).then(() => {
    const pending = pendingStart[u];
    if (!stopping && pending && !pending.timer && !jobs[u]) {
      delete pendingStart[u]; startJob(u, pending.prompts).catch(e => log(`recover queue error: ${e.message}`));
    }
  });
}

async function shutdown(sig, code = 0) {
  if (stopping) return;
  stopping = true;
  conversationCuration?.cancel();
  log(`收到 ${sig}，退出`);
  for (const j of Object.values(jobs)) {
    clearTimeout(j.ackTimer); clearInterval(j.progressTimer); typingStop(owner, j);
    j.run?.detach();
  }
  const pending = [automationRuntime?.stop(), taskRuntime?.stop(), outgoingPromise, ...Object.values(flushing)].filter(Boolean);
  await Promise.race([Promise.allSettled(pending), sleep(cfg.automationStopTimeoutMs ?? 5000)]);
  await Promise.race([reconcileAutomations(), sleep(1000)]);
  save();
  if (il) await Promise.race([il.notify('stop'), sleep(1000)]);
  releaseLock(P.lock);
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e?.stack || e}`));
process.on('uncaughtException', (e) => {
  // 状态不明就别硬撑：记下来退出，launchd 会重新拉起
  log(`uncaughtException: ${e?.stack || e}`);
  shutdown('uncaughtException', 1);
});

async function main() {
  if (!acquireLock(P.lock)) {
    log('另一个桥进程正在运行，本进程退出');
    process.exit(0);
  }
  fs.mkdirSync(cfg.workspace, { recursive: true });
  fs.mkdirSync(path.join(cfg.workspace, 'work'), { recursive: true });
  fs.mkdirSync(OUTGOING, { recursive: true, mode: 0o700 });
  // 自动化事件先按 eventId 对账：已有 outbox/stale 文本时不再导入 .sending 冗余副本。
  try {
    recoverAutomationOutgoing({
      outgoingDir: OUTGOING,
      items: Object.values(state.outbox).flat(),
      staleItems: Object.values(state.users).flatMap((user) => user.staleProactive || []),
    });
  } catch (e) { log(`automation outgoing recovery failed: ${e.message}`); }
  // 其他上次处理到一半退出的投递，改回 .txt 重新发
  for (const n of fs.readdirSync(OUTGOING).filter((x) => !x.startsWith('a:') && x.endsWith('.txt.sending'))) {
    try { fs.renameSync(path.join(OUTGOING, n), path.join(OUTGOING, n.replace(/\.sending$/, ''))); } catch { /* ignore */ }
  }
  log(`bridge start pid=${process.pid}`);
  if (cfg.conversationMemory) reportConversationSkips(rebuildConversations(CONVERSATION_PATHS).skipped);
  recoverJobs();
  try { await startAutomations(); } catch (e) { log(`automation start failed: ${e.message}`); }
  try { startTasks(); } catch (e) { log(`task start failed: ${e.code || e.message}`); }
  setInterval(() => { checkAttachments(); checkOutgoing().catch((e) => log(`outgoing error: ${e.message}`)); }, 3000).unref();
  setInterval(() => { try { checkReminders(); } catch (e) { log(`reminders error: ${e.message}`); } }, cfg.remindersIntervalSeconds * 1000).unref();
  setInterval(checkMemoryMaintenance, 30000).unref();
  setInterval(checkConversationMaintenance, 30000).unref();
  setInterval(() => {
    if (stopping || !inboxReady) return;
    for (const entry of Object.values(state.inbox)) {
      if (entry.u === owner && entry.status === 'received' && (entry.retryAfter || 0) <= Date.now()) scheduleInbound(entry);
    }
  }, 30000).unref();
  while (!stopping) {
    try {
      if (!loadAccount()) {
        if (!health.needLogin) { health.needLogin = true; writeHealth(true); log('还没登录，等扫码'); }
        await sleep(5000);
        continue;
      }
      if (health.needRelogin) { await sleep(5000); continue; } // 等新的扫码凭证
      if (!inboxReady) {
        recoverInbox(); inboxReady = true;
        for (const u of Object.keys(state.outbox)) flushOutbox(u);
        checkMemoryMaintenance();
        checkConversationMaintenance();
      }
      await pollOnce();
    } catch (e) {
      log(`main loop error: ${e.stack || e.message}`);
      await sleep(5000);
    }
  }
}

main();
