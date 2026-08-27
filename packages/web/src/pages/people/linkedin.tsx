import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  CheckCheck,
  CircleAlert,
  Clock,
  MessageCircle,
  RefreshCw,
  Send,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson } from "@/lib/fetch-json";
import { Avatar } from "./avatar";
import { ChannelGlyph } from "./channel-meta";
import { clockTime, dayLabel, navigatorLocale, startOfDay, timeAgo } from "./format";
import type { LinkedInMessage, LinkedInThread } from "./legacy-api-shapes";

/**
 * The LinkedIn mirror, carried onto the rebuilt People page.
 *
 * LinkedIn reaches Rome through the connection's inbox poller, which fills its
 * own `linkedin_threads`/`linkedin_messages` tables. Those rows are not
 * identities and do not appear in `/api/identities`, so nothing above this
 * section can render them: the stream, the directory and the person page all
 * read the identity union. Until a LinkedIn account can be linked to an
 * identity, this section is the only way the mirror is visible at all, so it
 * survives the rewrite as its own module rather than being deleted with the
 * WhatsApp surface the person page did supersede.
 *
 * Everything here is lifted from the pre-rewrite page unchanged in behavior —
 * the same endpoints, the same states, the same optimistic reply. It is meant
 * to be deleted whole once LinkedIn threads resolve to identities.
 */

// The mirror refreshes on the poller's 15–30 minute cadence, so the dialog's
// poll only needs to catch a sync landing while it happens to be open.
const LINKEDIN_MESSAGE_POLL_MS = 30_000;

// Neutral, like every other avatar on this page: a channel is a glyph here,
// never a color.
const AVATAR_TONE = "bg-surface-muted text-muted-foreground";

type SendStatus = "sending" | "sent" | "failed";

interface LinkedInChatMessage extends LinkedInMessage {
  status?: SendStatus;
}

function threadName(thread: LinkedInThread): string {
  return thread.personName || thread.conversationName || "LinkedIn conversation";
}

/**
 * The thread's own URL, if it is one a browser may be sent to.
 *
 * Everything in this module is mirrored from LinkedIn through the connection's
 * poller, and this value lands in an `href` — where a `javascript:` or `data:`
 * URI would run on click rather than navigate. The mirror is not a trusted
 * author, so the scheme is checked here rather than assumed upstream.
 */
export function openableHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    // Not absolute, so not something to open. A relative href would resolve
    // against the dashboard's own origin, which is never where a thread lives.
    return null;
  }
}

// A successful safe-send appears in the mirror on a later inbox sync. Keep its
// local bubble until an equivalent server row arrives, then let the durable row
// take over. Failed replies remain available for retry.
export function reconcileLinkedInPending(
  server: LinkedInMessage[],
  pending: LinkedInChatMessage[],
): LinkedInChatMessage[] {
  const used = new Set<string>();
  return pending.filter((p) => {
    if (p.status === "failed") return true;
    const match = server.find(
      (m) =>
        m.senderIsSelf &&
        !used.has(m.messageId) &&
        (m.text ?? "") === (p.text ?? "") &&
        m.timestamp >= p.timestamp - 120,
    );
    if (match) used.add(match.messageId);
    return !match;
  });
}

function StatusTicks({ status }: { status?: SendStatus }) {
  if (status === "sending") return <Clock className="size-3 opacity-60" aria-hidden="true" />;
  if (status === "failed")
    return <AlertCircle className="size-3 text-destructive" aria-hidden="true" />;
  return <CheckCheck className="size-3.5 opacity-60" aria-hidden="true" />;
}

function DateSeparator({ label }: { label: string }) {
  return (
    <div className="my-2 flex justify-center">
      <span className="rounded-8 bg-surface/90 px-2 py-1 text-badge text-muted-foreground shadow-1 ring-1 ring-inset ring-border-subtle">
        {label}
      </span>
    </div>
  );
}

function LinkedInComposer({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("people");
  const [text, setText] = useState("");
  const placeholder = t("linkedin.composerPlaceholder");

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex items-end gap-2 border-t border-border bg-surface px-3 py-2"
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder={placeholder}
        aria-label={placeholder}
        className="max-h-32 min-h-[var(--control-h-md)] flex-1 resize-none rounded-16 bg-surface-muted py-2"
      />
      <IconButton
        type="submit"
        disabled={disabled || !text.trim()}
        label={t("linkedin.send")}
        icon={<Send aria-hidden="true" />}
        // Hover reads the border step because this family has no `-hover-bg`.
        // It moves the fill away from the canvas in both modes — darker in
        // light, lighter in dark — which is the direction the families that do
        // have the step take.
        className="rounded-full border border-info-border bg-info-bg text-info-fg shadow-1 hover:bg-info-border"
      />
    </form>
  );
}

