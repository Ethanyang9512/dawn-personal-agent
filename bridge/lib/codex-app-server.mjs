// 聊天使用官方 app-server stdio 协议，保留 MCP 的用户授权往返。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { voiceInstructions } from './voice.mjs';

const TOOLS = { commandExecution: '跑命令', fileChange: '改文件', mcpToolCall: '用工具', webSearch: '搜网页', imageGeneration: '生成图片', imageView: '看图片' };

export function computerAppRequest(params) {
  const meta = params._meta;
  const app = meta?.tool_params?.app;
  if (!['cua_repl', 'node_repl'].includes(params.serverName) || params.mode === 'url' ||
      meta?.connector_id !== 'computer-use' || meta?.codex_approval_kind !== 'mcp_tool_call' ||
      typeof app !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,199}$/.test(app)) return null;
  const display = meta.tool_params_display?.find?.(x => x.name === 'app')?.value;
  return { app, name: typeof display === 'string' ? display.replace(/[\r\n]/g, ' ').slice(0, 80) : app };
}

export function runCodexAppServer({ bin = 'codex', cwd, prompt, sessionId, model = null, effort = 'high', env,
  idleMs = 600000, maxMs = 3600000, onProgress, onSession, approvedComputerApps = [], onApproval, voiceWorkspace, writableRoots, images = [] }) {
  const voice = voiceInstructions(voiceWorkspace || cwd);
  const scope = writableRoots ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`,
    '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true'] : [];
  const launchedAt=performance.now(),timings={},mark=name=>{timings[name]=Math.round(performance.now()-launchedAt)};
  const child = spawn(bin, ['app-server', ...scope], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });child.once('spawn',()=>mark('processSpawnedMs'));
  const out = { sessionId: null, text: '', texts: [], isError: false, errorText: '', rateLimit: null, steps: 0, lastTool: null, timedOut: null, cancelled: false };
  const pending = new Map();
  const seenTools = new Set();
  const approved = new Set(approvedComputerApps);
  const abort = new AbortController();
  let sequence = 0, stderr = '', completed = false, closed = false, ending = false, idleTimer, killTimer;
  let approvalQueue = Promise.resolve();
  const noteError = text => { stderr = (stderr + String(text) + '\n').slice(-20000); };
  const signal = name => { if (!closed && child.pid) { try { process.kill(-child.pid, name); } catch { /* 已退出 */ } } };
  const stop = () => {
    if (ending) return;
    ending = true;
    abort.abort();
    signal('SIGTERM');
    killTimer = setTimeout(() => signal('SIGKILL'), 5000); killTimer.unref();
  };
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { out.timedOut = 'idle'; stop(); }, idleMs);
  };
  const send = message => { if (!closed && !ending) child.stdin.write(JSON.stringify(message) + '\n'); };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); send({ id, method, params });
  });
  const fail = error => { if (!ending) { out.isError = true; out.errorText = error.message || String(error); stop(); } };
  const serverRequest = async message => {
    if (message.method === 'mcpServer/elicitation/request') {
      const app = computerAppRequest(message.params);
      let accept = app && approved.has(app.app);
      if (app && !accept && onApproval) {
        approvalQueue = approvalQueue.then(async () => {
          if (abort.signal.aborted) return false;
          if (approved.has(app.app)) return true;
          try {
            const accepted = await onApproval({ ...app, signal: abort.signal }) === true;
            if (accepted) approved.add(app.app);
            return accepted;
          } catch { return false; }
        });
        accept = await approvalQueue;
      }
      if (accept) approved.add(app.app);
      send({ id: message.id, result: { action: accept ? 'accept' : 'cancel', ...(accept ? { content: {} } : {}) } });
    } else {
      send({ id: message.id, error: { code: -32601, message: 'Dawn does not handle this approval request' } });
    }
  };
  createInterface({ input: child.stdout }).on('line', line => {
    bumpIdle();
    let message;
    try { message = JSON.parse(line); } catch { if (line.trim()) noteError(line); return; }
    if (message.method && message.id !== undefined) { serverRequest(message).catch(fail); return; }
    if (message.id !== undefined) {
      const callback = pending.get(message.id); pending.delete(message.id);
      if (message.error) callback?.reject(new Error(message.error.message)); else callback?.resolve(message.result);
      return;
    }
    const p = message.params || {};
    if (message.method === 'thread/started') out.sessionId = p.thread?.id || out.sessionId;
    if (message.method === 'account/rateLimits/updated') out.rateLimit = p.rateLimits;
    if (message.method === 'error') noteError(p.error?.message || p.message || 'Codex 连接错误');
    const item = p.item;
    if (item && TOOLS[item.type] && !seenTools.has(item.id)) {
      seenTools.add(item.id); out.steps += 1; out.lastTool = TOOLS[item.type];
      onProgress?.({ steps: out.steps, lastTool: out.lastTool, lastText: null });
    }
    if (message.method === 'item/completed' && item?.type === 'agentMessage' && item.text) {
      out.text = item.text; out.texts.push(item.text);
      onProgress?.({ steps: out.steps, lastTool: out.lastTool, lastText: item.text });
    }
    if (message.method === 'turn/completed') {
      completed = p.turn?.status === 'completed';
      if (!completed) { out.isError = true; out.errorText = p.turn?.error?.message || `Codex turn ${p.turn?.status}`; }
      // 所有结果已收到；关闭专用进程及其 MCP 子进程，避免后台悬挂。
      stop();
    }
  });
  child.stderr.on('data', data => { bumpIdle(); noteError(data); });
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') noteError(error.message); });
  bumpIdle();
  const maxTimer = setTimeout(() => { out.timedOut = 'max'; stop(); }, maxMs);
  const done = new Promise(resolve => {
    child.on('error', fail);
    child.on('close', code => {
      closed = true; abort.abort();
      clearTimeout(idleTimer); clearTimeout(maxTimer); clearTimeout(killTimer);
      for (const callback of pending.values()) callback.reject(new Error('Codex app-server closed'));
      pending.clear();
      if (!completed && !out.isError) { out.isError = true; out.errorText = stderr.trim().slice(-800) || 'Codex 未返回完成事件'; }
      out.exitCode = completed ? 0 : code; out.stderr = stderr;out.timings=timings;
      resolve(out);
    });
  });
  (async () => {
    await request('initialize', { clientInfo: { name: 'dawn', version: '1.0.0' }, capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true } });
    mark('initializedMs');
    send({ method: 'initialized', params: {} });
    const params = { cwd, ...(model ? { model } : {}), ...(voice ? { developerInstructions: voice } : {}), approvalPolicy: { granular: { mcp_elicitations: true, rules: false, sandbox_approval: false, request_permissions: false, skill_approval: false } }, sandbox: 'workspace-write', config: { model_reasoning_effort: effort } };
    const result = await request(sessionId ? 'thread/resume' : 'thread/start', { ...params, ...(sessionId ? { threadId: sessionId, excludeTurns: true } : {}) });
    out.sessionId = result.thread.id;
    mark(sessionId?'threadResumedMs':'threadStartedMs');
    onSession?.(out.sessionId);
    mark('turnSubmittedMs');
    try { await request('turn/start', { threadId: out.sessionId, ...(model ? { model } : {}), effort, input: [{ type: 'text', text: prompt }, ...images.map(file=>({type:'localImage',path:file}))] }); }
    catch(error) { out.imageInputFailed=images.length>0;throw error; }
  })().catch(fail);
  return { pid: child.pid, done, cancel() { out.cancelled = true; stop(); } };
}
