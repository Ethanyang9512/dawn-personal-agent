import { workspaceHome } from './locations.mjs';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const WAIT_REASONS = new Set(['busy', 'quiet', 'window', 'budget', 'cooldown', 'retry', 'unknown']);
const time = (value) => Number.isFinite(value) || (typeof value === 'string' && !Number.isNaN(Date.parse(value))) ? value : null;
const count = (value) => Number.isInteger(value) && value >= 0 ? value : 0;
const realpath = (file) => {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
};
const inside = (file, dir) => {
  const p = realpath(file).toLowerCase();
  const d = realpath(dir).toLowerCase();
  return p === d || p.startsWith(`${d}${path.sep}`);
};

function jobSnapshot(job, current) {
  if (current) return job ? { running: true, startedAt: time(job.startedAt), steps: count(job.steps) } : { running: false, startedAt: null, steps: 0 };
  if (!job) return { status: 'unknown', endedAt: null, steps: 0 };
  const status = job.timedOut ? 'timeout' : job.cancelled ? 'cancelled' : job.isError ? 'error' : 'ok';
  return { status, endedAt: time(job.endedAt), steps: count(job.steps) };
}

function matchesArtifacts(hashes, files) {
  if (!hashes.length || hashes.length !== files.length) return false;
  try {
    const actual=files.map(file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')).sort();
    return [...hashes].sort().every((value,index)=>value===actual[index]);
  } catch { return false; }
}

function deliverySnapshot(receipt, generatedAt, artifacts) {
  const group = receipt?.current || receipt?.lastGroup;
  const artifactHashes = (group?.artifactHashes || []).filter(h=>typeof h==='string' && /^[a-f0-9]{64}$/.test(h));
  const acceptedAt = time(receipt?.lastAcceptedAt);
  return {
    scope: 'date_aggregate',
    ...(group ? {lastGroup:{groupId:String(group.groupId),acceptedParts:(group.acceptedParts || []).filter(p=>typeof p==='string'),
      imagesAccepted:group.imagesAccepted===true,complete:group.complete===true,degraded:group.degraded===true,artifactHashes,
      matchesCurrentArtifacts:matchesArtifacts(artifactHashes,artifacts)}} : {}),
    acceptedCount: receipt && !Number.isInteger(receipt.acceptedCount) ? null : count(receipt?.acceptedCount),
    lastAcceptedAt: acceptedAt,
    mayPrecedeCurrentGeneration: !!(acceptedAt && generatedAt && Date.parse(new Date(generatedAt)) > Date.parse(new Date(acceptedAt))),
  };
}

function projectSnapshot(project, receipt, artifactRoot) {
  const generatedAt = time(project?.generatedAt);
  const candidates = Array.isArray(project?.artifacts) ? project.artifacts : [];
  const artifacts = candidates.filter((file) => typeof file === 'string' && path.isAbsolute(file) && inside(file, artifactRoot) && fs.existsSync(file));
  return {
    date: typeof project?.date === 'string' ? project.date : null,
    generatedAt,
    outboxedAt: time(project?.outboxedAt),
    artifacts,
    waitReason: WAIT_REASONS.has(project?.waitReason) ? project.waitReason : 'unknown',
    delivery: deliverySnapshot(receipt, generatedAt, artifacts),
  };
}

export function buildSelfStatus({ health = {}, currentJob = null, lastJob = null, digest = {}, review = {}, delivery = {}, now = Date.now(), artifactRoot = path.join(workspaceHome(), '发出') } = {}) {
  return {
    version: 1,
    updatedAt: new Date(now).toISOString(),
    bridge: {
      lastPollOkAt: time(health.lastPollOkAt),
      lastError: health.needRelogin ? 'auth' : health.lastError ? 'poll' : 'none',
      needLogin: health.needLogin === true,
      needRelogin: health.needRelogin === true,
      jobsRunning: count(health.jobsRunning),
    },
    currentJob: jobSnapshot(currentJob, true),
    lastJob: jobSnapshot(lastJob, false),
    digest: projectSnapshot(digest, delivery.digest, artifactRoot),
    review: projectSnapshot(review, delivery.review, artifactRoot),
  };
}

export function writeSelfStatus(file, snapshot) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2));
    fs.renameSync(temporary, file);
    return { ok: true };
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    return { ok: false, error: 'write_failed' };
  }
}

function sanitizedSnapshot(input) {
  const updatedAt = time(input.updatedAt);
  return {
    version: 1,
    updatedAt,
    bridge: {
      lastPollOkAt: time(input.bridge?.lastPollOkAt),
      lastError: ['none', 'auth', 'poll', 'unknown'].includes(input.bridge?.lastError) ? input.bridge.lastError : 'unknown',
      needLogin: input.bridge?.needLogin === true,
      needRelogin: input.bridge?.needRelogin === true,
      jobsRunning: count(input.bridge?.jobsRunning),
    },
    currentJob: { running: input.currentJob?.running === true, startedAt: time(input.currentJob?.startedAt), steps: count(input.currentJob?.steps) },
    lastJob: {
      status: ['ok', 'error', 'cancelled', 'timeout', 'unknown'].includes(input.lastJob?.status) ? input.lastJob.status : 'unknown',
      endedAt: time(input.lastJob?.endedAt), steps: count(input.lastJob?.steps),
    },
    digest: projectSnapshot(input.digest, input.digest?.delivery, path.join(workspaceHome(), '发出')),
    review: projectSnapshot(input.review, input.review?.delivery, path.join(workspaceHome(), '发出')),
  };
}

export function readSelfStatus(file, { now = Date.now() } = {}) {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (input?.version !== 1) throw new Error('unsupported');
  } catch {
    return { version: 1, updatedAt: null, freshness: 'unknown', bridge: null, currentJob: null, lastJob: null, digest: null, review: null, error: 'unavailable' };
  }
  const snapshot = sanitizedSnapshot(input);
  const updatedMs = Number.isFinite(snapshot.updatedAt) ? snapshot.updatedAt : Date.parse(snapshot.updatedAt || '');
  const age = Number.isFinite(updatedMs) ? now - updatedMs : NaN;
  snapshot.freshness = Number.isFinite(age) && age <= 120000 ? 'fresh' : Number.isFinite(age) ? 'stale' : 'unknown';
  if (snapshot.freshness === 'stale') snapshot.note = '这是某时刻快照，当前状况未确认';
  return snapshot;
}
