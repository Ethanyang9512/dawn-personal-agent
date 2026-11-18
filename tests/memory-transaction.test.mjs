import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as memory from '../bridge/lib/memory.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dawn-memory-transaction-'));
  const options = { memoryDir: path.join(root, 'memory'), journalPath: path.join(root, 'state', 'journal.json') };
  fs.mkdirSync(options.memoryDir);
  const file = name => path.join(options.memoryDir, name);
  fs.writeFileSync(file('profile.md'), '# 偏好\n'); fs.writeFileSync(file('now.md'), '原状态');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { options, file };
}
test('共享事务原子保存状态与内容寻址归档，返回准备结果', t => {
  const f = fixture(t), archived = '已完成事项', archive = `archive/${hash(archived)}.md`;
  const result = memory.mutateMemory(f.options, ({ read }) => {
    assert.equal(read('now.md'), '原状态');
    return { edits: new Map([['now.md', '新状态'], [archive, archived], ['archive/index.json', '{"entries":[]}']]), result: 'done' };
  });
  assert.equal(result, 'done'); assert.equal(fs.readFileSync(f.file(archive), 'utf8'), archived);
  assert.equal(fs.readFileSync(f.file('now.md'), 'utf8'), '新状态'); assert.equal(fs.existsSync(f.options.journalPath), false);
});
test('只读依赖也参与提交前的并发校验', t => {
  const f = fixture(t);
  assert.throws(() => memory.mutateMemory({ ...f.options, beforePrepare() { fs.writeFileSync(f.file('profile.md'), '新事实'); } }, ({ read }) => {
    read('profile.md'); return { edits: new Map([['now.md', '根据旧事实生成']]), result: null };
  }), { code: 'MEMORY_CONFLICT' });
  assert.equal(fs.readFileSync(f.file('now.md'), 'utf8'), '原状态'); assert.equal(fs.existsSync(f.options.journalPath), false);
});
test('中断后可恢复所有文件，重复读取不重复写入', t => {
  const f = fixture(t), archived = '完成原文', archive = `archive/${hash(archived)}.md`;
  assert.throws(() => memory.mutateMemory({ ...f.options, afterPrepare() { throw new Error('crash'); } }, () => ({ edits: new Map([['now.md', '新状态'], [archive, archived], ['archive/index.json', '{}']]), result: null })), /crash/);
  assert.equal(memory.readMemory(f.options).now, '新状态'); assert.equal(fs.readFileSync(f.file(archive), 'utf8'), archived);
  assert.equal(memory.readMemory(f.options).now, '新状态');
});
test('归档只能写与文件名哈希一致的原文，已有归档不可替换，路径不能越界', t => {
  const f = fixture(t), body = '归档原文', archive = `archive/${hash(body)}.md`;
  const write = (file, after) => memory.mutateMemory(f.options, () => ({ edits: new Map([[file, after]]), result: null }));
  write(archive, body); write(archive, body);
  assert.throws(() => write(archive, '改写'), { code: 'MEMORY_ARCHIVE' });
  fs.writeFileSync(f.file(archive), '已经被外部改写');
  assert.throws(() => write(archive, body), { code: 'MEMORY_ARCHIVE' });
  for (const file of ['../outside.md', 'archive/arbitrary.md']) assert.throws(() => write(file, body), { code: 'MEMORY_PATH' });
});
test('事务中断期间只读事实变化时，恢复停止而不发布依据旧事实的状态', t => {
  const f = fixture(t);
  assert.throws(() => memory.mutateMemory({ ...f.options, afterPrepare() { throw new Error('crash'); } }, ({ read }) => {
    read('profile.md'); return { edits: new Map([['now.md', '根据旧事实生成']]), result: null };
  }), /crash/);
  fs.writeFileSync(f.file('profile.md'), '已纠正的新事实');
  assert.throws(() => memory.readMemory(f.options), { code: 'MEMORY_CONFLICT' });
  assert.equal(fs.readFileSync(f.file('now.md'), 'utf8'), '原状态'); assert.ok(fs.existsSync(f.options.journalPath));
});
test('恢复重核归档内容哈希，损坏事务不能删掉状态原文', t => {
  const f = fixture(t), body = '归档原文', archive = `archive/${hash(body)}.md`;
  assert.throws(() => memory.mutateMemory({ ...f.options, afterPrepare() { throw new Error('crash'); } }, () => ({ edits: new Map([['now.md', ''], [archive, body]]), result: null })), /crash/);
  const tx = JSON.parse(fs.readFileSync(f.options.journalPath)); tx.files.find(x => x.file === archive).after = '损坏归档';
  fs.writeFileSync(f.options.journalPath, JSON.stringify(tx));
  assert.throws(() => memory.readMemory(f.options), { code: 'MEMORY_ARCHIVE' });
  assert.equal(fs.readFileSync(f.file('now.md'), 'utf8'), '原状态'); assert.equal(fs.existsSync(f.file(archive)), false);
});
test('纯profile读取复用版本与撤回语义，无磁盘和锁依赖', t => {
  assert.equal(typeof memory.profileRecords, 'function');
  const f = fixture(t);
  memory.correctMemory({ id: 'reply', subject: '回复', value: '详细', duration: 'persistent', expectedRevision: 0, expiresAt: '2099-01-01T00:00:00Z', source: { kind: 'user', quote: '详细', reference: 'm1', at: '2026-11-15T00:00:00Z' } }, f.options);
  const profile = fs.readFileSync(f.file('profile.md'), 'utf8');
  assert.equal(memory.profileRecords(profile)[0].value, '详细');
  assert.equal(memory.profileRecords(profile, Date.parse('2100-01-01'))[0].status, 'expired');
});