function LinkedInBubble({
  message,
  firstInGroup,
  showSender,
  onRetry,
}: {
  message: LinkedInChatMessage;
  firstInGroup: boolean;
  showSender: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation("people");
  const mine = message.senderIsSelf;
  const failed = message.status === "failed";
  const tail = firstInGroup ? (mine ? "rounded-tr-4" : "rounded-tl-4") : "";
  return (
    <div
      className={`flex ${mine ? "justify-end" : "justify-start"} ${firstInGroup ? "mt-2" : "mt-1"}`}
    >
      <div
        // `role="button"` promises Enter and Space, and an element that takes
        // focus and then answers neither is the one way this is worse than not
        // being focusable at all.
        {...(onRetry
          ? {
              role: "button" as const,
              tabIndex: 0,
              onClick: onRetry,
              onKeyDown: (event: React.KeyboardEvent) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                // Space scrolls the thread otherwise, which moves the message
                // out from under the reader as they retry it.
                event.preventDefault();
                onRetry();
              },
              title: t("linkedin.sendFailed"),
            }
          : {})}
        className={`relative max-w-[80%] rounded-12 px-2 py-1 text-body shadow-1 ${tail} ${
          mine
            ? "bg-info-bg text-info-fg"
            : "bg-surface text-foreground ring-1 ring-inset ring-border-subtle"
        } ${failed ? "cursor-pointer ring-1 ring-inset ring-destructive-border" : ""}`}
      >
        {showSender && message.senderName && (
          <p className="mb-1 max-w-56 truncate text-badge text-info-fg">{message.senderName}</p>
        )}
        {message.subject && <p className="break-words pr-1 font-medium">{message.subject}</p>}
        {message.text && <p className="whitespace-pre-wrap break-words pr-1">{message.text}</p>}
        <span
          className={`float-right ml-2 mt-1 flex translate-y-0.5 items-center gap-1 text-aux tabular-nums ${
            mine ? "text-info-fg/70" : "text-subtle-foreground"
          }`}
        >
          {message.reactionCount != null && message.reactionCount > 0 && (
            <span aria-hidden="true">👍 {message.reactionCount}</span>
          )}
          {clockTime(message.timestamp, navigatorLocale())}
          {mine && <StatusTicks status={message.status} />}
        </span>
        <span className="clear-both block" />
      </div>
    </div>
  );
}

