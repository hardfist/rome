import { useEffect, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  AccountDirectory,
  AccountState,
  PeopleList,
  PersonResource,
} from "@rome/api-types/people";
import type { TimelinePage } from "@rome/api-types/identities";
import { getApiErrorMessage } from "@/lib/api-error";
import { fetchJson } from "@/lib/fetch-json";
import { peopleRows, type PeopleRow } from "./people-model";

// The People page's reads, and nothing else — the writes are still the legacy
// `/api/persons/*` routes and move in rome-os/rome#67.
//
// Named for the roster rather than for people: `@/hooks/use-people` is the one
// shared people cache the composer's mention list reads, and these are this
// page's own paged reads. Two hooks with one name would be read as one.
//
// Two reads compose the roster: `GET /api/people` for the people the guardian
// has placed, `GET /api/accounts` for every account Rome has observed. They are
// separate queries rather than one, because they page differently: curated
// people are entered one at a time by hand and the listing is bounded, while a
// synced address book is thousands of rows and pages by cursor.
//
// Every number a chip or a heading shows comes back with these reads and
// describes the whole roster the query admits. A tally over the rows that
// happened to arrive would report no waiting senders whenever placed people
// filled page one.

const PEOPLE_KEY = "people";
const ACCOUNTS_KEY = "accounts";
const TIMELINE_KEY = "person-timeline";

const ROSTER_POLL_MS = 30_000;

/**
 * An open dossier's poll — the roster's cadence, not a faster one.
 *
 * A refetch of a paged read refetches *every page it holds*, so the cost of
 * this interval is one request per page the reader has opened: a dossier paged
 * six pages back costs six requests a tick, re-reading history that cannot have
 * changed. At four seconds that is ninety requests a minute to catch a message
 * that has not arrived.
 *
 * Four seconds is what a page with a composer needs, and for a specific reason:
 * a WhatsApp send returns once the adapter accepted the text, not once the echo
 * that stores it lands, so the reader is waiting on a line they just typed.
 * This page has no composer — the writes are rome-os/rome#67 — so nothing here
 * is waiting on a write of its own, and when the composer returns it can
 * invalidate this query at the moment of the send rather than have every reader
 * pay a fast poll for it.
 */
const TIMELINE_POLL_MS = ROSTER_POLL_MS;

// How long the search box settles before its term reaches the wire. Long enough
// that a typed word is one request rather than one per letter, short enough
// that the pause is not read as the page having stopped.
const SEARCH_DEBOUNCE_MS = 250;

/** A value that only changes once it has held still for `delayMs`. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export interface PeopleRosterParams {
  search: string;
  /** Whether the account directory carries the contacts nobody has ever
   *  messaged. The toggle governs browsing; a search reaches them either way,
   *  which is the endpoint's own rule. */
  includeSilent: boolean;
  /**
   * Which state of account the view is about, when one narrows it.
   *
   * Sent to the endpoint rather than applied to the rows: the directory pages,
   * and a chip that filtered the rows already loaded would show only the
   * matches that happened to land on page one. Null asks for every state at
   * once, which is what the directory view renders.
   */
  accountState?: AccountState | null;
  /**
   * Which bond level the view is about, on the people read's own parameter.
   * Null asks for every level — the directory renders each as its own group,
   * and a level on the request would leave the other headings with nothing.
   */
  personLevel?: string | null;
}

/**
 * The roster: both reads, joined into one list of rows.
 *
 * The search term rides both query keys, so what the page shows is the server's
 * answer for the box rather than a filter over whichever page arrived first.
 * `keepPreviousData` holds the previous answer on screen while the next one
 * loads — which is what stops the list blanking on every keystroke, and is why
 * callers filter by {@link PeopleRoster.settledSearch} rather than by what is
 * in the box.
 */
