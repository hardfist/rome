// Every account Rome has observed, in the shape the account contract puts on
// the wire (@rome/api-types/people). Three sources, folded into one list: the
// links the guardian has made, the sentinel log's senders, and the address
// books Rome mirrors.
//
// An account is one person on one channel, whatever addressings that channel
// reaches them at. Which of them fold together is the channel's own answer,
// read once through `AccountFold` (../channels/account-fold.ts), so nothing
// here is channel-specific and adding a mirror changes nothing in this file.

import { accountPresentation, type DirectoryAccount } from "@rome/api-types/people";
import { compareCodePoints } from "@rome/api-types/identities";
import { STRANGER_PERSON_ID } from "../constants.js";
import type { AccountNames } from "../channels/account-names.js";
import { foldAccounts, mirrorRegistry, type MirrorPlane } from "../channels/account-fold.js";
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
 */
export async function readAccountDirectory(
  deps: AccountDirectoryDeps,
): Promise<DirectoryAccount[]> {
  const [senders, persons] = await Promise.all([
    deps.sentinelLogRepo.listSenderActivity(),
    // One statement, so an account moving between two people mid-read cannot
    // land under both of them.
    deps.personMappingRepo.findAllWithMappings(),
  ]);

  const mappings = persons.flatMap((person) =>
    person.channelMappings.map((mapping) => ({ ...mapping, person })),
  );
  const fold = await foldAccounts(mirrorRegistry(deps), {
    senders,
    stored: [...senders, ...mappings],
  });

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

  return rows.map(([key, account], i) => ({
    ...account,
    displayName: names[i],
    ...accountPresentation(linkOf.get(key)),
    ...fold.recordFor(account.channel, account.channelUserId),
  }));
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
