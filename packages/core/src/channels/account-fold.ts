// Who is one account, and what is on record for them — every address book Rome
// mirrors folded onto accounts, joined to what the triage record saw.
//
// `TalkAccounts` (accounts.ts) is one channel's address book and `AccountNames`
// (account-names.ts) is the display-name half of all of them. This is the fold
// underneath both reads that have to show every account there is: which
// addressings are one account, and what that account last did.

import { compareCodePoints, type AccountDynamic } from "@rome/api-types/people";
import type { SentinelSenderActivity } from "../db/repositories/sentinel-log.js";
import type { TalkAccountActivity } from "./account-activity.js";
import type { TalkAccounts } from "./accounts.js";

/**
 * One account a channel's address book holds, in the shape every caller reads
 * every mirror through.
 *
 * The projection is `Account` plus its activity, and nothing channel-specific
 * survives it: which addressings a channel hands out, which of them is
 * canonical, and what counts as an account at all are the channel's answers,
 * given once behind {@link TalkAccounts}. So a caller's rules stay
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
  latest: AccountDynamic | null;
  messageCount: number;
}

/** What the producers hold for one account: its newest dynamic, and how many
 *  records are behind it. */
export interface AccountRecord {
  latest: AccountDynamic | null;
  messageCount: number;
}

/** Key a (channel, address) pair for the maps a fold is built out of. */
export const addressKey = (channel: string, channelUserId: string) =>
  `${channel}\n${channelUserId}`;

/**
 * The channels Rome mirrors an address book for. A provider joins every fold
 * and every naming read at once by taking an entry here.
 *
 * The plane type is the caller's: a fold needs the whole of {@link MirrorPlane}
 * and a naming read needs only `resolve`, and neither should have to name the
 * channels a second time to say so.
 */
export function mirrorRegistry<T>(deps: {
  whatsAppAccounts: T;
  linkedInAccounts: T;
}): Readonly<Record<string, T>> {
  return { whatsapp: deps.whatsAppAccounts, linkedin: deps.linkedInAccounts };
}

/** A channel that answers both halves of its address book: who it can reach,
 *  and what was last said to each of them. */
export type MirrorPlane = TalkAccounts & TalkAccountActivity;

export type MirrorPlanes = Readonly<Record<string, MirrorPlane>>;

/** An identifier a caller already holds, wherever it holds it — a link, a
 *  sentinel row — so a channel can be asked about the ones its address map does
 *  not cover. */
export interface StoredAddress {
  channel: string;
  channelUserId: string;
}

/**
 * Every account the mirrors hold and every sender the triage record saw, folded
 * so that one account answers under every address it is reachable at.
 *
 * Built by {@link foldAccounts}. A caller asks it questions about a (channel,
 * address) pair and never has to know which of them the channel considers
 * canonical, nor which store the answer came from.
 */
export class AccountFold {
  private readonly records = new Map<string, AccountRecord>();

