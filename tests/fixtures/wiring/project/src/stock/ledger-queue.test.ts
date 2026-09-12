import { LedgerQueue } from './ledger-queue';

test('drainPending empties the queue', async () => {
  const queue = new LedgerQueue();
  queue.record('sku-1');
  expect(await queue.drainPending()).toBe(1);
});
