import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyUserEdit } from './task-feedback.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { code: 'JOB_PREPARATION_INVALID' }); };
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('求职流程字段为空或过长');
  return value.trim();
};
export function jobPreparation(value) {
  const company = text(value.company, 60), role = text(value.role, 80);
  const requirements = text(value.requirements, 6000), origin = text(value.origin, 2000);
  if (!Array.isArray(value.materials) || value.materials.length > 20) fail('需要公司、岗位和候选人三类来源');
  const materials = value.materials.map(m => {
    if (!['company', 'role', 'candidate'].includes(m.kind) || typeof m.path !== 'string' || !path.isAbsolute(m.path)
      || !/^\d{4}-\d{2}-\d{2}$/.test(m.asOf || '')) fail('资料需要 kind、绝对 path 和 YYYY-MM-DD 的 asOf');
    if (m.validUntil && !Number.isFinite(Date.parse(m.validUntil))) fail('有效期需要明确时间');
    return { kind: m.kind, path: m.path, asOf: m.asOf, ...(m.validUntil ? { validUntil: m.validUntil } : {}) };
  }).sort((a, b) => {
    // 指纹必须跨终端/launchd 语言环境一致，不能采用本地化排序。
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (['company', 'role', 'candidate'].some(kind => !materials.some(m => m.kind === kind))) fail('缺少公司、岗位或候选人来源');
  const identity = [company, role].map(s => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim());
  const routine = { name: 'job-preparation', version: 1, company, role, requirements, materials };
  routine.fingerprint = hash(JSON.stringify(routine));
  const sources = [...new Set(materials.map(m => m.path))];
  return {
    id: `job-${hash(JSON.stringify(identity)).slice(0, 24)}`, title: `${company} · ${role}`.slice(0, 100),
    objective: `为 ${company} 的 ${role} 准备可直接用于面试的资料包。${requirements}`,
    scope: '读取指定资料、公开信息核验、生成本地求职材料；不投递、不联系招聘方、不替用户接受地点或条件，不修改原始资料。',
    origin, sources, notify: value.notify !== false, routine,
    steps: [
      { id: 'evidence', instruction: '逐一读取 routine.materials 的公司、岗位、候选人资料。生成证据与匹配.md：公司及岗位实际情况、资料日期和来源、岗位要求与候选人经历对应、未知和矛盾、面试准备重点。严格区分用户提供、公开事实、推断和待确认；历史招聘记录不能证明仍在招聘，公司品牌与雇佣主体分开，学历和经历以原文为准。不要大段复述公司宣传，不输出私人联系方式。结合 routine.requirements 和最新 inputs。约 1000–1600 中文字。',
        outputs: [{ name: '证据与匹配.md', minBytes: 1600, contains: ['来源', '待确认'] }] },
      { id: 'preparation', instruction: '基于已核验的证据与匹配.md、routine.materials 原资料及全部最新 inputs，生成求职准备.md：岗位判断（含来源日期与待确认事项）、经历匹配（可讲的具体案例，保留真实边界）、面试准备（核心问题及回答思路）、材料清单（向谁索取/核对什么/当前状态）、本次更新（逐项说明最新补充落实在哪一段）。约 1600–2400 中文字，可按用户最新要求调整篇幅和形式。不要虚构已索取材料、招聘进展、业绩、学位、雇佣关系；引用本地资料用绝对路径，网页用真实原链接。新输入若推翻前序分析，回读原资料并改正最终成果，不能照抄旧检查点。\n同时生成核验.json：{taskId,inputRevision,company,role,sourceChecks:[{path,sha256}],appliedInputs:[{id,revision,section}]}。sourceChecks 覆盖任务 sources 全部文件，sha256 必须通过实际读取文件计算；appliedInputs 覆盖 task.inputs 全部补充，section 为最终正文中实际存在的对应段落标题（已被后续要求替代也须在本次更新注明）。这份清单用于检查版本、来源完整性和补充落点，不能代替事实与内容审阅。',
        outputs: [{ name: '求职准备.md', minBytes: 2400, contains: ['岗位判断', '经历匹配', '面试准备', '材料清单', '本次更新', '来源'] },
          { name: '核验.json', format: 'json', minBytes: 100, audience: 'internal' }] },
    ],
  };
}

export function validateJobRoutine(routine) {
  if (routine?.name !== 'job-preparation' || routine.version !== 1) fail('未知求职流程版本');
  const canonical = jobPreparation({ ...routine, origin: '流程校验' }).routine;
  if (routine.fingerprint !== canonical.fingerprint) fail('流程快照不完整或已被修改');
  return canonical;
}

export function verifyJobPreparation(task, attempt) {
  if (task.routine?.name !== 'job-preparation' || task.steps[attempt.stepIndex].id !== 'preparation') return;
  const report = JSON.parse(fs.readFileSync(path.join(attempt.directory, '核验.json'), 'utf8'));
  const content = fs.readFileSync(path.join(attempt.directory, '求职准备.md'), 'utf8');
  if (report.taskId !== task.id || report.inputRevision !== task.inputRevision || report.company !== task.routine.company || report.role !== task.routine.role) fail('成果不属于当前岗位或输入版本');
  if (task.opportunity && report.opportunityRevision !== task.opportunity.revision) fail('成果没有核对当前机会版本');
  if (task.context && (report.contextRevision !== task.context.revision || JSON.stringify(report.factChecks?.map(f => [f.id, f.revision, f.status]).sort()) !== JSON.stringify(task.context.facts.map(f => [f.id, f.revision, f.status]).sort()))) fail('成果未核对当前资料与事实版本');
  const sources = task.context ? [...new Set(task.context.sources.map(s => s.snapshot))] : task.sources;
  if (!Array.isArray(report.sourceChecks) || report.sourceChecks.length !== sources.length
    || sources.some(file => report.sourceChecks.filter(s => s.path === file && s.sha256 === hash(fs.readFileSync(file))).length !== 1)) fail('来源遗漏或已变化，需按现有资料重新核对');
  if (!Array.isArray(report.appliedInputs) || report.appliedInputs.length !== task.inputs.length
    || task.inputs.some(input => report.appliedInputs.filter(i => i.id === input.id && i.revision === input.revision
      && typeof i.section === 'string' && i.section.trim() && content.includes(i.section)).length !== 1)) fail('补充要求缺少实际成果落点');
  const refs = attempt.experienceRefs || task.experienceRefs || [];
  if (refs.length && (!Array.isArray(report.experienceChecks) || report.experienceChecks.length !== refs.length
    || refs.some(ref => report.experienceChecks.filter(check => check.id === ref.id && check.revision === ref.revision
      && typeof check.applied === 'boolean' && typeof check.reason === 'string' && check.reason.trim() && check.reason.length <= 1000
      && (!check.applied || (typeof check.quote === 'string' && check.quote.trim().length >= 8 && check.quote.length <= 1000 && content.includes(check.quote)))).length !== 1))) fail('经验版本或实际应用落点无效');
  const edit = verifyUserEdit(task);
  if (edit && (!Array.isArray(report.userEditChecks) || report.userEditChecks.length !== 1 || report.userEditChecks.some(check => check.feedbackId !== edit.feedbackId
    || check.path !== edit.snapshot || check.sha256 !== edit.sha256 || typeof check.section !== 'string' || !check.section.trim() || !content.includes(check.section)))) fail('用户改稿版本或保留落点未核对');
}
