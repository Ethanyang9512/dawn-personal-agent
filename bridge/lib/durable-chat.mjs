import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { writeDurableJson, readDurableJson } from './durable-json.mjs';
import { requestMetadata } from './runtime-maintenance.mjs';

export function processIdentity(pid = process.pid) {
  try {
    process.kill(pid, 0);
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
    }).trim();
  } catch { return null; }
}

export function answerChatApproval(directory, id, accepted) {
  writeDurableJson(path.join(directory, 'answer.json'), { id, accepted: accepted === true });
}

// 专用执行进程持有 app-server 的 stdio。桥仅订阅磁盘记录，重启不再创建同一轮。
export function runDurableChat({ directory, onProgress, onApproval, ...options }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = name => path.join(directory, `${name}.json`);
  if (!fs.existsSync(file('request'))) writeDurableJson(file('request'), requestMetadata(options));
  let detached = false, timer, approvalId, approvalAbort, lastProgress, launchedAt = 0;
  const launch = () => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'chat-worker.mjs'), directory], {
      detached: true, stdio: ['pipe','ignore','ignore'], env: process.env,
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify(options));
    child.on('error', () => {}); child.unref(); launchedAt = Date.now();
  };
  if (!fs.existsSync(file('claim')) && !fs.existsSync(file('result'))) launch();
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const close = () => { clearInterval(timer); approvalAbort?.abort(); };
  const tick = () => {
    if (detached) return;
    try {
      const result = readDurableJson(file('result'), null);
      if (result) { close(); finish(result); return; }
      const status = readDurableJson(file('status'), {});
      const progress = JSON.stringify(status.progress);
      if (progress !== lastProgress && status.progress) { lastProgress = progress; onProgress?.(status.progress); }
      if (status.approval && status.approval.id !== approvalId) {
        approvalAbort?.abort(); approvalAbort = new AbortController();
        approvalId = status.approval.id;
        const id = approvalId;
        if (readDurableJson(file('answer'), null)?.id !== id) {
          Promise.resolve(onApproval?.({ ...status.approval, directory, signal: approvalAbort.signal }))
            .then(accepted => { if (!detached) answerChatApproval(directory, id, accepted); })
            .catch(() => { if (!detached) answerChatApproval(directory, id, false); });
        }
      }
      const claim = readDurableJson(file('claim'), null);
      if (claim && processIdentity(claim.pid) !== claim.start) {
        // 已承诺执行后失去整个 worker，无法证明外部工具未生效，保留原消息供核对。
        close(); finish({ text: '', texts: [], isError: true, recoveryRequired: true,
          errorText: '消息和执行记录已保存。执行进程意外退出，需要核对已完成的操作后续办。',
          sessionId: status.sessionId || null, steps: status.progress?.steps || 0, stderr: '' });
      } else if (!claim && Date.now() - launchedAt > 10000) {
        if (fs.existsSync(path.join(directory, 'claimed'))) {
          close(); finish({ text: '', texts: [], isError: true, recoveryRequired: true, steps: 0,
            errorText: '消息已保存，执行启动记录不完整，需要核对后续办。', stderr: '' });
        } else launch();
      }
    } catch (error) {
      close(); finish({ text: '', texts: [], isError: true, recoveryRequired: true, steps: 0,
        errorText: `执行记录无法读取：${error.code || error.name}`, stderr: '' });
    }
  };
  timer = setInterval(tick, 200); tick();
  return { done, directory,
    cancel() { writeDurableJson(file('cancel'), { at: Date.now() }); },
    detach() { detached = true; close(); },
  };
}