  constructor(
    /** Every account the mirrors hold. */
    readonly accounts: readonly MirrorAccount[],
    private readonly byAddress: ReadonlyMap<string, MirrorAccount>,
    private readonly bySender: ReadonlyMap<string, SentinelSenderActivity[]>,
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

  /** Every triage row filed against this account, under any of its addresses. */
  sendersFor(channel: string, channelUserId: string): readonly SentinelSenderActivity[] {
    return this.bySender.get(this.key(channel, channelUserId)) ?? [];
  }

  /**
   * What is on record for an account, across both histories.
   *
   * The newest word wins: a channel mirror holds the thread as the channel has
   * it, the triage record holds what every channel saw. Both are read across
   * every address of the account, so which one a mapping happens to name never
   * decides what a row shows.
   */
  recordFor(channel: string, channelUserId: string): AccountRecord {
    const key = this.key(channel, channelUserId);
    const memoized = this.records.get(key);
    if (memoized) return memoized;

    const fromMirror = this.byAddress.get(key);
    const rows = this.bySender.get(key) ?? [];
    const fromSentinel = rows.reduce<AccountDynamic | null>(
      (best, row) =>
        newer(
          best,
          row.lastMessageAt == null
            ? null
            : { source: channel, timestamp: row.lastMessageAt, preview: row.lastMessage },
        ),
      null,
    );
    const record: AccountRecord = {
      latest: newer(fromSentinel, fromMirror?.latest ?? null),
      // The mirror's count when there is one: a mirrored message and the
      // sentinel row that saw it are one message, and adding them would count
      // every exchange twice.
      messageCount:
        fromMirror != null
          ? fromMirror.messageCount
          : rows.reduce((sum, row) => sum + row.messageCount, 0),
    };
    this.records.set(key, record);
    return record;
  }
}

/** The newer of two dynamics, or whichever one exists. */
export function newer(a: AccountDynamic | null, b: AccountDynamic | null): AccountDynamic | null {
  if (!a) return b;
  if (!b) return a;
  return b.timestamp > a.timestamp ? b : a;
}

/**
 * Read every mirror whole and join the triage record to it.
 *
 * Whole rather than paged: a caller pages its own answer, and an account past a
 * channel's own cutoff is one the guardian cannot find and no count includes.
 * The fold that decides which addressings are one account needs every address
 * book entire in any case.
 *
 * `stored` is every address the caller already holds. The channels are read
 * concurrently, and each channel's reads are issued in one batch, because a
 * plane that folds its whole address book per call shares the read already in
 * flight — so the whole fold costs one read per channel rather than one per
 * call made against it.
 */
export async function foldAccounts(
  planes: MirrorPlanes,
  input: { senders: readonly SentinelSenderActivity[]; stored: readonly StoredAddress[] },
): Promise<AccountFold> {
  // One entry per (channel, address): the sources overlap — a link and a
  // sentinel row routinely name the same address — and each one asks its
  // channel a question.
  const stored = new Map<string, StoredAddress>();
  for (const address of input.stored) {
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

  const bySender = new Map<string, SentinelSenderActivity[]>();
  for (const sender of input.senders) {
    const own = byAddress.get(addressKey(sender.channel, sender.channelUserId));
    const key = addressKey(sender.channel, own?.channelUserId ?? sender.channelUserId);
    const group = bySender.get(key);
    if (group) group.push(sender);
    else bySender.set(key, [sender]);
  }
  return new AccountFold(accounts, byAddress, bySender);
}

/** One channel's address book, projected and indexed under every address its
 *  accounts answer to. */
async function readPlane(
  channel: string,
  plane: MirrorPlane,
  stored: readonly StoredAddress[],
): Promise<{ accounts: MirrorAccount[]; byAddress: Map<string, MirrorAccount> }> {
  // Every read this channel owes, issued in one batch so the plane serves them
  // all from a single fold of its address book. The stored addresses are
  // resolved without waiting to learn which of them the address map already
  // covers: a channel can accept an address it stores no row for — LinkedIn
  // derives a member id from a profile URL naming it — and asking after the map
  // arrived would fall outside the shared read and cost a second fold of the
  // whole address book.
  const [listing, activity, addresses, resolved] = await Promise.all([
    plane.listAccounts({ limit: WHOLE_LISTING }),
    plane.listActivity(),
    plane.listAddresses(),
    Promise.all(stored.map((address) => plane.resolve(address.channelUserId))),
  ]);

  // The addressing set of each account, which is the address map read the other
  // way round. An account carries all of them because a search reads them: an
  // omitted address is a contact the guardian cannot reach by the phone number
  // they know.
  const aliasesOf = new Map<string, string[]>();
  for (const [address, accountId] of addresses) {
    const group = aliasesOf.get(accountId);
    if (group) group.push(address);
    else aliasesOf.set(accountId, [address]);
  }

  const accounts: MirrorAccount[] = [];
  const byAddress = new Map<string, MirrorAccount>();
  const byId = new Map<string, MirrorAccount>();
  for (const account of listing.accounts) {
    const seen = activity.get(account.id);
    const mirrored: MirrorAccount = {
      channel,
      channelUserId: account.id,
      aliases: (aliasesOf.get(account.id) ?? [account.id]).sort(compareCodePoints),
      name: account.name,
      latest:
        seen == null
          ? null
          : { source: channel, timestamp: seen.lastMessageAt, preview: seen.lastMessagePreview },
      messageCount: seen?.messageCount ?? 0,
    };
    accounts.push(mirrored);
    byId.set(account.id, mirrored);
    for (const alias of mirrored.aliases) byAddress.set(addressKey(channel, alias), mirrored);
  }

  // A stored address the channel's address map did not cover. Left unfolded, a
  // mapping written in that form is a second account for someone the caller
  // already lists, and half their history hangs off it. The address stays as
  // the caller gave it: this is the fold, not a new alias to publish.
  stored.forEach((address, i) => {
    if (addresses.has(address.channelUserId)) return;
    const found = resolved[i];
    const account = found && byId.get(found.id);
    if (account) byAddress.set(addressKey(channel, address.channelUserId), account);
  });

  return { accounts, byAddress };
}

/**
 * One page big enough to hold any listing — what `TalkAccounts.listAccounts`
 * says to ask for when a caller needs every account exactly once. Its order is
 * stable but the listing under it is not, so walking cursors across a live
 * mirror would skip or repeat an account as an inbound message reordered it.
 */
const WHOLE_LISTING = Number.MAX_SAFE_INTEGER;
