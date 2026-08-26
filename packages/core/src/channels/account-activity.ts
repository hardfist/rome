import type { AccountId } from "./accounts.js";

/**
 * What happened on a channel's accounts.
 *
 * `TalkAccounts` (accounts.ts) answers *who* a channel can reach, and says that
 * a last message, a count and a preview are a separate read keyed by
 * {@link AccountId}. This is that read. Keeping it apart is what lets a channel
 * hold an address book it has no history for, and what stops the identity of an
 * account from depending on how much has been said to it.
 */

export interface AccountActivity {
  /** Unix seconds of the newest message, sent or received. */
  lastMessageAt: number;
  /** One line of that message; null when it carried no text (an image, a call). */
  lastMessagePreview: string | null;
  /**
   * Every record the channel holds for the account — not every line a timeline
   * would render. A reaction counts, and so does a message Rome sent.
   */
  messageCount: number;
}

export interface TalkAccountActivity {
  /**
   * Activity for every account that has any, keyed by {@link AccountId}.
   *
   * An account the channel has never exchanged anything with is absent rather
   * than present and zeroed, so "silent" is one condition to test instead of
   * two that can disagree.
   *
   * Read whole, not paged: this is joined against a listing the caller pages
   * itself, and an account whose activity fell past a cutoff would read as
   * silent rather than as what it is.
   */
  listActivity(): Promise<Map<AccountId, AccountActivity>>;
}
