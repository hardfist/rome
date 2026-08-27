import {
  BOND_LADDER,
  compareIdentityCursors,
  formatWhatsAppPhone,
  matchesQuery,
  normalizeBondLevel,
  type BondLadderLevel,
  type IdentityDynamic,
} from "@rome/api-types/identities";
import {
  accountRef,
  isSilentAccount,
  type AccountDirectory,
  type DirectoryAccount,
  type PersonCounts,
  type PersonResource,
} from "@rome/api-types/people";

// The People page's derivations, kept out of the components so the stream, the
// directory groups and the counts can be exercised without rendering. Every one
// of them is a pure function of what the two reads returned plus the view's own
// controls.
//
// The contract is two nouns — a person (`GET /api/people`) and an account
// somebody is reachable at (`GET /api/accounts`) — and this page is one ladder
// over both. `PeopleRow` is that join: the shape a row renders from, whichever
// noun it came from. Everything channel-shaped about it — which addressings are
// one account, what the channel calls it, how much is on record — is the
// server's answer carried through, not a rule restated here.

/** The two views the page offers: the activity stream, and the roster. */
export type PeopleView = "latest" | "directory";

/** Where a row sits on the ladder. The four placed levels are a person's stored
 *  bond; the two unplaced ends are what the guardian has not decided (an
 *  unlinked account) and what they decided against (a dismissed one). */
export type RowLevel = BondLadderLevel;

/** The chip the filter rail offers. "all" is a view, not a ladder position. */
export type PeopleFilter = "all" | RowLevel;

/**
 * The chips, in rail order.
 *
 * Guardian has none: it is the guardian's own row, which the directory always
 * shows and the stream never does. "All" holds back Stranger, so the dismissed
 * end of the ladder is entered on purpose rather than sitting in the default
 * view.
 */
export const FILTER_ORDER: PeopleFilter[] = [
  "all",
  "unknown",
  "inner-circle",
  "acquaintance",
  "other",
  "stranger",
];

/** Directory groups, in ladder order. */
export const GROUP_ORDER: RowLevel[] = [...BOND_LADDER];

/**
 * One row on the People page, from either noun.
 *
 * `kind` is what the row *is*, and it decides what can be done with it: only a
 * person has a dossier to open, because only a person has a merged history to
 * open it on. `id` is the route id for a person and the account's own
 * `channel:channelUserId` ref otherwise — never mixed, so nothing has to guess
 * which read a row came from.
 */
export interface PeopleRow {
  kind: "person" | "account";
  id: string;
  displayName: string;
  level: RowLevel;
  /** Every account the row stands for: a person's linked accounts, or the one
   *  account itself. */
  accounts: { channel: string; channelUserId: string; displayName: string }[];
  /**
   * Every address the row can be reached at, the server's fold of them.
   *
   * A WhatsApp contact answers to both its phone jid and its `@lid` jid; which
   * of those are one account is the channel's answer, given once by the server
   * in `DirectoryAccount.addresses`. The client renders what it decided rather
   * than folding a second time and disagreeing.
   */
  addresses: string[];
  latest: IdentityDynamic | null;
  messageCount: number;
  /** An account with nothing on record that nobody has decided about: a synced
   *  address-book contact and no more. Never true of a person. */
  silent: boolean;
}

/**
 * The two reads, joined into one roster.
 *
 * A linked account is left out: it is the same human as the person it resolves
 * to, seen from the other side, and rendering both would put one person on the
 * page twice — with the bond on one row and the history on the other. The
 * person carries both, so the person is the row.
 */
export function peopleRows(
  people: readonly PersonResource[],
  accounts: readonly DirectoryAccount[],
): PeopleRow[] {
  const rows: PeopleRow[] = people.map((person) => ({
    kind: "person",
    id: person.id,
    displayName: person.displayName,
    // The stored value is free text — older rows carry levels off today's
    // ladder — so it is bucketed here rather than trusted or dropped.
    level: normalizeBondLevel(person.bondLevel),
    accounts: person.accounts,
    addresses: person.accounts.map((account) => account.channelUserId),
    latest: person.latest,
    messageCount: person.messageCount,
    silent: false,
  }));

  for (const account of accounts) {
    if (account.state === "linked") continue;
    rows.push({
      kind: "account",
      id: accountRef(account),
      displayName: account.displayName,
      level: account.state === "dismissed" ? "stranger" : "unknown",
      accounts: [
        {
          channel: account.channel,
          channelUserId: account.channelUserId,
          displayName: account.displayName,
        },
      ],
      addresses: account.addresses,
      latest: account.latest,
      messageCount: account.messageCount,
      silent: isSilentAccount(account),
    });
  }

  return rows;
}

/** The guardian is not a routing decision, not selectable and not movable —
 *  that is the one row the page's uniform treatment does not apply to. */
export function isRowFixed(row: PeopleRow): boolean {
  return row.level === "guardian";
}

/** The identifier a row is recognized by when its name is not enough: a phone
 *  number where the channel has one, otherwise the raw handle. */
export function rowHandle(row: PeopleRow): string | null {
  const account = row.accounts[0];
  if (!account) return null;
  return account.channel === "whatsapp"
    ? (formatWhatsAppPhone(account.channelUserId) ?? account.channelUserId)
    : account.channelUserId;
}

/** What the search box matches over the rows already loaded: the name, and
 *  every address the row is reachable at — so a phone number finds a contact
 *  the platform named something else. The server matches the same fields; this
 *  is the client's copy of that rule over the page it holds. */
export function rowMatchesQuery(row: PeopleRow, query: string): boolean {
  return matchesQuery(query, [
    row.displayName,
    ...row.accounts.map((account) => account.channel),
    ...row.addresses,
  ]);
}

