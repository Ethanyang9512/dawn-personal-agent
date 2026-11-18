#!/usr/bin/env node
// 扫码登录微信 ClawBot：生成二维码页面并打开，等手机确认，凭证存到 state/account.json（0600）
// 手机要求输入验证码时：在终端输入，或把数字写进 $DAWN_HOME/state/verify-code.txt
import { dataHome } from './lib/locations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ILink } from './lib/ilink.mjs';
import { qrSvg, qrTerminal } from './lib/qr.mjs';
import { readJson, writeJson } from './lib/store.mjs';

const HOME = dataHome();
const cfg = readJson(path.join(HOME, 'config.json'), {});
const ACCOUNT = path.join(HOME, 'state', 'account.json');
const STATUS = path.join(HOME, 'state', 'login-status.json');
const VERIFY = path.join(HOME, 'state', 'verify-code.txt');
const PAGE = path.join(HOME, 'login-qr.html');
const noOpen = process.argv.includes('--no-open');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function status(s, extra = {}) {
  writeJson(STATUS, { status: s, at: new Date().toISOString(), ...extra });
  console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${s}${extra.note ? '：' + extra.note : ''}`);
}

function writePage(content, round) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dawn 扫码登录</title><style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f4f4f2;color:#222;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:16px;padding:32px 36px;box-shadow:0 2px 14px rgba(0,0,0,.08);text-align:center;max-width:420px}
h1{font-size:20px;margin:0 0 6px}p{color:#555;line-height:1.6;margin:8px 0}.qr svg{width:300px;height:300px}small{color:#999}</style></head>
<body><div class="card"><h1>用微信扫码，把 Dawn 接到微信</h1>
<p>手机微信「扫一扫」这张码，然后在手机上点确认。</p><div class="qr">${qrSvg(content)}</div>
<p>扫完先在微信里给 Dawn 发一句话，之后它才能回你。</p><small>第 ${round} 张码，约 2 分钟失效，失效会自动换新的；本页不会自动刷新，换码后请重新打开。</small></div></body></html>`;
  fs.writeFileSync(PAGE, html, { mode: 0o600 });
}

async function readVerifyCode() {
  try { fs.unlinkSync(VERIFY); } catch { /* 没有旧文件 */ }
  status('need_verifycode', { note: `手机上显示了一串数字。终端里输入，或写进 ${VERIFY}` });
  const deadline = Date.now() + 3 * 60e3;
  let typed = null;
  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => { typed = String(d).trim(); });
  }
  while (Date.now() < deadline) {
    if (typed) return typed;
    try {
      const v = fs.readFileSync(VERIFY, 'utf8').trim();
      if (v) { fs.unlinkSync(VERIFY); return v; }
    } catch { /* 还没写 */ }
    await sleep(1000);
  }
  return null;
}

async function main() {
  const old = readJson(ACCOUNT, null);
  const il = new ILink({ token: '', fixedBase: cfg.test?.fixedBase, cdnBase: cfg.test?.cdnBase });
  // --fresh：不带旧凭证，强制换一份新的
  const localTokens = old?.token && !process.argv.includes('--fresh') ? [old.token] : [];
  const loginDeadline = Date.now() + 8 * 60e3;
  let verify = null;

  for (let round = 1; round <= 4 && Date.now() < loginDeadline; round++) {
    const q = await il.getQrcode(localTokens);
    if (!q.qrcode || !q.qrcode_img_content) { status('error', { note: `取二维码失败：${JSON.stringify(q).slice(0, 200)}` }); process.exit(1); }
    writePage(q.qrcode_img_content, round);
    console.log(qrTerminal(q.qrcode_img_content));
    console.log(`扫不了终端里的码，就打开 ${PAGE}`);
    status('qr_ready', { round, page: PAGE });
    if (!noOpen && process.platform === 'darwin') execFile('/usr/bin/open', [PAGE]);

    let base = il.fixedBase;
    let scannedLogged = false;
    while (Date.now() < loginDeadline) {
      const s = await il.qrcodeStatus(base, q.qrcode, verify);
      switch (s.status) {
        case 'wait':
          break;
        case 'scaned':
          if (!scannedLogged) { status('scanned', { note: '已扫码，等手机上确认' }); scannedLogged = true; }
          verify = null;
          break;
        case 'need_verifycode':
          verify = await readVerifyCode();
          if (!verify) { status('error', { note: '3 分钟内没收到验证码' }); process.exit(1); }
          continue; // 带上验证码立刻再查
        case 'verify_code_blocked':
          status('verify_blocked', { note: '验证码错太多次，换一张码' });
          verify = null;
          break;
        case 'scaned_but_redirect':
          if (s.redirect_host) base = `https://${s.redirect_host}`;
          break;
        case 'binded_redirect':
          // 改一下保存时间，正在等重新扫码的桥看到变化会再试一次
          if (old?.token) writeJson(ACCOUNT, { ...old, savedAt: new Date().toISOString() });
          status('already_bound', { note: '这个微信已经绑在本机 Dawn 上，原来的凭证继续用。要是桥仍然报掉线，用 dawn login --fresh 换新凭证' });
          process.exit(0);
          break;
        case 'confirmed': {
          if (!s.ilink_bot_id || !s.bot_token) { status('error', { note: '确认了但没拿到凭证' }); process.exit(1); }
          if (old?.token) {
            const bak = path.join(HOME, 'state', `account.backup-${Date.now()}.json`);
            writeJson(bak, old);
          }
          const acct = { token: s.bot_token, botId: s.ilink_bot_id, baseUrl: s.baseurl || il.fixedBase, userId: s.ilink_user_id || null, savedAt: new Date().toISOString() };
          writeJson(ACCOUNT, acct);
          writeJson(path.join(HOME, 'state', 'account.latest-backup.json'), acct);
          status('confirmed', { note: '登录成功。现在去微信给 Dawn 发一句话。', hasUserId: !!acct.userId });
          process.exit(0);
          break;
        }
        case 'expired':
          status('expired', { note: '二维码过期，换一张' });
          break;
        default:
          break;
      }
      if (s.status === 'expired' || s.status === 'verify_code_blocked') break;
      await sleep(1000);
    }
  }
  status('error', { note: '超时没登录成功，请重新运行' });
  process.exit(1);
}

main().catch((e) => { status('error', { note: e.message }); process.exit(1); });
