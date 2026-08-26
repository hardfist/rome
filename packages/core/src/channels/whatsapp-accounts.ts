import { formatWhatsAppPhone } from "@rome/api-types/identities";
import type { Account, AccountId, TalkAccounts } from "./accounts.js";
import type { AccountActivity, TalkAccountActivity } from "./account-activity.js";
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
 * Two gaps stay open, both because the mirror stores no key that outlives the
 * digits an id is built from. Closing either needs a durable stored account
 * key, not a different choice of addressing, and code that persists an
 * `AccountId` has to survive both:
 *
 * - An account that changes its phone number gets a new id (I2).
 * - A named LID row carrying no phone number addresses itself. Its id moves to
 *   the phone-number form once the mirror learns the number (I2), and until
 *   then a phone-number row for the same person is a second `Account` (I1).
 *   Nothing links the two but the name, and names are not identity.
 */
export class WhatsAppAccounts implements TalkAccounts, TalkAccountActivity {
  constructor(private readonly store: WhatsAppStoreRepository) {}

  /** The read a concurrent set of calls shares. See {@link load}. */
  private reading: Promise<Snapshot> | null = null;

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

  async listAddresses(): Promise<Map<string, AccountId>> {
    const { grouped } = await this.load();
    const addresses = new Map<string, AccountId>();
    for (const [id, group] of grouped) {
      // The id first: it is derived from the account's digits, so it is an
      // address the account answers to whether or not a row spells it out.
      addresses.set(id, id);
      for (const row of group) {
        for (const alias of row.aliases) addresses.set(alias, id);
      }
    }
    return addresses;
  }

  async listActivity(): Promise<Map<AccountId, AccountActivity>> {
    const { grouped } = await this.load();
    const activity = new Map<AccountId, AccountActivity>();
    for (const [id, group] of grouped) {
      // A conversation usually sits on one addressing, but history split across
      // both is two rows here, so the newest wins and the counts add.
      const newest = group.reduce(
        (best, row) => ((row.lastMessageAt ?? -1) > (best.lastMessageAt ?? -1) ? row : best),
        group[0],
      );
      const messageCount = group.reduce((n, row) => n + row.messageCount, 0);
      if (newest.lastMessageAt == null) continue;
      activity.set(id, {
        lastMessageAt: newest.lastMessageAt,
        lastMessagePreview: newest.lastMessagePreview,
        messageCount,
      });
    }
    return activity;
  }

  /**
   * The whole mirror, folded. Every call reads the address book and rebuilds
   * the index, so walking pages costs one full read per page and `resolve`
   * costs one per identifier. That is bounded by address-book size and holds no
   * stale rows. A caller that resolves per message wants a real cache, and the
   * cache belongs here, where a sync can invalidate it rather than the caller
   * guessing at when it went stale.
   *
   * Reads already in flight are shared. That is not that cache: the window
   * closes the moment the read settles, so nothing outlives a sync. It is what
   * makes the several reads a single caller needs at once — a listing, its
   * addresses, its activity — one read of one mirror, so the three answers
   * cannot describe address books a sync moved between.
   */
  private load(): Promise<Snapshot> {
    if (this.reading) return this.reading;
    const reading = this.read();
    this.reading = reading;
    const done = () => {
      if (this.reading === reading) this.reading = null;
    };
    reading.then(done, done);
    return reading;
  }

  /**
   * The store already folds a person's two addressings onto one card, but it
   * folds on the phone number a row carries, so a row that has not learned its
   * number yet stays separate. Re-keying on the canonical id here collapses
   * those too — one `Account` per account, whatever the mirror's row shape (I1).
   */
  private async read(): Promise<Snapshot> {
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
    return { accounts, byKey, grouped };
  }
}

/** One fold of the mirror: the accounts, the index they resolve through, and
 *  the rows behind each, which the activity read sums over. */
interface Snapshot {
  accounts: Account[];
  byKey: Map<string, Account>;
  grouped: Map<AccountId, WhatsAppContactRow[]>;
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
    // No name on record anywhere: the number, written the way a person writes
    // one. The raw JID is a last resort, not a label.
    formatWhatsAppPhone(pick((row) => row.phoneNumber) ?? id) ??
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
