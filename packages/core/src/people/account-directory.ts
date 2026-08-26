// Every account Rome has observed, in the shape the account contract puts on
// the wire (@rome/api-types/people). Three sources, folded into one list: the
// links the guardian has made, the sentinel log's senders, and the address
// books Rome mirrors.
//
// An account is one person on one channel, whatever addressings that channel
// reaches them at. Which of them fold together is the channel's own answer,
// read once through its account plane (../channels/mirrors.ts), so nothing here
// is channel-specific and adding a mirror changes nothing in this file.

import {
  accountPresentation,
  type AccountDynamic,
  type DirectoryAccount,
} from "@rome/api-types/people";
import { compareCodePoints } from "@rome/api-types/identities";
import { STRANGER_PERSON_ID } from "../constants.js";
import type { AccountNames } from "../channels/account-names.js";
import {
  addressKey,
  readMirrors,
  type MirrorDeps,
  type StoredIdentifiers,
} from "../channels/mirrors.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import type {
  SentinelLogRepository,
  SentinelSenderActivity,
} from "../db/repositories/sentinel-log.js";

export interface AccountDirectoryDeps extends MirrorDeps {
  personMappingRepo: Pick<PersonMappingRepository, "findAllWithMappings">;
  sentinelLogRepo: Pick<SentinelLogRepository, "listSenderActivity">;
  accountNames: Pick<AccountNames, "displayNames">;
}

/** The link an account carries, before {@link accountPresentation} decides how
 *  it renders. */
interface AccountLink {
  personId: string;
  displayName: string;
}

/** What is on record for one account, across every history that mentions it. */
interface AccountActivity {
  latest: AccountDynamic | null;
  messageCount: number;
}

/**
 * Every account there is, unordered and unfiltered — the whole directory a page
 * is cut out of (`sliceAccountDirectory`).
 *
 * Whole rather than paged, and the cost is a full read of every mirror per
 * call. An account past a channel's own cutoff is one the guardian cannot find
 * and no count includes, and the fold that decides which addressings are one
 * account needs every address book entire in any case.
 */
export async function readAccountDirectory(
  deps: AccountDirectoryDeps,
): Promise<DirectoryAccount[]> {
  const senders = await deps.sentinelLogRepo.listSenderActivity();
  // One statement, so an account moving between two people mid-read cannot land
  // under both of them.
  const persons = await deps.personMappingRepo.findAllWithMappings();

  // Every identifier the directory is about to fold, gathered before the
  // mirrors are read so a channel can be asked about the ones its address map
  // misses.
  const stored: StoredIdentifiers = new Map();
  const remember = (channel: string, channelUserId: string) => {
    const group = stored.get(channel);
    if (group) group.add(channelUserId);
    else stored.set(channel, new Set([channelUserId]));
  };
  for (const sender of senders) remember(sender.channel, sender.channelUserId);
  for (const person of persons) {
    for (const mapping of person.channelMappings) remember(mapping.channel, mapping.channelUserId);
  }

  const { accounts: mirrored, byAddress } = await readMirrors(deps, stored);

  // One account is one account however many addresses reach it, so every one of
  // them answers to the account's own. Without this the same person is both a
  // linked account (under the addressing a mapping named) and an unlinked
  // sender (a sentinel row under another) — two rows the guardian cannot tell
  // apart, and a dismissal of one that leaves the other listed.
  const canonical = (channel: string, channelUserId: string): string =>
    byAddress.get(addressKey(channel, channelUserId))?.channelUserId ?? channelUserId;
  const accountKey = (channel: string, channelUserId: string) =>
    addressKey(channel, canonical(channel, channelUserId));

  const sentinel = new Map<string, SentinelSenderActivity[]>();
  for (const sender of senders) {
    const key = accountKey(sender.channel, sender.channelUserId);
    const group = sentinel.get(key);
    if (group) group.push(sender);
    else sentinel.set(key, [sender]);
  }

  // The newest word wins across both histories: a channel mirror holds the
  // thread as the channel has it, the sentinel log holds what every channel
  // saw. Both are read across every address of the account, so which one a
  // mapping happens to name never decides what the row shows.
  const activityFor = (channel: string, channelUserId: string): AccountActivity => {
    const key = accountKey(channel, channelUserId);
    const fromMirror = byAddress.get(key);
    const rows = sentinel.get(key) ?? [];
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
    return {
      latest: newer(fromSentinel, fromMirror?.latest ?? null),
      // The mirror's count when there is one: a mirrored message and the
      // sentinel row that saw it are one message, and adding them would count
      // every exchange twice.
      messageCount:
        fromMirror != null
          ? fromMirror.messageCount
          : rows.reduce((sum, row) => sum + row.messageCount, 0),
    };
  };

  /**
   * Who holds each account, decided once before any row is built.
   *
   * A real person outranks the stranger sentinel. The unique index already
   * holds one mapping per identifier, but two mappings can name two addressings
   * of one account, and that account is one row: a placement the guardian made
   * is what it should say, and reading the dismissal of a second addressing
   * instead would hide someone they already placed. Among real people the
   * lowest id wins, so the answer does not depend on read order.
   */
  const linkOf = new Map<string, AccountLink>();
  for (const person of persons) {
    for (const mapping of person.channelMappings) {
      const key = accountKey(mapping.channel, mapping.channelUserId);
      const held = linkOf.get(key);
      if (held && !outranks(person.id, held.personId)) continue;
      linkOf.set(key, { personId: person.id, displayName: person.displayName });
    }
  }

  // The account behind every address the three sources name, each one under the
  // address the channel folds it onto.
  const found = new Map<string, { channel: string; channelUserId: string; addresses: string[] }>();
  const observe = (channel: string, channelUserId: string, addresses?: string[]) => {
    const key = accountKey(channel, channelUserId);
    if (found.has(key)) return;
    const own = canonical(channel, channelUserId);
    found.set(key, {
      channel,
      channelUserId: own,
      // A channel with no address book can say nothing about which addressings
      // are the same account, so an address it named is an account of its own.
      addresses: addresses ?? [own],
    });
  };
  for (const account of mirrored) observe(account.channel, account.channelUserId, account.aliases);
  for (const sender of senders) observe(sender.channel, sender.channelUserId);
  for (const person of persons) {
    for (const mapping of person.channelMappings) observe(mapping.channel, mapping.channelUserId);
  }

  const observed = [...found.values()];
  // One naming read for the whole directory: every mirror answers from a single
  // fold of its address book, and the sentinel log's push names are read once,
  // and only where a mirror left a name unanswered.
  const names = await deps.accountNames.displayNames(observed);

  return observed.map((account, i) => ({
    channel: account.channel,
    channelUserId: account.channelUserId,
    addresses: [...account.addresses].sort(compareCodePoints),
    displayName: names[i],
    ...accountPresentation(linkOf.get(accountKey(account.channel, account.channelUserId))),
    ...activityFor(account.channel, account.channelUserId),
  }));
}

/** Whether a claim on an account beats the one already held. */
function outranks(personId: string, held: string): boolean {
  if (personId === STRANGER_PERSON_ID) return false;
  if (held === STRANGER_PERSON_ID) return true;
  return compareCodePoints(personId, held) < 0;
}

/** The newer of two dynamics, or whichever one exists. */
function newer(a: AccountDynamic | null, b: AccountDynamic | null): AccountDynamic | null {
  if (!a) return b;
  if (!b) return a;
  return b.timestamp > a.timestamp ? b : a;
}
