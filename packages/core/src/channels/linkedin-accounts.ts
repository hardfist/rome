import type { Account, AccountId, TalkAccounts } from "./accounts.js";
import type { AccountActivity, TalkAccountActivity } from "./account-activity.js";
import { pageAccounts } from "./account-paging.js";
import { sharedRead } from "./account-snapshot.js";
import { linkedInMemberIdFromProfileUrl } from "./linkedin-sync.js";
import type {
  LinkedInParticipantContactRow,
  LinkedInStoreRepository,
} from "../db/repositories/linkedin-store.js";

/**
 * `TalkAccounts` over the LinkedIn inbox mirror (`linkedin_participants`).
 *
 * LinkedIn hands out two identifiers for one member — the bare member id
 * (`ACoAA…`) and the profile URL that contains it — and the second folds onto
 * the first by derivation, with no lookup and no stored row. That is why the
 * fold stays behind this class: a caller holding a profile URL asks `resolve`
 * rather than learning to read a URL, and WhatsApp answers the same question
 * from a stored alias set without either caller knowing the difference (I3).
 *
 * The guardian's own `isSelf` row is not an account: it names the viewer, not
 * someone the channel reaches.
 */
export class LinkedInAccounts implements TalkAccounts, TalkAccountActivity {
  constructor(private readonly store: LinkedInStoreRepository) {}

  async listAccounts(input: {
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ accounts: Account[]; nextCursor?: string }> {
    const { accounts } = await this.load();
    return pageAccounts(accounts, input);
  }

  async resolve(identifier: string): Promise<Account | null> {
    const memberId = memberIdFrom(identifier);
    if (!memberId) return null;
    const { byId } = await this.load();
    return byId.get(memberId) ?? null;
  }

  async listAddresses(): Promise<Map<string, AccountId>> {
    // A member is stored under its member id and nothing else; the profile URL
    // that also names it is derived on sight, not held, so `resolve` is what
    // takes one.
    const { accounts } = await this.load();
    const addresses = new Map<string, AccountId>();
    for (const account of accounts) addresses.set(account.id, account.id);
    return addresses;
  }

  /**
   * What the mirror holds on each member's *direct* threads, and nothing from
   * the group ones — see `DIRECT_THREADS` in the store for why a room of ten
   * people is nobody's history. A member Rome only shares group threads with is
   * absent here rather than zeroed, which is the contract's own "silent".
   */
  async listActivity(): Promise<Map<AccountId, AccountActivity>> {
    const { rows } = await this.load();
    const activity = new Map<AccountId, AccountActivity>();
    for (const row of rows) {
      if (row.lastMessageAt == null) continue;
      activity.set(row.participantId as AccountId, {
        lastMessageAt: row.lastMessageAt,
        lastMessagePreview: row.lastMessagePreview,
        messageCount: row.messageCount,
      });
    }
    return activity;
  }

  /**
   * The whole mirror, read unbounded because every answer above is drawn from
   * it and a truncated read would report a member as absent rather than as
   * missed. Concurrent calls share one read; see {@link sharedRead} for what
   * that is and is not.
   */
  private readonly load = sharedRead(() => this.read());

  private async read(): Promise<Snapshot> {
    const rows = (await this.store.listParticipants({ limit: null })).filter((row) => !row.isSelf);
    const accounts = rows.map(toAccount);
    return { rows, accounts, byId: new Map(accounts.map((a) => [String(a.id), a])) };
  }
}

/** One fold of the mirror: the participant rows, the accounts they project
 *  onto, and the index `resolve` answers from. */
interface Snapshot {
  rows: LinkedInParticipantContactRow[];
  accounts: Account[];
  byId: Map<string, Account>;
}

/**
 * The member id an identifier names, or null. A profile URL yields the id it
 * embeds. Anything else is taken as a bare member id, which is what an
 * `AccountId` is, so an id round-trips.
 */
function memberIdFrom(identifier: string): string | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  return linkedInMemberIdFromProfileUrl(trimmed) ?? trimmed;
}

function toAccount(row: LinkedInParticipantContactRow): Account {
  return {
    id: row.participantId as AccountId,
    // A headline is not a name, but it is text LinkedIn holds about the member
    // rather than an identifier of theirs, so it stands as one here: a caller
    // that falls through to the member id has nothing better to show than
    // `ACoAA…`.
    name: row.name || row.headline || null,
    identifiers: { "linkedin:member_id": row.participantId },
  };
}
