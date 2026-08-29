import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, CircleAlert } from "lucide-react";
import { formatWhatsAppPhone, type TimelineEntry } from "@rome/api-types/people";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageShell, PageBody } from "@/shell/PageShell";
import { Avatar } from "./people/avatar";
import { ChannelPill } from "./people/channel-meta";
import { clockTime, dayLabel, navigatorLocale, startOfDay } from "./people/format";
import { PersonManagement } from "./people/manage";
import { usePerson, usePersonTimeline } from "./people/use-roster";

/**
 * One person's page: the dossier.
 *
 * Who they are on top — name, bond, the accounts that resolve to this person — then
 * the merged timeline of everything said on any of them, grouped by day.
 * Timeline entries are generic, so a channel Rome learns about later shows up
 * here without a change to this page.
 *
 * Two reads own it. `GET /api/people/:id` and `GET /api/people/:id/messages`:
 * one request for the person, one for the history across every account they
 * hold. Which stores that history is merged from is the server's business, and
 * a client that merged per-channel reads itself would have to re-derive the
 * ordering the cursor is written against — and would disagree with it at every
 * page boundary.
 *
 * The management gestures the design puts on this card — the bond select, Link
 * account…, Merge into… — are `people/manage.tsx`, and each settles by
 * invalidating those reads.
 */

/**
 * The route element, keyed by the person it is showing.
 *
 * Navigating from one person to another stays on this route, so React would
 * keep the same instance mounted and every piece of local state with it — now
 * sitting on somebody else's dossier. The key makes "a different person" a
 * different component, which is what it is.
 */
export default function PersonDetailPageRoute() {
  const params = useParams<{ personId: string }>();
  return <PersonDetailPage key={params.personId} personId={params.personId} />;
}

function PersonDetailPage({ personId }: { personId: string | undefined }) {
  const { t } = useTranslation("people");
  const navigate = useNavigate();

  const personQuery = usePerson(personId);
  const timeline = usePersonTimeline(personId);
  const person = personQuery.data ?? null;

  const days = useMemo(() => groupByDay(timeline.entries), [timeline.entries]);

  if (personQuery.isPending) {
    return (
      <PageShell>
        <PageBody>
          <p className="py-12 text-center text-ui text-muted-foreground">{t("page.loading")}</p>
        </PageBody>
      </PageShell>
    );
  }

  // A failed read and a person who is genuinely gone are different answers, and
  // both leave `data` undefined. Reporting a network error as "not here" tells
  // the reader the row was removed when nothing was even read, and offers no
  // way to try again.
  if (personQuery.error || !person) {
    const missing = !personQuery.error;
    return (
      <PageShell>
        <PageBody>
          <BackLink onClick={() => navigate("/people")} />
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>
              {missing ? t("detail.missingTitle") : t("errors.loadFailedTitle")}
            </AlertTitle>
            <AlertDescription>
              {missing ? t("detail.missingBody") : personQuery.error?.message}
            </AlertDescription>
          </Alert>
          {!missing && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => void personQuery.refetch()}
            >
              {t("errors.retry")}
            </Button>
          )}
        </PageBody>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageBody>
        <BackLink onClick={() => navigate("/people")} />

        <div className="flex flex-wrap items-start gap-4 rounded-14 border border-border bg-surface p-5 shadow-1">
          <Avatar name={person.displayName} tone="bg-surface-muted text-muted-foreground" />
          <div className="min-w-0 flex-1 basis-64">
            <h1 className="text-title text-foreground">{person.displayName}</h1>
            <p className="text-aux text-muted-foreground">
              {t("row.messageCount", { count: person.messageCount })}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {person.accounts.length === 0 ? (
                <span className="text-aux text-subtle-foreground">{t("detail.noAccounts")}</span>
              ) : (
                person.accounts.map((account) => (
                  <ChannelPill
                    key={`${account.channel}:${account.channelUserId}`}
                    channel={account.channel}
                  >
                    <span className="font-mono tabular-nums">
                      {account.channel === "whatsapp"
                        ? (formatWhatsAppPhone(account.channelUserId) ?? account.channelUserId)
                        : account.channelUserId}
                    </span>
                  </ChannelPill>
                ))
              )}
            </div>
          </div>
          {/* A merge ends with this person gone, so the page that had them open
              follows the account history to the survivor rather than sitting on
              a route that now 404s. */}
          <PersonManagement
            person={person}
            onMerged={(survivorId) => navigate(`/people/${encodeURIComponent(survivorId)}`)}
          />
        </div>

        <section>
          <h2 className="text-section uppercase tracking-wide text-muted-foreground">
            {t("detail.timeline")}
          </h2>
          {timeline.isPending ? (
            <p className="py-8 text-center text-aux text-muted-foreground">{t("page.loading")}</p>
          ) : timeline.error ? (
            // Same reason as the person read: "nothing has happened yet" is a
            // claim about this person, and a failed fetch has not earned it.
            <div className="py-4">
              <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>{t("errors.loadFailedTitle")}</AlertTitle>
                <AlertDescription>{timeline.error.message}</AlertDescription>
              </Alert>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void timeline.refetch()}
              >
                {t("errors.retry")}
              </Button>
            </div>
          ) : days.length === 0 ? (
            <p className="py-8 text-center text-aux text-subtle-foreground">
              {t("detail.timelineEmpty")}
            </p>
          ) : (
            days.map((day) => (
              <div key={day.dayStart}>
                <h3 className="mt-5 mb-1 text-badge uppercase tracking-wide text-subtle-foreground">
                  {dayLabel(t, day.dayStart, navigatorLocale())}
                </h3>
                {day.entries.map((entry) => (
                  <div
                    key={`${entry.source}:${entry.ref}`}
                    className="grid grid-cols-[auto_1fr_auto] items-baseline gap-3 border-b border-border-subtle px-2 py-2"
                  >
                    <ChannelPill channel={entry.source} />
                    <p className="min-w-0 text-ui text-foreground">
                      {entry.direction === "outbound" && (
                        <span className="text-subtle-foreground">
                          {t("detail.outboundPrefix")}{" "}
                        </span>
                      )}
                      <span
                        className={entry.direction === "outbound" ? "text-muted-foreground" : ""}
                      >
                        {entry.body ?? t("row.noPreview")}
                      </span>
                    </p>
                    <span className="font-mono text-badge tabular-nums text-subtle-foreground">
                      {clockTime(entry.timestamp, navigatorLocale())}
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
          {timeline.hasNextPage && (
            <div className="flex justify-center pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={timeline.isFetchingNextPage}
                onClick={() => void timeline.fetchNextPage()}
              >
                {t("detail.loadOlder")}
              </Button>
            </div>
          )}
        </section>
      </PageBody>
    </PageShell>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation("people");
  return (
    <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onClick}>
      <ArrowLeft aria-hidden="true" />
      {t("detail.back")}
    </Button>
  );
}

interface TimelineDay {
  dayStart: number;
  entries: TimelineEntry[];
}

/** Entries arrive newest first and stay that way inside each day, so the page
 *  reads top-down as "most recent first" at both levels. */
function groupByDay(entries: TimelineEntry[]): TimelineDay[] {
  const days: TimelineDay[] = [];
  for (const entry of entries) {
    const dayStart = startOfDay(entry.timestamp);
    const current = days.at(-1);
    if (current && current.dayStart === dayStart) current.entries.push(entry);
    else days.push({ dayStart, entries: [entry] });
  }
  return days;
}
