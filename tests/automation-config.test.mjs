import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AutomationConfigError,
  validateAutomationConfig,
  validateAutomationTask,
} from '../bridge/lib/automation-schema.mjs';
import {
  cancelAutomation,
  listAutomations,
  pauseAutomation,
  resumeAutomation,
  upsertAutomation,
  validateAutomationFile,
} from '../tools/automations.mjs';

const NOW = Date.parse('2026-10-25T02:00:00.000Z');
const NOW_ISO = '2026-10-25T02:00:00.000Z';

function onceTask(overrides = {}) {
  return {
    id: 'task-1',
    name: 'Test reminder',
    trigger: { type: 'once', at: '2026-10-26T09:30:00+08:00' },
    action: { type: 'notify', text: 'Hello' },
    ...overrides,
  };
}

function pollTask(overrides = {}) {
  return onceTask({
    trigger: { type: 'poll', everyMinutes: 15 },
    sources: [{
      id: 'official',
      adapter: 'rss',
      url: 'https://example.com/feed.xml',
      canConfirm: true,
    }],
    condition: { type: 'new_item' },
    completion: { stopOnMatch: true },
    ...overrides,
  });
}

function assertCode(code, fn) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof AutomationConfigError, `expected AutomationConfigError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('normalizes a once task, applies metadata defaults, and deep-copies input', () => {
  const raw = onceTask();
  const task = validateAutomationTask(raw, { now: NOW });

  assert.equal(task.id, 'task-1');
  assert.equal(task.desiredState, 'active');
  assert.equal(task.revision, 1);
  assert.equal(task.scheduleGeneration, 1);
  assert.equal(task.createdAt, NOW_ISO);
  assert.equal(task.updatedAt, NOW_ISO);
  assert.equal(task.trigger.at, '2026-10-26T01:30:00.000Z');
  assert.equal(task.action.type, 'notify');
  assert.notEqual(task.trigger, raw.trigger);
  assert.notEqual(task.action, raw.action);
  raw.action.text = 'Changed later';
  assert.equal(task.action.text, 'Hello');
  assert.equal(Object.hasOwn(task, 'authorityVerified'), false);
});

test('accepts action=notify shorthand with top-level text', () => {
  const task = validateAutomationTask(onceTask({ action: 'notify', text: ' shorthand ' }), { now: NOW });
  assert.deepEqual(task.action, { type: 'notify', text: 'shorthand' });
  assert.equal(Object.hasOwn(task, 'text'), false);
});

test('accepts daily, weekly, monthly, and interval triggers', () => {
  const daily = validateAutomationTask(onceTask({ trigger: { type: 'daily', time: '08:15' } }), { now: NOW });
  assert.deepEqual(daily.trigger, { type: 'daily', time: '08:15', timeZone: 'Asia/Shanghai' });

  const weekly = validateAutomationTask(onceTask({
    trigger: { type: 'weekly', days: [5, 1, 3, 1], time: '08:15', timeZone: 'Asia/Shanghai' },
  }), { now: NOW });
  assert.deepEqual(weekly.trigger.days, [1, 3, 5]);

  const monthly = validateAutomationTask(onceTask({
    trigger: { type: 'monthly', day: 31, time: '08:15' },
  }), { now: NOW });
  assert.equal(monthly.trigger.day, 31);

  const interval = validateAutomationTask(onceTask({
    trigger: { type: 'interval', everyMinutes: 60 },
    allowHighVolume: true,
  }), { now: NOW });
  assert.equal(interval.trigger.everyMinutes, 60);
});

test('applies poll defaults for interval, completion, delivery, and source authority', () => {
  const task = validateAutomationTask(pollTask({
    trigger: { type: 'poll' },
    sources: [{ id: 'official', adapter: 'html', url: 'https://example.com/news' }],
    completion: undefined,
  }), { now: NOW });

  assert.equal(task.trigger.everyMinutes, 360);
  assert.deepEqual(task.completion, {
    stopOnMatch: true,
    expiresAt: '2026-11-24T02:00:00.000Z',
  });
  assert.equal(task.deliveryPolicy.quiet, 'follow');
  assert.equal(task.sources[0].canConfirm, false);
  assert.equal(task.sources[0].allowedOrigin, 'https://example.com');
  assert.equal(task.sources[0].canonicalUrl, 'https://example.com/news');
});

test('accepts every supported poll condition and semantic details', () => {
  for (const type of ['new_item', 'on_change', 'condition_true', 'false_to_true']) {
    const condition = { type, include: ['ticket'], semantic: 'same-event evidence' };
    const task = validateAutomationTask(pollTask({ condition }), { now: NOW });
    assert.deepEqual(task.condition, condition);
  }
});

test('rejects unsafe or empty task IDs', () => {
  for (const id of ['', ' ', '../escape', 'a/b', 'a b', '-leading', 'dot.name', 'a'.repeat(65), null]) {
    assertCode('INVALID_ID', () => validateAutomationTask(onceTask({ id }), { now: NOW }));
  }
});

test('rejects timestamps without an explicit zone and impossible timestamps', () => {
  for (const at of [
    '2026-10-26T09:30:00',
    '2026-02-30T09:30:00+08:00',
    '2026-10-26T09:30:00+25:00',
    'not-a-time',
    123,
  ]) {
    assertCode('INVALID_TIME', () => validateAutomationTask(onceTask({
      trigger: { type: 'once', at },
    }), { now: NOW }));
  }
  assertCode('INVALID_TIME', () => validateAutomationTask(onceTask({ createdAt: '2026-10-25 10:00:00' }), { now: NOW }));
});

test('rejects invalid local times, zones, weekdays, and month days', () => {
  const invalidTriggers = [
    { type: 'daily', time: '24:00' },
    { type: 'daily', time: '08:15', timeZone: 'UTC' },
    { type: 'weekly', days: [], time: '08:15' },
    { type: 'weekly', days: [0], time: '08:15' },
    { type: 'monthly', day: 0, time: '08:15' },
    { type: 'monthly', day: 32, time: '08:15' },
    { type: 'unknown' },
  ];
  for (const trigger of invalidTriggers) {
    assertCode('INVALID_TRIGGER', () => validateAutomationTask(onceTask({ trigger }), { now: NOW }));
  }
});

test('enforces one-hour reminder and fifteen-minute poll minimum intervals', () => {
  for (const everyMinutes of [59, 0, 1.5, '60']) {
    assertCode('INVALID_FREQUENCY', () => validateAutomationTask(onceTask({
      trigger: { type: 'interval', everyMinutes },
    }), { now: NOW }));
  }
  assertCode('INVALID_FREQUENCY', () => validateAutomationTask(pollTask({
    trigger: { type: 'poll', everyMinutes: 14 },
  }), { now: NOW }));
});

test('enforces the trigger union and notify-only action', () => {
  assertCode('INVALID_UNION', () => validateAutomationTask(pollTask({ sources: [] }), { now: NOW }));
  assertCode('INVALID_UNION', () => validateAutomationTask(pollTask({ condition: {} }), { now: NOW }));
  assertCode('INVALID_UNION', () => validateAutomationTask(pollTask({ condition: null }), { now: NOW }));
  assertCode('INVALID_UNION', () => validateAutomationTask(pollTask({ condition: { type: 'semantic' } }), { now: NOW }));
  assertCode('INVALID_UNION', () => validateAutomationTask(onceTask({ sources: pollTask().sources }), { now: NOW }));
  assertCode('INVALID_UNION', () => validateAutomationTask(onceTask({ condition: { type: 'new_item' } }), { now: NOW }));
  assertCode('INVALID_UNION', () => validateAutomationTask(onceTask({ completion: { stopOnMatch: true } }), { now: NOW }));
  assertCode('INVALID_ACTION', () => validateAutomationTask(onceTask({ action: { type: 'webhook' } }), { now: NOW }));
});

test('validates source IDs, URLs, canonical origins, and canConfirm types', () => {
  for (const source of [
    { id: '../source', adapter: 'rss', url: 'https://example.com/feed' },
    { id: 'official', adapter: 'rss', url: 'file:///etc/passwd' },
    { id: 'official', adapter: 'rss', url: 'https://user:secret@example.com/feed' },
    { id: 'official', adapter: 'rss', url: 'https://example.com/feed', allowedOrigin: 'https://example.com/path' },
    { id: 'official', adapter: 'rss', url: 'https://example.com/feed', canConfirm: 'yes' },
  ]) {
    assertCode('INVALID_SOURCE', () => validateAutomationTask(pollTask({ sources: [source] }), { now: NOW }));
  }
});

test('allowExternalLinks 只接受 boolean', () => {
  assertCode('INVALID_SOURCE', () => validateAutomationTask(pollTask({
    sources: [{ id: 'official', adapter: 'html_list', url: 'https://example.com/news', allowExternalLinks: 'yes' }],
  }), { now: NOW }));
  const accepted = validateAutomationTask(pollTask({
    sources: [{ id: 'official', adapter: 'html_list', url: 'https://example.com/news', allowExternalLinks: true }],
  }), { now: NOW });
  assert.equal(accepted.sources[0].allowExternalLinks, true);
});

test('requires explicit high-volume confirmation above four estimated notifications per day', () => {
  assertCode('HIGH_VOLUME_CONFIRMATION_REQUIRED', () => validateAutomationTask(onceTask({
    trigger: { type: 'interval', everyMinutes: 300 },
  }), { now: NOW }));

  const allowed = validateAutomationTask(onceTask({
    trigger: { type: 'interval', everyMinutes: 300 },
    allowHighVolume: true,
  }), { now: NOW });
  assert.equal(allowed.allowHighVolume, true);

  const exactlyFour = validateAutomationTask(onceTask({
    trigger: { type: 'interval', everyMinutes: 360 },
  }), { now: NOW });
  assert.equal(exactlyFour.trigger.everyMinutes, 360);
});

test('estimates continuous polls conservatively but stop-on-match polls as one-shot', () => {
  assertCode('HIGH_VOLUME_CONFIRMATION_REQUIRED', () => validateAutomationTask(pollTask({
    completion: { stopOnMatch: false },
  }), { now: NOW }));
  const continuous = validateAutomationTask(pollTask({
    completion: { stopOnMatch: false },
    allowHighVolume: true,
  }), { now: NOW });
  assert.equal(continuous.completion.stopOnMatch, false);
  const oneShot = validateAutomationTask(pollTask(), { now: NOW });
  assert.equal(oneShot.allowHighVolume, false);
});

test('validates desiredState, revision, delivery policy, and expiry types', () => {
  assertCode('INVALID_STATE', () => validateAutomationTask(onceTask({ desiredState: 'deleted' }), { now: NOW }));
  assertCode('INVALID_REVISION', () => validateAutomationTask(onceTask({ revision: 0 }), { now: NOW }));
  assertCode('INVALID_REVISION', () => validateAutomationTask(onceTask({ scheduleGeneration: 1.5 }), { now: NOW }));
  assertCode('INVALID_DELIVERY', () => validateAutomationTask(onceTask({ deliveryPolicy: { quiet: 'never' } }), { now: NOW }));
  assertCode('INVALID_TIME', () => validateAutomationTask(pollTask({
    completion: { expiresAt: '2026-12-07 00:00:00' },
  }), { now: NOW }));
});

test('validates config arrays, returns a task array, and rejects duplicate IDs', () => {
  const tasks = validateAutomationConfig({ version: 1, tasks: [onceTask()] }, { now: NOW });
  assert.ok(Array.isArray(tasks));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].createdAt, NOW_ISO);

  const fromArray = validateAutomationConfig([onceTask()], { now: NOW });
  assert.equal(fromArray.length, 1);
  assertCode('DUPLICATE_ID', () => validateAutomationConfig({ tasks: [onceTask(), onceTask()] }, { now: NOW }));
  assertCode('INVALID_CONFIG', () => validateAutomationConfig({ version: 2, tasks: [] }, { now: NOW }));
});

const CLI_PATH = path.resolve(import.meta.dirname, '../tools/automations.mjs');

function tempPaths(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dawn-automation-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    configPath: path.join(root, 'memory', 'automations.json'),
    legacyPath: path.join(root, 'memory', 'reminders.json'),
    statePath: path.join(root, 'state', 'automations.json'),
    controlPath: path.join(root, 'state', 'automation-control.json'),
  };
}

function options(paths) {
  return { ...paths, now: NOW };
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function legacyReminder() {
  return {
    id: 'r-legacy-1',
    at: '2026-10-27T09:30:00+08:00',
    text: 'Legacy reminder',
    type: 'reminder',
  };
}

function runCli(paths, args, input) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      DAWN_AUTOMATIONS_CONFIG: paths.configPath,
      DAWN_AUTOMATIONS_STATE: paths.statePath,
      DAWN_AUTOMATIONS_CONTROL: paths.controlPath,
    },
  });
}

test('CLI 未传路径时直接报错，不回退到 home 下的生产默认路径', (t) => {
  const paths = tempPaths(t);
  const env = { ...process.env, HOME: path.join(paths.root, 'fake-home') };
  for (const key of ['DAWN_AUTOMATIONS_CONFIG', 'DAWN_AUTOMATIONS_STATE', 'DAWN_AUTOMATIONS_CONTROL']) delete env[key];
  const result = spawnSync(process.execPath, [CLI_PATH, 'list'], { encoding: 'utf8', env });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(JSON.parse(result.stderr).error.code, 'MISSING_AUTOMATIONS_PATHS');
});

test('run-now 缺少 control 时直接报错且不创建默认控制文件', (t) => {
  const paths = tempPaths(t);
  const created = upsertAutomation(pollTask(), options(paths));
  const fakeHome = path.join(paths.root, 'fake-home');
  const env = {
    ...process.env,
    HOME: fakeHome,
    DAWN_AUTOMATIONS_CONFIG: paths.configPath,
    DAWN_AUTOMATIONS_STATE: paths.statePath,
  };
  delete env.DAWN_AUTOMATIONS_CONTROL;
  const result = spawnSync(process.execPath, [CLI_PATH, 'run-now', created.id], { encoding: 'utf8', env });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(JSON.parse(result.stderr).error.code, 'MISSING_AUTOMATIONS_PATHS');
  assert.throws(() => readFileSync(path.join(fakeHome, 'Dawn', 'state', 'automation-control.json')), /ENOENT/);
});

test('upsert increments revision on every edit but scheduleGeneration only for trigger rules', (t) => {
  const paths = tempPaths(t);
  const created = upsertAutomation(onceTask(), options(paths));
  assert.equal(created.revision, 1);
  assert.equal(created.scheduleGeneration, 1);

  const renamed = upsertAutomation({ ...created, name: 'Renamed' }, options(paths));
  assert.equal(renamed.revision, 2);
  assert.equal(renamed.scheduleGeneration, 1);
  assert.equal(renamed.createdAt, created.createdAt);

  const reworded = upsertAutomation({
    ...renamed,
    action: { ...renamed.action, text: 'New wording' },
  }, options(paths));
  assert.equal(reworded.revision, 3);
  assert.equal(reworded.scheduleGeneration, 1);

  const rescheduled = upsertAutomation({
    ...reworded,
    trigger: { type: 'daily', time: '08:15' },
  }, options(paths));
  assert.equal(rescheduled.revision, 4);
  assert.equal(rescheduled.scheduleGeneration, 2);
  assert.equal(readJson(paths.configPath).tasks.length, 1);
});

test('poll condition, source, and completion edits advance scheduleGeneration', (t) => {
  const paths = tempPaths(t);
  const created = upsertAutomation(pollTask({
    sources: [{ id: 'official', adapter: 'rss', url: 'https://example.com/feed.xml' }],
  }), options(paths));
  const conditionChanged = upsertAutomation({ ...created, condition: { type: 'on_change' } }, options(paths));
  assert.equal(conditionChanged.scheduleGeneration, 2);
  const sourceChanged = upsertAutomation({
    ...conditionChanged,
    sources: [{ ...conditionChanged.sources[0], url: 'https://example.com/other-feed.xml' }],
  }, options(paths));
  assert.equal(sourceChanged.scheduleGeneration, 3);
  const completionChanged = upsertAutomation({
    ...sourceChanged,
    completion: { ...sourceChanged.completion, stopOnMatch: false },
    allowHighVolume: true,
  }, options(paths));
  assert.equal(completionChanged.scheduleGeneration, 4);
  assert.equal(completionChanged.revision, 4);
});

test('pause, resume, and cancel preserve scheduleGeneration and cancelled IDs cannot be reused', (t) => {
  const paths = tempPaths(t);
  const created = upsertAutomation(onceTask(), options(paths));
  const paused = pauseAutomation(created.id, options(paths));
  assert.equal(paused.desiredState, 'paused');
  assert.equal(paused.revision, 2);
  assert.equal(paused.scheduleGeneration, 1);
  assert.equal(pauseAutomation(created.id, options(paths)).revision, 2);

  const resumed = resumeAutomation(created.id, options(paths));
  assert.equal(resumed.desiredState, 'active');
  assert.equal(resumed.revision, 3);
  const cancelled = cancelAutomation(created.id, options(paths));
  assert.equal(cancelled.desiredState, 'cancelled');
  assert.equal(cancelled.revision, 4);
  assert.equal(cancelAutomation(created.id, options(paths)).revision, 4);

  assertCode('TASK_CANCELLED', () => resumeAutomation(created.id, options(paths)));
  assertCode('TASK_CANCELLED', () => upsertAutomation(onceTask({ name: 'Reuse' }), options(paths)));
  assert.equal(readJson(paths.configPath).tasks[0].desiredState, 'cancelled');
});

test('URL and canonical authority changes invalidate canConfirm unless reverified in the same upsert', (t) => {
  const paths = tempPaths(t);
  const unverified = upsertAutomation(pollTask(), options(paths));
  assert.equal(unverified.sources[0].canConfirm, false);
  assert.equal(Object.hasOwn(unverified, 'authorityVerified'), false);

  const verified = upsertAutomation({
    ...unverified,
    authorityVerified: true,
    sources: [{ ...unverified.sources[0], canConfirm: true }],
  }, options(paths));
  assert.equal(verified.sources[0].canConfirm, true);
  const renamed = upsertAutomation({ ...verified, name: 'Authority retained' }, options(paths));
  assert.equal(renamed.sources[0].canConfirm, true);

  const urlChanged = upsertAutomation({
    ...renamed,
    sources: [{ ...renamed.sources[0], url: 'https://other.example/feed.xml' }],
  }, options(paths));
  assert.equal(urlChanged.sources[0].canConfirm, false);

  const urlReverifiedOnChange = upsertAutomation({
    ...urlChanged,
    authorityVerified: true,
    sources: [{
      ...urlChanged.sources[0],
      url: 'https://reverified.example/feed.xml',
      canConfirm: true,
    }],
  }, options(paths));
  assert.equal(urlReverifiedOnChange.sources[0].canConfirm, true);

  const canonicalChanged = upsertAutomation({
    ...urlReverifiedOnChange,
    sources: [{ ...urlReverifiedOnChange.sources[0], canonicalUrl: 'https://reverified.example/item/2' }],
  }, options(paths));
  assert.equal(canonicalChanged.sources[0].canConfirm, false);

  const originChanged = upsertAutomation({
    ...canonicalChanged,
    sources: [{
      ...canonicalChanged.sources[0],
      allowedOrigin: 'https://different.example',
      canConfirm: true,
    }],
  }, options(paths));
  assert.equal(originChanged.sources[0].canConfirm, false);
});

test('legacy reminders are list-only projections and cannot be upserted', (t) => {
  const paths = tempPaths(t);
  upsertAutomation(onceTask(), options(paths));
  writeJson(paths.legacyPath, [legacyReminder()]);
  const before = readFileSync(paths.configPath, 'utf8');

  const listed = listAutomations(options(paths));
  const legacy = listed.find((task) => task.id === 'r-legacy-1');
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.text, 'Legacy reminder');
  assert.equal(listed.filter((task) => task.legacy).length, 1);

  assertCode('LEGACY_READ_ONLY', () => upsertAutomation({ ...legacy }, options(paths)));
  assert.equal(readFileSync(paths.configPath, 'utf8'), before);
  assert.deepEqual(readJson(paths.legacyPath), [legacyReminder()]);
});

test('corrupt config is never treated as empty or overwritten', (t) => {
  const paths = tempPaths(t);
  mkdirSync(path.dirname(paths.configPath), { recursive: true });
  const truncated = '{"version":1,"tasks":[';
  writeFileSync(paths.configPath, truncated);

  assertCode('CONFIG_CORRUPT', () => listAutomations(options(paths)));
  assertCode('CONFIG_CORRUPT', () => validateAutomationFile(options(paths)));
  assertCode('CONFIG_CORRUPT', () => upsertAutomation(onceTask(), options(paths)));
  assert.equal(readFileSync(paths.configPath, 'utf8'), truncated);
  assert.deepEqual(readdirSync(path.dirname(paths.configPath)), ['automations.json']);
});

test('failed edits leave config byte-identical and atomic writes leave no temp files', (t) => {
  const paths = tempPaths(t);
  const created = upsertAutomation(onceTask(), options(paths));
  const before = readFileSync(paths.configPath, 'utf8');
  assertCode('HIGH_VOLUME_CONFIRMATION_REQUIRED', () => upsertAutomation({
    ...created,
    trigger: { type: 'interval', everyMinutes: 300 },
  }, options(paths)));
  assert.equal(readFileSync(paths.configPath, 'utf8'), before);

  upsertAutomation({ ...created, name: 'Committed atomically' }, options(paths));
  assert.equal(readJson(paths.configPath).tasks[0].name, 'Committed atomically');
  assert.deepEqual(readdirSync(path.dirname(paths.configPath)), ['automations.json']);
});

test('runtime state is read into list output but never modified by management commands', (t) => {
  const paths = tempPaths(t);
  const created = upsertAutomation(onceTask(), options(paths));
  const state = {
    tasks: [{ id: created.id, lifecycle: 'active', nextDueAt: '2026-10-26T01:30:00.000Z', health: 'healthy' }],
  };
  writeJson(paths.statePath, state);
  const stateBefore = readFileSync(paths.statePath, 'utf8');

  const listed = listAutomations(options(paths));
  assert.equal(listed[0].runtime.lifecycle, 'active');
  assert.equal(listed[0].runtime.nextDueAt, '2026-10-26T01:30:00.000Z');
  upsertAutomation({ ...created, name: 'State remains untouched' }, options(paths));
  pauseAutomation(created.id, options(paths));
  resumeAutomation(created.id, options(paths));
  cancelAutomation(created.id, options(paths));
  validateAutomationFile(options(paths));
  assert.equal(readFileSync(paths.statePath, 'utf8'), stateBefore);
});

test('CLI supports stdin/argument upsert, pause, resume, cancel, list, and validate with isolated env paths', (t) => {
  const paths = tempPaths(t);
  writeJson(paths.legacyPath, [legacyReminder()]);
  writeJson(paths.statePath, { tasks: {} });
  const stateBefore = readFileSync(paths.statePath, 'utf8');

  const createdResult = runCli(paths, ['upsert'], JSON.stringify(onceTask()));
  assert.equal(createdResult.status, 0, createdResult.stderr);
  const created = JSON.parse(createdResult.stdout).task;
  assert.equal(created.revision, 1);

  const editedResult = runCli(paths, ['upsert', JSON.stringify({ ...created, name: 'CLI edit' })]);
  assert.equal(editedResult.status, 0, editedResult.stderr);
  assert.equal(JSON.parse(editedResult.stdout).task.revision, 2);

  for (const [command, desiredState] of [['pause', 'paused'], ['resume', 'active'], ['cancel', 'cancelled']]) {
    const result = runCli(paths, [command, created.id]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).task.desiredState, desiredState);
  }

  const validated = runCli(paths, ['validate']);
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).tasks.length, 1);
  const listed = runCli(paths, ['list']);
  assert.equal(listed.status, 0, listed.stderr);
  const listOutput = JSON.parse(listed.stdout);
  assert.equal(listOutput.tasks.length, 2);
  assert.equal(listOutput.tasks.find((task) => task.id === 'r-legacy-1').legacy, true);

  const configBeforeRejectedReuse = readFileSync(paths.configPath, 'utf8');
  const reuse = runCli(paths, ['upsert', JSON.stringify(onceTask())]);
  assert.equal(reuse.status, 1);
  assert.equal(JSON.parse(reuse.stderr).error.code, 'TASK_CANCELLED');
  assert.equal(readFileSync(paths.configPath, 'utf8'), configBeforeRejectedReuse);
  assert.equal(readFileSync(paths.statePath, 'utf8'), stateBefore);
  assert.deepEqual(readdirSync(path.dirname(paths.configPath)).sort(), ['automations.json', 'reminders.json']);
});

test('a legacy ID cannot be reused even when the upsert itself has new-schema fields', (t) => {
  const paths = tempPaths(t);
  writeJson(paths.legacyPath, [{ ...legacyReminder(), id: 'task-1' }]);
  assertCode('LEGACY_READ_ONLY', () => upsertAutomation(onceTask(), options(paths)));
  assert.deepEqual(readdirSync(path.dirname(paths.configPath)), ['reminders.json']);
});

test('upserting a listed task strips its runtime projection instead of persisting it', (t) => {
  const paths = tempPaths(t);
  upsertAutomation(onceTask(), options(paths));
  writeJson(paths.statePath, { tasks: [{ id: 'task-1', lifecycle: 'active', health: 'healthy' }] });
  const listed = listAutomations(options(paths))[0];
  assert.equal(listed.runtime.lifecycle, 'active');

  const edited = upsertAutomation({ ...listed, name: 'Round trip without state' }, options(paths));
  assert.equal(Object.hasOwn(edited, 'runtime'), false);
  assert.equal(Object.hasOwn(readJson(paths.configPath).tasks[0], 'runtime'), false);
});

test('runtime-owned fields cannot be injected into config', (t) => {
  const paths = tempPaths(t);
  upsertAutomation(onceTask(), options(paths));
  for (const field of ['lifecycle', 'health', 'nextDueAt', 'lastRun', 'blocker', 'consecutiveFailures']) {
    assertCode('RUNTIME_READ_ONLY', () => upsertAutomation({ ...onceTask(), [field]: {} }, options(paths)));
  }
  assert.equal(readJson(paths.configPath).tasks[0].revision, 1);
});

test('condition_true and false_to_true require a rule beyond their type', () => {
  for (const type of ['condition_true', 'false_to_true']) {
    assertCode('INVALID_UNION', () => validateAutomationTask(pollTask({ condition: { type } }), { now: NOW }));
  }
});

test('run-now writes only the independent control file and supports the CLI command', async (t) => {
  const paths = tempPaths(t);
  const controlPath = path.join(paths.root, 'state', 'automation-control.json');
  const created = upsertAutomation(pollTask(), options(paths));
  writeJson(paths.statePath, { version: 1, tasks: {}, sentinel: 'unchanged' });
  const configBefore = readFileSync(paths.configPath, 'utf8');
  const stateBefore = readFileSync(paths.statePath, 'utf8');
  const { requestAutomationRun } = await import('../tools/automations.mjs');
  assert.equal(typeof requestAutomationRun, 'function');

  const request = requestAutomationRun(created.id, { ...options(paths), controlPath });
  assert.equal(request.taskId, created.id);
  assert.ok(request.requestId);
  assert.equal(readFileSync(paths.configPath, 'utf8'), configBefore);
  assert.equal(readFileSync(paths.statePath, 'utf8'), stateBefore);
  assert.equal(JSON.parse(readFileSync(controlPath, 'utf8')).requests.length, 1);

  const result = spawnSync(process.execPath, [CLI_PATH, 'run-now', created.id], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DAWN_AUTOMATIONS_CONFIG: paths.configPath,
      DAWN_AUTOMATIONS_STATE: paths.statePath,
      DAWN_AUTOMATIONS_CONTROL: controlPath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).request.taskId, created.id);
  assert.equal(JSON.parse(readFileSync(controlPath, 'utf8')).requests.length, 2);
  const lockPath = `${controlPath}.lock`;
  writeFileSync(lockPath, String(process.pid));
  assertCode('CONTROL_BUSY', () => requestAutomationRun(created.id, { ...options(paths), controlPath }));
  rmSync(lockPath, { force: true });
  assert.equal(JSON.parse(readFileSync(controlPath, 'utf8')).requests.length, 2);
  writeFileSync(lockPath, '99999999');
  requestAutomationRun(created.id, { ...options(paths), controlPath });
  assert.equal(JSON.parse(readFileSync(controlPath, 'utf8')).requests.length, 3);
  assert.equal(readdirSync(path.dirname(lockPath)).includes(path.basename(lockPath)), false);
  assert.equal(readFileSync(paths.configPath, 'utf8'), configBefore);
  assert.equal(readFileSync(paths.statePath, 'utf8'), stateBefore);
});

test('condition_true and false_to_true reject candidateWords as their only rule', () => {
  for (const type of ['condition_true', 'false_to_true']) {
    assertCode('INVALID_UNION', () => validateAutomationTask(pollTask({
      condition: { type, candidateWords: ['开售'] },
    }), { now: NOW }));
  }
});

test('semantic, includes, excludes, and numeric are executable condition rules', () => {
  const rules = [
    { semantic: 'same event with sale evidence' },
    { includes: ['开售'] },
    { excludes: ['尚未开售'] },
    { numeric: { field: 'price', operator: '<=', value: 500 } },
  ];
  for (const type of ['condition_true', 'false_to_true']) {
    for (const rule of rules) {
      const task = validateAutomationTask(pollTask({ condition: { type, ...rule } }), { now: NOW });
      assert.equal(task.condition.type, type);
    }
  }
});

test('maxEventsPerPoll defaults to three and drives conservative volume estimates', () => {
  const defaultTask = validateAutomationTask(pollTask(), { now: NOW });
  assert.equal(defaultTask.maxEventsPerPoll, 3);
  const oneEvent = validateAutomationTask(pollTask({
    trigger: { type: 'poll', everyMinutes: 360 },
    completion: { stopOnMatch: false },
    maxEventsPerPoll: 1,
  }), { now: NOW });
  assert.equal(oneEvent.maxEventsPerPoll, 1);
  assertCode('HIGH_VOLUME_CONFIRMATION_REQUIRED', () => validateAutomationTask(pollTask({
    trigger: { type: 'poll', everyMinutes: 360 },
    completion: { stopOnMatch: false },
    maxEventsPerPoll: 2,
  }), { now: NOW }));
  for (const maxEventsPerPoll of [0, 1.5, -1]) {
    assertCode('INVALID_VOLUME', () => validateAutomationTask(pollTask({ maxEventsPerPoll }), { now: NOW }));
  }
});

test('legacy list and ID conflict checks include only missing-type or reminder entries', (t) => {
  const paths = tempPaths(t);
  const reminder = legacyReminder();
  const followup = { ...legacyReminder(), id: 'legacy-followup', type: 'followup' };
  const missingType = { ...legacyReminder(), id: 'legacy-missing-type' };
  delete missingType.type;
  writeJson(paths.legacyPath, [reminder, followup, missingType]);

  const listed = listAutomations(options(paths));
  assert.deepEqual(listed.filter((task) => task.legacy).map((task) => task.id).sort(),
    ['legacy-missing-type', 'r-legacy-1']);
  assert.doesNotThrow(() => upsertAutomation(onceTask({ id: 'legacy-followup' }), options(paths)));
  assertCode('LEGACY_READ_ONLY', () => upsertAutomation(onceTask({ id: 'legacy-missing-type' }), options(paths)));
});

test('management CLI validation remains strict for any invalid task in the config', (t) => {
  const paths = tempPaths(t);
  writeJson(paths.configPath, {
    version: 1,
    tasks: [onceTask(), onceTask({ id: 'invalid-cli', action: { type: 'notify', text: '' } })],
  });
  assertCode('INVALID_ACTION', () => validateAutomationFile(options(paths)));
});
