// Every address book Rome mirrors, folded into one list of accounts and one
// index from address to account. `TalkAccounts` (accounts.ts) is one channel's
// address book, and `AccountNames` (account-names.ts) is the display-name half
// of all of them — this is the whole of all of them, for the reads that have to
// show every account there is.

import type { AccountDynamic } from "@rome/api-types/people";
import { compareCodePoints } from "@rome/api-types/identities";
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
 * channel-agnostic, and adding a mirror is an entry in {@link mirrorPlanes}
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

/** The mirrors, and the index that says which account an address belongs to. */
export interface MirrorRead {
  accounts: MirrorAccount[];
  byAddress: Map<string, MirrorAccount>;
}

/** Key a (channel, address) pair for the maps a fold is built out of. */
export const addressKey = (channel: string, channelUserId: string) =>
  `${channel}\n${channelUserId}`;

/** A channel whose account plane the mirrors are read through. One entry per
 *  mirror, and a channel Rome only ever sees senders on has none. */
interface MirrorPlane {
  channel: string;
  accounts: TalkAccounts & TalkAccountActivity;
}

export interface MirrorDeps {
  whatsAppAccounts: TalkAccounts & TalkAccountActivity;
  linkedInAccounts: TalkAccounts & TalkAccountActivity;
}

function mirrorPlanes(deps: MirrorDeps): MirrorPlane[] {
  return [
    { channel: "whatsapp", accounts: deps.whatsAppAccounts },
    { channel: "linkedin", accounts: deps.linkedInAccounts },
  ];
}

/**
 * One page big enough to hold any listing — what `TalkAccounts.listAccounts`
 * says to ask for when a caller needs every account exactly once. Its order is
 * stable but the listing under it is not, so walking cursors across a live
 * mirror would skip or repeat an account as an inbound message reordered it.
 */
const WHOLE_LISTING = Number.MAX_SAFE_INTEGER;

/** Every identifier a caller already holds on a channel, keyed by channel. */
export type StoredIdentifiers = Map<string, Set<string>>;

/**
 * Every account the channel mirrors hold, projected onto one shape, with each
 * of them indexed under every address it answers to.
 *
 * Read whole rather than paged: the caller pages its own answer, and an account
 * past a channel's own cutoff is one the guardian cannot find and no count
 * includes.
 *
 * `stored` is every identifier the caller already holds — from its links, its
 * sentinel rows — so a channel can be asked about the ones its address map does
 * not cover. A channel can still accept such an identifier: LinkedIn derives a
 * member id from a profile URL naming it and stores no row for the URL, so a
 * guardian who pasted a profile link into a mapping wrote a form only `resolve`
 * takes. Left unresolved, that mapping is a second account for someone the
 * caller already lists, and half their history hangs off it.
 */
export async function readMirrors(
  deps: MirrorDeps,
  stored: StoredIdentifiers,
): Promise<MirrorRead> {
  const accounts: MirrorAccount[] = [];
  const byAddress = new Map<string, MirrorAccount>();

  for (const plane of mirrorPlanes(deps)) {
    const { channel } = plane;
    const [listing, activity, addresses] = await Promise.all([
      plane.accounts.listAccounts({ limit: WHOLE_LISTING }),
      plane.accounts.listActivity(),
      plane.accounts.listAddresses(),
    ]);

    // The addressing set of each account, which is the address map read the
    // other way round. An account carries all of them because a search reads
    // them: an omitted address is a contact the guardian cannot reach by the
    // phone number they know.
    const aliasesOf = new Map<string, string[]>();
    for (const [address, accountId] of addresses) {
      const group = aliasesOf.get(accountId);
      if (group) group.push(address);
      else aliasesOf.set(accountId, [address]);
    }

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

    // Asked in one batch, because a plane that folds the whole mirror per call
    // shares the read already in flight, so the misses cost one read rather
    // than one each. The addresses stay as the caller gave them: this is the
    // fold, not a new alias to publish.
    const missing = [...(stored.get(channel) ?? [])].filter(
      (identifier) => !addresses.has(identifier),
    );
    const found = await Promise.all(
      missing.map(
        async (identifier) => [identifier, await plane.accounts.resolve(identifier)] as const,
      ),
    );
    for (const [identifier, account] of found) {
      const mirrored = account && byId.get(account.id);
      if (mirrored) byAddress.set(addressKey(channel, identifier), mirrored);
    }
  }
  return { accounts, byAddress };
}