function LinkedInMessagesDialog({
  thread,
  open,
  onClose,
}: {
  thread: LinkedInThread;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("people");
  const scrollRef = useRef<HTMLDivElement>(null);
  const localSeq = useRef(0);
  const [pending, setPending] = useState<LinkedInChatMessage[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const title = threadName(thread);
  // Only the API's own flag decides group-ness — conversationName is a display
  // title, and a legacy row may carry counterparty names there. Unknown (null,
  // thread not yet snapshotted) renders as 1:1: no bogus badges or labels.
  const isGroup = thread.isGroup === true;

  const messagesQuery = useQuery<LinkedInMessage[]>({
    queryKey: ["linkedin-messages", thread.threadId],
    enabled: open,
    refetchInterval: LINKEDIN_MESSAGE_POLL_MS,
    queryFn: ({ signal }) =>
      fetchJson<LinkedInMessage[]>(
        `/api/linkedin/threads/${encodeURIComponent(thread.threadId)}/messages?limit=100`,
        { signal, fallback: t("errors.messagesFailed") },
      ),
  });
  const serverMessages = messagesQuery.data ?? null;
  const loading = messagesQuery.isPending;
  const loadError = messagesQuery.error ? messagesQuery.error.message : null;
  const reload = messagesQuery.refetch;

  useEffect(() => {
    if (!open) return;
    setPending([]);
    setSendError(null);
  }, [open]);

  useEffect(() => {
    if (!messagesQuery.data) return;
    setPending((prev) => reconcileLinkedInPending(messagesQuery.data, prev));
  }, [messagesQuery.data]);

  const messages: LinkedInChatMessage[] = useMemo(
    () => [...(serverMessages ?? []), ...pending],
    [serverMessages, pending],
  );
  const hasMessages = messages.length > 0;
  const sending = pending.some((message) => message.status === "sending");

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, open]);

  const sendText = useCallback(
    async (text: string) => {
      const id = `local-linkedin-${localSeq.current++}`;
      const optimistic: LinkedInChatMessage = {
        messageId: id,
        senderName: null,
        senderHeadline: null,
        senderProfileUrl: null,
        senderIsSelf: true,
        timestamp: Math.floor(Date.now() / 1000),
        text,
        subject: null,
        reactionCount: null,
        status: "sending",
      };
      setPending((prev) => [...prev, optimistic]);
      setSendError(null);

      const res = await fetch(`/api/linkedin/threads/${encodeURIComponent(thread.threadId)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ text }),
      }).catch(() => null);

      if (!res || !res.ok) {
        let message = t("linkedin.sendFailed");
        if (res?.status === 503) {
          message = t("linkedin.notConnected");
        } else if (res) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          if (body?.error) message = body.error;
        }
        setSendError(message);
        setPending((prev) =>
          prev.map((m) => (m.messageId === id ? { ...m, status: "failed" } : m)),
        );
        return;
      }

      setPending((prev) => prev.map((m) => (m.messageId === id ? { ...m, status: "sent" } : m)));
      setTimeout(() => void reload(), 1_200);
    },
    [reload, t, thread.threadId],
  );

  const retry = useCallback(
    (message: LinkedInChatMessage) => {
      setPending((prev) =>
        prev.filter((pendingMessage) => pendingMessage.messageId !== message.messageId),
      );
      void sendText(message.text ?? "");
    },
    [sendText],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      ariaLabel={t("linkedin.dialogTitle", { name: title })}
    >
      <DialogHeader onClose={onClose} closeLabel={t("actions.close")}>
        <div className="flex items-center gap-3">
          <Avatar name={title} tone={AVATAR_TONE} />
          <div className="min-w-0">
            <DialogTitle className="truncate text-body">{title}</DialogTitle>
            {/* No link at all rather than a dead one: a thread whose URL did
                not survive the check has nothing to open. */}
            {openableHref(thread.threadUrl) && (
              <a
                href={openableHref(thread.threadUrl)!}
                target="_blank"
                rel="noreferrer"
                className="truncate text-aux text-muted-foreground underline-offset-2 hover:underline"
              >
                {t("linkedin.openInLinkedIn")}
              </a>
            )}
          </div>
        </div>
      </DialogHeader>

      <div
        ref={scrollRef}
        className="flex h-[58vh] flex-col overflow-y-auto bg-surface-muted px-4 py-3"
      >
        {loading && serverMessages === null ? (
          <p className="m-auto text-ui text-muted-foreground">{t("linkedin.loading")}</p>
        ) : loadError && !hasMessages ? (
          <div className="m-auto text-center">
            <p className="text-ui text-destructive">{loadError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void reload()}
            >
              <RefreshCw aria-hidden="true" />
              {t("errors.retry")}
            </Button>
          </div>
        ) : !hasMessages ? (
          <div className="m-auto text-center">
            <p className="text-ui text-muted-foreground">{t("linkedin.noMessages")}</p>
            <p className="mt-1 text-aux text-subtle-foreground">{t("linkedin.noMessagesHint")}</p>
          </div>
        ) : (
          messages.map((m, i) => {
            const prev = i > 0 ? messages[i - 1] : undefined;
            const dayStart = startOfDay(m.timestamp);
            const showDate = !prev || startOfDay(prev.timestamp) !== dayStart;
            const senderChanged =
              !prev ||
              prev.senderIsSelf !== m.senderIsSelf ||
              (isGroup && prev.senderName !== m.senderName);
            const firstInGroup = showDate || senderChanged;
            return (
              <div key={m.messageId}>
                {showDate && <DateSeparator label={dayLabel(t, dayStart, navigatorLocale())} />}
                <LinkedInBubble
                  message={m}
                  firstInGroup={firstInGroup}
                  showSender={isGroup && !m.senderIsSelf && firstInGroup}
                  onRetry={m.status === "failed" ? () => retry(m) : undefined}
                />
              </div>
            );
          })
        )}
      </div>

      {/* A poll that failed while messages are on screen: say so instead of
          leaving stale content passing for live. */}
      {loadError && hasMessages && (
        <p className="flex items-center justify-center gap-2 bg-destructive-bg px-4 py-1 text-center text-aux text-destructive-fg">
          {loadError}
          <button
            type="button"
            onClick={() => void reload()}
            className="underline underline-offset-2 hover:no-underline"
          >
            {t("errors.retry")}
          </button>
        </p>
      )}

      {sendError && (
        <p className="bg-destructive-bg px-4 py-1 text-center text-aux text-destructive-fg">
          {sendError}
        </p>
      )}

      <LinkedInComposer onSend={sendText} disabled={sending} />
    </Dialog>
  );
}

function LinkedInThreadCard({ thread }: { thread: LinkedInThread }) {
  const { t } = useTranslation("people");
  const [showMessages, setShowMessages] = useState(false);
  const name = threadName(thread);
  const isGroup = thread.isGroup === true;

  return (
    <article className="relative overflow-hidden rounded-12 border border-border bg-surface p-4 shadow-1">
      <div className="flex items-start gap-3">
        <Avatar name={name} tone={AVATAR_TONE} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-ui text-foreground">{name}</span>
            {thread.unread && (
              <span className="inline-flex items-center rounded-full bg-info-bg px-2 py-1 text-badge text-info-fg ring-1 ring-inset ring-info-border">
                {t("linkedin.unread")}
              </span>
            )}
            {isGroup && (
              <span className="inline-flex items-center rounded-full bg-surface-muted px-2 py-1 text-badge text-muted-foreground ring-1 ring-inset ring-border">
                {t("linkedin.groupChat")}
              </span>
            )}
            {thread.lastMessageAt && (
              <span className="text-aux tabular-nums text-subtle-foreground">
                {timeAgo(t, thread.lastMessageAt)}
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-aux text-muted-foreground">
            {isGroup
              ? thread.participantCount != null
                ? t("linkedin.participants", { count: thread.participantCount })
                : t("linkedin.groupChat")
              : t("linkedin.thread")}
          </p>
          {thread.lastMessagePreview && (
            <p className="mt-2 line-clamp-2 rounded-8 border border-border-subtle bg-surface-muted px-2 py-1 text-aux text-muted-foreground">
              {thread.lastMessagePreview}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row">
          <Button type="button" variant="outline" size="sm" onClick={() => setShowMessages(true)}>
            <MessageCircle data-icon="inline-start" aria-hidden="true" />
            {t("linkedin.messages")}
          </Button>
        </div>
      </div>

      <LinkedInMessagesDialog
        thread={thread}
        open={showMessages}
        onClose={() => setShowMessages(false)}
      />
    </article>
  );
}

/**
 * The section, always rendered. "Nothing synced yet", "the endpoint failed" and
 * "no search matches" have to stay distinguishable — collapsing the section
 * away would make all three read as an empty page.
 */
export function LinkedInSection() {
  const { t } = useTranslation("people");
  const [search, setSearch] = useState("");

  const threadsQuery = useQuery<LinkedInThread[]>({
    queryKey: ["linkedin-threads"],
    queryFn: ({ signal }) =>
      fetchJson<LinkedInThread[]>("/api/linkedin/threads", {
        signal,
        fallback: t("errors.loadFailedFallback"),
      }),
  });
  const threads = threadsQuery.data ?? [];
  const loadError = threadsQuery.error ? threadsQuery.error.message : null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((thread) => {
      const name = threadName(thread).toLowerCase();
      const preview = (thread.lastMessagePreview ?? "").toLowerCase();
      return name.includes(q) || preview.includes(q);
    });
  }, [threads, search]);

  return (
    <section className="border-t border-border pt-6">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-section text-foreground">
            <ChannelGlyph channel="linkedin" />
            {t("linkedin.heading")}
          </h2>
          <p className="mt-1 text-aux text-muted-foreground">{t("linkedin.description")}</p>
        </div>
        {threads.length > 0 && (
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("linkedin.searchPlaceholder")}
            className="w-full sm:w-64"
          />
        )}
      </div>
      {threadsQuery.isPending ? (
        <p className="py-8 text-center text-ui text-muted-foreground">
          {t("linkedin.loadingThreads")}
        </p>
      ) : loadError && threads.length === 0 ? (
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
              onClick={() => void threadsQuery.refetch()}
            >
              <RefreshCw aria-hidden="true" />
              {t("errors.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : threads.length === 0 ? (
        <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-8 text-center">
          <p className="text-ui text-muted-foreground">{t("linkedin.emptyTitle")}</p>
          <p className="mt-1 text-aux text-subtle-foreground">{t("linkedin.emptyHint")}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-8 text-center">
          <p className="text-ui text-muted-foreground">{t("linkedin.emptyForSearch")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((thread) => (
            <LinkedInThreadCard key={thread.threadId} thread={thread} />
          ))}
        </div>
      )}
    </section>
  );
}
