// 长期主动任务的唯一运行状态 owner。所有持久化修改都经同一个同步 mutateAndSave。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withAutomationControlLock } from './automation-control.mjs';
import { validateAutomationTask as validateSchemaAutomationTask } from './automation-schema.mjs';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL_LIFECYCLES = new Set(['completed', 'cancelled', 'expired']);
const DELIVERY_STATUSES = new Set([
  'queued', 'retrying', 'deferred_quiet', 'deferred_window',
  'wechat_accepted', 'unknown', 'failed', 'withdrawn',
]);

const asDate = (value) => value instanceof Date ? value : new Date(value);
const asIso = (value) => asDate(value).toISOString();
const clone = (value) => structuredClone(value);
const eventIdFor = (key) => `ev_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
const occurrenceIdFor = (task, scheduledFor) => `${task.id}:${task.scheduleGeneration || 1}:${scheduledFor}`;

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

function defaultSleep(ms, { signal } = {}) {
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    if (signal?.aborted) done();
    else signal?.addEventListener('abort', done, { once: true });
  });
}

function shanghaiParts(value) {
  const date = new Date(asDate(value).getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

function fromShanghai(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - SHANGHAI_OFFSET_MS);
}

function parseClock(value = '09:00') {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('INVALID_SCHEDULE_TIME');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('INVALID_SCHEDULE_TIME');
  return { hour, minute };
}

function intervalMs(trigger) {
  if (Number.isFinite(trigger.intervalMs) && trigger.intervalMs > 0) return trigger.intervalMs;
  if (Number.isFinite(trigger.everySeconds) && trigger.everySeconds > 0) return trigger.everySeconds * 1000;
  const minutes = trigger.everyMinutes ?? trigger.intervalMinutes;
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('INVALID_INTERVAL');
  return minutes * 60 * 1000;
}

function nextCalendar(trigger, after, inclusive = false) {
  const afterMs = asDate(after).getTime();
  const parts = shanghaiParts(afterMs);
  const { hour, minute } = parseClock(trigger.time || trigger.atTime || '09:00');
  const type = trigger.type;
  const include = (candidate) => inclusive ? candidate.getTime() >= afterMs : candidate.getTime() > afterMs;

  if (type === 'daily') {
    for (let offset = 0; offset < 3700; offset += 1) {
      const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
      const candidate = fromShanghai(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute);
      if (include(candidate)) return candidate;
    }
  }

  if (type === 'weekly') {
    const days = new Set(trigger.days || trigger.weekdays || [trigger.dayOfWeek]);
    for (let offset = 0; offset < 3700; offset += 1) {
      const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
      if (!days.has(day.getUTCDay() || 7)) continue;
      const candidate = fromShanghai(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute);
      if (include(candidate)) return candidate;
    }
  }

  if (type === 'monthly') {
    const wantedDay = trigger.day ?? trigger.dayOfMonth;
    if (!Number.isInteger(wantedDay) || wantedDay < 1 || wantedDay > 31) throw new Error('INVALID_MONTH_DAY');
    for (let offset = 0; offset < 480; offset += 1) {
      const month = new Date(Date.UTC(parts.year, parts.month - 1 + offset, 1));
      const year = month.getUTCFullYear();
      const monthNumber = month.getUTCMonth() + 1;
      const probe = new Date(Date.UTC(year, month.getUTCMonth(), wantedDay));
      if (probe.getUTCMonth() !== month.getUTCMonth() || probe.getUTCDate() !== wantedDay) continue;
      const candidate = fromShanghai(year, monthNumber, wantedDay, hour, minute);
      if (include(candidate)) return candidate;
    }
  }
  throw new Error('NO_NEXT_OCCURRENCE');
}

function initialNextDue(task, now) {
  const trigger = task.trigger;
  if (trigger.type === 'once') return asIso(trigger.at || trigger.onceAt);
  if (['daily', 'weekly', 'monthly'].includes(trigger.type)) return nextCalendar(trigger, now, true).toISOString();
  if (trigger.type === 'poll') return asIso(now);
  if (trigger.type === 'interval') {
    const every = intervalMs(trigger);
    const nowMs = asDate(now).getTime();
    const anchorMs = trigger.anchorAt ? asDate(trigger.anchorAt).getTime() : nowMs;
    if (anchorMs > nowMs) return asIso(anchorMs);
    return asIso(anchorMs + (Math.floor((nowMs - anchorMs) / every) + 1) * every);
  }
  throw new Error('INVALID_TRIGGER');
}

function nextFromScheduled(task, scheduledFor) {
  const trigger = task.trigger;
  if (trigger.type === 'once') return null;
  if (['daily', 'weekly', 'monthly'].includes(trigger.type)) return nextCalendar(trigger, scheduledFor).toISOString();
  return asIso(asDate(scheduledFor).getTime() + intervalMs(trigger));
}

function nextAfterResume(task, now) {
  if (['daily', 'weekly', 'monthly'].includes(task.trigger.type)) return nextCalendar(task.trigger, now).toISOString();
  if (task.trigger.type === 'poll') return asIso(now);
  if (task.trigger.anchorAt) return initialNextDue(task, now);
  return asIso(asDate(now).getTime() + intervalMs(task.trigger));
}

function collectDue(task, firstDue, now) {
  const occurrences = [];
  let scheduledFor = firstDue;
  const nowMs = asDate(now).getTime();
  while (scheduledFor && asDate(scheduledFor).getTime() <= nowMs && occurrences.length < 100000) {
    occurrences.push(scheduledFor);
    scheduledFor = nextFromScheduled(task, scheduledFor);
  }
  return { occurrences, nextDueAt: scheduledFor };
}

function isQuiet(now, quietHours) {
  if (!quietHours) return false;
  const start = quietHours.startHour ?? quietHours.start ?? 23;
  const end = quietHours.endHour ?? quietHours.end ?? 8;
  if (start === end) return false;
  const parts = shanghaiParts(now);
  const minutes = parts.hour * 60 + parts.minute;
  const startMinutes = start * 60;
  const endMinutes = end * 60;
  return startMinutes > endMinutes
    ? minutes >= startMinutes || minutes < endMinutes
    : minutes >= startMinutes && minutes < endMinutes;
}

function cleanText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function clipText(value, limit) {
  const characters = Array.from(String(value || ''));
  if (characters.length <= limit) return characters.join('');
  return `${characters.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

function beijingText(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return cleanText(value);
  return `${new Date(time + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')} 北京时间`;
}

function notificationText(event) {
  const conclusion = clipText(cleanText(event.conclusion) || cleanText(event.taskName) || '主动任务提醒', 600);
  const lines = [conclusion];
  if (event.canonicalUrl) lines.push(`链接：${clipText(cleanText(event.canonicalUrl), 700)}`);
  lines.push(`检测时间：${beijingText(event.detectedAt)}`);
  if (['once', 'reminder'].includes(event.kind)) lines.push(`原定时间：${beijingText(event.scheduledFor)}`);
  if (event.missedCount) lines.push(`合并遗漏：${event.missedCount} 次`);
  let text = lines.join('\n');
  if (event.evidence) {
    const remaining = 1600 - Array.from(text).length - 1;
    if (remaining > 4) text += `\n${clipText(`证据：${cleanText(event.evidence)}`, remaining)}`;
  }
  return clipText(text, 1600);
}

function emptyTaskState(task, now) {
  const desiredState = task.desiredState || 'active';
  const lifecycle = desiredState === 'cancelled'
    ? 'cancelled'
    : desiredState === 'paused'
      ? 'paused'
      : task.trigger.type === 'poll' ? 'pending' : 'active';
  return {
    lifecycle,
    desiredState,
    revision: task.revision || 1,
    scheduleGeneration: task.scheduleGeneration || 1,
    baselineKey: JSON.stringify({ condition: task.condition || null, sources: task.sources || [] }),
    nextDueAt: initialNextDue(task, now),
    health: lifecycle === 'pending' ? 'needs_attention' : 'unknown',
    blocker: lifecycle === 'pending' ? { code: 'pending_verification' } : null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    runs: [],
    rollups: {},
    events: {},
    sources: {},
    processedOccurrences: {},
  };
}

function invalidTaskState(task) {
  return {
    lifecycle: 'pending',
    desiredState: task.desiredState || 'active',
    revision: task.revision || 1,
    scheduleGeneration: task.scheduleGeneration || 1,
    baselineKey: JSON.stringify({ condition: task.condition || null, sources: task.sources || [] }),
    nextDueAt: null,
    health: 'config_error',
    blocker: { code: 'invalid_task' },
    lastSuccessAt: null,
    consecutiveFailures: 0,
    runs: [],
    rollups: {},
    events: {},
    sources: {},
    processedOccurrences: {},
  };
}

function validTask(task) {
  return task && !task.__invalidTask && typeof task.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(task.id)
    && ['active', 'paused', 'cancelled'].includes(task.desiredState || 'active')
    && task.trigger && ['once', 'daily', 'weekly', 'monthly', 'interval', 'poll'].includes(task.trigger.type);
}

export function createAutomationRuntime(options = {}) {
  const configPath = options.configPath;
  const statePath = options.statePath;
  const outgoingDir = options.outgoingDir;
  const now = options.now || (() => new Date());
  const quietHours = options.quietHours || { startHour: 23, endHour: 8 };
  const reviewBackoffMs = options.reviewBackoffMs || 60_000;
  const reviewMaxBackoffMs = options.reviewMaxBackoffMs ?? 30 * 60_000;
  const log = options.log || (() => {});
  const alert = options.alert || (() => {});
  const sleep = options.sleep || defaultSleep;
  let state;
  try {
    state = readJson(statePath, { version: 1, tasks: {} });
  } catch {
    state = { version: 1, tasks: {}, configError: 'state_error' };
  }
  if (!state.tasks || typeof state.tasks !== 'object') state.tasks = {};
  let configSnapshot = { version: 1, tasks: [] };
  let configError = null;
  let tickPromise = null;
  const manualPromises = new Map();
  let running = false;
  let stopping = false;
  let workController = new AbortController();
  let loopPromise = null;
  let stopPromise = null;

  function save() {
    if (statePath) atomicWriteJson(statePath, state);
  }

  function mutateAndSave(fn) {
    if (typeof fn !== 'function') throw new TypeError('mutateAndSave requires a synchronous function');
    const before = JSON.stringify(state);
    const result = fn(state);
    if (result && typeof result.then === 'function') throw new TypeError('mutateAndSave callback must be synchronous');
    if (JSON.stringify(state) !== before) save();
    return result;
  }

  function readConfig() {
    if (!configPath) return { version: 1, tasks: [] };
    const document = readJson(configPath, { version: 1, tasks: [] });
    let candidate = document;
    if (options.validateAutomationConfig) {
      try {
        const validated = options.validateAutomationConfig(document, { now: asDate(now()).getTime() });
        if (validated === false) throw Object.assign(new Error('INVALID_CONFIG'), { code: 'INVALID_CONFIG' });
        if (validated && validated !== true) candidate = validated;
      } catch (error) {
        if (error?.code === 'INVALID_CONFIG') throw error;
        candidate = document;
      }
    }
    const envelope = Array.isArray(candidate) ? { tasks: candidate } : candidate;
    const rawTasks = envelope?.tasks ?? envelope?.automations;
    if (!envelope || typeof envelope !== 'object' || !Array.isArray(rawTasks)
      || (envelope.version !== undefined && envelope.version !== 1)) {
      throw Object.assign(new Error('INVALID_CONFIG'), { code: 'INVALID_CONFIG' });
    }
    const usedIds = new Set();
    const validateTask = options.validateAutomationTask || validateSchemaAutomationTask;
    const tasks = rawTasks.map((rawTask) => {
      if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) return rawTask;
      try {
        const task = validateTask(rawTask, { now: asDate(now()).getTime() });
        if (usedIds.has(task.id)) return { ...task, __invalidTask: true };
        usedIds.add(task.id);
        return task;
      } catch {
        return { ...rawTask, __invalidTask: true };
      }
    });
    return { ...envelope, tasks };
  }

  function configTasks(document = configSnapshot) {
    const tasks = document.tasks || document.automations || [];
    return options.taskIds ? tasks.filter((task) => options.taskIds.includes(task.id)) : tasks;
  }

  function recordRun(target, task, run) {
    const full = {
      taskId: task.id,
      finishedAt: asIso(now()),
      status: 'success',
      missedCount: 0,
      ...run,
    };
    target.runs ||= [];
    target.runs.push(full);
    target.runs = target.runs.slice(-20);
    for (const staleId of Object.keys(target.processedOccurrences || {}).slice(0, -1000)) {
      delete target.processedOccurrences[staleId];
    }
    const day = asIso(asDate(full.finishedAt).getTime() + SHANGHAI_OFFSET_MS).slice(0, 10);
    target.rollups ||= {};
    const rollup = target.rollups[day] ||= {
      scheduled: 0, success: 0, filtered: 0, failed: 0, notifications: 0, skippedPaused: 0, blockers: {},
    };
    rollup.scheduled += full.status === 'skipped_paused' ? (full.missedCount || 0) : 1 + (full.missedCount || 0);
    if (full.status === 'success') rollup.success += 1;
    else if (full.status === 'skipped_paused') rollup.skippedPaused += 1;
    else if (full.status === 'failed') rollup.failed += 1;
    else rollup.filtered += 1;
    if (full.notified) rollup.notifications += 1;
    if (full.blocker) rollup.blockers[full.blocker] = (rollup.blockers[full.blocker] || 0) + 1;
    const cutoff = asIso(asDate(now()).getTime() - 13 * DAY_MS + SHANGHAI_OFFSET_MS).slice(0, 10);
    for (const key of Object.keys(target.rollups)) {
      if (key < cutoff) delete target.rollups[key];
    }
  }

  function recomputeHealth(current, task) {
    const configuredSources = task.sources || [];
    if (!configuredSources.some((source) => source.canConfirm)) {
      current.health = 'needs_attention';
      current.blocker = { code: 'no_confirmed_source' };
      return;
    }
    const sourceStates = configuredSources.map((source) => ({ source, state: current.sources[source.id] }));
    const failures = sourceStates.filter(({ state }) => state?.lastError);
    const successes = sourceStates.filter(({ state }) => state?.lastSuccessAt && !state.lastError);
    if (current.lifecycle === 'pending' && !successes.some(({ source }) => source.canConfirm)) {
      current.health = failures.length ? 'degraded' : 'needs_attention';
      current.blocker = failures.length
        ? { code: 'source_fetch_failed', sources: failures.map(({ source }) => source.id) }
        : { code: 'pending_verification' };
      return;
    }
    const items = sourceStates.flatMap(({ source, state }) => Object.entries(state?.items || {})
      .map(([itemId, item]) => ({ source, itemId, item })));
    const detailFailure = items.find(({ item }) => item.detailError);
    if (detailFailure) {
      current.health = 'degraded';
      current.blocker = {
        code: 'detail_fetch_failed', sourceId: detailFailure.source.id,
        itemId: detailFailure.itemId, detailError: clone(detailFailure.item.detailError),
      };
      return;
    }
    const pending = items.find(({ item }) => item.pendingReview);
    const reviewDay = asIso(asDate(now()).getTime() + SHANGHAI_OFFSET_MS).slice(0, 10);
    if (pending && current.reviewDaily?.day === reviewDay
      && current.reviewDaily.used >= (options.maxReviewsPerDay ?? 24)) {
      current.health = 'degraded';
      current.blocker = { code: 'review_daily_budget', day: reviewDay };
      return;
    }
    const blocked = items.find(({ item }) => item.reviewBlockedHash);
    if (blocked) {
      current.health = 'degraded';
      current.blocker = {
        code: 'review_permanent_invalid', sourceId: blocked.source.id,
        itemId: blocked.itemId, versionHash: blocked.item.reviewBlockedHash,
      };
      return;
    }
    if (pending) {
      current.health = 'degraded';
      current.blocker = {
        code: 'review_pending', sourceId: pending.source.id,
        itemId: pending.itemId, versionHash: pending.item.pendingReview.versionHash,
      };
      return;
    }
    if (failures.length) {
      current.health = successes.length ? 'partial_degraded' : 'degraded';
      current.blocker = {
        code: successes.length ? 'source_partial_failure' : 'source_fetch_failed',
        sources: failures.map(({ source }) => source.id),
      };
      return;
    }
    current.health = 'healthy';
    current.blocker = null;
  }

  function reconcileHealthAlerts(latest) {
    const nowMs = asDate(now()).getTime();
    const nowIso = asIso(nowMs);
    const issues = [];
    if (latest.configError) issues.push({ taskId: null, code: 'config_error', thresholdMs: 0 });
    for (const [taskId, taskState] of Object.entries(latest.tasks || {})) {
      if (latest.configError || taskState.desiredState === 'cancelled') continue;
      const blockerCode = taskState.blocker?.code;
      let code = null;
      let thresholdMs = 0;
      if (['source_fetch_failed', 'source_partial_failure', 'detail_fetch_failed'].includes(blockerCode)) {
        code = 'source_fetch_failed';
        thresholdMs = 60 * 60_000;
      } else if (blockerCode === 'review_pending') {
        code = 'review_pending';
        thresholdMs = 60 * 60_000;
      } else if (blockerCode === 'review_daily_budget') {
        code = 'review_daily_budget';
      } else if (blockerCode === 'invalid_task') {
        code = 'config_error';
      }
      if (code) issues.push({ taskId, code, thresholdMs });
    }

    const activeKeys = new Set();
    for (const issue of issues) {
      const key = `${issue.taskId || 'global'}:${issue.code}`;
      activeKeys.add(key);
      const records = latest.healthAlerts ||= {};
      const record = records[key] || { since: nowIso, lastAlertAt: null };
      records[key] = record;
      const due = nowMs - asDate(record.since).getTime() >= issue.thresholdMs;
      const throttled = record.lastAlertAt && nowMs - asDate(record.lastAlertAt).getTime() < 6 * 60 * 60_000;
      if (due && !throttled) {
        alert({ event: 'automation_health_degraded', taskId: issue.taskId, code: issue.code, since: record.since, notifiedAt: nowIso });
        record.lastAlertAt = nowIso;
      }
    }
    for (const [key, record] of Object.entries(latest.healthAlerts || {})) {
      if (activeKeys.has(key)) continue;
      const taskId = key.startsWith('global:') ? null : key.split(':')[0];
      const taskState = taskId ? latest.tasks?.[taskId] : null;
      const recovered = taskId
        ? taskState && !taskState.blocker && !['paused', 'cancelled'].includes(taskState.desiredState)
        : !latest.configError;
      const lastAlertAt = record.lastAlertAt;
      delete latest.healthAlerts[key];
      if (recovered && lastAlertAt) {
        alert({ event: 'automation_health_recovered', taskId, code: key.split(':').slice(1).join(':'), since: record.since, recoveredAt: nowIso });
      }
    }
    if (latest.healthAlerts && !Object.keys(latest.healthAlerts).length) delete latest.healthAlerts;
  }

  function markOccurrenceNotified(current, task, occurrenceId, scheduledFor) {
    const run = [...(current.runs || [])].reverse().find((entry) => entry.occurrenceId === occurrenceId);
    if (!run) {
      recordRun(current, task, { occurrenceId, scheduledFor, status: 'success', notified: true });
      return;
    }
    if (run.notified) return;
    run.notified = true;
    const day = asIso(asDate(run.finishedAt).getTime() + SHANGHAI_OFFSET_MS).slice(0, 10);
    const rollup = current.rollups[day] ||= {
      scheduled: 0, success: 0, filtered: 0, failed: 0, notifications: 0, skippedPaused: 0, blockers: {},
    };
    rollup.notifications += 1;
  }

  function withdrawCancelledEvents() {
    const events = Object.values(state.tasks)
      .filter(task => task.desiredState === 'cancelled')
      .flatMap(task => Object.values(task.events || {}));
    if (!events.length) return;
    const ids = new Set(events.map(event => event.id));
    // 清理文件时仅匹配本调度器的事件名，不触碰日报或普通投递。
    if (outgoingDir && fs.existsSync(outgoingDir)) {
      for (const name of fs.readdirSync(outgoingDir)) {
        const match = /^a:([A-Za-z0-9_-]+)\.txt(?:\.sending)?$/.exec(name);
        if (match && ids.has(match[1])) fs.unlinkSync(path.join(outgoingDir, name));
      }
    }
    const lookup = id => {
      for (const task of Object.values(state.tasks)) if (task.events?.[id]) return clone(task.events[id]);
      return null;
    };
    const inFlight = new Set(options.withdrawNotifications?.(ids, lookup) || []);
    mutateAndSave(latest => {
      for (const task of Object.values(latest.tasks)) {
        if (task.desiredState !== 'cancelled') continue;
        for (const event of Object.values(task.events || {})) {
          const delivery = event.delivery;
          delivery.cancelRequestedAt ||= asIso(now());
          if (inFlight.has(event.id) || ['wechat_accepted', 'unknown', 'failed', 'withdrawn'].includes(delivery.status)) continue;
          // 上次请求未返回就退出，或网络回执不确定：撤掉重试，但不能声称消息没发出。
          const uncertain = delivery.requestPending || delivery.lastError === 'network';
          Object.assign(delivery, {
            status: uncertain ? 'unknown' : 'withdrawn',
            reason: uncertain ? 'cancelled_after_uncertain_send' : 'task_cancelled',
            updatedAt: asIso(now()), terminalAt: asIso(now()), revision: (delivery.revision || 0) + 1,
          });
          delete delivery.nextRetryAt;
        }
      }
    });
  }

  function refreshConfig() {
    let nextConfig;
    try {
      nextConfig = readConfig();
      configSnapshot = nextConfig;
      configError = null;
    } catch (error) {
      configError = error?.code === 'ENOENT' ? null : 'config_error';
    }
    mutateAndSave((latest) => {
      latest.configError = configError;
      if (configError) {
        for (const taskState of Object.values(latest.tasks)) {
          taskState.health = 'config_error';
          taskState.blocker = { code: 'config_error' };
        }
        return;
      }
      for (const task of configTasks()) {
        if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
        const current = latest.tasks[task.id];
        if (!validTask(task)) {
          if (typeof task.id !== 'string') continue;
          if (current) {
            current.health = 'config_error';
            current.blocker = { code: 'invalid_task' };
          } else {
            latest.tasks[task.id] = invalidTaskState(task);
          }
          continue;
        }
        try {
          initialNextDue(task, now());
          if (['interval', 'poll'].includes(task.trigger.type)) intervalMs(task.trigger);
        } catch {
          if (current) {
            current.health = 'config_error';
            current.blocker = { code: 'invalid_task' };
          } else {
            latest.tasks[task.id] = invalidTaskState(task);
          }
          continue;
        }
        if (!current) {
          latest.tasks[task.id] = emptyTaskState(task, now());
          continue;
        }
        if (current.blocker?.code === 'invalid_task' && !current.nextDueAt) {
          latest.tasks[task.id] = emptyTaskState(task, now());
          continue;
        }
        const previousDesired = current.desiredState;
        const previousGeneration = current.scheduleGeneration;
        const generationChanged = previousGeneration !== (task.scheduleGeneration || 1);
        const baselineKey = JSON.stringify({ condition: task.condition || null, sources: task.sources || [] });
        const baselineChanged = current.baselineKey !== baselineKey;
        current.desiredState = task.desiredState || 'active';
        current.revision = task.revision || 1;
        current.scheduleGeneration = task.scheduleGeneration || 1;
        current.baselineKey = baselineKey;
        current.health = current.health === 'config_error' ? 'unknown' : current.health;
        current.blocker = current.blocker?.code === 'config_error' ? null : current.blocker;
        if (baselineChanged) current.sources = {};

        if (task.desiredState === 'cancelled') {
          current.lifecycle = 'cancelled';
          continue;
        }
        if (generationChanged) {
          current.sources = {};
          current.processedOccurrences = {};
          current.nextDueAt = initialNextDue(task, now());
          current.lifecycle = task.desiredState === 'paused' ? 'paused' : task.trigger.type === 'poll' ? 'pending' : 'active';
        } else if (task.desiredState === 'paused') {
          if (!TERMINAL_LIFECYCLES.has(current.lifecycle)) current.lifecycle = 'paused';
        } else if (previousDesired === 'paused' && current.lifecycle === 'paused') {
          if (task.trigger.type === 'once') {
            current.lifecycle = asDate(current.nextDueAt).getTime() <= asDate(now()).getTime() ? 'expired' : 'active';
          } else {
            const skipped = current.nextDueAt ? collectDue(task, current.nextDueAt, now()).occurrences.length : 0;
            if (skipped) recordRun(current, task, { status: 'skipped_paused', missedCount: skipped });
            current.nextDueAt = nextAfterResume(task, now());
            current.lifecycle = task.trigger.type === 'poll' ? 'pending' : 'active';
          }
        }
        const expiresAt = task.completion?.expiresAt || task.expiresAt;
        if (expiresAt && asDate(now()).getTime() >= asDate(expiresAt).getTime() && current.lifecycle !== 'completed') {
          current.lifecycle = 'expired';
        }
        if (task.trigger.type === 'once' && current.lifecycle === 'paused'
          && asDate(current.nextDueAt).getTime() <= asDate(now()).getTime()) {
          current.lifecycle = 'expired';
        }
        if (task.trigger.type === 'poll' && ['active', 'pending'].includes(current.lifecycle)
          && !(task.sources || []).some((source) => source.canConfirm)) {
          current.lifecycle = 'pending';
          current.health = 'needs_attention';
          current.blocker = { code: 'no_confirmed_source' };
        }
      }
    });
    withdrawCancelledEvents();
  }

  function workerIsCurrent(task) {
    refreshConfig();
    const configured = configTasks().find((entry) => entry.id === task.id);
    const current = state.tasks[task.id];
    return !stopping && !configError && configured && current
      && configured.desiredState !== 'paused' && configured.desiredState !== 'cancelled'
      && (configured.revision || 1) === (task.revision || 1)
      && (configured.scheduleGeneration || 1) === (task.scheduleGeneration || 1)
      && ['active', 'pending'].includes(current.lifecycle);
  }

  function defaultEmit(notification) {
    if (!outgoingDir) throw new Error('OUTGOING_DIR_REQUIRED');
    fs.mkdirSync(outgoingDir, { recursive: true, mode: 0o700 });
    const finalPath = path.join(outgoingDir, `a:${notification.eventId}.txt`);
    const temporary = `${finalPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, notification.text, { mode: 0o600 });
    fs.renameSync(temporary, finalPath);
    return { status: 'queued' };
  }

  const emitNotification = options.emitNotification || defaultEmit;

  function markDelivery(eventId, status, details = {}) {
    if (typeof eventId === 'object') {
      details = eventId;
      eventId = details.eventId;
      status = details.status;
    }
    if (status === 'delivered') status = 'wechat_accepted';
    if (status === 'suspect-dropped') status = 'unknown';
    if (!DELIVERY_STATUSES.has(status)) return false;
    const normalized = { ...details };
    delete normalized.eventId;
    delete normalized.status;
    if (normalized.messageId == null && normalized.message_id != null) normalized.messageId = String(normalized.message_id);
    delete normalized.message_id;
    if (status === 'wechat_accepted' && normalized.messageId == null) status = 'unknown';
    return mutateAndSave((latest) => {
      for (const taskState of Object.values(latest.tasks)) {
        const event = taskState.events?.[eventId];
        if (!event) continue;
        if (event.delivery.status === 'withdrawn' && !['wechat_accepted', 'unknown'].includes(status)) return false;
        event.delivery = {
          ...event.delivery,
          ...normalized,
          status,
          updatedAt: asIso(now()),
        };
        if (['wechat_accepted', 'failed', 'unknown', 'withdrawn'].includes(status)) {
          if (event.delivery.status !== status || !event.delivery.terminalAt) event.delivery.terminalAt = asIso(now());
        } else {
          delete event.delivery.terminalAt;
        }
        event.delivery.revision = (event.delivery.revision || 0) + 1;
        if (taskState.desiredState !== 'cancelled' && event.deliveryPolicy?.priority === 'high'
          && ['deferred_window', 'unknown', 'failed'].includes(status)
          && !(status === 'deferred_window' && normalized.reason === 'reply_budget')
          && !event.delivery.doorbellAt) {
          event.delivery.doorbellAt = asIso(now());
          alert({ event: 'automation_delivery_doorbell', taskId: event.taskId, eventId, taskName: event.taskName, code: status });
        }
        return true;
      }
      return false;
    });
  }

  async function reconcileNotification(input) {
    let records = input;
    if (records === undefined) {
      records = [];
      if (outgoingDir && fs.existsSync(outgoingDir)) {
        for (const name of fs.readdirSync(outgoingDir)) {
          const match = /^a:([A-Za-z0-9_-]+)\.txt(\.sending)?$/.exec(name)
            || /^a:([A-Za-z0-9_-]+)\.sending$/.exec(name);
          if (!match) continue;
          records.push({
            eventId: match[1],
            kind: name.endsWith('.sending') ? 'sending' : 'outgoing',
            path: path.join(outgoingDir, name),
          });
        }
      }
    }
    if (!Array.isArray(records)) records = records?.records || [];
    const expanded = records.flatMap((record) => (record.eventIds || [record.eventId])
      .filter(Boolean).map((eventId) => ({ ...record, eventId })));
    const matched = [];
    mutateAndSave((latest) => {
      const events = new Map();
      for (const taskState of Object.values(latest.tasks)) {
        for (const event of Object.values(taskState.events || {})) {
          event.delivery.references = [];
          events.set(event.id, event);
        }
      }
      for (const record of expanded) {
        const event = events.get(record.eventId);
        if (!event) continue;
        event.delivery.references.push({
          kind: record.kind || record.location || 'unknown',
          ...(record.path ? { path: record.path } : {}),
          ...(record.groupId ? { groupId: record.groupId } : {}),
        });
        matched.push(record);
      }
    });
    for (const record of matched) {
      if (record.status) markDelivery({ ...record, eventId: record.eventId });
    }
    return { matched: matched.length, unmatched: expanded.length - matched.length };
  }

  function cleanupTerminalEvents() {
    const cutoff = asDate(now()).getTime() - 30 * DAY_MS;
    mutateAndSave((latest) => {
      for (const taskState of Object.values(latest.tasks)) {
        for (const [eventId, event] of Object.entries(taskState.events || {})) {
          const terminal = ['wechat_accepted', 'failed', 'unknown', 'withdrawn'].includes(event.delivery?.status);
          const terminalAt = event.delivery?.terminalAt || event.delivery?.updatedAt || event.detectedAt;
          if (terminal && !(event.delivery.references || []).length && asDate(terminalAt).getTime() <= cutoff) {
            delete taskState.events[eventId];
          }
        }
      }
    });
  }

  async function deliverEvent(taskId, eventId) {
    if (stopping) return false;
    refreshConfig();
    if (state.tasks[taskId]?.desiredState === 'cancelled') return false;
    const snapshot = getSnapshot().tasks[taskId]?.events?.[eventId];
    if (!snapshot) return false;
    const deliveryRevision = snapshot.delivery.revision || 0;
    try {
      const notification = { taskId, eventId, text: snapshot.text, event: clone(snapshot) };
      const result = await emitNotification(notification);
      refreshConfig(); // 发送适配器等待期间可能收到取消；迟到的入箱回执不能复活事件。
      const details = result && typeof result === 'object' ? { ...result } : {};
      const deduped = details.deduped === true;
      delete details.deduped;
      const reportedStatus = typeof result === 'string' ? result : result?.status || 'queued';
      const status = DELIVERY_STATUSES.has(reportedStatus) || ['delivered', 'suspect-dropped'].includes(reportedStatus)
        ? reportedStatus : 'unknown';
      const current = getSnapshot().tasks[taskId]?.events?.[eventId];
      if (current && (current.delivery.revision || 0) === deliveryRevision
        && !(deduped && current.delivery.status === status)) markDelivery(eventId, status, details);
      return true;
    } catch (error) {
      mutateAndSave((latest) => {
        const event = latest.tasks[taskId]?.events?.[eventId];
        if (!event || (event.delivery.revision || 0) !== deliveryRevision) return;
        event.delivery.status = 'retrying';
        event.delivery.nextRetryAt = asIso(asDate(now()).getTime() + reviewBackoffMs);
        event.delivery.updatedAt = asIso(now());
        event.delivery.lastError = error?.code || 'emit_failed';
        event.delivery.revision = (event.delivery.revision || 0) + 1;
      });
      return false;
    }
  }

  async function releaseEvents() {
    const snapshot = getSnapshot();
    const quiet = isQuiet(now(), quietHours);
    for (const [taskId, taskState] of Object.entries(snapshot.tasks)) {
      if (taskState.desiredState === 'cancelled') continue;
      for (const event of Object.values(taskState.events || {})) {
        const status = event.delivery?.status;
        const deliveryRevision = event.delivery?.revision || 0;
        const quietReady = status === 'deferred_quiet' && !quiet;
        const windowReady = status === 'deferred_window'
          && (options.isDeliveryWindowOpen ? await options.isDeliveryWindowOpen(clone(event)) : true);
        const retryReady = status === 'retrying' && (!event.delivery.nextRetryAt || asDate(event.delivery.nextRetryAt) <= now());
        if (!quietReady && !windowReady && !retryReady) continue;
        let shouldDeliver = false;
        mutateAndSave((latest) => {
          const current = latest.tasks[taskId]?.events?.[event.id];
          if (!current || current.delivery.status !== status || (current.delivery.revision || 0) !== deliveryRevision) return;
          if (status !== 'retrying') {
            current.delivery.status = 'retrying';
            current.delivery.updatedAt = asIso(now());
            current.delivery.revision = (current.delivery.revision || 0) + 1;
          }
          shouldDeliver = true;
        });
        if (shouldDeliver) await deliverEvent(taskId, event.id);
      }
    }
  }

  function makeReminderEvent(task, scheduledFor, missedCount) {
    const occurrenceId = occurrenceIdFor(task, scheduledFor);
    const event = {
      id: eventIdFor(occurrenceId),
      taskId: task.id,
      taskName: task.name || task.id,
      kind: task.trigger.type === 'once' ? 'once' : 'reminder',
      occurrenceId,
      scheduledFor,
      detectedAt: asIso(now()),
      deliveryPolicy: clone(task.deliveryPolicy || {}),
      conclusion: task.action?.text || task.action?.message || task.message || task.text || task.name || task.id,
      canonicalUrl: task.action?.url || null,
      missedCount,
      delivery: { status: 'retrying', revision: 0, updatedAt: asIso(now()) },
    };
    event.text = notificationText(event);
    return event;
  }

  async function processTimeTask(task) {
    const taskId = task.id;
    const snapshot = getSnapshot().tasks[taskId];
    if (!snapshot?.nextDueAt || asDate(snapshot.nextDueAt) > now()) return;
    const due = collectDue(task, snapshot.nextDueAt, now());
    if (!due.occurrences.length) return;
    const scheduledFor = due.occurrences.at(-1);
    const missedCount = due.occurrences.length - 1;
    const occurrenceId = occurrenceIdFor(task, scheduledFor);
    if (snapshot.processedOccurrences?.[occurrenceId]) return;
    const quiet = isQuiet(now(), quietHours);
    const follow = (task.deliveryPolicy?.quiet || task.deliveryPolicy?.quietHours || 'follow') === 'follow';
    const deferred = Object.values(snapshot.events || {}).find((event) => event.delivery?.status === 'deferred_quiet');
    let eventToDeliver = null;

    mutateAndSave((latest) => {
      const current = latest.tasks[taskId];
      if (!current) return;
      if (deferred && task.trigger.type !== 'once') {
        deferred.missedCount += missedCount + 1;
        for (const occurrence of due.occurrences) {
          current.processedOccurrences[occurrenceIdFor(task, occurrence)] = { status: 'merged', eventId: deferred.id };
        }
        mutateExistingEvent(deferred, task, scheduledFor);
        current.events[deferred.id] = clone(deferred);
        recordRun(current, task, {
          occurrenceId, scheduledFor, status: 'success', missedCount,
          eventId: deferred.id, notified: false,
        });
      } else {
        const event = makeReminderEvent(task, scheduledFor, missedCount);
        if (quiet && follow) event.delivery.status = 'deferred_quiet';
        else eventToDeliver = event.id;
        current.events[event.id] = event;
        for (const occurrence of due.occurrences) {
          current.processedOccurrences[occurrenceIdFor(task, occurrence)] = { status: 'done', eventId: event.id };
        }
        recordRun(current, task, {
          occurrenceId, scheduledFor, status: 'success', missedCount, eventId: event.id, notified: true,
        });
        if (task.trigger.type === 'once') current.lifecycle = 'completed';
      }
      current.nextDueAt = due.nextDueAt;
      current.lastSuccessAt = asIso(now());
      current.health = 'healthy';
      current.blocker = null;
      current.consecutiveFailures = 0;
    });
    if (eventToDeliver) await deliverEvent(taskId, eventToDeliver);
  }

  function mutateExistingEvent(event, task, scheduledFor) {
    event.occurrenceId = occurrenceIdFor(task, scheduledFor);
    event.scheduledFor = scheduledFor;
    event.detectedAt = asIso(now());
    event.text = notificationText(event);
  }

  function observationHash(observation) {
    return observation.versionHash || createHash('sha256')
      .update(`${observation.canonicalUrl || ''}\n${observation.text || ''}`)
      .digest('hex');
  }

  function observationCondition(observation, task) {
    if (typeof observation.match === 'boolean') return observation.match;
    if (typeof observation.conditionValue === 'boolean') return observation.conditionValue;
    const condition = task.condition || {};
    const includes = [condition.includes || condition.include || condition.contains || []].flat();
    const excludes = [condition.excludes || condition.exclude || []].flat();
    const numeric = condition.numeric || condition.compare;
    if (!includes.length && !excludes.length && !numeric) return null;
    const text = String(observation.text || '');
    if (!includes.every((word) => text.includes(word))) return false;
    if (excludes.some((word) => text.includes(word))) return false;
    if (numeric) {
      const raw = observation.fields?.[numeric.field] ?? observation[numeric.field];
      if (raw === undefined || raw === null || raw === '' || typeof raw === 'boolean' || typeof raw === 'object') return null;
      const actual = Number(raw);
      const expected = Number(numeric.value);
      if (!Number.isFinite(actual) || !Number.isFinite(expected)) return null;
      const operator = numeric.operator || numeric.op;
      const comparisons = {
        '<': () => actual < expected,
        '<=': () => actual <= expected,
        '>': () => actual > expected,
        '>=': () => actual >= expected,
        '==': () => actual === expected,
        '!=': () => actual !== expected,
        lt: () => actual < expected,
        lte: () => actual <= expected,
        gt: () => actual > expected,
        gte: () => actual >= expected,
        eq: () => actual === expected,
        ne: () => actual !== expected,
      };
      if (!comparisons[operator]) return null;
      return comparisons[operator]();
    }
    return true;
  }

  function makeMonitorEvent(task, source, observation, scheduledFor, occurrenceId) {
    const versionHash = observationHash(observation);
    const conditionType = task.condition.type;
    const key = [task.id, task.scheduleGeneration || 1, task.revision || 1, source.id, observation.itemId, versionHash, conditionType, occurrenceId].join(':');
    const event = {
      id: eventIdFor(key),
      taskId: task.id,
      taskName: task.name || task.id,
      kind: 'monitor',
      occurrenceId,
      scheduledFor,
      detectedAt: asIso(now()),
      deliveryPolicy: clone(task.deliveryPolicy || {}),
      sourceId: source.id,
      itemId: observation.itemId,
      versionHash,
      conclusion: observation.conclusion || observation.summary || observation.text || task.name || task.id,
      canonicalUrl: observation.canonicalUrl || source.url || null,
      evidence: observation.evidence || null,
      missedCount: 0,
      delivery: { status: 'retrying', revision: 0, updatedAt: asIso(now()) },
    };
    event.text = notificationText(event);
    return event;
  }

  function claimMonitorEvent(current, task, source, observation, scheduledFor, occurrenceId, deliverIds, stopState) {
    if (!source.canConfirm) return false;
    const event = makeMonitorEvent(task, source, observation, scheduledFor, occurrenceId);
    if (current.events[event.id]) return false;
    if (task.completion?.stopOnMatch && stopState.claimed) return false;
    if (isQuiet(now(), quietHours)
      && (task.deliveryPolicy?.quiet || task.deliveryPolicy?.quietHours || 'follow') === 'follow') {
      event.delivery.status = 'deferred_quiet';
    } else {
      deliverIds.push(event.id);
    }
    current.events[event.id] = event;
    if (task.completion?.stopOnMatch) stopState.claimed = true;
    return true;
  }

  function makeMonitorSummaryEvent(task, matches) {
    const latest = matches.at(-1);
    const sourceIds = [...new Set(matches.map((match) => match.source.id))];
    const key = JSON.stringify([
      task.id, task.scheduleGeneration || 1, task.revision || 1,
      matches.map((match) => [match.occurrenceId, match.source.id, match.observation.itemId, observationHash(match.observation)]),
    ]);
    const event = {
      id: eventIdFor(key),
      taskId: task.id,
      taskName: task.name || task.id,
      kind: 'monitor_summary',
      occurrenceId: latest.occurrenceId,
      scheduledFor: latest.scheduledFor,
      detectedAt: asIso(now()),
      deliveryPolicy: clone(task.deliveryPolicy || {}),
      sourceIds,
      matchedCount: matches.length,
      suppressedCount: matches.length - Math.max(0, (task.maxEventsPerPoll ?? 3) - 1),
      conclusion: `本轮共 ${matches.length} 条命中，来源：${sourceIds.join('、')}；其余命中已合并，未逐条展开。`,
      canonicalUrl: null,
      evidence: null,
      missedCount: 0,
      delivery: { status: 'retrying', revision: 0, updatedAt: asIso(now()) },
    };
    event.text = notificationText(event);
    return event;
  }

  async function commitContinuousMatches(task, eventControl) {
    eventControl.matches = eventControl.matches.filter((match) => match.source.canConfirm);
    if (!eventControl.matches.length || task.completion?.stopOnMatch) return;
    if (!stopping && !workerIsCurrent(task)) return;
    const deliverIds = [];
    mutateAndSave((latest) => {
      const current = latest.tasks[task.id];
      if (!current) return;
      const matches = eventControl.matches;
      const limit = task.maxEventsPerPoll ?? options.maxEventsPerPoll ?? 3;
      const overflow = matches.length > limit;
      const individual = overflow ? matches.slice(0, Math.max(0, limit - 1)) : matches;
      const stopState = { claimed: false };
      for (const match of individual) {
        claimMonitorEvent(current, task, match.source, match.observation,
          match.scheduledFor, match.occurrenceId, deliverIds, stopState);
      }
      if (overflow) {
        const summary = makeMonitorSummaryEvent(task, matches);
        summary.suppressedCount = matches.length - individual.length;
        if (!current.events[summary.id]) {
          if (isQuiet(now(), quietHours)
            && (task.deliveryPolicy?.quiet || task.deliveryPolicy?.quietHours || 'follow') === 'follow') {
            summary.delivery.status = 'deferred_quiet';
          } else {
            deliverIds.push(summary.id);
          }
          current.events[summary.id] = summary;
        }
      }
      for (const match of matches) markOccurrenceNotified(current, task, match.occurrenceId, match.scheduledFor);
    });
    eventControl.matches = [];
    for (const eventId of deliverIds) await deliverEvent(task.id, eventId);
  }

  function needsReview(task, source, observation) {
    const semantic = task.condition.semantic;
    const words = task.condition.candidateWords
      || (typeof semantic === 'object' ? semantic.candidateWords : null)
      || source.candidateWords;
    if (!words?.length) return true;
    const text = String(observation.text || '');
    return words.some((word) => text.includes(word));
  }

  async function processPendingReviews(task, reviewBudget = { used: 0 }, eventControl = { matches: [] }) {
    const taskId = task.id;
    const snapshot = getSnapshot().tasks[taskId];
    if (stopping || workController.signal.aborted || !snapshot) return;
    for (const [sourceId, sourceState] of Object.entries(snapshot.sources || {})) {
      if (stopping || workController.signal.aborted) return;
      const source = (task.sources || []).find((entry) => entry.id === sourceId);
      if (!source) continue;
      for (const [itemId, item] of Object.entries(sourceState.items || {})) {
        if (stopping || workController.signal.aborted) return;
        const pending = item.pendingReview;
        if (!pending || (pending.nextRetryAt && asDate(pending.nextRetryAt) > now())) continue;
        if (!['active', 'pending'].includes(getSnapshot().tasks[taskId]?.lifecycle)) return;
        if (reviewBudget.used >= (options.maxReviewsPerPoll ?? 5)) return;
        reviewBudget.used += 1;
        const allowed = mutateAndSave((latest) => {
          const current = latest.tasks[taskId];
          const currentPending = current?.sources?.[sourceId]?.items?.[itemId]?.pendingReview;
          if (!currentPending || currentPending.versionHash !== pending.versionHash) return null;
          const day = asIso(asDate(now()).getTime() + SHANGHAI_OFFSET_MS).slice(0, 10);
          if (current.reviewDaily?.day !== day) current.reviewDaily = { day, used: 0 };
          if (current.reviewDaily.used >= (options.maxReviewsPerDay ?? 24)) {
            recomputeHealth(current, task);
            return false;
          }
          return true;
        });
        if (allowed === null) continue;
        if (!allowed) return;
        const deliverIds = [];
        try {
          if (!options.reviewObservation) throw new Error('REVIEWER_REQUIRED');
          const review = await options.reviewObservation({
            task,
            source,
            observation: clone(pending.observation),
            pendingReview: clone(pending),
            signal: workController.signal,
          });
          if (!review || typeof review.match !== 'boolean') throw new Error('INVALID_REVIEW');
          if (!workerIsCurrent(task)) return;
          mutateAndSave((latest) => {
            const current = latest.tasks[taskId];
            const currentItem = current?.sources?.[sourceId]?.items?.[itemId];
            if (!currentItem?.pendingReview || currentItem.pendingReview.versionHash !== pending.versionHash) return;
            const day = asIso(asDate(now()).getTime() + SHANGHAI_OFFSET_MS).slice(0, 10);
            if (current.reviewDaily?.day !== day) current.reviewDaily = { day, used: 0 };
            current.reviewDaily.used += 1;
            delete currentItem.pendingReview;
            currentItem.lastReviewedHash = pending.versionHash;
            delete currentItem.reviewBlockedHash;
            const previousValue = typeof currentItem.conditionState === 'boolean' ? currentItem.conditionState : null;
            let matched = false;
            if (task.condition.type === 'condition_true') matched = review.match && previousValue !== true;
            if (task.condition.type === 'false_to_true') matched = previousValue === false && review.match;
            currentItem.conditionState = review.match;
            if (matched) {
              const reviewedObservation = {
                ...pending.observation,
                conclusion: review.conclusion || review.summary || pending.observation.conclusion,
                evidence: review.evidence || pending.observation.evidence,
              };
              if (task.completion?.stopOnMatch) {
                const stopState = { claimed: false };
                const added = claimMonitorEvent(current, task, source, reviewedObservation,
                  pending.scheduledFor, pending.occurrenceId, deliverIds, stopState);
                if (added) markOccurrenceNotified(current, task, pending.occurrenceId, pending.scheduledFor);
                if (stopState.claimed) current.lifecycle = 'completed';
              } else {
                eventControl.matches.push({
                  source, observation: reviewedObservation,
                  scheduledFor: pending.scheduledFor, occurrenceId: pending.occurrenceId,
                });
              }
            }
            recomputeHealth(current, task);
          });
        } catch (error) {
          if (!workerIsCurrent(task)) return;
          mutateAndSave((latest) => {
            const current = latest.tasks[taskId];
            const currentItem = current?.sources?.[sourceId]?.items?.[itemId];
            const currentPending = currentItem?.pendingReview;
            if (!currentPending || currentPending.versionHash !== pending.versionHash) return;
            currentPending.attempts = (currentPending.attempts || 0) + 1;
            currentPending.permanentFailures = error?.permanent ? (currentPending.permanentFailures || 0) + 1 : 0;
            currentPending.lastError = error?.code || 'review_failed';
            currentPending.updatedAt = asIso(now());
            if (currentPending.permanentFailures >= 3) {
              currentItem.reviewBlockedHash = pending.versionHash;
              delete currentItem.pendingReview;
              current.blocker = { code: 'review_permanent_invalid', sourceId, itemId, versionHash: pending.versionHash };
              alert({ event: 'automation_review_blocked', taskId, sourceId, itemId });
            } else {
              const nowMs = asDate(now()).getTime();
              const cappedBackoff = Math.min(reviewMaxBackoffMs, reviewBackoffMs * (2 ** (currentPending.attempts - 1)));
              const retryAt = Number(error?.retryAt);
              const delay = Number.isFinite(retryAt) && retryAt > nowMs ? retryAt - nowMs : cappedBackoff;
              currentPending.nextRetryAt = asIso(nowMs + delay);
              current.blocker = { code: 'review_pending', sourceId, itemId, versionHash: pending.versionHash };
            }
            recomputeHealth(current, task);
          });
        }
        for (const eventId of deliverIds) await deliverEvent(taskId, eventId);
      }
    }
  }

  async function processPollTask(task, manual = false) {
    const taskId = task.id;
    if (stopping || workController.signal.aborted) return;
    const reviewBudget = { used: 0 };
    const eventControl = { matches: [] };
    try {
      const snapshot = getSnapshot().tasks[taskId];
      if (!snapshot || !['active', 'pending'].includes(snapshot.lifecycle)) return;
      if (!manual && (!snapshot.nextDueAt || asDate(snapshot.nextDueAt) > now())) {
        await processPendingReviews(task, reviewBudget, eventControl);
        return;
      }
      const regularOverdue = snapshot.nextDueAt && asDate(snapshot.nextDueAt) <= now();
      const due = manual && !regularOverdue
        ? { occurrences: [asIso(now())], nextDueAt: snapshot.nextDueAt }
        : collectDue(task, snapshot.nextDueAt, now());
      const scheduledFor = due.occurrences.at(-1);
      const occurrenceId = occurrenceIdFor(task, scheduledFor);
      if (snapshot.processedOccurrences?.[occurrenceId]) {
        await processPendingReviews(task, reviewBudget, eventControl);
        mutateAndSave((latest) => {
          const current = latest.tasks[taskId];
          if (current?.nextDueAt === snapshot.nextDueAt) current.nextDueAt = due.nextDueAt;
        });
        return;
      }
    const fetched = [];
    const failures = [];
    for (const source of task.sources || []) {
      if (stopping || workController.signal.aborted) break;
      try {
        const result = await options.fetchObservations(task, source, {
          scheduledFor, occurrenceId, observedAt: asIso(now()), signal: workController.signal,
        });
        const observations = Array.isArray(result) ? result : result?.observations;
        if (!Array.isArray(observations)) throw new Error('INVALID_OBSERVATIONS');
        fetched.push({ source, observations });
      } catch (error) {
        failures.push({ sourceId: source.id, code: error?.code || 'fetch_failed' });
      }
    }

    if (!workerIsCurrent(task)) return;
    const deliverIds = [];
    mutateAndSave((latest) => {
      const current = latest.tasks[taskId];
      if (!current) return;
      const stopState = { claimed: false };
      let addedEvents = 0;
      for (const { source, observations } of fetched) {
        const sourceState = current.sources[source.id] || { initialized: false, items: {} };
        sourceState.items ||= {};
        sourceState.itemOrder ||= Object.keys(sourceState.items);
        const firstBaseline = !sourceState.initialized;
        for (const original of observations) {
          if (!original?.itemId) continue;
          const observation = { ...original, sourceId: original.sourceId || source.id };
          const itemId = String(observation.itemId);
          const versionHash = observationHash(observation);
          sourceState.itemOrder = sourceState.itemOrder.filter((id) => id !== itemId);
          sourceState.itemOrder.push(itemId);
          const previous = sourceState.items[itemId];
          if (previous?.lastFetchedHash === versionHash) {
            previous.lastObservedAt = asIso(now());
            continue;
          }
          const nextItem = {
            ...previous,
            versionHash,
            lastFetchedHash: versionHash,
            lastReviewedHash: previous?.lastReviewedHash ?? null,
            lastObservedAt: asIso(now()),
          };
          if (observation.detailError) {
            sourceState.items[itemId] = {
              ...previous,
              versionHash,
              lastFetchedHash: null,
              lastObservedAt: asIso(now()),
              detailError: clone(observation.detailError),
            };
            continue;
          }
          delete nextItem.detailError;
          delete nextItem.pendingReview;
          delete nextItem.reviewBlockedHash;
          const semantic = task.condition.semantic && ['condition_true', 'false_to_true'].includes(task.condition.type);
          if (semantic) {
            if (needsReview(task, source, observation)) {
              nextItem.pendingReview = {
                versionHash,
                observation: clone(observation),
                scheduledFor,
                occurrenceId,
                attempts: 0,
                permanentFailures: 0,
                nextRetryAt: null,
                updatedAt: asIso(now()),
              };
              delete nextItem.reviewBlockedHash;
            } else {
              nextItem.lastReviewedHash = versionHash;
              nextItem.conditionState = false;
            }
            sourceState.items[itemId] = nextItem;
            continue;
          }

          let matched = false;
          const type = task.condition.type;
          if (type === 'new_item') {
            matched = !firstBaseline && !previous;
          } else if (type === 'on_change') {
            matched = !firstBaseline && (!previous || previous.lastFetchedHash !== versionHash);
          } else {
            const value = observationCondition(observation, task);
            const previousValue = typeof previous?.conditionState === 'boolean' ? previous.conditionState : null;
            if (value !== null) {
              if (type === 'condition_true') matched = value === true && previousValue !== true;
              if (type === 'false_to_true') matched = previousValue === false && value === true;
            }
          }
          const value = observationCondition(observation, task);
          if (value !== null) nextItem.conditionState = value;
          sourceState.items[itemId] = nextItem;
          if (matched) {
            if (task.completion?.stopOnMatch) {
              if (claimMonitorEvent(current, task, source, observation, scheduledFor, occurrenceId, deliverIds, stopState)) {
                addedEvents += 1;
              }
            } else {
              eventControl.matches.push({ source, observation, scheduledFor, occurrenceId });
            }
          }
        }
        for (const staleItemId of sourceState.itemOrder.slice(0, -1000)) delete sourceState.items[staleItemId];
        sourceState.itemOrder = sourceState.itemOrder.slice(-1000);
        sourceState.initialized = true;
        sourceState.lastSuccessAt = asIso(now());
        sourceState.lastError = null;
        current.sources[source.id] = sourceState;
      }
      for (const failure of failures) {
        const sourceState = current.sources[failure.sourceId] || { initialized: false, items: {} };
        sourceState.lastError = failure.code;
        current.sources[failure.sourceId] = sourceState;
      }
      const successfulSources = fetched.length;
      const confirmedSuccesses = fetched.filter(({ source }) => source.canConfirm).length;
      if (successfulSources > 0) {
        if (current.lifecycle === 'pending' && confirmedSuccesses > 0) current.lifecycle = 'active';
        current.lastSuccessAt = asIso(now());
        current.consecutiveFailures = 0;
      } else {
        current.consecutiveFailures = (current.consecutiveFailures || 0) + 1;
      }
      recomputeHealth(current, task);
      if (task.completion?.stopOnMatch && stopState.claimed) current.lifecycle = 'completed';
      current.nextDueAt = due.nextDueAt;
      for (const occurrence of due.occurrences) {
        current.processedOccurrences[occurrenceIdFor(task, occurrence)] = { status: 'done' };
      }
      recordRun(current, task, {
        occurrenceId,
        scheduledFor,
        status: successfulSources ? 'success' : 'failed',
        missedCount: due.occurrences.length - 1,
        blocker: successfulSources ? null : 'source_fetch_failed',
        notified: addedEvents > 0,
      });
    });
    for (const eventId of deliverIds) await deliverEvent(taskId, eventId);
    if (['active', 'pending'].includes(getSnapshot().tasks[taskId]?.lifecycle)) await processPendingReviews(task, reviewBudget, eventControl);
    } finally {
      await commitContinuousMatches(task, eventControl);
    }
  }

  function claimRunNowRequests() {
    if (!options.controlPath || !fs.existsSync(options.controlPath)) return new Set();
    try {
      return withAutomationControlLock(options.controlPath, () => {
        const document = readJson(options.controlPath, { version: 1, requests: [] });
        if (!Array.isArray(document.requests) || !document.requests.length) return new Set();
        const taskIds = new Set(document.requests.map((request) => request?.taskId).filter((id) => typeof id === 'string'));
        // 同一锁内读取并原子认领：并发追加不会丢失或复活已认领的请求。
        atomicWriteJson(options.controlPath, { ...document, requests: [] });
        return taskIds;
      });
    } catch (error) {
      if (error?.code === 'CONTROL_BUSY') return new Set();
      throw error;
    }
  }

  async function tickInternal() {
    await Promise.all([...manualPromises.values()]);
    if (stopping || workController.signal.aborted) return getSnapshot();
    refreshConfig();
    const runNow = claimRunNowRequests();
    cleanupTerminalEvents();
    await releaseEvents();
    for (const task of configTasks()) {
      if (stopping || workController.signal.aborted) break;
      if (!validTask(task)) continue;
      const manual = runNow.has(task.id);
      const snapshot = getSnapshot().tasks[task.id];
      if (!snapshot || snapshot.health === 'config_error' || !['active', 'pending'].includes(snapshot.lifecycle)) continue;
      try {
        if (manual) {
          if (task.trigger.type === 'poll') await processPollTask(task, true);
        } else if (task.trigger.type === 'poll') await processPollTask(task);
        else await processTimeTask(task);
      } catch (error) {
        mutateAndSave((latest) => {
          const current = latest.tasks[task.id];
          if (!current) return;
          current.health = 'degraded';
          current.blocker = { code: error?.code || 'task_failed' };
          current.consecutiveFailures = (current.consecutiveFailures || 0) + 1;
          recordRun(current, task, { status: 'failed', blocker: current.blocker.code });
        });
        log({ level: 'error', event: 'automation_task_failed', taskId: task.id, code: error?.code || 'task_failed' });
      }
    }
    mutateAndSave((latest) => { reconcileHealthAlerts(latest); });
    return getSnapshot();
  }

  function tick() {
    if (tickPromise) return tickPromise;
    tickPromise = tickInternal().finally(() => { tickPromise = null; });
    return tickPromise;
  }

  function getSnapshot() {
    return clone({ ...state, configError, running, config: configSnapshot });
  }

  function start() {
    if (running) return Promise.resolve();
    running = true;
    stopping = false;
    stopPromise = null;
    if (workController.signal.aborted) workController = new AbortController();
    let failures = 0;
    loopPromise = (async () => {
      while (running) {
        try {
          await tick();
          failures = 0;
        } catch (error) {
          failures += 1;
          log({ level: 'error', event: 'automation_loop_failed', code: error?.code || 'loop_failed' });
          alert({ event: 'automation_loop_failed', code: error?.code || 'loop_failed' });
        }
        if (!running) break;
        const delay = failures
          ? Math.min(options.loopMaxBackoffMs || 60_000, (options.loopBackoffMs || 5000) * (2 ** (failures - 1)))
          : (options.loopIntervalMs ?? 1000);
        try {
          await sleep(delay, { signal: workController.signal });
        } catch (error) {
          if (!running || workController.signal.aborted) break;
          failures += 1;
          log({ level: 'error', event: 'automation_sleep_failed', code: error?.code || 'sleep_failed' });
        }
      }
    })();
    return Promise.resolve();
  }

  async function waitBounded(promise) {
    if (!promise) return;
    let timer;
    try {
      await Promise.race([
        promise,
        new Promise((resolve) => { timer = setTimeout(resolve, options.stopTimeoutMs ?? 5000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    running = false;
    stopping = true;
    workController.abort();
    stopPromise = (async () => {
      try { await options.cancelCurrentWork?.(); } catch (error) {
        log({ level: 'error', event: 'automation_cancel_failed', code: error?.code || 'cancel_failed' });
      }
      await waitBounded(Promise.allSettled([tickPromise, ...manualPromises.values()].filter(Boolean)));
      await waitBounded(loopPromise);
    })();
    return stopPromise;
  }

  refreshConfig();

  return {
    start,
    stop,
    tick,
    getSnapshot,
    refreshConfig,
    mutateAndSave,
    markDelivery,
    reconcileNotification,
    runOnce(taskId) {
      if (manualPromises.has(taskId)) return manualPromises.get(taskId);
      const promise = (async () => {
        if (tickPromise) await tickPromise;
        if (stopping || workController.signal.aborted) return null;
        refreshConfig();
        const task = configTasks().find((entry) => entry.id === taskId);
        const current = getSnapshot().tasks[taskId];
        if (!validTask(task) || task.trigger.type !== 'poll' || !current
          || !['active', 'pending'].includes(current.lifecycle)) return null;
        await processPollTask(task, true);
        return getSnapshot().tasks[taskId];
      })();
      manualPromises.set(taskId, promise);
      return promise.finally(() => { manualPromises.delete(taskId); });
    },
  };
}
