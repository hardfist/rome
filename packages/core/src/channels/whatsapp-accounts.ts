import type { Account, AccountId, TalkAccounts } from "./accounts.js";
import { pageAccounts } from "./account-paging.js";
import type {
  WhatsAppContactRow,
  WhatsAppStoreRepository,
} from "../db/repositories/whatsapp-store.js";

const PHONE_JID_DOMAIN = "@s.whatsapp.net";

// A phone number written as a person writes one. Anything else — a name, a
// LinkedIn member id that happens to contain digits — is not a phone identifier
// and must not be stripped down to one.
const BARE_PHONE = /^\+?[\d\s()-]+$/;

/** Digits of a phone identifier — a `@s.whatsapp.net` JID or a bare number. */
function phoneDigits(value: string | null | undefined): string | null {
  if (!value) return null;
  const user = value.endsWith(PHONE_JID_DOMAIN)
    ? value.slice(0, -PHONE_JID_DOMAIN.length).replace(/:.*$/, "")
    : value;
  if (!BARE_PHONE.test(user)) return null;
  const digits = user.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/** A JID with its `:device` suffix stripped, so every device folds onto one user. */
function normalizeJid(value: string): string {
  const at = value.indexOf("@");
  if (at < 0) return value;
  return `${value.slice(0, at).replace(/:.*$/, "")}${value.slice(at)}`;
}

function isGroupJid(value: string): boolean {
  return value.endsWith("@g.us");
}

function firstNonEmpty(...values: Array<string | null>): string | null {
  for (const v of values) if (v != null && v !== "") return v;
  return null;
}

/**
 * `TalkAccounts` over the WhatsApp address-book mirror (`wa_contacts`).
 *
 * WhatsApp addresses one person two ways — the phone-number JID
 * (`<pn>@s.whatsapp.net`) and the privacy LID (`<lid>@lid`) — and the mirror
 * holds a row for each. The canonical form is the phone-number JID, and it is
 * built from the account's digits rather than picked from whichever row exists,
 * so learning the second addressing later never moves the id (I2) while either
 * addressing still resolves to it (I4). Preferring the LID would invert that: a
 * LID can only be found, never derived, so every account's id would move the
 * first time a conversation arrived.
 *
 * Group chats (`@g.us`) are not accounts.
 *
 * One clause of I2 stays open here: an account that changes its phone number
 * gets a new id, because the mirror stores no key that outlives the digits.
 * Closing it needs a durable stored account key, not a different addressing.
 */
export class WhatsAppAccounts implements TalkAccounts {
  constructor(private readonly store: WhatsAppStoreRepository) {}

  async listAccounts(input: {
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ accounts: Account[]; nextCursor?: string }> {
    const { accounts } = await this.load();
    return pageAccounts(accounts, input);
  }

  async resolve(identifier: string): Promise<Account | null> {
    if (!identifier || isGroupJid(identifier)) return null;
    const { byKey } = await this.load();
    for (const key of lookupKeys(identifier)) {
      const hit = byKey.get(key);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Every account, plus the index every identifier resolves through. The store
   * already folds a person's two addressings onto one card, but it folds on the
   * phone number a row carries, so a row that has not learned its number yet
   * stays separate. Re-keying on the canonical id here collapses those too —
   * one `Account` per account, whatever the mirror's row shape (I1).
   */
  private async load(): Promise<{ accounts: Account[]; byKey: Map<string, Account> }> {
    const rows = (await this.store.listContacts({ limit: null })).filter(
      (row) => !row.isGroup && !isGroupJid(row.jid),
    );

    const grouped = new Map<AccountId, WhatsAppContactRow[]>();
    for (const row of rows) {
      const id = accountIdOf(row);
      const existing = grouped.get(id);
      if (existing) existing.push(row);
      else grouped.set(id, [row]);
    }

    const accounts: Account[] = [];
    const byKey = new Map<string, Account>();
    for (const [id, group] of grouped) {
      const account = toAccount(id, group);
      accounts.push(account);
      for (const key of accountKeys(id, group)) byKey.set(key, account);
    }
    return { accounts, byKey };
  }
}

/**
 * The account's canonical address. A row's stored phone number is the first
 * answer; a phone-number JID carries its own digits when the number column is
 * still empty. A LID-only row has neither, so it addresses itself until the
 * mirror learns its number.
 */
function accountIdOf(row: WhatsAppContactRow): AccountId {
  const digits = phoneDigits(row.phoneNumber) ?? phoneDigits(row.jid);
  return (digits ? `${digits}${PHONE_JID_DOMAIN}` : normalizeJid(row.jid)) as AccountId;
}

function toAccount(id: AccountId, group: WhatsAppContactRow[]): Account {
  const identifiers: Record<string, string> = {};
  const digits = phoneDigits(id);
  if (digits) identifiers.phone = digits;

  const lid = group
    .flatMap((row) => row.aliases)
    .map(normalizeJid)
    .filter((jid) => jid.endsWith("@lid"))
    .sort()[0];
  if (lid) identifiers["whatsapp:lid"] = lid;

  // Field-major, not row-major: a saved name on any row of the account beats a
  // push name on another, and every name beats falling back to the number.
  const pick = (field: (row: WhatsAppContactRow) => string | null) =>
    firstNonEmpty(...group.map(field));
  const label =
    pick((row) => row.name) ??
    pick((row) => row.notify) ??
    pick((row) => row.verifiedName) ??
    pick((row) => row.chatName) ??
    pick((row) => row.phoneNumber) ??
    id;

  return { id, label, identifiers };
}

/** Every index key the account answers to, including its own id. */
function accountKeys(id: AccountId, group: WhatsAppContactRow[]): string[] {
  const keys = [`jid:${id}`];
  const digits = phoneDigits(id);
  if (digits) keys.push(`pn:${digits}`);
  for (const row of group) {
    for (const alias of row.aliases) keys.push(`jid:${normalizeJid(alias)}`);
  }
  return keys;
}

/** The keys an inbound identifier could match, most specific first. */
function lookupKeys(identifier: string): string[] {
  const keys: string[] = [];
  const digits = phoneDigits(identifier);
  if (digits) keys.push(`pn:${digits}`);
  keys.push(`jid:${normalizeJid(identifier)}`);
  return keys;
}
