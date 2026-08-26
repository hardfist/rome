import type { Account } from "./accounts.js";

/**
 * The in-memory half of `TalkAccounts.listAccounts`, for channels that mirror
 * the whole address book locally and page over it here. A channel whose
 * provider paginates server-side pages there and does not use this.
 */

/** Case-insensitive substring match over the label and every identifier value. */
function matches(account: Account, needle: string): boolean {
  if (account.label.toLowerCase().includes(needle)) return true;
  for (const value of Object.values(account.identifiers)) {
    if (value.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/**
 * One page of an already-ordered account list. The cursor is an offset into the
 * filtered list — opaque to the caller, and rejected back to the first page
 * when it does not parse, so a corrupt value cannot walk off the end silently.
 */
export function pageAccounts(
  accounts: Account[],
  input: { query?: string; cursor?: string; limit: number },
): { accounts: Account[]; nextCursor?: string } {
  const needle = input.query?.trim().toLowerCase();
  const filtered = needle ? accounts.filter((a) => matches(a, needle)) : accounts;

  const parsed = input.cursor == null ? 0 : Number(input.cursor);
  const start = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  const limit = Math.max(1, Math.floor(input.limit));
  const end = start + limit;

  return {
    accounts: filtered.slice(start, end),
    nextCursor: end < filtered.length ? String(end) : undefined,
  };
}
