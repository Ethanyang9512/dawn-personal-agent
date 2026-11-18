import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCodexAppServer } from './codex-app-server.mjs';
import { processIdentity } from './durable-chat.mjs';
import { writeDurableJson, readDurableJson } from './durable-json.mjs';

const directory = process.argv[2];
const file = name => path.join(directory, `${name}.json`);
const metadata = readDurableJson(file('request'));
let options=metadata;
if(metadata.schemaVersion===2){
  let input='';for await(const chunk of process.stdin)input+=chunk;
  options=JSON.parse(input); // A broken pipe never leaves a permanent execution claim.
}
// 永久执行承诺。竞争启动的 worker 只能有一个胜出；完成记录不删除。
try {
  fs.mkdirSync(path.join(directory, 'claimed'), { mode: 0o700 });
  writeDurableJson(file('claim'), { pid: process.pid, start: processIdentity() });
} catch (error) { if (error.code === 'EEXIST') process.exit(0); throw error; }
if (fs.existsSync(file('cancel'))) {
  writeDurableJson(file('result'), { text: '', texts: [], cancelled: true, steps: 0 });
  process.exit(0);
}
const status = { startedAt: Date.now(), progress: { steps: 0, lastTool: null } };
const save = () => writeDurableJson(file('status'), status);
save();
let approvalResolve;
const run = runCodexAppServer({ ...options,
  onSession(sessionId) { status.sessionId = sessionId; save(); },
  onProgress(progress) { status.progress = { ...progress, lastText: progress.lastText || status.progress.lastText || null }; save(); },
  onApproval: ({ app, name, signal }) => new Promise(resolve => {
    status.approval = { id: randomUUID(), app, name }; save();
    const settle = accepted => { signal.removeEventListener('abort', cancel); approvalResolve = null; delete status.approval; save(); resolve(accepted); };
    const cancel = () => settle(false);
    approvalResolve = settle;
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  }),
});
status.backendPid = run.pid; save();
const timer = setInterval(() => {
  if (fs.existsSync(file('cancel'))) run.cancel();
  const answer = readDurableJson(file('answer'), null);
  if (approvalResolve && answer?.id === status.approval?.id) approvalResolve(answer.accepted === true);
}, 100);
process.on('SIGTERM', () => run.cancel());
process.on('SIGINT', () => run.cancel());
const result = await run.done;
clearInterval(timer);
writeDurableJson(file('result'), result);
