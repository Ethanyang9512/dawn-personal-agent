const TIME_ZONE = 'Asia/Shanghai';
const CONDITION_TYPES = new Set(['new_item', 'on_change', 'condition_true', 'false_to_true']);
const DESIRED_STATES = new Set(['active', 'paused', 'cancelled']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

export class AutomationConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AutomationConfigError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AutomationConfigError(code, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTime(value, field) {
  if (typeof value !== 'string') fail('INVALID_TIME', `${field} must be an ISO timestamp with a zone`);
  const match = ISO_WITH_ZONE.exec(value);
  if (!match) fail('INVALID_TIME', `${field} must be an ISO timestamp with a zone`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let valid = month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59;
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    valid = valid && offsetHour <= 14 && offsetMinute <= 59 && (offsetHour !== 14 || offsetMinute === 0);
  }
  const date = new Date(value);
  if (!valid || !Number.isFinite(date.getTime())) fail('INVALID_TIME', `${field} is not a valid timestamp`);
  return date.toISOString();
}

function nowIso(now) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) fail('INVALID_TIME', 'now is not a valid time');
  return date.toISOString();
}

function normalizeTrigger(raw) {
  if (!isObject(raw) || typeof raw.type !== 'string') fail('INVALID_TRIGGER', 'trigger.type is required');
  const trigger = structuredClone(raw);
  switch (raw.type) {
    case 'once':
      trigger.at = normalizeTime(raw.at, 'trigger.at');
      return trigger;
    case 'daily':
    case 'weekly':
    case 'monthly': {
      if (typeof raw.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.time)) {
        fail('INVALID_TRIGGER', `${raw.type}.time must be HH:MM`);
      }
      if (raw.timeZone !== undefined && raw.timeZone !== TIME_ZONE) {
        fail('INVALID_TRIGGER', `timeZone must be ${TIME_ZONE}`);
      }
      trigger.timeZone = TIME_ZONE;
      if (raw.type === 'weekly') {
        if (!Array.isArray(raw.days) || raw.days.length === 0
          || raw.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
          fail('INVALID_TRIGGER', 'weekly.days must contain ISO weekdays 1 through 7');
        }
        trigger.days = [...new Set(raw.days)].sort((a, b) => a - b);
      }
      if (raw.type === 'monthly' && (!Number.isInteger(raw.day) || raw.day < 1 || raw.day > 31)) {
        fail('INVALID_TRIGGER', 'monthly.day must be between 1 and 31');
      }
      return trigger;
    }
    case 'interval':
    case 'poll': {
      const everyMinutes = raw.everyMinutes ?? (raw.type === 'poll' ? 360 : undefined);
      const minimum = raw.type === 'poll' ? 15 : 60;
      if (!Number.isInteger(everyMinutes) || everyMinutes < minimum) {
        fail('INVALID_FREQUENCY', `${raw.type}.everyMinutes must be an integer of at least ${minimum}`);
      }
      trigger.everyMinutes = everyMinutes;
      return trigger;
    }
    default:
      fail('INVALID_TRIGGER', `unsupported trigger type: ${raw.type}`);
  }
}

function normalizeAction(task) {
  let action;
  if (task.action === 'notify') {
    action = { type: 'notify', text: task.text };
    delete task.text;
  } else if (isObject(task.action) && task.action.type === 'notify') {
    action = task.action;
  } else {
    fail('INVALID_ACTION', 'action must be notify');
  }
  if (typeof action.text !== 'string' || action.text.trim() === '') {
    fail('INVALID_ACTION', 'notify action requires non-empty text');
  }
  action.type = 'notify';
  action.text = action.text.trim();
  task.action = action;
}

