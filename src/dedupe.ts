import type { ActualTransaction } from './clients/actual.js';

export interface ExistingTransaction {
  date: string;
  amount: number;
  imported_id?: string;
}

export interface DedupeResult {
  keep: ActualTransaction[];
  skipped: ActualTransaction[];
}

/**
 * Drop incoming transactions that are already represented in Actual by a row
 * this tool did not import.
 *
 * Actual dedupes on `imported_id`, and falls back to fuzzy matching only for
 * existing rows where `imported_id IS NULL`. Anything migrated from another
 * tool carries that tool's own id (YNAB writes `YNAB:<amount>:<date>:<n>`),
 * so it is invisible to both passes and the overlap duplicates. The same
 * applies if TrueLayer reissues a transaction_id for something already synced.
 *
 * Matching is exact on date and amount, and each existing row is consumed
 * once, so two genuine same-day transactions of the same value still import
 * as two.
 */
export function dropAlreadyPresent(
  incoming: ActualTransaction[],
  existing: ExistingTransaction[]
): DedupeResult {
  const incomingIds = new Set(incoming.map((t) => t.imported_id));

  // Rows carrying one of our own ids are handled by Actual's id match; leaving
  // them in lets pending-to-booked changes still come through as updates.
  const foreign = existing.filter(
    (e) => !e.imported_id || !incomingIds.has(e.imported_id)
  );

  const available = new Map<string, number>();
  for (const row of foreign) {
    const key = `${row.date}|${row.amount}`;
    available.set(key, (available.get(key) ?? 0) + 1);
  }

  const keep: ActualTransaction[] = [];
  const skipped: ActualTransaction[] = [];

  for (const txn of incoming) {
    const key = `${txn.date}|${txn.amount}`;
    const count = available.get(key) ?? 0;
    if (count > 0) {
      available.set(key, count - 1);
      skipped.push(txn);
    } else {
      keep.push(txn);
    }
  }

  return { keep, skipped };
}
