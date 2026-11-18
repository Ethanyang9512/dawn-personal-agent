export function userArtifacts(task) {
  if (task.freshness && !['current', 'baseline'].includes(task.freshness.state)) return [];
  const artifacts = task.freshness?.state === 'baseline' ? task.baselineArtifacts || task.resultArtifacts || [] : task.resultArtifacts || [];
  const internal = new Set((task.steps || []).flatMap(step => step.outputs || []).filter(output => output.audience === 'internal').map(output => output.name));
  // 既有求职快照没有 audience 字段；它的核验文件继续留作内部证据。
  if (task.routine?.name === 'job-preparation') internal.add('核验.json');
  return artifacts.filter(artifact => artifact.audience !== 'internal' && !internal.has(artifact.name));
}

export function completionMessage(task, summary) {
  return [`任务「${task.title}」已完成。`, summary.slice(0, 600), ...userArtifacts(task).map(artifact => `[[发送文件: ${artifact.path}]]`)].filter(Boolean).join('\n');
}
