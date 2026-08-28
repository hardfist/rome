// Which stores a person's history comes from, and the order they claim an
// account in. The stores themselves are the channels' — one `Messages` adapter
// each, in channels/ — and the merge over them is timeline.ts's.
//
// Also the fold from a person's channel mappings to the accounts those stores
// are read for, since the two are the same question asked of one channel: which
// addresses are one account, and what was said at them.
//
// Direct threads only. Each store scopes itself by the account's own addresses,
// so a group conversation — addressed by the group rather than by the person —
// never reaches a person's timeline.

import type { Accounts } from "../channels/accounts.js";
import { linkedInMessages } from "../channels/linkedin-messages.js";
import type { Messages } from "../channels/messages.js";
import { agentMessages } from "../channels/messages-agent.js";
import { sentinelLogMessages } from "../channels/messages-sentinel.js";
import { whatsAppMessages } from "../channels/whatsapp-messages.js";
import type { DrizzleDb } from "../db/index.js";
import type { TimelineAccount } from "./timeline.js";

/**
 * The stores a person's history is read from, in the order they claim an
 * account — the list `assignAccounts` walks, for the page and for the listing
 * row alike.
 *
 * The order is a precedence: a channel mirror holds the conversation as the
 * channel has it, so it outranks Rome's own transcript of the same messages,
 * which in turn outranks the sentinel's triage record. An account only the
 * sentinel saw still gets its exchanges — the sentinel is last, not excluded.
 *
 * The cost of that precedence: an account with a mirrored conversation shows
 * the conversation, and the sentinel's own record of an exchange inside it
 * stays behind Rome's reply as the channel delivered it.
 *
 * Adding a store is one more `Messages` adapter appended here. Nothing above
 * knows how many there are or what they read.
 */
export function personMessageStores(deps: { db: DrizzleDb }): Messages[] {
  return [
    whatsAppMessages(deps.db),
    linkedInMessages(deps.db),
    agentMessages(deps.db),
    sentinelLogMessages(deps.db),
  ];
}

/**
 * Every account each group of mappings is reachable at, with every address the
 * channel folds onto it — one result per group, in the order given.
 *
 * Two mappings that name two addressings of one account collapse to one
 * account, so a person mapped under both a WhatsApp phone JID and its `@lid`
 * form reads one timeline rather than two halves of one.
 *
 * A channel with no account plane contributes the mapping's own address and
 * nothing else, which is all the channel can say about who it can reach.
 *
 * Positional and over every group at once, like `AccountNames.displayNames`
 * next door: each channel's address book costs a full read, so one caller
 * asking about a directory of people must not pay for one read per row.
 */
export async function timelineAccounts(
  deps: { whatsAppAccounts: AddressBook },
  groups: readonly (readonly ChannelMapping[])[],
): Promise<TimelineAccount[][]> {
  const channels = new Set(groups.flatMap((group) => group.map((mapping) => mapping.channel)));
  const books = await readAddressBooks(deps, channels);
  return groups.map((group) => foldAccounts(books, group));
}

interface ChannelMapping {
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
 *  Read only for the channels the mappings name, since a plane costs a full
 *  address-book read. LinkedIn has a plane too but is deliberately absent: it
 *  stores a member under its member id and nothing else, so folding it would
 *  buy a whole mirror read and change no answer. It joins here when it starts
 *  storing a second addressing. */
async function readAddressBooks(
  deps: { whatsAppAccounts: AddressBook },
  channels: ReadonlySet<string>,
): Promise<Map<string, FoldedBook>> {
  const planes = new Map<string, AddressBook>([["whatsapp", deps.whatsAppAccounts]]);
  const books = new Map<string, FoldedBook>();
  for (const [channel, accounts] of planes) {
    if (!channels.has(channel)) continue;
    // One page big enough to hold the listing: its order is stable but the
    // listing under it is not, so walking cursors across a live mirror would
    // skip or repeat an account as an inbound message reordered it.
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
  mappings: readonly ChannelMapping[],
): TimelineAccount[] {
  const byAccount = new Map<string, TimelineAccount>();
  for (const mapping of mappings) {
    const book = books.get(mapping.channel);
    const accountId = book?.of.get(mapping.channelUserId) ?? mapping.channelUserId;
    const key = `${mapping.channel}\n${accountId}`;
    if (byAccount.has(key)) continue;
    byAccount.set(key, {
      channel: mapping.channel,
      addresses: [...new Set([mapping.channelUserId, ...(book?.folded.get(accountId) ?? [])])],
    });
  }
  return [...byAccount.values()];
}

/** One page big enough to hold any listing — what `Accounts.listAccounts`
 *  says to ask for when a caller needs every account exactly once. */
const WHOLE_LISTING = Number.MAX_SAFE_INTEGER;
