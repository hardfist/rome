import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilterChipGroup } from "@/components/ui/filter-chip-group";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useInvalidatePeople } from "@/hooks/use-people";
import { PageShell, PageBody } from "@/shell/PageShell";
import { DirectoryRow, StreamRow, levelLabelKey } from "./people/rows";
import { UnknownEntry } from "./people/triage";
import {
  directoryGroups,
  FILTER_ORDER,
  levelCounts,
  streamRows,
  type PeopleFilter,
  type PeopleRow,
  type PeopleView,
  type RowLevel,
} from "./people/people-model";
import { usePeopleRoster } from "./people/use-roster";
import { LinkedInSection } from "./people/linkedin";

/**
 * The People page: an activity stream and a roster, over two reads.
 *
 * Latest answers "who has something new" — one row per identity with a
 * dynamic, newest first, carrying only what routing needs. Directory answers
 * "who does Rome know" — everyone grouped by bond. Unknown and Stranger are
 * positions on the same ladder as the curated levels, so an account waiting on
 * a decision and a person the guardian placed sit in one list rather than in
 * sections that cannot say where either stands relative to the other.
 *
 * The contract is two nouns and this page is one ladder over both: `GET
 * /api/people` for the people, `GET /api/accounts` for every account Rome has
 * observed, joined in `people-model.ts`. A person's history is a third read,
 * `GET /api/people/:id/messages`, and it belongs to the person page.
 *
 * Every number on screen is the server's. The directory pages, so a count taken
 * over the rows that happened to arrive would report no waiting senders as soon
 * as placed people filled page one.
 */

/** The chips whose level the people read can be narrowed by: the levels a
 *  person row actually holds. Unknown and Stranger are account states, and the
 *  account read is narrowed by those instead. */
const PLACED_FILTERS = new Set<PeopleFilter>(["inner-circle", "acquaintance", "other"]);

/** The one-line reading of what each bond level means for Rome's behavior,
 *  sitting beside its group heading. */
const LEVEL_HINT_KEY: Partial<Record<RowLevel, string>> = {
  "inner-circle": "levelHints.innerCircle",
  acquaintance: "levelHints.acquaintance",
  other: "levelHints.other",
  stranger: "levelHints.stranger",
};

