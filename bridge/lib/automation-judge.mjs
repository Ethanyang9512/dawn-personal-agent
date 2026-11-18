import { codexHome } from './locations.mjs';
import { runCodex } from './codex.mjs';
import { normalizeObservationText } from './automation-sources.mjs';

const PERMANENT_REVIEW_CODES = new Set([
  'INVALID_MODEL_JSON', 'INVALID_MODEL_RESULT', 'INVALID_FACT', 'EVIDENCE_NOT_FOUND',
  'OBSERVATION_MISMATCH', 'MISSING_REQUIRED_FACTS', 'TOOL_USE_REJECTED',
  'INVALID_CONDITION', 'INVALID_OBSERVATION', 'OBSERVATION_TOO_LARGE',
]);

export class SemanticReviewError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.name = 'SemanticReviewError';
    this.code = code;
    this.permanent = PERMANENT_REVIEW_CODES.has(code);
    if (Number.isFinite(extra.retryAt)) this.retryAt = extra.retryAt;
  }

  toJSON() {
    return { code: this.code, permanent: this.permanent, ...(this.retryAt ? { retryAt: this.retryAt } : {}) };
  }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function factSpecifications(condition) {
  const input = condition?.requiredFacts;
  const list = Array.isArray(input)
    ? input.map((item) => typeof item === 'string' ? { key: item, required: true } : item)
    : isRecord(input)
      ? Object.entries(input).map(([key, item]) => typeof item === 'string' ? { key, required: true, description: item } : { ...item, key })
      : [];
  const seen = new Set();
  return list.map((item) => {
    if (!isRecord(item)) throw new SemanticReviewError('INVALID_CONDITION');
    const key = item.key || item.name || item.field;
    const group = item.group || item.anyOf;
    if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || seen.has(key)) throw new SemanticReviewError('INVALID_CONDITION');
    if (group != null && (typeof group !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(group))) throw new SemanticReviewError('INVALID_CONDITION');
    seen.add(key);
    return {
      key,
      required: item.required === true,
      group: group || null,
      description: typeof item.description === 'string' ? item.description : '',
    };
  });
}

function makePrompt(condition, observation, specifications) {
  let conditionJson;
  try { conditionJson = JSON.stringify(condition); } catch { throw new SemanticReviewError('INVALID_CONDITION'); }
  const schema = specifications.map(({ key, required, group, description }) => ({ key, required, anyOfGroup: group, description }));
  return `你是长期监测任务的语义复核器。只依据本次输入的一条 Observation 的规范化 text 判断，不使用外部知识，不调用任何工具，不把其他条目或历史对话当作证据。
 condition 是判断口径；requiredFacts 定义允许输出的事实字段。required=true 的字段必须存在；同一 anyOfGroup 至少需要一个字段，match=true 时这些事实都必须有逐项原文证据。
 证据必须逐字复制本次 Observation.text 的连续子串，不能改写、拼接、补充或来自 URL。match 只能是 JSON boolean。不要采用或生成官方链接，canonicalUrl 由程序保留。
 完整输出只能是一个可直接 JSON.parse 的 JSON 对象，不要 Markdown 代码围栏或任何额外文字，形状如下：
 {"sourceId":"与输入相同","itemId":"与输入相同","match":false,"facts":{"字段名":{"value":"字符串、数值或 boolean","evidence":"输入 text 的连续子串"}}}
 若没有事实，facts 输出 {}。match=false 时也可输出有证据的事实。不要输出其他事实字段。
 condition.requiredFacts 的程序化描述：${JSON.stringify(schema)}
 condition 原始条件：${conditionJson}
 Observation：${JSON.stringify(observation)}`;
}

function validateFacts(input, specifications, normalizedText) {
  if (!isRecord(input)) throw new SemanticReviewError('INVALID_MODEL_RESULT');
  const declared = new Map(specifications.map((spec) => [spec.key, spec]));
  const facts = Object.create(null);
  for (const [key, fact] of Object.entries(input)) {
    if (!declared.has(key) || !isRecord(fact) || !Object.hasOwn(fact, 'value')) throw new SemanticReviewError('INVALID_FACT');
    const value = fact.value;
    const validScalar = typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && !!value.trim());
    if (!validScalar || typeof fact.evidence !== 'string' || !fact.evidence.trim()) throw new SemanticReviewError('INVALID_FACT');
    if (!normalizedText.includes(fact.evidence)) throw new SemanticReviewError('EVIDENCE_NOT_FOUND');
    facts[key] = { value, evidence: fact.evidence };
  }
  return facts;
}

