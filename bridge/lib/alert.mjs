// 可选的本机通知与飞书提醒，同一类提醒按间隔限频。
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';

function run(cmd, args, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: 30000 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err }));
  });
}

export function createAlerter({ cfg, state, saveState, log }) {
  return async function alert(kind, text, { minIntervalMs = 6 * 3600e3 } = {}) {
    const now = Date.now();
    state.alerts ||= {};
    if (state.alerts[kind] && now - state.alerts[kind] < minIntervalMs) return {confirmed:false,attempted:false};
    state.alerts[kind] = now;
    saveState();
    log(`alert ${kind}: ${text}`);

    const pending=[];
    if (cfg.alert?.mac === true && process.platform === 'darwin') {
      const esc = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      pending.push(run('/usr/bin/osascript', ['-e', `display notification "${esc}" with title "Dawn（微信）"`], process.env));
    }
    const fs = cfg.alert?.feishu;
    let confirmation=pending[0]?.then(r=>r.ok) || Promise.resolve(false);
    if (fs?.enabled) {
      confirmation=Promise.resolve(false);
      // 飞书连接独立于模型代理设置
      const env = { ...process.env, LARKSUITE_CLI_CONFIG_DIR: fs.configDir };
      for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
      const key = `dawn-${kind}-${Math.floor(now / 60000)}`.slice(0, 50);
      // lark-cli 是 #!/usr/bin/env node 脚本；launchd 的 PATH 里未必有 node，直接用本进程的 node 跑它
      let script;
      try { script = realpathSync(fs.larkCli); } catch { log(`alert feishu: 找不到 lark-cli ${fs.larkCli}`); }
      if(script && fs.userOpenId && fs.configDir){
        confirmation=run(process.execPath, [script, 'im', '+messages-send', '--as', 'bot', '--user-id', fs.userOpenId, '--text', `【Dawn 微信】${text}`, '--idempotency-key', key], env).then(r=>{
          const ok=r.ok && /"ok":\s*true/.test(r.stdout);
          if(!ok)log(`alert feishu failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
          return ok;
        });
        pending.push(confirmation);
      }
    }
    await Promise.all(pending);
    return {confirmed:await confirmation,attempted:true};
  };
}