export default function PeoplePage() {
  const { t } = useTranslation("people");
  const { t: tCommon } = useTranslation("common");
  const navigate = useNavigate();
  // A placement changes who Rome knows, so the one shared people cache — the
  // composer's mention list reads it — is invalidated alongside this page's own
  // refetch rather than left to its own staleness window.
  const invalidatePeople = useInvalidatePeople();

  const [view, setView] = useState<PeopleView>("latest");
  const [filter, setFilter] = useState<PeopleFilter>("all");
  const [search, setSearch] = useState("");
  const [showSilent, setShowSilent] = useState(false);

  // The directory shows the address book behind its own toggle; the stream
  // never does, and a search reaches it either way — the endpoint's own rule.
  //
  // The chip rides the requests in the stream, where a level is the whole view:
  // an account state is what the directory read can narrow by, a bond level is
  // what the people read can. The directory view renders every group at once,
  // so it sends neither — a level on the request would leave the other headings
  // with nothing to show.
  const roster = usePeopleRoster({
    search,
    includeSilent: view === "directory" && showSilent,
    accountState: view === "directory" ? null : filter === "stranger" ? "dismissed" : "unlinked",
    personLevel: view === "directory" || !PLACED_FILTERS.has(filter) ? null : filter,
  });
  const rows = roster.rows;

  // Derived from the term the loaded rows answer, not the one in the box: the
  // box runs ahead of the request by a debounce, and filtering this page by a
  // term it was not fetched for empties it for exactly the contacts only the
  // server's search can reach.
  const settled = roster.settledSearch;
  const latest = useMemo(
    () => streamRows(rows, { search: settled, filter }),
    [rows, settled, filter],
  );
  const groups = useMemo(
    () => directoryGroups(rows, { filter, search: settled, showSilent }),
    [rows, filter, settled, showSilent],
  );
  const counts = useMemo(
    () => levelCounts(roster.peopleCounts, { counts: roster.accountCounts }),
    [roster.peopleCounts, roster.accountCounts],
  );
  // A link lands on a person, so the picker offers the people this read
  // returned rather than the accounts beside them.
  const linkTargets = useMemo(
    () =>
      rows
        .filter((row) => row.kind === "person" && row.level !== "guardian")
        .map((row) => ({
          id: row.id,
          displayName: row.displayName,
          bondLevel: row.level,
          accounts: row.accounts,
          messageCount: row.messageCount,
          latest: row.latest,
        })),
    [rows],
  );

  // Only a person has a dossier: a dossier is a merged history, and a history
  // is what a person has. An account nobody has placed carries its evidence on
  // its own row instead.
  const openRow = (row: PeopleRow) => {
    if (row.kind === "person") navigate(`/people/${encodeURIComponent(row.id)}`);
  };

  const loading = roster.isPending;
  const loadError = roster.error ? roster.error.message : null;

  const triage = (row: PeopleRow) => (
    <UnknownEntry
      key={row.id}
      row={row}
      people={linkTargets}
      onSettled={() => {
        void roster.refetch();
        void invalidatePeople();
      }}
    />
  );

  return (
    <PageShell>
      <PageBody>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-title text-foreground">{tCommon("nav.people")}</h1>
            <p className="mt-1 text-aux text-muted-foreground">{t("page.subtitle")}</p>
          </div>
          {/* Both of this page's one-of-N controls are the kit's radiogroups
              rather than buttons wearing `role="radio"`: Radix supplies the
              roving focus and arrow-key movement the role promises, which a row
              of tab stops does not have. */}
          <SegmentedControl<PeopleView>
            aria-label={t("views.label")}
            value={view}
            onValueChange={setView}
            options={[
              { value: "latest", label: t("views.latest") },
              { value: "directory", label: t("views.directory") },
            ]}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("search.placeholder")}
            aria-label={t("search.label")}
            className="w-full sm:w-72"
          />
          <FilterChipGroup<PeopleFilter>
            aria-label={t("filters.groupLabel")}
            value={filter}
            onValueChange={setFilter}
            className="flex-1"
            options={FILTER_ORDER.map((option) => ({
              value: option,
              label: option === "all" ? t("filters.all") : t(levelLabelKey(option)),
              // Unknown is the page's one number that asks for a decision, so
              // it carries a count; the other chips are plain labels.
              count: option === "unknown" && counts.unknown > 0 ? counts.unknown : undefined,
            }))}
          />
        </div>

        {/* A read that failed while rows are on screen: say so instead of
            leaving stale content passing for live. `keepPreviousData` holds the
            previous page through a refetch, which is what stops the list
            blanking on every keystroke — and would otherwise let a failed
            search or chip swallow its error, because the branch below only
            reports one when there is nothing to show. */}
        {loadError && rows.length > 0 && (
          <p className="flex flex-wrap items-center justify-center gap-2 rounded-8 bg-destructive-bg px-4 py-1 text-center text-aux text-destructive-fg">
            {loadError}
            <button
              type="button"
              onClick={() => void roster.refetch()}
              className="underline underline-offset-2 hover:no-underline"
            >
              {t("errors.retry")}
            </button>
          </p>
        )}

        {loading && rows.length === 0 ? (
          <p className="py-12 text-center text-ui text-muted-foreground">{t("page.loading")}</p>
        ) : loadError && rows.length === 0 ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{t("errors.loadFailedTitle")}</AlertTitle>
            <AlertDescription>
              <p>{loadError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void roster.refetch()}
              >
                <RefreshCw aria-hidden="true" />
                {t("errors.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : view === "latest" ? (
          <LatestView
            rows={latest}
            searching={settled !== ""}
            onOpen={openRow}
            renderUnknown={triage}
          />
        ) : (
          <DirectoryView
            groups={groups}
            counts={counts}
            showSilent={showSilent}
            silentTotal={roster.silentTotal}
            onToggleSilent={setShowSilent}
            onOpen={openRow}
            renderUnknown={triage}
          />
        )}

        {roster.hasNextPage && (
          <div className="flex justify-center pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={roster.isFetchingNextPage}
              onClick={() => void roster.fetchNextPage()}
            >
              {t("page.loadMore")}
            </Button>
          </div>
        )}

        {/* LinkedIn threads are mirrored conversations, not accounts: they
            never reach `/api/accounts`, so neither view above can render them.
            The section sits below both until a LinkedIn account can be linked
            to a person, at which point it goes away with its module. */}
        <LinkedInSection />
      </PageBody>
    </PageShell>
  );
}

