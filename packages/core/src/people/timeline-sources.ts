// Which stores a person's history comes from, and the order they claim an
// account in. The stores themselves are the channels' — one `Messages` adapter
// each, in channels/ — and the merge over them is timeline.ts's.
//
// Also the fold from a person's links to the accounts those stores are read
// for, since the two are the same question asked of one channel: which
// addresses are one account, and what was said at them.
//
// Vocabulary: docs/concepts/people.md.
//
// Direct threads only. Each store scopes itself by the account's own addresses,
// so a group conversation — addressed by the group rather than by the person —
// never reaches a person's timeline.

import type { Accounts } from "../channels/accounts.js";
import { messageStores, type Channels } from "../channels/channel.js";
import type { Messages } from "../channels/messages.js";
import { agentMessages } from "../channels/messages-agent.js";
import { sentinelLogMessages } from "../channels/messages-sentinel.js";
import type { DrizzleDb } from "../db/index.js";
import type { TimelineAccount } from "./timeline.js";

/**
 * The stores a person's history is read from, in the order they claim an
 * account — the list `assignAccounts` walks, for the page and for the listing
 * row alike.
 *
 * The order is a precedence: a channel mirror holds the conversation as the
 * channel has it, so every channel's own store outranks Rome's transcript of
 * the same messages, which in turn outranks the sentinel's triage record. An
 * account only the sentinel saw still gets its exchanges — the sentinel is
 * last, not excluded.
 *
 * The cost of that precedence: an account with a mirrored conversation shows
 * the conversation, and the sentinel's own record of an exchange inside it
 * stays behind Rome's reply as the channel delivered it.
 *
 * A channel joins by mirroring a history, which is an entry in the channel list
 * (rome-channels.ts). Rome's own two stores belong to no channel and answer for
 * every one, which is why they are named here and sit behind all of them.
 */
export function personMessageStores(deps: { db: DrizzleDb; channels: Channels }): Messages[] {
  return [...messageStores(deps.channels), agentMessages(deps.db), sentinelLogMessages(deps.db)];
}

/**
 * Every account each group of linked addresses is reachable at, with every
 * address the channel folds onto it — one result per group, in the order given.
 *
 * Two links that name two addresses of one account collapse to one account, so
 * a person linked under both a WhatsApp phone JID and its `@lid` form reads one
 * timeline rather than two halves of one.
 *
 * A channel with no address book contributes the link's own address and nothing
 * else, which is all the channel can say about who it can reach.
 *
 * Positional and over every group at once, like `AccountNames.displayNames`
 * next door: each channel's address book costs a full read, so one caller
 * asking about a directory of people must not pay for one read per row.
 */
export async function timelineAccounts(
  deps: { whatsAppAccounts: AddressBook },
  groups: readonly (readonly LinkedAddress[])[],
): Promise<TimelineAccount[][]> {
  const channels = new Set(groups.flatMap((group) => group.map((link) => link.channel)));
  const books = await readAddressBooks(deps, channels);
  return groups.map((group) => foldAccounts(books, group));
}

/** One address a link names. `channelUserId` is the account's own address —
 *  the wire field's name, kept because the column and the contract carry it. */
interface LinkedAddress {
  channel: string;
  channelUserId: string;
}

/** The listing half of a channel's address book: the accounts, each carrying
 *  every address it answers to. There is no separate address map to ask for —
 *  the listing already says which addresses are one account. */
type AddressBook = Accounts;

/** Each channel's accounts, indexed the two ways the fold reads them: which
 *  account an address belongs to, and every address of that account.
 *
 *  Named here rather than read off the channel list, and only for the channels
 *  the links name, since an address book costs a full read. LinkedIn has one
 *  too but is deliberately absent: it stores a member under its member id and
 *  nothing else, so folding it would buy a whole read and change no answer. It
 *  joins here when it starts storing a second address. */
async function readAddressBooks(
  deps: { whatsAppAccounts: AddressBook },
  channels: ReadonlySet<string>,
): Promise<Map<string, FoldedBook>> {
  const known = new Map<string, AddressBook>([["whatsapp", deps.whatsAppAccounts]]);
  const books = new Map<string, FoldedBook>();
  for (const [channel, accounts] of known) {
    if (!channels.has(channel)) continue;
    // One page big enough to hold the listing: its order is stable but the
    // listing under it is not, so walking cursors across a live address book
    // would skip or repeat an account as an inbound message reordered it.
    const { accounts: listing } = await accounts.listAccounts({ limit: WHOLE_LISTING });
    const of = new Map<string, string>();
    const folded = new Map<string, string[]>();
    for (const account of listing) {
      // The id among them, whether or not the channel spelled it out as an
      // address: it is a form the account answers to.
      const addresses = [...new Set([account.id as string, ...account.addresses])];
      folded.set(account.id, addresses);
      for (const address of addresses) of.set(address, account.id);
    }
    books.set(channel, { of, folded });
  }
  return books;
}

/** One channel's listing, indexed by address and by account. */
interface FoldedBook {
  /** Which account each address belongs to. */
  of: Map<string, string>;
  /** Every address of each account. */
  folded: Map<string, string[]>;
}

function foldAccounts(
  books: Map<string, FoldedBook>,
  links: readonly LinkedAddress[],
): TimelineAccount[] {
  const byAccount = new Map<string, TimelineAccount>();
  for (const link of links) {
    const book = books.get(link.channel);
    const accountId = book?.of.get(link.channelUserId) ?? link.channelUserId;
    const key = `${link.channel}\n${accountId}`;
    if (byAccount.has(key)) continue;
    byAccount.set(key, {
      channel: link.channel,
      addresses: [...new Set([link.channelUserId, ...(book?.folded.get(accountId) ?? [])])],
    });
  }
  return [...byAccount.values()];
}

/** One page big enough to hold any listing — what `Accounts.listAccounts`
 *  says to ask for when a caller needs every account exactly once. */
const WHOLE_LISTING = Number.MAX_SAFE_INTEGER;
