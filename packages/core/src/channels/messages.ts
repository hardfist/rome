/**
 * What was said on a channel, as one store holds it. `Accounts` (accounts.ts)
 * answers who a channel can reach; this answers what passed between Rome and
 * them, and what a conversation holds — including one nobody in particular is
 * addressed on.
 *
 * A message is a {@link TimelineEntry}, whichever question reached it. The
 * shape, the ordering and the cursor belong to the People contract
 * (`@rome/api-types/people`), because what an account read answers here is
 * what a person's timeline pages. A second definition of either is a page
 * boundary the two ends disagree about.
 *
 * A conversation read is not a person's timeline, and it answers the same type
 * anyway — not by reusing what was to hand, but because it is the same rows of
 * the same store, and every message a direct conversation holds is a message
 * that person's timeline pages. Given a second shape, one message read two
 * ways would carry two orderings and two cursors, and the store that holds it
 * would owe both of them. The type is one because the history is one.
 */

import type { TimelineEntry } from "@rome/api-types/people";

/**
 * One account a store reads for, named by every address it answers to —
 * `Account.addresses` on the channel's own address book.
 *
 * The addresses rather than the id, because a store keys its rows by whichever
 * address a message arrived on: a WhatsApp contact is reachable under both a
 * phone JID and a `@lid` JID, and history hangs off either. A read that named
 * only the address a person mapping happens to carry would answer an empty
 * history for a conversation that plainly exists.
 *
 * What `timelineAccounts` (../people/timeline-sources.ts) folds a person's
 * links into, and what every store a person's history is read from is then
 * scoped by.
 */
export interface MessageAccount {
  channel: string;
  /** Non-empty. Order carries no meaning. */
  addresses: readonly string[];
}

export interface MessageRead {
  accounts: readonly MessageAccount[];
  /** The entry the previous page ended on. Null or absent for the first page. */
  after?: TimelineEntry | null;
  limit: number;
}

/**
 * One conversation a store reads for: the thread a message was said in, named
 * by the platform's own id for it.
 *
 * The pair rather than the id alone, for the reason {@link MessageAccount}
 * carries a channel: two platforms are free to spell a thread id the same way
 * and mean two different conversations, and a store holding several channels
 * side by side would otherwise hand one channel's thread to a caller asking
 * about another's.
 *
 * A direct conversation is addressed by the person on it, so the same messages
 * reach {@link Messages.read} through that person's account. A group
 * conversation is addressed by the group and by nobody on it, so this is the
 * only way to ask for it.
 */
export interface MessageConversation {
  channel: string;
  /** The platform's own id for the thread — a WhatsApp chat JID, a LinkedIn
   *  thread id, the thread a channel session is keyed by. */
  id: string;
}

export interface ConversationRead {
  conversation: MessageConversation;
  /** The entry the previous page ended on. Null or absent for the first page. */
  after?: TimelineEntry | null;
  limit: number;
}

/**
 * One message store, asked either what passed between Rome and a set of
 * accounts or what a conversation holds.
 *
 * A set of accounts is read as one history: a person holds several accounts
 * and an account several addresses, and the caller wants the messages merged,
 * not one sequence per address.
 *
 * One law binds the three account verbs. Call the *full read* of a set of
 * accounts the
 * `read` with no cursor and a limit large enough to hold everything the store
 * can answer for them:
 *
 * - `count` is the length of the full read.
 * - `latest` is its first entry, and null when the full read is empty.
 *
 * So a row previewing `latest` previews exactly the entry the page beneath it
 * opens on, and the count beside it measures exactly the history that page
 * walks. A store answering the three on their own terms could preview an entry
 * its own pages never show.
 *
 * `latest` answering null is how a caller learns the store holds nothing for
 * an account. There is no `holds` verb — a second way to ask the same question
 * is a second answer to disagree with.
 *
 * Those three are direct threads only. A group conversation is addressed by
 * the group rather than by any person on it, so no address of an account names
 * it and none of its messages reaches them. `readConversation` is how a caller
 * asks for one, and it reaches every conversation the store holds.
 *
 * The two questions are one store asked two ways rather than two histories. So
 * a message is the same {@link TimelineEntry} however it was reached, in the
 * same `compareTimelineEntries` order, resumed by the same cursor: a direct
 * conversation read through its person's account and read through its own id
 * answers the same entries, and neither page boundary is a position the other
 * cannot name.
 */
export interface Messages {
  /**
   * The store's newest messages for `accounts`, at most `limit` of them, every
   * one strictly after `after`, in `compareTimelineEntries` order — newest
   * first, and total.
   *
   * "Strictly after `after`" is the store's own obligation and not the
   * caller's: a store that answered its newest `limit` messages and left the
   * filtering above it would spend that budget on messages the caller has
   * already seen, and the ones it dropped to make room are the ones no page
   * ever shows.
   */
  read(request: MessageRead): Promise<TimelineEntry[]>;

  /** How many messages the full read of `accounts` answers. */
  count(accounts: readonly MessageAccount[]): Promise<number>;

  /**
   * The first entry of the full read of `accounts`, or null when the store
   * holds none.
   *
   * `read` with a limit of one, declared as its own verb so a store can answer
   * it in one pass over a whole directory rather than one page per row.
   */
  latest(accounts: readonly MessageAccount[]): Promise<TimelineEntry | null>;

  /**
   * The store's newest messages of one conversation, under the obligations
   * `read` carries: at most `limit` of them, every one strictly after `after`,
   * in `compareTimelineEntries` order.
   *
   * Every store owes this verb. It is not optional and it never refuses: a
   * store holding nothing of the conversation answers an empty page, which is
   * the same answer as one holding a conversation nothing was ever said in.
   *
   * So a store whose platform names no thread it can be asked for answers
   * empty for every conversation, and a caller reads that as "nothing here"
   * rather than as a case to branch on. Carving out an unanswerable case would
   * invent a state no store is in today; forbidding one would deny it to a
   * store that turns out to be in it.
   */
  readConversation(request: ConversationRead): Promise<TimelineEntry[]>;
}
