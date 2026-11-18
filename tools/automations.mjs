import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AutomationConfigError,
  validateAutomationConfig,
  validateAutomationTask,
} from '../bridge/lib/automation-schema.mjs';
import { withAutomationControlLock } from '../bridge/lib/automation-control.mjs';

function fail(code, message) {
  throw new AutomationConfigError(code, message);
}

function resolveOptions(options = {}) {
  const configPath = options.configPath ?? process.env.DAWN_AUTOMATIONS_CONFIG;
  const statePath = options.statePath ?? process.env.DAWN_AUTOMATIONS_STATE;
  const controlPath = options.controlPath ?? process.env.DAWN_AUTOMATIONS_CONTROL;
  if (!configPath || !statePath || !controlPath) {
    fail('MISSING_AUTOMATIONS_PATHS', 'set configPath/statePath/controlPath or DAWN_AUTOMATIONS_CONFIG/DAWN_AUTOMATIONS_STATE/DAWN_AUTOMATIONS_CONTROL explicitly');
  }
  const now = options.now ?? Date.now();
  if (typeof now !== 'number' || !Number.isFinite(now)) fail('INVALID_TIME', 'now must be a finite timestamp');
  return {
    configPath,
    statePath,
    controlPath,
    legacyPath: options.legacyPath ?? path.join(path.dirname(configPath), 'reminders.json'),
    now,
    nowIso: new Date(now).toISOString(),
  };
}

function readJson(file, missingValue, corruptCode) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return missingValue;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(corruptCode, `${file} is not valid JSON`);
  }
}

function readConfig(options) {
  const raw = readJson(options.configPath, { version: 1, tasks: [] }, 'CONFIG_CORRUPT');
  return validateAutomationConfig(raw, { now: options.now });
}

