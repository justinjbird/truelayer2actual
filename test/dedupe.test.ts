import test from 'node:test';
import assert from 'node:assert/strict';
import { dropAlreadyPresent } from '../src/dedupe.js';
import type { ActualTransaction } from '../src/clients/actual.js';

function txn(overrides: Partial<ActualTransaction> = {}): ActualTransaction {
  return {
    date: '2026-09-19',
    amount: -20004,
    payee_name: 'Transfer',
    notes: 'TRANSFER',
    imported_id: 'tl-1',
    cleared: true,
    ...overrides,
  };
}

test('dropAlreadyPresent', async (t) => {
  await t.test('skips a transaction matching a migrated row from another tool', () => {
    const incoming = [txn()];
    const existing = [
      { date: '2026-09-19', amount: -20004, imported_id: 'YNAB:-200040:2026-09-19:1' },
    ];

    const { keep, skipped } = dropAlreadyPresent(incoming, existing);

    assert.equal(keep.length, 0);
    assert.equal(skipped.length, 1);
  });

  await t.test('skips a row we synced before TrueLayer reissued the id', () => {
    const incoming = [txn({ imported_id: 'tl-new' })];
    const existing = [{ date: '2026-09-19', amount: -20004, imported_id: 'tl-old' }];

    const { keep } = dropAlreadyPresent(incoming, existing);

    assert.equal(keep.length, 0);
  });

  await t.test('keeps a transaction whose id is already in Actual, for Actual to update', () => {
    const incoming = [txn({ imported_id: 'tl-1' })];
    const existing = [{ date: '2026-09-19', amount: -20004, imported_id: 'tl-1' }];

    const { keep, skipped } = dropAlreadyPresent(incoming, existing);

    assert.equal(keep.length, 1);
    assert.equal(skipped.length, 0);
  });

  await t.test('skips a transaction matching a hand-entered row with no id', () => {
    const incoming = [txn()];
    const existing = [{ date: '2026-09-19', amount: -20004 }];

    const { keep } = dropAlreadyPresent(incoming, existing);

    assert.equal(keep.length, 0);
  });

  await t.test('consumes each existing row once, so genuine repeats still import', () => {
    const incoming = [
      txn({ imported_id: 'tl-1', amount: -300 }),
      txn({ imported_id: 'tl-2', amount: -300 }),
    ];
    const existing = [{ date: '2026-09-19', amount: -300, imported_id: 'YNAB:x' }];

    const { keep, skipped } = dropAlreadyPresent(incoming, existing);

    assert.equal(keep.length, 1);
    assert.equal(skipped.length, 1);
    assert.equal(keep[0].imported_id, 'tl-2');
  });

  await t.test('keeps transactions on a different date or amount', () => {
    const incoming = [
      txn({ imported_id: 'tl-1', date: '2026-09-20' }),
      txn({ imported_id: 'tl-2', amount: -20005 }),
    ];
    const existing = [
      { date: '2026-09-19', amount: -20004, imported_id: 'YNAB:-200040:2026-09-19:1' },
    ];

    const { keep } = dropAlreadyPresent(incoming, existing);

    assert.equal(keep.length, 2);
  });

  await t.test('keeps everything when the account is empty', () => {
    const incoming = [txn()];

    const { keep } = dropAlreadyPresent(incoming, []);

    assert.equal(keep.length, 1);
  });
});
