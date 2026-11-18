import fs from 'node:fs';
import path from 'node:path';
import { AutomationConfigError } from './automation-schema.mjs';

function liveLock(lockPath) {
  let pid;
  try { pid = Number(fs.readFileSync(lockPath, 'utf8').trim()); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; }
}

export function withAutomationControlLock(controlPath, fn) {
  const lockPath = `${controlPath}.lock`;
  fs.mkdirSync(path.dirname(controlPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (error?.code !== 'EEXIST') throw error;
      if (liveLock(lockPath)) throw new AutomationConfigError('CONTROL_BUSY', 'automation control is being updated');
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    try { return fn(); } finally {
      fs.closeSync(descriptor);
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new AutomationConfigError('CONTROL_BUSY', 'automation control lock could not be acquired');
}
