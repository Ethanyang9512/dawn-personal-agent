// 状态文件：JSON，原子写（先写临时文件再改名），权限 0600
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 单实例锁：同一个微信 token 只能有一个进程在收消息。
// 断电重启后锁文件还在、PID 可能被别的进程复用（比如飞书桥），所以锁里同时记 PID 和进程启动时间，两样都对上才算被占用。
// ps 的时间格式随语言和时区变：固定成 C 和 UTC，写锁和查锁算出来才一致
const PS_ENV = { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
function processStart(pid) {
  try { process.kill(pid, 0); } catch { return null; } // 进程不在了
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: PS_ENV }).trim() || '?';
  } catch { return '?'; } // 进程在、但 ps 查不了：保守起见当作被占用（launchd 会隔 30 秒再试）
}

export function acquireLock(file) {
  let held = null;
  try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 没有锁文件，或旧格式 */ }
  if (held?.pid && held.pid !== process.pid && held.start) {
    const now = processStart(held.pid);
    if (now === '?' || now === held.start) return false;
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, start: processStart(process.pid) }), { mode: 0o600 });
  return true;
}

export function releaseLock(file) {
  try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); } catch { /* ignore */ }
}
