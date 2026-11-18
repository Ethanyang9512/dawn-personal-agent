// 定时管线使用 Codex exec JSONL；返回桥统一的结果协议。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { voiceInstructions } from './voice.mjs';

const TOOLS = { command_execution: '跑命令', file_change: '改文件', mcp_tool_call: '用工具', web_search: '搜网页', collab_tool_call: '派子任务' };

export function runCodex({ bin = 'codex', cwd, prompt, sessionId, model = null, effort = 'high', env, idleMs, maxMs, onProgress, voiceWorkspace }) {
  const voice = voiceInstructions(voiceWorkspace || cwd);
  const pipeline = env?.DAWN_GUARD_MODE === 'pipeline';
  const args = ['exec', '--json', '--color', 'never', '--skip-git-repo-check',
    ...(model ? ['-m', model] : []), '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
    '-c', 'approval_policy="never"', '-c', `sandbox_mode="${pipeline ? 'read-only' : 'workspace-write'}"`,
    '-c', `web_search="${pipeline ? 'disabled' : 'live'}"`];
  if (pipeline) args.push('--ephemeral', '--disable', 'shell_tool', '--disable', 'plugins', '--disable', 'apps', '--disable', 'hooks');
  if (voice) args.push('-c', `developer_instructions=${JSON.stringify(voice)}`);
  if (sessionId) args.push('resume', sessionId);
  args.push('-');
  const child = spawn(bin, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = { sessionId: null, text: '', texts: [], isError: false, errorText: '', rateLimit: null, steps: 0, lastTool: null, timedOut: null, cancelled: false };
  let stderr = '';
  let completed = false;
  let closed = false;
  let killTimer;
  let idleTimer;
  const seenTools = new Set();
  const signal = (name) => { if (!closed && child.pid) { try { process.kill(-child.pid, name); } catch { /* 已退出 */ } } };
  const kill = () => { signal('SIGTERM'); killTimer ||= setTimeout(() => signal('SIGKILL'), 5000); killTimer.unref(); };
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { out.timedOut = 'idle'; kill(); }, idleMs);
  };
  const noteError = (text) => { stderr = (stderr + String(text) + '\n').slice(-20000); };
  bumpIdle();
  const maxTimer = setTimeout(() => { out.timedOut = 'max'; kill(); }, maxMs);
  createInterface({ input: child.stdout }).on('line', (line) => {
    bumpIdle();
    let event;
    try { event = JSON.parse(line); } catch { if (line.trim()) noteError(line); return; }
    if (event.type === 'thread.started') out.sessionId = event.thread_id;
    if (event.type === 'rate_limit' || event.type === 'rate_limit_event') out.rateLimit = event.rate_limit_info || null;
    if (event.type === 'turn.completed') completed = true;
    if (event.type === 'turn.failed') { out.isError = true; out.errorText = event.error?.message || 'Codex 执行失败'; }
    if (event.type === 'error') noteError(event.message || event.error?.message || 'Codex 连接错误');
    const item = event.item;
    if (item && TOOLS[item.type] && !seenTools.has(item.id)) {
      seenTools.add(item.id);
      out.steps += 1;
      out.lastTool = TOOLS[item.type];
      onProgress?.({ steps: out.steps, lastTool: out.lastTool, lastText: null });
    }
    if (event.type === 'item.completed' && item?.type === 'agent_message' && item.text) {
      out.text = item.text;
      out.texts.push(item.text);
      onProgress?.({ steps: out.steps, lastTool: out.lastTool, lastText: item.text });
    }
  });
  child.stderr.on('data', (data) => { bumpIdle(); noteError(data); });
  child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') noteError(error.message); });
  child.stdin.end(prompt);
  const done = new Promise((resolve) => {
    child.on('error', (error) => { out.isError = true; out.errorText = `启动 Codex 失败：${error.message}`; });
    child.on('close', (code) => {
      closed = true;
      clearTimeout(idleTimer); clearTimeout(maxTimer); clearTimeout(killTimer);
      if ((code !== 0 || !completed) && !out.isError) {
        out.isError = true;
        out.errorText = stderr.trim().slice(-800) || (code !== 0 ? `exit ${code}` : 'Codex 未返回完成事件');
      }
      out.exitCode = code;
      out.stderr = stderr;
      resolve(out);
    });
  });
  return { pid: child.pid, done, cancel() { out.cancelled = true; kill(); } };
}