function writeJsonAtomic(file, document) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tempPath = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  let descriptor;
  try {
    descriptor = openSync(tempPath, 'wx', 0o600);
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, file);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function writeConfig(configPath, tasks) {
  writeJsonAtomic(configPath, { version: 1, tasks });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function triggerFingerprint(task) {
  const sources = task.sources?.map((source) => {
    const copy = { ...source };
    delete copy.canConfirm;
    return copy;
  }).sort((a, b) => a.id.localeCompare(b.id));
  return canonical({
    trigger: task.trigger,
    condition: task.condition,
    sources,
    completion: task.completion,
  });
}

function reconcileAuthority(candidate, previous, authorityVerified) {
  if (candidate.trigger.type !== 'poll') return;
  const previousSources = new Map((previous?.sources ?? []).map((source) => [source.id, source]));
  for (const source of candidate.sources) {
    const old = previousSources.get(source.id);
    const authorityChanged = !old || ['url', 'canonicalUrl', 'allowedOrigin']
      .some((field) => source[field] !== old[field]);
    const promotion = source.canConfirm && (!old?.canConfirm || authorityChanged);
    if (promotion && !authorityVerified) source.canConfirm = false;
  }
}

export function upsertAutomation(raw, options = {}) {
  if (raw?.legacy === true) fail('LEGACY_READ_ONLY', 'legacy reminders cannot be upserted');
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_TASK', 'task must be an object');
  const opts = resolveOptions(options);
  const tasks = readConfig(opts);
  if (readLegacy(opts).some((entry) => entry.id === raw.id)) {
    fail('LEGACY_READ_ONLY', 'legacy reminder IDs cannot be upserted');
  }
  const index = tasks.findIndex((task) => task.id === raw.id);
  const previous = index === -1 ? undefined : tasks[index];
  if (previous?.desiredState === 'cancelled') fail('TASK_CANCELLED', 'cancelled task IDs cannot be reused');

  const authorityVerified = raw.authorityVerified === true;
  const input = { ...structuredClone(raw) };
  delete input.authorityVerified;
  delete input.legacy;
  delete input.runtime;
  if (previous) {
    input.desiredState = input.desiredState ?? previous.desiredState;
    input.revision = previous.revision + 1;
    input.scheduleGeneration = previous.scheduleGeneration;
    input.createdAt = previous.createdAt;
    input.updatedAt = opts.nowIso;
  } else {
    input.revision = 1;
    input.scheduleGeneration = 1;
    input.createdAt = opts.nowIso;
    input.updatedAt = opts.nowIso;
  }
  const candidate = validateAutomationTask(input, { now: opts.now });
  reconcileAuthority(candidate, previous, authorityVerified);
  if (previous && triggerFingerprint(candidate) !== triggerFingerprint(previous)) {
    candidate.scheduleGeneration = previous.scheduleGeneration + 1;
  }

  if (index === -1) tasks.push(candidate);
  else tasks[index] = candidate;
  writeConfig(opts.configPath, tasks);
  return candidate;
}

function transitionAutomation(id, desiredState, options) {
  const opts = resolveOptions(options);
  const tasks = readConfig(opts);
  const index = tasks.findIndex((task) => task.id === id);
  if (index === -1) fail('TASK_NOT_FOUND', `task not found: ${id}`);
  const previous = tasks[index];
  if (previous.desiredState === 'cancelled' && desiredState !== 'cancelled') {
    fail('TASK_CANCELLED', 'cancelled tasks cannot be resumed or paused');
  }
  if (previous.desiredState === desiredState) return previous;
  const candidate = validateAutomationTask({
    ...previous,
    desiredState,
    revision: previous.revision + 1,
    updatedAt: opts.nowIso,
  }, { now: opts.now });
  tasks[index] = candidate;
  writeConfig(opts.configPath, tasks);
  return candidate;
}

export function pauseAutomation(id, options = {}) {
  return transitionAutomation(id, 'paused', options);
}

export function resumeAutomation(id, options = {}) {
  return transitionAutomation(id, 'active', options);
}

export function cancelAutomation(id, options = {}) {
  return transitionAutomation(id, 'cancelled', options);
}

export function requestAutomationRun(id, options = {}) {
  const opts = resolveOptions(options);
  const task = readConfig(opts).find((entry) => entry.id === id);
  if (!task) fail('TASK_NOT_FOUND', `task not found: ${id}`);
  if (task.trigger.type !== 'poll') fail('RUN_NOW_REQUIRES_POLL', 'run-now requires a poll task');
  if (task.desiredState !== 'active') fail('TASK_NOT_ACTIVE', 'run-now requires an active task');
  return withAutomationControlLock(opts.controlPath, () => {
    const control = readJson(opts.controlPath, { version: 1, requests: [] }, 'CONTROL_CORRUPT');
    if (!Array.isArray(control.requests)) fail('CONTROL_CORRUPT', `${opts.controlPath} requests must be an array`);
    const request = { requestId: randomUUID(), taskId: id, requestedAt: opts.nowIso };
    writeJsonAtomic(opts.controlPath, { version: 1, requests: [...control.requests, request] });
    return request;
  });
}

export function validateAutomationFile(options = {}) {
  const opts = resolveOptions(options);
  return readConfig(opts);
}

function readLegacy(options) {
  const raw = readJson(options.legacyPath, [], 'LEGACY_CORRUPT');
  if (!Array.isArray(raw) || raw.some((entry) => entry === null || typeof entry !== 'object' || Array.isArray(entry))) {
    fail('INVALID_LEGACY', 'legacy reminders must be an array of objects');
  }
  return raw.filter((entry) => entry.type === undefined || entry.type === 'reminder')
    .map((entry) => ({ ...structuredClone(entry), legacy: true }));
}

function readRuntimeById(options) {
  const raw = readJson(options.statePath, {}, 'STATE_CORRUPT');
  const runtime = new Map();
  if (Array.isArray(raw.tasks)) {
    for (const task of raw.tasks) {
      if (task && typeof task.id === 'string') runtime.set(task.id, task);
    }
  } else if (raw.tasks !== null && typeof raw.tasks === 'object') {
    for (const [id, task] of Object.entries(raw.tasks)) {
      if (task && typeof task === 'object' && !Array.isArray(task)) runtime.set(id, task);
    }
  }
  return runtime;
}

export function listAutomations(options = {}) {
  const opts = resolveOptions(options);
  const tasks = readConfig(opts);
  const runtime = readRuntimeById(opts);
  const projected = tasks.map((task) => {
    if (!runtime.has(task.id)) return task;
    return { ...task, runtime: structuredClone(runtime.get(task.id)) };
  });
  return [...projected, ...readLegacy(opts)];
}

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function parseJson(text) {
  if (!text || text.trim() === '') fail('INVALID_JSON', 'JSON input is required');
  try {
    return JSON.parse(text);
  } catch {
    fail('INVALID_JSON', 'input is not valid JSON');
  }
}

async function main(argv) {
  const [command, argument] = argv;
  let output;
  switch (command) {
    case 'upsert': {
      const input = parseJson(argument ?? await readStdin());
      output = { ok: true, task: upsertAutomation(input) };
      break;
    }
    case 'pause':
    case 'resume':
    case 'cancel': {
      if (!argument) fail('USAGE', `${command} requires a task ID`);
      const operation = { pause: pauseAutomation, resume: resumeAutomation, cancel: cancelAutomation }[command];
      output = { ok: true, task: operation(argument) };
      break;
    }
    case 'run-now': {
      if (!argument) fail('USAGE', 'run-now requires a task ID');
      output = { ok: true, request: requestAutomationRun(argument) };
      break;
    }
    case 'list':
      output = { ok: true, tasks: listAutomations() };
      break;
    case 'validate':
      if (argument) {
        const input = parseJson(argument === '-' ? await readStdin() : argument);
        output = { ok: true, task: validateAutomationTask(input) };
      } else {
        output = { ok: true, tasks: validateAutomationFile() };
      }
      break;
    default:
      fail('USAGE', 'usage: automations.mjs upsert [JSON] | pause ID | resume ID | cancel ID | run-now ID | list | validate [JSON|-]');
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    const code = error instanceof AutomationConfigError ? error.code : 'INTERNAL_ERROR';
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message: error.message } })}\n`);
    process.exitCode = 1;
  });
}
