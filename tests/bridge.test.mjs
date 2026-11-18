import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '../bin/dawn');
const fixture = path.join(import.meta.dirname, 'fixtures/codex.mjs');
const owner = 'fixture-owner';
function incoming(id, who, text) {
  return { message_id: id, from_user_id: who, to_user_id: 'fixture-bot', message_type: 1,
    context_token: 'fixture-context', create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text } }] };
}
async function until(predicate) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await delay(75);
  }
  assert.fail('The expected bridge event did not arrive.');
}

test('clean install, QR binding, owner-only chat, restart deduplication and local memory', { timeout: 50000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dawn-e2e-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'data');
  const env = { HOME: root, PATH: process.env.PATH, DAWN_HOME: home };
  const run = (...args) => exec(process.execPath, [cli, ...args], { env, timeout: 15000 });
  await run('init');
  const configFile = path.join(home, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(JSON.parse((await run('status')).stdout).paired, false);
  const received = [], pending = [];
  let polls = 0;
  const server = http.createServer(async (request, response) => {
    const endpoint = new URL(request.url, 'http://localhost').pathname.split('/').pop();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    let result = { ret: 0 };
    if (endpoint === 'get_bot_qrcode') result = { qrcode: 'demo', qrcode_img_content: 'https://example.org/pair/demo' };
    if (endpoint === 'get_qrcode_status') result = { status: 'confirmed', bot_token: 'fixture', ilink_bot_id: 'fixture-bot', ilink_user_id: owner, baseurl: base };
    if (endpoint === 'getupdates') {
      await delay(60);
      result = { ret: 0, msgs: pending.splice(0), get_updates_buf: String(++polls), longpolling_timeout_ms: 1000 };
    }
    if (endpoint === 'sendmessage') {
      received.push(body.msg);
      result = { ret: 0, message_id: String(received.length) };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  let bridge;
  async function stop() {
    if (!bridge || bridge.exitCode !== null || bridge.signalCode !== null) return;
    const ended = once(bridge, 'exit');
    bridge.kill('SIGTERM');
    await ended;
  }
  t.after(async () => { await stop(); server.closeAllConnections(); await new Promise(done => server.close(done)); });
  Object.assign(cfg, { test: { fixedBase: base, cdnBase: base }, codexBin: fixture,
    mergeSeconds: 0.02, conversationCuration: false, memoryMaintenance: false, reminders: false });
  fs.writeFileSync(configFile, JSON.stringify(cfg));
  await run('init');
  assert.equal(JSON.parse(fs.readFileSync(configFile)).codexBin, fixture);
  await run('login', '--no-open');
  assert.equal(JSON.parse((await run('status')).stdout).paired, true);
  assert.equal(fs.statSync(path.join(home, 'state/account.json')).mode & 0o077, 0);
  const start = () => { bridge = spawn(process.execPath, [cli, 'start'], { env, stdio: 'ignore' }); };
  const first = incoming('101', owner, '保存纸样。');
  pending.push(incoming('100', 'outsider', '外部消息'), first, first);
  start();
  const replies = () => received.map(msg => msg.item_list[0].text_item?.text);
  await until(() => replies().includes('纸样收到了。'));
  await stop();
  pending.push(first, incoming('102', owner, '继续做装订。'));
  start();
  await until(() => received.length >= 2);
  await stop();
  assert.equal(received.length, 2);
  assert.ok(received.every(msg => msg.to_user_id === owner));
  const { stdout } = await exec(process.execPath, [path.join(cfg.workspace, 'tools/memory.mjs'), 'recall', '纸样'], {
    env: { ...env, DAWN_MEMORY_DIR: path.join(cfg.workspace, 'memory'),
      DAWN_MEMORY_JOURNAL: path.join(cfg.workspace, 'state/memory-transaction.json'),
      DAWN_CONVERSATIONS_INDEX: path.join(cfg.workspace, 'state/conversations.sqlite') }
  });
  assert.match(stdout, /保存纸样/);
  assert.doesNotMatch(stdout, /外部消息/);
});
