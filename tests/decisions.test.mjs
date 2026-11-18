import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { captureConversation, annotateConversations } from '../bridge/lib/conversation-memory.mjs';
import { notebookBrief, readNotebook, saveDraft } from '../bridge/lib/dawn-notebook.mjs';
import { opportunityDecision } from '../bridge/lib/opportunities.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dawn-evidence-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { memoryDir: path.join(root, 'memory'), indexPath: path.join(root, 'state/index.sqlite'),
    vaultDir: path.join(root, 'vault'), journalPath: path.join(root, 'state/memory-transaction.json') };
}
test('recover a dated reason and distinguish an unconfirmed update from a recorded decision', t => {
  const paths = fixture(t);
  const at = '2026-01-08T10:00:00Z';
  const text = '工坊的职位需要夜班，我只能上白班，所以先放一放。';
  const source = { id: 'fixture-shift', at, text };
  captureConversation({ sourceId: source.id, at, text, role: 'user' }, paths);
  const task = { id: 'workshop', title: '工坊职位', opportunity: { current: { stage: 'contacted', waitingFor: '白班' }, asOf: at, revision: 1,
    history: [{ occurredAt: at, source, disposition: 'applied', changes: { waitingFor: '白班' }, revision: 1 }] } };
  const before = structuredClone(task);
  const report = opportunityDecision(task, paths, { basis: 'unconfirmed', changes: { waitingFor: null } });
  assert.equal(report.history[0].quote, text);
  assert.equal(report.comparison.impact, 'needs_confirmation');
  assert.equal(report.comparison.recorded, false);
  assert.deepEqual(task, before);
  const missing = structuredClone(task);
  missing.opportunity.history[0].source.id = 'missing';
  assert.equal(opportunityDecision(missing, paths).history[0].evidence, 'unavailable');
});
test('retrieve a topic by an indexed alternative expression and preserve a concurrent manual edit', t => {
  const paths = fixture(t);
  const text = '纸张要厚一些，翻页时才不会透出背面的图案。';
  const row = captureConversation({ sourceId: 'paper', role: 'user', text, at: '2026-01-08T10:00:00Z' }, paths);
  annotateConversations([{ id: row.id, kind: 'idea', quote: text, topic: '内页用纸', terms: ['不透明','纸张厚度'], summary: text }], paths);
  assert.equal(notebookBrief({ query: '不透明' }, paths).materials[0].id, row.id);
  assert.equal(notebookBrief({ query: '天文望远镜' }, paths).materials.length, 0);
  const draft = { id: 'paper-guide', title: '装帧指南', text: '试用厚纸。', sources: [row.id] };
  saveDraft({ ...draft, expectedSha256: null }, paths);
  const current = readNotebook('draft:paper-guide', paths);
  fs.appendFileSync(current.path, '\n手改的打样要求\n');
  assert.throws(() => saveDraft({ ...draft, expectedSha256: current.sha256 }, paths), /版本已变化/);
  assert.match(fs.readFileSync(current.path, 'utf8'), /手改的打样要求/);
});