export function searchRows(rows: readonly PeopleRow[], query: string): PeopleRow[] {
  const q = query.trim();
  if (!q) return [...rows];
  return rows.filter((row) => rowMatchesQuery(row, q));
}

/** The stream's order, and the directory's within a group: newest first, rows
 *  that have never done anything last, ties broken by name and then id so the
 *  sequence is total. The identity stream's order rather than a second one that
 *  happens to agree. */
export function compareRows(a: PeopleRow, b: PeopleRow): number {
  return compareIdentityCursors(
    { timestamp: a.latest?.timestamp ?? null, displayName: a.displayName, id: a.id },
    { timestamp: b.latest?.timestamp ?? null, displayName: b.displayName, id: b.id },
  );
}

/** Whether a row belongs to a chip's view. "all" is the placed levels: the two
 *  unplaced ends of the ladder are both entered on purpose, so neither an
 *  account waiting on a decision nor one already dismissed is the default. */
export function rowMatchesFilter(row: PeopleRow, filter: PeopleFilter): boolean {
  return filter === "all"
    ? row.level !== "unknown" && row.level !== "stranger"
    : row.level === filter;
}

/**
 * The stream: one row per identity that has a dynamic, newest first, over both
 * nouns at once.
 *
 * The reader is asking who has something new, and whether Rome has placed the
 * sender is not part of that question — so a waiting sender and a curated
 * person interleave by time rather than sitting in separate sections.
 *
 * The chip picks which of the two nouns the view is about, so it is applied
 * here as well as ridden by the request: the account directory pages, and the
 * request can only narrow it by state, while "which level of person" is the
 * people read's own parameter. Both ends narrow the same set, and this is the
 * one that holds for both nouns at once.
 *
 * A search takes over from the chip — someone typing a name wants that person
 * wherever they sit — and reaches quiet contacts, so the roster is reachable
 * from the same box.
 */
export function streamRows(
  rows: readonly PeopleRow[],
  options: { search: string; filter: PeopleFilter },
): PeopleRow[] {
  if (options.search.trim() !== "") {
    return searchRows(rows, options.search)
      .filter((row) => !isRowFixed(row))
      .sort(compareRows);
  }
  return rows
    .filter(
      (row) => row.latest !== null && !isRowFixed(row) && rowMatchesFilter(row, options.filter),
    )
    .sort(compareRows);
}

export interface PeopleGroup {
  level: RowLevel;
  rows: PeopleRow[];
}

/**
 * The directory's groups, in ladder order, after the chip, the search box and
 * the silent-contact toggle have each had their say.
 *
 * Guardian survives every filter: a roster that hid it would read as "you are
 * not in your own people list". Empty groups are dropped rather than rendered
 * as headings with nothing under them — except Unknown while the toggle is what
 * emptied it, since that heading is where the toggle lives.
 */
export function directoryGroups(
  rows: readonly PeopleRow[],
  options: { filter: PeopleFilter; search: string; showSilent: boolean },
): PeopleGroup[] {
  const searching = options.search.trim() !== "";
  const matching = searchRows(rows, options.search);
  // A search reaches the address book whatever the toggle says: a lookup that
  // answered "no such contact" for someone the mirror holds is a worse answer
  // than a long list.
  const visible = matching.filter((row) => options.showSilent || searching || !row.silent);

  return GROUP_ORDER.map((level) => ({
    level,
    rows: visible.filter((row) => row.level === level).sort(compareRows),
  })).filter((group) => {
    const chipShows =
      options.filter === "all" ? group.level !== "stranger" : group.level === options.filter;
    if (group.level === "unknown" && !searching && chipShows) return true;
    if (group.rows.length === 0) return false;
    if (searching || group.level === "guardian") return true;
    return chipShows;
  });
}

/** How many rows sit at each ladder position, over the whole roster the query
 *  admits rather than the page that arrived. */
export type LevelCounts = Record<RowLevel, number>;

/**
 * The two sets of numbers this page renders — the server's, from both reads at
 * once, and meant to disagree.
 *
 * `chips` is what a filter chip can show: what is *waiting on a decision*. A
 * contact the address book synced and nobody has ever heard from is not waiting
 * on anything, so it is not counted, whether or not the directory is currently
 * showing it.
 *
 * `totals` is what a directory heading counts: everyone in the group as the
 * roster currently stands, silent contacts included once the toggle has asked
 * for them — a heading answers "how many are in here".
 *
 * Both come off the reads rather than the loaded rows. The directory pages, so
 * a count taken over what happened to arrive would report no waiting senders
 * whenever placed people filled page one.
 *
 * A linked account is never counted twice: it is already counted under the
 * person it resolves to, which is the same rule that keeps it off the roster as
 * a row of its own.
 */
export function levelCounts(
  people: PersonCounts,
  accounts: Pick<AccountDirectory, "counts" | "silentTotal">,
  options: { includeSilent: boolean },
): { chips: LevelCounts; totals: LevelCounts } {
  const placed = {
    guardian: people.guardian,
    "inner-circle": people["inner-circle"],
    acquaintance: people.acquaintance,
    other: people.other,
    stranger: accounts.counts.dismissed,
  };
  // `counts` describes what the request admitted, so the silent contacts are in
  // it exactly when the toggle asked for them — and taking them back out is
  // what keeps the chip counting the same thing in both views.
  const waiting = accounts.counts.unlinked - (options.includeSilent ? accounts.silentTotal : 0);
  return {
    chips: { ...placed, unknown: waiting },
    totals: { ...placed, unknown: accounts.counts.unlinked },
  };
}
