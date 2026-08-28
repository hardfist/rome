// Who is one account, and what is on record for them — every address book Rome
// mirrors folded onto accounts, joined to what the triage record saw.
//
// `TalkAccounts` (accounts.ts) is one channel's address book and `AccountNames`
// (account-names.ts) is the display-name half of all of them. This is the fold
// underneath both reads that have to show every account there is: which
// addressings are one account, and — for the readers that ask — what that
// account last did.
//
// The two halves fold separately, because the contacts list has no use for the
// second one. `foldAccounts` reads address books alone; `foldAccountRecords`
// reads them and joins the histories. A caller that only needs to know who is
// one account therefore never touches a message store.

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

/**
 * A channel that answers both halves of its address book: who it can reach,
 * and what was last said to each of them.
 *
 * The listing half is read as the listing gives it — each account carrying its
 * own addressing set — so the whole address book arrives as accounts rather
 * than as a map of addresses a caller has to invert back into them. A separate
 * address map is deliberately not part of what a plane owes here: it is a
 * second answer to a question the listing already answers, and two sources of
 * one truth is how they drift.
 */
export type MirrorPlane = Omit<TalkAccounts, "listAddresses"> & TalkAccountActivity;

export type MirrorPlanes = Readonly<Record<string, MirrorPlane>>;

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
 * canonical. Nothing here is about what anybody said — {@link AccountRecords}
 * is the fold that answers that.
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
 * An {@link AccountFold} joined to what the producers hold for each account:
 * the newest dynamic, and how many records are behind it.
 *
 * Built by {@link foldAccountRecords}, which is the fold that reads a message
 * store. A caller holding one of these is on the recents surface; a caller who
 * only has to know who is one account holds the base fold and pays for none of
 * this.
 */
export class AccountRecords extends AccountFold {
  private readonly records = new Map<string, AccountRecord>();

  constructor(
    accounts: readonly MirrorAccount[],
    byAddress: ReadonlyMap<string, MirrorAccount>,
    /** What each mirror holds for its own accounts, under the account's own
     *  address. An entry per listed account, whether or not anything has
     *  happened on it. */
    private readonly mirrored: ReadonlyMap<string, AccountRecord>,
    private readonly bySender: ReadonlyMap<string, SentinelSenderActivity[]>,
  ) {
    super(accounts, byAddress);
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

    const fromMirror = this.mirrored.get(key);
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
 * Read every mirror's address book whole and fold it.
 *
 * Whole rather than paged: a caller pages its own answer, and an account past a
 * channel's own cutoff is one the guardian cannot find and no count includes.
 * The fold that decides which addressings are one account needs every address
 * book entire in any case.
 *
 * No history is read here — not a mirror's and not the triage record's. This is
 * what a contacts list needs and the whole of it, so the read that serves one
 * never reaches a message store. {@link foldAccountRecords} is the fold that
 * does.
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
  const read = await readPlanes(planes, input.stored, { activity: false });
  return new AccountFold(read.accounts, read.byAddress);
}

/**
 * {@link foldAccounts}, joined to what the producers hold for each account.
 *
 * Two histories: each mirror's own, and the triage record, which is the only
 * one Rome keeps for a channel it mirrors no address book for. `senders` is
 * that record, read by the caller and folded onto accounts here.
 */
export async function foldAccountRecords(
  planes: MirrorPlanes,
  input: { senders: readonly SentinelSenderActivity[]; stored: readonly StoredAddress[] },
): Promise<AccountRecords> {
  const read = await readPlanes(planes, input.stored, { activity: true });

  const bySender = new Map<string, SentinelSenderActivity[]>();
  for (const sender of input.senders) {
    const own = read.byAddress.get(addressKey(sender.channel, sender.channelUserId));
    const key = addressKey(sender.channel, own?.channelUserId ?? sender.channelUserId);
    const group = bySender.get(key);
    if (group) group.push(sender);
    else bySender.set(key, [sender]);
  }
  return new AccountRecords(read.accounts, read.byAddress, read.activity, bySender);
}

/** Every channel read concurrently, and their address books merged into one
 *  fold. */
async function readPlanes(
  planes: MirrorPlanes,
  storedAddresses: readonly StoredAddress[],
  options: { activity: boolean },
): Promise<{
  accounts: MirrorAccount[];
  byAddress: Map<string, MirrorAccount>;
  activity: Map<string, AccountRecord>;
}> {
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
        options,
      ),
    ),
  );

  const accounts: MirrorAccount[] = [];
  const byAddress = new Map<string, MirrorAccount>();
  const activity = new Map<string, AccountRecord>();
  for (const read of reads) {
    accounts.push(...read.accounts);
    for (const [address, account] of read.byAddress) byAddress.set(address, account);
    for (const [address, record] of read.activity) activity.set(address, record);
  }
  return { accounts, byAddress, activity };
}

/** One channel's address book, projected and indexed under every address its
 *  accounts answer to. */
async function readPlane(
  channel: string,
  plane: MirrorPlane,
  stored: readonly StoredAddress[],
  options: { activity: boolean },
): Promise<{
  accounts: MirrorAccount[];
  byAddress: Map<string, MirrorAccount>;
  activity: Map<string, AccountRecord>;
}> {
  // Every read this channel owes, issued in one batch so the plane serves them
  // all from a single fold of its address book. The stored addresses are
  // resolved without waiting to learn which of them the listing already covers:
  // a channel can accept an address it stores no row for — LinkedIn derives a
  // member id from a profile URL naming it — and asking after the listing
  // arrived would fall outside the shared read and cost a second fold of the
  // whole address book.
  //
  // The history read is the one thing that is conditional: a caller who only
  // has to know who is one account skips it, and with it the channel's whole
  // message store.
  const [listing, seenBy, resolved] = await Promise.all([
    plane.listAccounts({ limit: WHOLE_LISTING }),
    options.activity ? plane.listActivity() : null,
    Promise.all(stored.map((address) => plane.resolve(address.channelUserId))),
  ]);

  const accounts: MirrorAccount[] = [];
  const byAddress = new Map<string, MirrorAccount>();
  const byId = new Map<string, MirrorAccount>();
  const activity = new Map<string, AccountRecord>();
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
    if (seenBy) {
      // An entry for every listed account, activity or not: its presence is
      // what says the mirror holds this account, which is what decides whose
      // message count a record reports.
      const seen = seenBy.get(account.id);
      activity.set(addressKey(channel, account.id), {
        latest:
          seen == null
            ? null
            : { source: channel, timestamp: seen.lastMessageAt, preview: seen.lastMessagePreview },
        messageCount: seen?.messageCount ?? 0,
      });
    }
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

  return { accounts, byAddress, activity };
}

/**
 * One page big enough to hold any listing — what `TalkAccounts.listAccounts`
 * says to ask for when a caller needs every account exactly once. Its order is
 * stable but the listing under it is not, so walking cursors across a live
 * mirror would skip or repeat an account as an inbound message reordered it.
 */
const WHOLE_LISTING = Number.MAX_SAFE_INTEGER;
