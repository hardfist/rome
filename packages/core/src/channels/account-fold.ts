// Who is one account — every address book Rome mirrors folded onto accounts.
//
// `Accounts` (accounts.ts) is one channel's address book and `AccountNames`
// (account-names.ts) is the display-name half of all of them. This is the fold
// underneath both reads that have to show every account there is: which
// addressings are one account.
//
// Nothing here reads a history. What an account last did is a `Messages` store's
// answer (messages.ts), read by the callers that show it, so the contacts list
// never touches a message store to learn who exists.

import { compareCodePoints } from "@rome/api-types/people";
import type { Accounts } from "./accounts.js";

/**
 * One account a channel's address book holds, in the shape every caller reads
 * every mirror through.
 *
 * The projection is `Account` as the fold reads it, and nothing channel-specific
 * survives it: which addressings a channel hands out, which of them is
 * canonical, and what counts as an account at all are the channel's answers,
 * given once behind {@link Accounts}. So a caller's rules stay
 * channel-agnostic, and adding a mirror is an entry in {@link mirrorRegistry}
 * rather than another special case above.
 */
export interface MirrorAccount {
  channel: string;
  /** The account's own address — what a mapping or a placement should name. */
  channelUserId: string;
  /** Every address the account answers to, `channelUserId` included. */
  aliases: string[];
  /** What the channel calls the account, or null when it holds no name. */
  name: string | null;
}

/** Key a (channel, address) pair for the maps a fold is built out of. */
export const addressKey = (channel: string, channelUserId: string) =>
  `${channel}\n${channelUserId}`;

/**
 * The channels Rome mirrors an address book for. A provider joins every fold
 * and every naming read at once by taking an entry here.
 *
 * The plane type is the caller's: a fold needs the whole of {@link Accounts}
 * and a naming read needs only `resolve`, and neither should have to name the
 * channels a second time to say so.
 */
export function mirrorRegistry<T>(deps: {
  whatsAppAccounts: T;
  linkedInAccounts: T;
}): Readonly<Record<string, T>> {
  return { whatsapp: deps.whatsAppAccounts, linkedin: deps.linkedInAccounts };
}

/**
 * The channels a fold reads, each behind its own address book.
 *
 * A plane is read as its listing gives it — each account carrying its own
 * addressing set — so the whole address book arrives as accounts rather than as
 * a map of addresses a caller has to invert back into them.
 */
export type MirrorPlanes = Readonly<Record<string, Accounts>>;

/** An identifier a caller already holds, wherever it holds it — a link, a
 *  sentinel row — so a channel can be asked about the ones its address map does
 *  not cover. */
export interface StoredAddress {
  channel: string;
  channelUserId: string;
}

/**
 * Every account the mirrors hold, folded so that one account answers under
 * every address it is reachable at.
 *
 * Built by {@link foldAccounts}. A caller asks it questions about a (channel,
 * address) pair and never has to know which of them the channel considers
 * canonical. Nothing here is about what anybody said: a `Messages` store is
 * what answers that, for the callers that ask.
 */
export class AccountFold {
  constructor(
    /** Every account the mirrors hold. */
    readonly accounts: readonly MirrorAccount[],
    protected readonly byAddress: ReadonlyMap<string, MirrorAccount>,
  ) {}

  /**
   * The address the channel folds this one onto, or the address itself on a
   * channel that holds no address book.
   *
   * Which addresses fold together is the channel's answer, not a rule derived
   * here: it is the address map read as given. Without it the same person is
   * both a linked account (under the addressing a mapping named) and an
   * unplaced sender (a sentinel row under another) — two rows a caller cannot
   * merge and the guardian cannot tell apart.
   */
  canonical(channel: string, channelUserId: string): string {
    return this.byAddress.get(addressKey(channel, channelUserId))?.channelUserId ?? channelUserId;
  }

  /** The key every map in a fold is keyed by: the account, not the addressing
   *  the caller happened to name. */
  key(channel: string, channelUserId: string): string {
    return addressKey(channel, this.canonical(channel, channelUserId));
  }

  /** The mirror's account for an address, or undefined on a channel that holds
   *  no address book. */
  mirrorFor(channel: string, channelUserId: string): MirrorAccount | undefined {
    return this.byAddress.get(this.key(channel, channelUserId));
  }
}

