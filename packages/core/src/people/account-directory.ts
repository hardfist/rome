// Every account Rome has observed, in the shape the account contract puts on
// the wire (@rome/api-types/people). Three sources, folded into one list: the
// links the guardian has made, the sentinel log's senders, and the address
// books Rome mirrors.
//
// An account is one person on one channel, whatever addressings that channel
// reaches them at. Which of them fold together is the channel's own answer,
// read once through `AccountFold` (../channels/account-fold.ts), so nothing
// here is channel-specific and adding a mirror changes nothing in this file.
//
// Two reads, because the two surfaces ask two questions — "who does Rome know"
// and "who has something new". They fold the same address books to decide which
// addressings are one account, and only the stream goes on to read a history.

import {
  accountPresentation,
  type DirectoryAccount,
  type StreamAccount,
} from "@rome/api-types/people";
import { compareCodePoints } from "@rome/api-types/identities";
import { STRANGER_PERSON_ID } from "../constants.js";
import type { AccountNames } from "../channels/account-names.js";
import {
  foldAccountRecords,
  foldAccounts,
  mirrorRegistry,
  type AccountFold,
  type AccountRecords,
  type MirrorPlane,
} from "../channels/account-fold.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import type { SentinelLogRepository } from "../db/repositories/sentinel-log.js";

export interface AccountDirectoryDeps {
  whatsAppAccounts: MirrorPlane;
  linkedInAccounts: MirrorPlane;
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

/**
 * Every account there is, unordered and unfiltered — the whole directory a page
 * is cut out of (`sliceAccountDirectory`).
 *
 * Whole rather than paged: the fold that decides which addressings are one
 * account needs every address book entire, and an account past a channel's own
 * cutoff is one the guardian cannot find and no count includes. The cost is one
 * read of each address book for the fold and one more to name what it found.
 *
 * A contacts list's rows: who each account is, and nothing about what anyone
 * said. No message store is read — not a mirror's history and not the triage
 * record's — because the directory orders by name and previews nothing, so
 * every message-derived fact would be work no reader of this read ever renders.
 * {@link readAccountStream} is the read that does.
 */
export async function readAccountDirectory(
  deps: AccountDirectoryDeps,
): Promise<DirectoryAccount[]> {
  return (await observeAccounts(deps, { activity: false })).accounts;
}

/**
 * Every account something has happened on, unordered and unfiltered — the whole
 * stream a page is cut out of (`sliceAccountStream`).
 *
 * The same accounts as {@link readAccountDirectory} over the same sources,
 * projected the other way: with the dynamic the stream orders and previews by,
 * and without the accounts that have none. An address-book contact nobody has
 * ever heard from has no position in an order made of timestamps, so it is
 * absent rather than listed last.
 */
export async function readAccountStream(deps: AccountDirectoryDeps): Promise<StreamAccount[]> {
  const { accounts, fold } = await observeAccounts(deps, { activity: true });
  return accounts.flatMap((account) => {
    const record = fold.recordFor(account.channel, account.channelUserId);
    return record.latest == null
      ? []
      : [{ ...account, latest: record.latest, messageCount: record.messageCount }];
  });
}

/**
 * Which accounts there are, what each is called, and who holds it — the join
 * both reads share, so the two can never disagree about which accounts exist.
 *
 * `activity` decides how much is read, not what is answered: with it the fold
 * carries each account's history and the caller can ask, without it no message
 * store is touched at all.
 */
async function observeAccounts(
  deps: AccountDirectoryDeps,
  options: { activity: true },
): Promise<{ accounts: DirectoryAccount[]; fold: AccountRecords }>;
async function observeAccounts(
  deps: AccountDirectoryDeps,
  options: { activity: false },
): Promise<{ accounts: DirectoryAccount[]; fold: AccountFold }>;
async function observeAccounts(
  deps: AccountDirectoryDeps,
  options: { activity: boolean },
): Promise<{ accounts: DirectoryAccount[]; fold: AccountFold }> {
  const [senders, persons] = await Promise.all([
    // The triage record, for the senders it is the only source of: a channel
    // Rome mirrors no address book for has no other row saying the account
    // exists. What each of them said is read off this only by the stream.
    deps.sentinelLogRepo.listSenderActivity(),
    // One statement, so an account moving between two people mid-read cannot
    // land under both of them.
    deps.personMappingRepo.findAllWithMappings(),
  ]);

  const mappings = persons.flatMap((person) =>
    person.channelMappings.map((mapping) => ({ ...mapping, person })),
  );
  const stored = [...senders, ...mappings];
  const fold = options.activity
    ? await foldAccountRecords(mirrorRegistry(deps), { senders, stored })
    : await foldAccounts(mirrorRegistry(deps), { stored });

  /** Who holds each account, decided once before any row is built. */
  const linkOf = new Map<string, AccountLink>();
  // The account behind every address the three sources name, each one under the
  // address the channel folds it onto.
  const observed = new Map<
    string,
    { channel: string; channelUserId: string; addresses: string[] }
  >();
  const observe = (channel: string, channelUserId: string, addresses?: string[]) => {
    const key = fold.key(channel, channelUserId);
    if (!observed.has(key)) {
      const own = fold.canonical(channel, channelUserId);
      observed.set(key, {
        channel,
        channelUserId: own,
        // A channel with no address book can say nothing about which
        // addressings are the same account, so an address it named is an
        // account of its own.
        addresses: [...(addresses ?? [own])].sort(compareCodePoints),
      });
    }
    return key;
  };

  for (const account of fold.accounts) {
    observe(account.channel, account.channelUserId, account.aliases);
  }
  for (const sender of senders) observe(sender.channel, sender.channelUserId);
  for (const mapping of mappings) {
    const key = observe(mapping.channel, mapping.channelUserId);
    const held = linkOf.get(key);
    if (held && !outranks(mapping.person.id, held.personId)) continue;
    linkOf.set(key, { personId: mapping.person.id, displayName: mapping.person.displayName });
  }

  const rows = [...observed];
  // One naming read for the whole directory: every mirror answers from a single
  // fold of its address book, and the sentinel log's push names are read once,
  // and only where a mirror left a name unanswered.
  const names = await deps.accountNames.displayNames(rows.map(([, account]) => account));

  return {
    fold,
    accounts: rows.map(([key, account], i) => ({
      ...account,
      displayName: names[i],
      ...accountPresentation(linkOf.get(key)),
    })),
  };
}

/**
 * Whether a claim on an account beats the one already held.
 *
 * A real person outranks the stranger sentinel. The unique index already holds
 * one mapping per identifier, but two mappings can name two addressings of one
 * account, and that account is one row: a placement the guardian made is what
 * it should say, and reading the dismissal of a second addressing instead would
 * hide someone they already placed. Among real people the lowest id wins, so
 * the answer does not depend on read order.
 */
function outranks(personId: string, held: string): boolean {
  if (personId === STRANGER_PERSON_ID) return false;
  if (held === STRANGER_PERSON_ID) return true;
  return compareCodePoints(personId, held) < 0;
}
