import type { Account, AccountId, TalkAccounts } from "./accounts.js";
import { pageAccounts } from "./account-paging.js";
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
export class LinkedInAccounts implements TalkAccounts {
  constructor(private readonly store: LinkedInStoreRepository) {}

  async listAccounts(input: {
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ accounts: Account[]; nextCursor?: string }> {
    return pageAccounts(await this.load(), input);
  }

  async resolve(identifier: string): Promise<Account | null> {
    const memberId = memberIdFrom(identifier);
    if (!memberId) return null;
    const accounts = await this.load();
    return accounts.find((account) => account.id === memberId) ?? null;
  }

  async listAddresses(): Promise<Map<string, AccountId>> {
    // A member is stored under its member id and nothing else; the profile URL
    // that also names it is derived on sight, not held, so `resolve` is what
    // takes one.
    const addresses = new Map<string, AccountId>();
    for (const account of await this.load()) addresses.set(account.id, account.id);
    return addresses;
  }

  private async load(): Promise<Account[]> {
    const rows = await this.store.listParticipants({ limit: null });
    return rows.filter((row) => !row.isSelf).map(toAccount);
  }
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
    label: row.name || row.headline || row.participantId,
    identifiers: { "linkedin:member_id": row.participantId },
  };
}