/** The stream. Accounts nobody has placed are dense — the placement decision
 *  runs on their evidence — and every other row is lean. */
function LatestView({
  rows,
  searching,
  onOpen,
  renderUnknown,
}: {
  rows: PeopleRow[];
  searching: boolean;
  onOpen: (row: PeopleRow) => void;
  renderUnknown: (row: PeopleRow) => React.ReactNode;
}) {
  const { t } = useTranslation("people");
  if (rows.length === 0) {
    return (
      <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-10 text-center">
        <p className="text-ui text-muted-foreground">
          {searching ? t("page.emptyForSearch") : t("page.emptyTitle")}
        </p>
        {!searching && (
          <p className="mt-1 text-aux text-subtle-foreground">{t("page.emptyHint")}</p>
        )}
      </div>
    );
  }

  return (
    <section>
      <div className="flex items-baseline gap-2 border-b border-border pb-1">
        <h2 className="text-section uppercase tracking-wide text-muted-foreground">
          {t("views.latest")}
        </h2>
        <span className="ml-auto text-badge text-subtle-foreground">
          {searching ? t("stream.searchHint") : t("stream.hint")}
        </span>
      </div>
      <div className="flex flex-col">
        {rows.map((row) =>
          row.level === "unknown" ? (
            renderUnknown(row)
          ) : (
            <StreamRow
              key={row.id}
              row={row}
              onOpen={row.kind === "person" ? () => onOpen(row) : undefined}
            />
          ),
        )}
      </div>
    </section>
  );
}

function DirectoryView({
  groups,
  counts,
  showSilent,
  silentTotal,
  onToggleSilent,
  onOpen,
  renderUnknown,
}: {
  groups: { level: RowLevel; rows: PeopleRow[] }[];
  counts: Record<RowLevel, number>;
  showSilent: boolean;
  /** How many silent contacts the directory holds, whether or not this view is
   *  currently carrying them. */
  silentTotal: number;
  onToggleSilent: (value: boolean) => void;
  onOpen: (row: PeopleRow) => void;
  renderUnknown: (row: PeopleRow) => React.ReactNode;
}) {
  const { t } = useTranslation("people");
  if (groups.length === 0) {
    return (
      <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-10 text-center">
        <p className="text-ui text-muted-foreground">{t("page.emptyForSearch")}</p>
      </div>
    );
  }

  return (
    <>
      {groups.map((group) => (
        <section key={group.level}>
          <div className="flex flex-wrap items-baseline gap-2 border-b border-border pb-1">
            <h2 className="text-section uppercase tracking-wide text-muted-foreground">
              {t(levelLabelKey(group.level))}
            </h2>
            {/* The server's total for the level, not the rows on screen: the
                directory pages, and a heading that counted what had loaded
                would read as a roster that shrank. */}
            <span className="font-mono text-badge tabular-nums text-subtle-foreground">
              {counts[group.level]}
            </span>
            {/* The toggle is always on the Unknown heading: the endpoint holds
                silent contacts back until it is on, so the page cannot count
                what it has not been sent. */}
            {group.level === "unknown" ? (
              <label className="ml-auto flex items-center gap-2 text-badge text-muted-foreground">
                <input
                  type="checkbox"
                  checked={showSilent}
                  onChange={(e) => onToggleSilent(e.target.checked)}
                  className="accent-primary"
                />
                {/* The number is what the toggle is deciding about, and it is a
                    directory-wide total rather than a page one — so it reads
                    the same whether those rows are on screen or held back. */}
                {silentTotal > 0
                  ? t("unknown.includeSilentCount", { count: silentTotal })
                  : t("unknown.includeSilent")}
              </label>
            ) : (
              LEVEL_HINT_KEY[group.level] && (
                <span className="ml-auto text-badge text-subtle-foreground">
                  {t(LEVEL_HINT_KEY[group.level]!)}
                </span>
              )
            )}
          </div>
          <div className="flex flex-col">
            {group.rows.map((row) =>
              row.level === "unknown" ? (
                renderUnknown(row)
              ) : (
                <DirectoryRow
                  key={row.id}
                  row={row}
                  onOpen={row.kind === "person" ? () => onOpen(row) : undefined}
                />
              ),
            )}
          </div>
        </section>
      ))}
    </>
  );
}