export function usePeopleRoster(params: PeopleRosterParams) {
  const { t } = useTranslation("people");
  const fallback = t("errors.loadFailedFallback");
  // Only the typed term waits. A chip or a toggle is one deliberate click and
  // answers at once.
  const search = useDebounced(params.search.trim(), SEARCH_DEBOUNCE_MS);

  // A search takes over from the chip: someone typing a name wants that person
  // wherever they sit on the ladder. Both halves move off the one settled term,
  // so the level is dropped in step with the request that carries it rather
  // than a debounce ahead of it.
  const personLevel = search ? null : (params.personLevel ?? null);
  const accountState = search ? null : (params.accountState ?? null);

  const people = useQuery<PeopleList>({
    queryKey: [PEOPLE_KEY, search, personLevel],
    refetchInterval: ROSTER_POLL_MS,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => {
      const query = new URLSearchParams();
      if (search) query.set("q", search);
      if (personLevel) query.set("level", personLevel);
      const suffix = query.toString();
      return fetchJson<PeopleList>(`/api/people${suffix ? `?${suffix}` : ""}`, {
        signal,
        fallback,
      });
    },
  });

  // The directory pages; the people listing does not. Its cursor is opaque and
  // names a position rather than a row, so a page boundary survives an account
  // being linked or dismissed between two requests.
  const accounts = useInfiniteQuery<AccountDirectory>({
    queryKey: [ACCOUNTS_KEY, search, params.includeSilent, accountState],
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: ROSTER_POLL_MS,
    placeholderData: keepPreviousData,
    queryFn: ({ signal, pageParam }) => {
      const query = new URLSearchParams();
      if (search) query.set("q", search);
      if (accountState) query.set("state", accountState);
      if (params.includeSilent) query.set("includeSilent", "true");
      if (pageParam) query.set("cursor", String(pageParam));
      const suffix = query.toString();
      return fetchJson<AccountDirectory>(`/api/accounts${suffix ? `?${suffix}` : ""}`, {
        signal,
        fallback,
      });
    },
  });

  const accountPages = accounts.data?.pages ?? [];
  // Counts are whole-directory answers, identical on every page of one query;
  // the first page that arrived carries them.
  const head = accountPages[0];
  const rows: PeopleRow[] = peopleRows(
    people.data?.people ?? [],
    accountPages.flatMap((page) => page.accounts),
  );

  return {
    rows,
    /** The per-level numbers the chips and the group headings show. */
    peopleCounts: people.data?.counts ?? {
      all: 0,
      guardian: 0,
      "inner-circle": 0,
      acquaintance: 0,
      other: 0,
    },
    accountCounts: head?.counts ?? { unlinked: 0, linked: 0, dismissed: 0 },
    /** Every matching silent account, whether or not the toggle let them onto
     *  the page — the number the toggle itself offers. */
    silentTotal: head?.silentTotal ?? 0,
    /** The term these rows answer. A caller filtering or labelling them reads
     *  this rather than what is in the box, or it applies a term the rows were
     *  not fetched for and empties the view for exactly the quiet contacts only
     *  the server's search can reach. */
    settledSearch: search,
    isPending: people.isPending || accounts.isPending,
    error: (people.error ?? accounts.error) as Error | null,
    hasNextPage: accounts.hasNextPage,
    isFetchingNextPage: accounts.isFetchingNextPage,
    fetchNextPage: accounts.fetchNextPage,
    refetch: async () => {
      await Promise.all([people.refetch(), accounts.refetch()]);
    },
  };
}

export type PeopleRoster = ReturnType<typeof usePeopleRoster>;

/**
 * One person by id — what lets the dossier open a person the roster has not
 * paged to.
 *
 * A 404 answers null rather than throwing: "there is no such person" and "the
 * read failed" are different answers, and both would otherwise leave `data`
 * undefined. Reporting a network error as "merged away" tells the reader a
 * write landed when nothing was even read, and offers no way to try again.
 */
export function usePerson(id: string | undefined) {
  const { t } = useTranslation("people");
  const fallback = t("errors.loadFailedFallback");
  return useQuery<PersonResource | null>({
    queryKey: [PEOPLE_KEY, "one", id],
    enabled: id != null,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/people/${encodeURIComponent(id!)}`, {
        signal,
        credentials: "include",
        cache: "no-store",
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(await getApiErrorMessage(response, fallback));
      return (await response.json()) as PersonResource;
    },
  });
}

/**
 * One person's history across every account they hold, newest first.
 *
 * One request rather than one per channel: which stores a history is merged
 * from is the server's business, and a client that merged per-channel reads
 * would have to re-derive the ordering the cursor is written against — and
 * would disagree with it at every page boundary.
 *
 * The poll is what makes a send appear: the WhatsApp send route returns once
 * the adapter has accepted the text, not once the echo has been mirrored, so a
 * refetch fired at send time almost always reads a timeline that does not have
 * the message yet.
 */
export function usePersonTimeline(id: string | undefined) {
  const { t } = useTranslation("people");
  const query = useInfiniteQuery<TimelinePage>({
    queryKey: [TIMELINE_KEY, id],
    enabled: id != null,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: TIMELINE_POLL_MS,
    queryFn: ({ signal, pageParam }) => {
      // The cursor names an exact entry (time, direction, source, ref), so it
      // carries separators of its own and has to be escaped rather than pasted
      // into the query string.
      const search = pageParam ? `?cursor=${encodeURIComponent(String(pageParam))}` : "";
      return fetchJson<TimelinePage>(`/api/people/${encodeURIComponent(id!)}/messages${search}`, {
        signal,
        fallback: t("errors.loadFailedFallback"),
      });
    },
  });
  return { ...query, entries: query.data?.pages.flatMap((page) => page.entries) ?? [] };
}