function requirementsSatisfied(specifications, facts) {
  if (specifications.some((spec) => spec.required && !Object.hasOwn(facts, spec.key))) return false;
  const groups = new Set(specifications.map((spec) => spec.group).filter(Boolean));
  return [...groups].every((group) => specifications.some((spec) => spec.group === group && Object.hasOwn(facts, spec.key)));
}

function defaultRunModel(call) {
  return runCodex({
    bin: call.bin,
    cwd: call.cwd,
    prompt: call.prompt,
    sessionId: call.sessionId,
    model: call.model,
    effort: call.effort,
    env: call.env,
    idleMs: call.idleMs,
    maxMs: call.maxMs,
  }).done;
}

export function createSemanticReviewer(options = {}) {
  const runModel = options.runModel || defaultRunModel;
  return {
    async reviewObservation({ condition, observation }) {
      if (!isRecord(condition) || !isRecord(observation) || typeof observation.sourceId !== 'string' || typeof observation.itemId !== 'string' || typeof observation.canonicalUrl !== 'string' || typeof observation.text !== 'string') {
        throw new SemanticReviewError('INVALID_OBSERVATION');
      }
      const normalizedText = normalizeObservationText(observation.text);
      if (!normalizedText) throw new SemanticReviewError('INVALID_OBSERVATION');
      if (Array.from(normalizedText).length > 24000) throw new SemanticReviewError('OBSERVATION_TOO_LARGE');
      const specifications = factSpecifications(condition);
      const modelObservation = {
        sourceId: observation.sourceId,
        itemId: observation.itemId,
        canonicalUrl: observation.canonicalUrl,
        text: normalizedText,
      };
      const prompt = makePrompt(condition, modelObservation, specifications);
      const env = {
        ...(options.env || process.env),
        DAWN_WECHAT: '1',
        CODEX_HOME: options.codexHome || options.env?.CODEX_HOME || codexHome(),
        // 防误操作护栏，不是提示注入安全沙箱；steps=0 与证据校验仍是独立出口。
        DAWN_GUARD_MODE: 'pipeline',
      };
      for (const key of Object.keys(env)) if (key.startsWith('KIMI_')) delete env[key];
      let result;
      try {
        result = await runModel({
          bin: options.bin || 'codex',
          cwd: options.cwd || process.cwd(),
          prompt,
          sessionId: null,
          model: options.model ?? null,
          effort: options.effort ?? 'high',
          env,
          idleMs: options.idleMs ?? 2 * 60e3,
          maxMs: options.maxMs ?? 5 * 60e3,
        });
      } catch {
        throw new SemanticReviewError('MODEL_FAILED');
      }
      if (!result || result.isError) {
        const resetsAt = Number(result?.rateLimit?.resetsAt);
        const retryAt = Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt * 1000 : undefined;
        throw new SemanticReviewError('MODEL_FAILED', { retryAt });
      }
      if (result.steps !== 0) throw new SemanticReviewError('TOOL_USE_REJECTED');
      if (typeof result.text !== 'string') throw new SemanticReviewError('INVALID_MODEL_JSON');
      let raw;
      try { raw = JSON.parse(result.text); } catch { throw new SemanticReviewError('INVALID_MODEL_JSON'); }
      if (!isRecord(raw) || raw.sourceId !== observation.sourceId || raw.itemId !== observation.itemId) throw new SemanticReviewError('OBSERVATION_MISMATCH');
      if (typeof raw.match !== 'boolean' || !isRecord(raw.facts)) throw new SemanticReviewError('INVALID_MODEL_RESULT');
      const facts = validateFacts(raw.facts, specifications, normalizedText);
      if (raw.match && !requirementsSatisfied(specifications, facts)) throw new SemanticReviewError('MISSING_REQUIRED_FACTS');
      return {
        sourceId: observation.sourceId,
        itemId: observation.itemId,
        canonicalUrl: observation.canonicalUrl,
        ...(typeof observation.versionHash === 'string' ? { versionHash: observation.versionHash } : {}),
        match: raw.match,
        facts,
      };
    },
  };
}
