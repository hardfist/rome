/**
 * The account plane of a channel. `ProviderAdapter` (adapter.ts) is the
 * message plane — it moves text. This is the address book behind it: who a
 * channel can reach, and which of the identifiers a channel hands out name one
 * and the same account.
 *
 * The four invariants below are the contract. The types cannot carry them, and
 * every implementation owes all four:
 *
 * - **I1 Uniqueness.** Exactly one {@link Account} per real account. The same
 *   `id` means the same account. Callers never fold aliases themselves.
 * - **I2 Stability.** `id` does not change for the life of the account — not
 *   across a restart, a re-sync, a message arriving on a different addressing,
 *   or a change to any identifier the account is reachable on.
 * - **I3 Opacity.** Callers never parse or construct an `id`. This is what lets
 *   a channel change its canonical form later without touching a consumer.
 * - **I4 Total resolution.** Every identifier the channel can receive a message
 *   on resolves to that account's `id`.
 *
 * An account answers *who*. What happened — a last message, a count, a preview
 * — is a separate read, keyed by {@link AccountId}, and does not belong here.
 */

/** Opaque provider-owned account address. Callers may persist and round-trip
 * this value, but must never parse, construct, or compare parts of one. */
export type AccountId = string & { readonly __brand: "AccountId" };

export interface Account {
  id: AccountId;
  /** Human-readable, for display and search. Never an identity key. */
  label: string;
  /**
   * Searchable facts. Never used to address the account.
   *
   * `email`, `phone`, `username` and `profile_url` are reserved and mean the
   * same thing on every channel. Every other key is namespaced by its channel
   * — `whatsapp:lid`, `linkedin:member_id`. One value per key: an account
   * holding a second value of the same kind qualifies the key (`email:work`).
   */
  identifiers: Record<string, string>;
}

export interface TalkAccounts {
  /**
   * One page of the channel's accounts, in a stable order. `query` matches the
   * label and the identifier values. `cursor` is opaque and comes from a prior
   * page. A missing `nextCursor` means the listing is exhausted.
   */
  listAccounts(input: {
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ accounts: Account[]; nextCursor?: string }>;

  /** The account an identifier belongs to, or null. Accepts any identifier the
   *  channel can receive on — and an {@link AccountId}, which round-trips. */
  resolve(identifier: string): Promise<Account | null>;
}