function normalizeHttpUrl(value, field) {
  if (typeof value !== 'string') fail('INVALID_SOURCE', `${field} must be an HTTP(S) URL`);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('INVALID_SOURCE', `${field} must be an HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    fail('INVALID_SOURCE', `${field} must be a public HTTP(S) URL without credentials`);
  }
  return url;
}

function normalizeOrigin(value, field) {
  const url = normalizeHttpUrl(value, field);
  if (url.pathname !== '/' || url.search || url.hash) fail('INVALID_SOURCE', `${field} must be an origin`);
  return url.origin;
}

function normalizeSources(raw) {
  if (!Array.isArray(raw) || raw.length === 0) fail('INVALID_UNION', 'poll requires at least one source');
  const ids = new Set();
  return raw.map((source) => {
    if (!isObject(source) || typeof source.id !== 'string' || !SAFE_ID.test(source.id)
      || typeof source.adapter !== 'string' || source.adapter.trim() === '') {
      fail('INVALID_SOURCE', 'each source requires a safe id and adapter');
    }
    if (ids.has(source.id)) fail('INVALID_SOURCE', `duplicate source id: ${source.id}`);
    ids.add(source.id);
    if (source.canConfirm !== undefined && typeof source.canConfirm !== 'boolean') {
      fail('INVALID_SOURCE', 'source.canConfirm must be boolean');
    }
    if (source.allowExternalLinks !== undefined && typeof source.allowExternalLinks !== 'boolean') {
      fail('INVALID_SOURCE', 'source.allowExternalLinks must be boolean');
    }
    const normalized = structuredClone(source);
    normalized.adapter = source.adapter.trim();
    normalized.url = normalizeHttpUrl(source.url, `source ${source.id}.url`).href;
    normalized.canonicalUrl = source.canonicalUrl === undefined
      ? normalized.url
      : normalizeHttpUrl(source.canonicalUrl, `source ${source.id}.canonicalUrl`).href;
    normalized.allowedOrigin = source.allowedOrigin === undefined
      ? normalizeHttpUrl(source.url, `source ${source.id}.url`).origin
      : normalizeOrigin(source.allowedOrigin, `source ${source.id}.allowedOrigin`);
    normalized.canConfirm = source.canConfirm ?? false;
    return normalized;
  });
}

function normalizeCompletion(raw, isPoll, now) {
  if (!isPoll && isObject(raw) && Object.hasOwn(raw, 'stopOnMatch')) {
    fail('INVALID_UNION', 'stopOnMatch is only valid for poll tasks');
  }
  if (raw !== undefined && !isObject(raw)) fail('INVALID_COMPLETION', 'completion must be an object');
  if (!isPoll) {
    if (raw === undefined) return undefined;
    const completion = structuredClone(raw);
    if (completion.expiresAt !== undefined) completion.expiresAt = normalizeTime(completion.expiresAt, 'completion.expiresAt');
    return completion;
  }
  const completion = raw === undefined ? {} : structuredClone(raw);
  completion.stopOnMatch = completion.stopOnMatch ?? true;
  if (typeof completion.stopOnMatch !== 'boolean') fail('INVALID_COMPLETION', 'stopOnMatch must be boolean');
  completion.expiresAt = completion.expiresAt === undefined
    ? new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString()
    : normalizeTime(completion.expiresAt, 'completion.expiresAt');
  return completion;
}

function normalizeDelivery(raw) {
  if (raw !== undefined && !isObject(raw)) fail('INVALID_DELIVERY', 'deliveryPolicy must be an object');
  const delivery = raw === undefined ? {} : structuredClone(raw);
  delivery.quiet = delivery.quiet ?? 'follow';
  if (!['follow', 'immediate'].includes(delivery.quiet)) fail('INVALID_DELIVERY', 'quiet must be follow or immediate');
  return delivery;
}

function validateConditionRule(condition) {
  if (!['condition_true', 'false_to_true'].includes(condition.type)) return;
  const semantic = condition.semantic !== undefined;
  const textRules = ['includes', 'include', 'contains', 'excludes', 'exclude'].filter((key) => condition[key] !== undefined);
  const numeric = condition.numeric ?? condition.compare;
  if (!semantic && !textRules.length && numeric === undefined) {
    fail('INVALID_UNION', `${condition.type} requires an executable semantic or deterministic rule`);
  }
  if (semantic && condition.semantic !== true && typeof condition.semantic !== 'string'
    && !isObject(condition.semantic)) {
    fail('INVALID_UNION', 'semantic must be true, a prompt string, or an object');
  }
  if (semantic && typeof condition.semantic === 'string' && condition.semantic.trim() === '') {
    fail('INVALID_UNION', 'semantic prompt must be non-empty');
  }
  for (const key of textRules) {
    const values = Array.isArray(condition[key]) ? condition[key] : [condition[key]];
    if (!values.length || values.some((value) => typeof value !== 'string' || value.trim() === '')) {
      fail('INVALID_UNION', `${key} must contain non-empty strings`);
    }
  }
  if (numeric !== undefined) {
    const operators = new Set(['<', '<=', '>', '>=', '==', '!=', 'lt', 'lte', 'gt', 'gte', 'eq', 'ne']);
    if (!isObject(numeric) || typeof numeric.field !== 'string' || numeric.field.trim() === ''
      || !Number.isFinite(numeric.value) || !operators.has(numeric.operator ?? numeric.op)) {
      fail('INVALID_UNION', 'numeric requires field, a finite value, and a supported operator');
    }
  }
}

function estimatedNotificationsPerDay(task) {
  switch (task.trigger.type) {
    case 'once': return 0;
    case 'daily': return 1;
    case 'weekly': return task.trigger.days.length / 7;
    case 'monthly': return 12 / 365;
    case 'interval': return 1440 / task.trigger.everyMinutes;
    case 'poll': {
      const pollsPerDay = 1440 / task.trigger.everyMinutes;
      return task.completion.stopOnMatch ? 1 : pollsPerDay * task.maxEventsPerPoll;
    }
    default: return 0;
  }
}

export function validateAutomationTask(raw, { now = Date.now() } = {}) {
  if (!isObject(raw)) fail('INVALID_TASK', 'task must be an object');
  if (typeof now !== 'number' || !Number.isFinite(now)) fail('INVALID_TIME', 'now must be a finite timestamp');
  for (const field of ['runtime', 'lifecycle', 'health', 'nextDueAt', 'lastRun', 'blocker', 'consecutiveFailures']) {
    if (Object.hasOwn(raw, field)) fail('RUNTIME_READ_ONLY', `${field} belongs to runtime state`);
  }
  const task = structuredClone(raw);
  delete task.authorityVerified;

  if (typeof task.id !== 'string' || !SAFE_ID.test(task.id)) fail('INVALID_ID', 'id must be 1-64 safe characters');
  if (typeof task.name !== 'string' || task.name.trim() === '') fail('INVALID_NAME', 'name must be non-empty');
  task.name = task.name.trim();
  task.desiredState = task.desiredState ?? 'active';
  if (!DESIRED_STATES.has(task.desiredState)) fail('INVALID_STATE', 'invalid desiredState');
  task.revision = task.revision ?? 1;
  task.scheduleGeneration = task.scheduleGeneration ?? 1;
  if (!Number.isInteger(task.revision) || task.revision < 1
    || !Number.isInteger(task.scheduleGeneration) || task.scheduleGeneration < 1) {
    fail('INVALID_REVISION', 'revision and scheduleGeneration must be positive integers');
  }
  const normalizedNow = nowIso(now);
  task.createdAt = task.createdAt === undefined ? normalizedNow : normalizeTime(task.createdAt, 'createdAt');
  task.updatedAt = task.updatedAt === undefined ? normalizedNow : normalizeTime(task.updatedAt, 'updatedAt');
  task.trigger = normalizeTrigger(task.trigger);
  normalizeAction(task);

  const isPoll = task.trigger.type === 'poll';
  if (!isPoll && (task.sources !== undefined || task.condition !== undefined)) {
    fail('INVALID_UNION', 'sources and condition are only valid for poll tasks');
  }
  if (isPoll) {
    task.sources = normalizeSources(task.sources);
    if (!isObject(task.condition) || !CONDITION_TYPES.has(task.condition.type)) {
      fail('INVALID_UNION', 'poll requires a supported non-empty condition');
    }
    validateConditionRule(task.condition);
    task.maxEventsPerPoll = task.maxEventsPerPoll ?? 3;
    if (!Number.isInteger(task.maxEventsPerPoll) || task.maxEventsPerPoll < 1) {
      fail('INVALID_VOLUME', 'maxEventsPerPoll must be a positive integer');
    }
  }
  task.completion = normalizeCompletion(task.completion, isPoll, now);
  if (task.completion === undefined) delete task.completion;
  task.deliveryPolicy = normalizeDelivery(task.deliveryPolicy);
  task.allowHighVolume = task.allowHighVolume ?? false;
  if (typeof task.allowHighVolume !== 'boolean') fail('INVALID_VOLUME', 'allowHighVolume must be boolean');
  if (estimatedNotificationsPerDay(task) > 4 && !task.allowHighVolume) {
    fail('HIGH_VOLUME_CONFIRMATION_REQUIRED', 'estimated notifications exceed four per day; set allowHighVolume=true');
  }
  return task;
}

export function validateAutomationConfig(raw, { now = Date.now() } = {}) {
  if (Array.isArray(raw)) return validateAutomationConfig({ tasks: raw }, { now });
  if (!isObject(raw) || !Array.isArray(raw.tasks) || (raw.version !== undefined && raw.version !== 1)) {
    fail('INVALID_CONFIG', 'config must be {version:1, tasks:[]}');
  }
  const ids = new Set();
  return raw.tasks.map((task) => {
    const normalized = validateAutomationTask(task, { now });
    if (ids.has(normalized.id)) fail('DUPLICATE_ID', `duplicate task id: ${normalized.id}`);
    ids.add(normalized.id);
    return normalized;
  });
}
