import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { backendOptions } from './backend.mjs';
import { fetchObservations as fetchSourceObservations } from './automation-sources.mjs';
import { createSemanticReviewer } from './automation-judge.mjs';
import { validateAutomationConfig } from './automation-schema.mjs';

const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (value, limit) => {
  const chars = Array.from(clean(value));
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit - 1).join('')}…`;
};
const factValue = (value) => typeof value === 'string' ? value : JSON.stringify(value);

export function createAutomationAdapters(options = {}) {
  const cfg = options.cfg || {};
  const modelOptions = backendOptions(cfg, { pipeline: true, env: options.env || process.env });
  const startModel = options.runModel || modelOptions.runner;
  const active = new Set();
  const reviewCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dawn-automation-review-'));
  const runModel = async (call) => {
    const handle = startModel({ ...call, voiceWorkspace: modelOptions.voiceWorkspace });
    active.add(handle);
    try { return await handle.done; } finally { active.delete(handle); }
  };
  const reviewer = createSemanticReviewer({
    backend: modelOptions.backend,
    bin: modelOptions.bin,
    cwd: reviewCwd,
    model: cfg.automationModel || modelOptions.model,
    effort: cfg.automationEffort || modelOptions.effort,
    env: modelOptions.env,
    runModel,
  });
  return {
    validateAutomationConfig,
    async fetchObservations(task, source, opts = {}) {
      const candidateWords = source.candidateWords || task.condition?.candidateWords;
      const sanitizedSource = { ...source, sourceId: source.id || source.sourceId };
      delete sanitizedSource.allowedOrigins;
      delete sanitizedSource.allowOrigins;
      if (source.allowedOrigin) sanitizedSource.allowedOrigins = [source.allowedOrigin];
      if (candidateWords) sanitizedSource.candidateWords = candidateWords;
      return (options.fetchSource || fetchSourceObservations)(sanitizedSource, {
        ...opts,
        ...(cfg.test?.monitorPrivateOrigins ? { allowPrivateOrigins: cfg.test.monitorPrivateOrigins } : {}),
      });
    },
    async reviewObservation({ task, observation }) {
      const review = await reviewer.reviewObservation({ condition: task.condition, observation });
      const facts = Object.entries(review.facts || {});
      const builtinLabels = { eventIdentity: '赛事身份', ticketEvidence: '售票证据', onSale: '开售状态' };
      const configuredLabels = new Map((task.condition?.requiredFacts || []).map((fact) => [fact.key, fact.description]));
      const labelFor = (key) => configuredLabels.get(key) || builtinLabels[key] || key;
      const values = facts.map(([key, fact]) => `${labelFor(key)}=${clip(factValue(fact.value), 80)}`).join('；');
      return {
        ...review,
        canonicalUrl: observation.canonicalUrl,
        conclusion: clip(`${task.action?.text || task.name || '监测命中'}${values ? `：${values}` : ''}`, 240),
        evidence: facts.map(([key, fact]) => (
          `${labelFor(key)}=${clip(factValue(fact.value), 80)}；原文：${clip(fact.evidence, 500)}`
        )).join('\n'),
      };
    },
    cancelCurrentWork() {
      for (const handle of active) {
        try { handle.cancel(); } catch { /* 已退出 */ }
      }
      fs.rmSync(reviewCwd, { recursive: true, force: true });
    },
  };
}

export function deliveryEventIds(item) {
  const ids = item?.automation?.eventIds
    || item?.proactive?.eventIds
    || (item?.proactive?.eventId ? [item.proactive.eventId] : []);
  return [...new Set(ids.filter((id) => typeof id === 'string' && id))];
}

export function groupAutomationItems(items) {
  const policies = items.map((item) => item.proactive?.deliveryPolicy || {});
  const quiet = policies[0]?.quiet || 'follow';
  const incompatible = policies.some((policy) => policy.priority === 'high' || policy.merge === false
    || (policy.quiet || 'follow') !== quiet);
  if (items.length < 2 || incompatible) return items;
  const text = items.map((item) => item.text).join('\n\n');
  if (Array.from(text).length > 1600) return items;
  const eventIds = items.flatMap(deliveryEventIds);
  const groupId = `ag_${createHash('sha256').update(eventIds.join('\n')).digest('hex').slice(0, 24)}`;
  return [{
    kind: 'text',
    text,
    proactive: {
      type: 'automation',
      groupId,
      eventIds,
      events: items.map((item) => item.proactive),
      deliveryPolicy: { priority: 'low', quiet },
    },
    automation: { groupId, eventIds },
  }];
}

// 混合摘要按事件重建，不能靠替换正文来撤回其中一项。
export function withdrawAutomationEvents(item, cancelledIds, lookupEvent) {
  const ids = deliveryEventIds(item);
  const kept = ids.filter(id => !cancelledIds.has(id));
  if (kept.length === ids.length) return [item];
  if (!kept.length) return [];
  const parts = kept.map(id => {
    const event = lookupEvent(id);
    if (!event?.text) throw new Error(`Missing automation event for partial withdrawal: ${id}`);
    return {
      kind: 'text', text: event.text,
      proactive: {
        type: 'automation', id, eventId: id, taskId: event.taskId,
        detectedAt: event.detectedAt, at: Date.parse(event.detectedAt),
        deliveryPolicy: event.deliveryPolicy || {}, text: event.text,
      },
      automation: { eventIds: [id] },
    };
  });
  return groupAutomationItems(parts).map(part => ({
    ...part,
    ...(item.deferredQuiet ? { deferredQuiet: true } : {}),
    ...(item.notBefore ? { notBefore: item.notBefore } : {}),
  }));
}

export function recoverAutomationOutgoing({ outgoingDir, items = [], staleItems = [] }) {
  const referenced = new Set([...items, ...staleItems].flatMap(deliveryEventIds));
  for (const name of fs.readdirSync(outgoingDir)) {
    const match = /^a:([A-Za-z0-9_-]+)\.txt(\.sending)?$/.exec(name);
    if (!match) continue;
    const file = path.join(outgoingDir, name);
    const finalPath = path.join(outgoingDir, `a:${match[1]}.txt`);
    if (referenced.has(match[1])) {
      fs.unlinkSync(file); // 已有持久 outbox/stale 文本；删除冗余文件不代表已发送
      continue;
    }
    if (!match[2]) continue;
    if (fs.existsSync(finalPath)) fs.unlinkSync(file);
    else fs.renameSync(file, finalPath);
  }
}
