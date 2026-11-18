import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceTaskDelivery } from '../bridge/lib/task-delivery-receipt.mjs';

const part = index => ({ taskPartIndex: index, taskPartCount: 2, clientId: `client-${index}` });
const persist = result => ({ status: result.status, ...result.details });

test('accepting the first piece keeps the completion event pending', () => {
  const initial = { status: 'queued' }, before = structuredClone(initial);
  const result = reduceTaskDelivery(initial, part(0), 'delivered', { messageId: 'text-receipt' });
  assert.equal(result.status, 'pending');
  assert.equal(result.details.acceptedParts, 1);
  assert.equal(result.details.partCount, 2);
  assert.equal(result.details.parts[0].status, 'wechat_accepted');
  assert.equal(result.details.parts[1].status, 'pending');
  assert.deepEqual(initial, before);
});

test('persisted receipts resume after restart and finish only after the final file receipt', () => {
  const first = reduceTaskDelivery({ status: 'queued' }, part(0), 'delivered', { messageId: 'text-receipt' });
  const restored = JSON.parse(JSON.stringify(persist(first)));
  const result = reduceTaskDelivery(restored, part(1), 'delivered', { messageId: 'file-receipt', requestPending: false });
  assert.equal(result.status, 'wechat_accepted');
  assert.equal(result.details.acceptedParts, 2);
  assert.equal(result.details.requestPending, false);
  assert.equal(result.details.parts[0].messageId, 'text-receipt');
  assert.equal(result.details.parts[1].messageId, 'file-receipt');
});

test('duplicate receipts are idempotent and queued retries cannot downgrade an accepted piece', () => {
  const first = reduceTaskDelivery({}, part(0), 'delivered', { messageId: 'text-receipt' });
  const repeated = reduceTaskDelivery(persist(first), part(0), 'delivered', { messageId: 'text-receipt' });
  assert.deepEqual(repeated, first);
  const retry = reduceTaskDelivery(persist(first), part(0), 'retrying', { requestPending: true });
  assert.equal(retry.details.acceptedParts, 1);
  assert.equal(retry.details.parts[0].status, 'wechat_accepted');
  assert.equal(retry.details.parts[0].messageId, 'text-receipt');
  assert.equal(retry.status, 'pending');
  assert.equal(retry.details.requestPending, true);
});

test('pending file retries or deferred delivery cannot become a completed event', () => {
  const first = reduceTaskDelivery({}, part(0), 'delivered', { messageId: 'text-receipt' });
  for (const status of ['queued', 'deferred', 'retrying']) {
    const result = reduceTaskDelivery(persist(first), part(1), status, { requestPending: status === 'retrying' });
    assert.equal(result.status, status);
    assert.equal(result.details.acceptedParts, 1);
    assert.equal(result.details.messageId, null);
  }
});

test('a late text receipt preserves the file window and quiet-hour deferral', () => {
  for (const status of ['deferred_window', 'deferred_quiet']) {
    const deferred = reduceTaskDelivery({}, part(1), status, {});
    const late = reduceTaskDelivery(persist(deferred), part(0), 'delivered', { messageId: 'late-text' });
    assert.equal(late.status, status);
    assert.equal(late.details.parts[1].status, status);
  }
});

test('cancelling after one receipt is partially accepted; cancelling every unsent piece is withdrawn', () => {
  const first = reduceTaskDelivery({}, part(0), 'delivered', { messageId: 'text-receipt' });
  const cancelled = reduceTaskDelivery(persist(first), part(1), 'withdrawn', { requestPending: false });
  assert.equal(cancelled.status, 'partially_accepted');
  assert.equal(cancelled.details.acceptedParts, 1);
  const none = reduceTaskDelivery({}, part(0), 'withdrawn', {});
  assert.equal(none.status, 'unknown');
  assert.equal(reduceTaskDelivery(persist(none), part(1), 'withdrawn', {}).status, 'withdrawn');
});

test('unknown piece stays unknown through cancellation and only a real receipt resolves it', () => {
  let current = reduceTaskDelivery({}, part(0), 'delivered', {});
  assert.equal(current.status, 'unknown');
  current = reduceTaskDelivery(persist(current), part(1), 'delivered', { messageId: 'file-receipt' });
  assert.equal(current.status, 'unknown');
  const cancelled = reduceTaskDelivery(persist(current), part(0), 'withdrawn', {});
  assert.equal(cancelled.status, 'unknown');
  assert.equal(cancelled.details.parts[0].status, 'unknown');
  assert.equal(reduceTaskDelivery(persist(cancelled), part(0), 'delivered', { messageId: 'late-text-receipt' }).status, 'wechat_accepted');
});

test('current request state is not inherited from the previous piece', () => {
  const started = reduceTaskDelivery({}, part(0), 'retrying', { requestPending: true });
  assert.equal(started.details.requestPending, true);
  const ended = reduceTaskDelivery(persist(started), part(0), 'delivered', { messageId: 'done' });
  assert.equal(ended.details.requestPending, false);
});

test('cancelling a queued file preserves the text request already in flight', () => {
  const started = reduceTaskDelivery({}, part(0), 'queued', { requestPending: true });
  const cancelFile = reduceTaskDelivery(persist(started), part(1), 'withdrawn', { requestPending: false });
  assert.equal(cancelFile.status, 'unknown');
  assert.equal(cancelFile.details.requestPending, true);
  const lateReceipt = reduceTaskDelivery(persist(cancelFile), part(0), 'delivered', { messageId: 'text-receipt', requestPending: false });
  assert.equal(lateReceipt.status, 'partially_accepted');
  assert.equal(lateReceipt.details.requestPending, false);
});

test('a terminal failed file makes the group unknown rather than automatically replayable', () => {
  const first = reduceTaskDelivery({}, part(0), 'delivered', { messageId: 'text-receipt' });
  const failed = reduceTaskDelivery(persist(first), part(1), 'failed', { lastError: 'upload-failed', requestPending: false });
  assert.equal(failed.status, 'unknown');
  assert.equal(failed.details.parts[1].status, 'failed');
  assert.equal(failed.details.parts[1].lastError, 'upload-failed');
});

test('legacy and explicit single-piece items keep existing receipt mapping', () => {
  for (const item of [{ clientId: 'legacy' }, { taskPartIndex: 0, taskPartCount: 1, clientId: 'single' }]) {
    assert.equal(reduceTaskDelivery({}, item, 'delivered', { messageId: 'received' }).status, 'wechat_accepted');
    assert.equal(reduceTaskDelivery({}, item, 'delivered', {}).status, 'unknown');
    assert.equal(reduceTaskDelivery({}, item, 'suspect-dropped', { messageId: 'not-confirmed' }).status, 'unknown');
    assert.equal(reduceTaskDelivery({}, item, 'retrying', {}).status, 'retrying');
    const accepted = reduceTaskDelivery({ status: 'wechat_accepted', messageId: 'old' }, item, 'queued', {});
    assert.equal(accepted.status, 'wechat_accepted');
    assert.equal(accepted.details.messageId, 'old');
  }
});
