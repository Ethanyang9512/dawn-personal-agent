import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

test('generate digest and review locally and queue only explicitly requested delivery', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dawn-reports-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'instance');
  const candidates = path.join(base, 'feed.json');
  const day = '2026-01-08';
  const items = Array.from({ length: 9 }, (_, i) => ({
    title: 'Sample entry ' + i, summary: 'A synthetic update.', section: ['ai','world','tech'][i % 3],
    source: 'Example Feed', link: 'https://example.org/article/' + i, time: day + 'T06:00:00Z'
  }));
  fs.writeFileSync(candidates, JSON.stringify({ count: items.length, items }));
  const env = { HOME: base, DAWN_HOME: home, PATH: process.env.PATH, DAWN_DIGEST_FAKE_COLLECT: candidates,
    DAWN_DIGEST_FAKE: 'ok', DAWN_REVIEW_FAKE: 'ok', DAWN_FAKE_RENDER: '1', DAWN_DIGEST_RETRY_MS: '1', DAWN_ALERT_DISABLE: '1' };
  const run = (...args) => execFileSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/dawn'), ...args], { env, timeout: 12000 });
  run('init');
  run('digest', '--date', day);
  run('review', '--days', '7');
  const out = path.join(home, 'workspace/发出');
  assert.match(fs.readFileSync(path.join(out, 'digest', day, 'digest.md'), 'utf8'), /Sample entry/);
  assert.ok(fs.readdirSync(path.join(out, 'review')).some(file => file.endsWith('.md')));
  assert.deepEqual(fs.readdirSync(path.join(home, 'outgoing')), []);
  run('digest', '--date', day, '--send');
  run('review', '--send');
  const queue = fs.readdirSync(path.join(home, 'outgoing'));
  assert.ok(queue.some(file => file.startsWith('digest-')));
  assert.ok(queue.some(file => file.startsWith('weekly-review-')));
});