/**
 * Read every mirror's address book whole and fold it.
 *
 * Whole rather than paged: a caller pages its own answer, and an account past a
 * channel's own cutoff is one the guardian cannot find and no count includes.
 * The fold that decides which addressings are one account needs every address
 * book entire in any case.
 *
 * No history is read here — not a mirror's and not the triage record's. This is
 * what a contacts list needs and the whole of it, so the read that serves one
 * never reaches a message store.
 *
 * `stored` is every address the caller already holds. The channels are read
 * concurrently, and each channel's reads are issued in one batch, because a
 * plane that folds its whole address book per call shares the read already in
 * flight — so the whole fold costs one read per channel rather than one per
 * call made against it.
 */
export async function foldAccounts(
  planes: MirrorPlanes,
  input: { stored: readonly StoredAddress[] },
): Promise<AccountFold> {
  const read = await readPlanes(planes, input.stored);
  return new AccountFold(read.accounts, read.byAddress);
}

/** Every channel read concurrently, and their address books merged into one
 *  fold. */
async function readPlanes(
  planes: MirrorPlanes,
  storedAddresses: readonly StoredAddress[],
): Promise<{ accounts: MirrorAccount[]; byAddress: Map<string, MirrorAccount> }> {
  // One entry per (channel, address): the sources overlap — a link and a
  // sentinel row routinely name the same address — and each one asks its
  // channel a question.
  const stored = new Map<string, StoredAddress>();
  for (const address of storedAddresses) {
    stored.set(addressKey(address.channel, address.channelUserId), address);
  }

  const reads = await Promise.all(
    Object.entries(planes).map(([channel, plane]) =>
      readPlane(
        channel,
        plane,
        [...stored.values()].filter((address) => address.channel === channel),
      ),
    ),
  );

  const accounts: MirrorAccount[] = [];
  const byAddress = new Map<string, MirrorAccount>();
  for (const read of reads) {
    accounts.push(...read.accounts);
    for (const [address, account] of read.byAddress) byAddress.set(address, account);
  }
  return { accounts, byAddress };
}

/** One channel's address book, projected and indexed under every address its
 *  accounts answer to. */
async function readPlane(
  channel: string,
  plane: Accounts,
  stored: readonly StoredAddress[],
): Promise<{ accounts: MirrorAccount[]; byAddress: Map<string, MirrorAccount> }> {
  // Every read this channel owes, issued in one batch so the plane serves them
  // all from a single fold of its address book. The stored addresses are
  // resolved without waiting to learn which of them the listing already covers:
  // a channel can accept an address it stores no row for — LinkedIn derives a
  // member id from a profile URL naming it — and asking after the listing
  // arrived would fall outside the shared read and cost a second fold of the
  // whole address book.
  const [listing, resolved] = await Promise.all([
    plane.listAccounts({ limit: WHOLE_LISTING }),
    Promise.all(stored.map((address) => plane.resolve(address.channelUserId))),
  ]);

  const accounts: MirrorAccount[] = [];
  const byAddress = new Map<string, MirrorAccount>();
  const byId = new Map<string, MirrorAccount>();
  for (const account of listing.accounts) {
    const mirrored: MirrorAccount = {
      channel,
      channelUserId: account.id,
      // The account's own addressing set, as the channel gave it. An account
      // carries all of them because a search reads them: an omitted address is
      // a contact the guardian cannot reach by the phone number they know. An
      // account the channel holds no address for still answers to its id.
      aliases: (account.addresses.length > 0 ? [...account.addresses] : [account.id]).sort(
        compareCodePoints,
      ),
      name: account.name,
    };
    accounts.push(mirrored);
    byId.set(account.id, mirrored);
    for (const alias of mirrored.aliases) byAddress.set(addressKey(channel, alias), mirrored);
  }

  // A stored address no listed account named. Left unfolded, a mapping written
  // in that form is a second account for someone the caller already lists, and
  // half their history hangs off it. The address stays as the caller gave it:
  // this is the fold, not a new alias to publish.
  stored.forEach((address, i) => {
    if (byAddress.has(addressKey(channel, address.channelUserId))) return;
    const found = resolved[i];
    const account = found && byId.get(found.id);
    if (account) byAddress.set(addressKey(channel, address.channelUserId), account);
  });

  return { accounts, byAddress };
}

/**
 * One page big enough to hold any listing — what `Accounts.listAccounts`
 * says to ask for when a caller needs every account exactly once. Its order is
 * stable but the listing under it is not, so walking cursors across a live
 * mirror would skip or repeat an account as an inbound message reordered it.
 */
const WHOLE_LISTING = Number.MAX_SAFE_INTEGER;
