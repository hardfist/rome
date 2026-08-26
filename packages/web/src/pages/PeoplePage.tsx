import { useState, useEffect, useCallback, useId, useMemo, useRef } from "react";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { FilterChipGroup } from "@/components/ui/filter-chip-group";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { PageShell, PageBody } from "@/shell/PageShell";
import { useInvalidatePeople } from "@/hooks/use-people";
import { getApiErrorMessage } from "@/lib/api-error";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import { STRANGER_PERSON_ID } from "@rome/api-types/persons";
// One phone formatter, shared with the mock backend and `/api/identities`.
// A second copy here rendered a bare 10-digit number as a US one, so the
// same contact could carry two different names on two surfaces.
import { formatWhatsAppPhone, whatsAppDisplayName } from "@rome/api-types/identities";

// The four shapes this page decodes its four endpoints into live in one module,
// shared with `mock/handlers/people.ts`, so a contract change breaks
// `pnpm typecheck` instead of letting mock mode drift from the API it stands
// in for.
import type {
  LinkedInMessage,
  LinkedInThread,
  Person,
  UnknownSender,
  WhatsAppContact,
  WhatsAppMessage,
} from "./people/legacy-api-shapes";

function waBestName(c: WhatsAppContact): string {
  // The ladder itself is shared — this page only supplies the last resort for
  // a contact whose phone is unrenderable.
  return whatsAppDisplayName(c) || "WhatsApp contact";
}

function waPhone(c: WhatsAppContact): string | null {
  return formatWhatsAppPhone(c.phoneNumber || c.jid);
}

function waSubtitle(t: TFunction<"people">, c: WhatsAppContact): string {
  const phone = waPhone(c);
  if (c.isGroup) return t("whatsapp.groupChat");
  const primary = waBestName(c);
  if (phone && phone !== primary) return phone;
  return t("whatsapp.contact");
}

function waSenderName(message: WhatsAppMessage): string {
  return (
    message.senderName ||
    message.pushName ||
    formatWhatsAppPhone(message.senderPhoneNumber || message.senderJid) ||
    "WhatsApp sender"
  );
}

function liThreadName(thread: LinkedInThread): string {
  return thread.personName || thread.conversationName || "LinkedIn conversation";
}

type BondMeta = {
  labelKey: string;
  bar: string;
  dot: string;
  pill: string;
  avatar: string;
};

const BOND_META: Record<string, BondMeta> = {
  guardian: {
    labelKey: "bondLevels.guardian",
    bar: "border-brand",
    dot: "bg-brand",
    pill: "bg-brand/10 text-brand ring-brand/20",
    avatar: "bg-brand/15 text-brand",
  },
  "inner-circle": {
    labelKey: "bondLevels.innerCircle",
    bar: "border-info",
    dot: "bg-info",
    pill: "bg-info-bg text-info-fg ring-info-border",
    avatar: "bg-info-bg text-info-fg",
  },
  acquaintance: {
    labelKey: "bondLevels.acquaintance",
    bar: "border-success",
    dot: "bg-success",
    pill: "bg-success-bg text-success-fg ring-success-border",
    avatar: "bg-success-bg text-success-fg",
  },
  other: {
    labelKey: "bondLevels.other",
    bar: "border-border-strong",
    dot: "bg-border-strong",
    pill: "bg-surface-muted text-foreground ring-border",
    avatar: "bg-surface-muted text-foreground",
  },
  stranger: {
    labelKey: "bondLevels.stranger",
    bar: "border-destructive",
    dot: "bg-destructive",
    pill: "bg-destructive-bg text-destructive-fg ring-destructive-border",
    avatar: "bg-destructive-bg text-destructive-fg",
  },
};

function bondMeta(level: string): BondMeta {
  return BOND_META[level] ?? BOND_META.other;
}

const CHANNEL_META: Record<string, { labelKey: string; pill: string }> = {
  telegram: {
    labelKey: "channels.telegram",
    pill: "bg-info-bg text-info-fg ring-info-border",
  },
  whatsapp: {
    labelKey: "channels.whatsapp",
    pill: "bg-success-bg text-success-fg ring-success-border",
  },
  linkedin: {
    labelKey: "channels.linkedin",
    pill: "bg-info-bg text-info-fg ring-info-border",
  },
  discord: {
    labelKey: "channels.discord",
    pill: "bg-brand/10 text-brand ring-brand/20",
  },
  webchat: {
    labelKey: "channels.webchat",
    pill: "bg-surface-muted text-foreground ring-border",
  },
};

const FALLBACK_CHANNEL_PILL = "bg-surface-muted text-foreground ring-border";

function channelDisplay(t: TFunction<"people">, channel: string): { label: string; pill: string } {
  const meta = CHANNEL_META[channel];
  if (!meta) return { label: channel, pill: FALLBACK_CHANNEL_PILL };
  return { label: t(meta.labelKey), pill: meta.pill };
}

type KnownFilter = "all" | "inner-circle" | "acquaintance" | "other";

function timeAgo(t: TFunction<"people">, ts: number | null): string {
  if (!ts) return t("timeAgo.unknown");
  const now = Date.now();
  const diffMs = now - ts * 1000;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 5) return t("timeAgo.justNow");
  if (diffSec < 60) return t("timeAgo.seconds", { count: diffSec });
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t("timeAgo.minutes", { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("timeAgo.hours", { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  return t("timeAgo.days", { count: diffDay });
}

function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Avatar({
  name,
  tone,
  size = "md",
}: {
  name: string | null | undefined;
  tone: string;
  size?: "sm" | "md";
}) {
  const sizes = {
    sm: "h-8 w-8 text-aux",
    md: "h-10 w-10 text-aux",
  };
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full ${sizes[size]} ${tone}`}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}

function ChannelPill({
  channel,
  onClick,
  title,
}: {
  channel: string;
  onClick?: () => void;
  title?: string;
}) {
  const { t } = useTranslation("people");
  const { label, pill } = channelDisplay(t, channel);
  const base = `inline-flex items-center rounded-full px-2 py-1 text-badge ring-1 ring-inset ${pill}`;
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-label={title}
        className={`${base} cursor-pointer transition-opacity hover:opacity-80`}
      >
        {label}
      </button>
    );
  }
  return <span className={base}>{label}</span>;
}

/**
 * A submit label that swaps to a busy phrasing while the request is in flight.
 *
 * Both strings share one grid cell, so the box is always as wide as the longer
 * of the two and the swap never resizes the button. The inactive one is
 * `invisible` (`visibility: hidden`, which browsers already drop from the
 * accessibility tree) *and* `aria-hidden`, because jsdom computes accessible
 * names without layout — without the attribute a test would read both labels
 * concatenated.
 */
function BusyLabel({ idle, busy, isBusy }: { idle: string; busy: string; isBusy: boolean }) {
  return (
    <span className="grid place-items-center">
      <span className={cn("col-start-1 row-start-1", isBusy && "invisible")} aria-hidden={isBusy}>
        {idle}
      </span>
      <span className={cn("col-start-1 row-start-1", !isBusy && "invisible")} aria-hidden={!isBusy}>
        {busy}
      </span>
    </span>
  );
}

function BondPill({ level }: { level: string }) {
  const { t } = useTranslation("people");
  const m = bondMeta(level);
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-2 py-1 text-badge ring-1 ring-inset ${m.pill}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {t(m.labelKey)}
    </span>
  );
}

function CardShell({ accent, children }: { accent: string; children: React.ReactNode }) {
  return (
    <article
      className="group relative overflow-hidden rounded-12 border border-border bg-surface shadow-1 transition-all duration-200 hover:border-border-strong hover:shadow-4"
      style={{ animation: "rome-activity-rise 0.25s ease-out backwards" }}
    >
      <div className={`absolute inset-y-0 left-0 border-l-3 ${accent}`} aria-hidden="true" />
      <div className="relative p-4 pl-5">{children}</div>
    </article>
  );
}

const BOND_FORM_OPTIONS = ["inner-circle", "acquaintance", "other"] as const;

/**
 * POST a person mutation and reduce whatever comes back to "it worked" or a
 * message worth showing. Never throws — the callers are event handlers, where
 * an unhandled rejection would leave the card silent.
 *
 * Only a 4xx body is treated as copy. These routes answer a rejected request
 * with an `{ error }` naming the missing field, which is exactly what the
 * guardian needs. A 5xx body carries the same shape but not the same meaning:
 * the API error handler serializes an unhandled exception as
 * `{ error: err.message }`, so trusting it would put a raw SQLite or repository
 * message on the card. Those, and a fetch that never reached the server, get
 * generic copy.
 */
async function postPersonMutation(
  url: string,
  body: unknown,
  t: TFunction<"people">,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  }).catch(() => null);

  if (!res) return { ok: false, error: t("errors.network") };
  if (res.ok) return { ok: true };
  if (res.status >= 500) return { ok: false, error: t("errors.requestFailed") };
  const payload = (await res.json().catch(() => null)) as {
    error?: string;
  } | null;
  return { ok: false, error: payload?.error || t("errors.requestFailed") };
}

/** Why the last mutation failed, sitting at the left end of a card's button row. */
function MutationError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mr-auto text-aux text-destructive-fg">
      {message}
    </p>
  );
}

function CreateProfileForm({
  sender,
  error,
  onSubmit,
  onCancel,
}: {
  sender: UnknownSender;
  /** Message from the last failed submit, rendered beside the submit row. */
  error: string | null;
  onSubmit: (data: { displayName: string; bondLevel: string; relation: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation("people");
  const uid = useId();
  const form = useForm({
    defaultValues: {
      displayName: sender.displayName || "",
      bondLevel: "acquaintance",
      relation: "",
    },
    onSubmit: async ({ value }) => {
      await onSubmit({
        displayName: value.displayName,
        bondLevel: value.bondLevel,
        relation: value.relation,
      });
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="mt-3 space-y-3 rounded-8 border border-border-subtle bg-surface-muted/60 p-3"
      style={{ animation: "rome-activity-rise 0.18s ease-out" }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <form.Field name="displayName">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={`${uid}-display-name`}>{t("createForm.nameLabel")}</FieldLabel>
              <Input
                id={`${uid}-display-name`}
                type="text"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                required
              />
            </Field>
          )}
        </form.Field>
        <form.Field name="bondLevel">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={`${uid}-bond-level`}>
                {t("createForm.bondLevelLabel")}
              </FieldLabel>
              <Select value={field.state.value} onValueChange={field.handleChange}>
                <SelectTrigger id={`${uid}-bond-level`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BOND_FORM_OPTIONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(bondMeta(value).labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
      </div>
      <form.Field name="relation">
        {(field) => (
          <Field>
            <FieldLabel htmlFor={`${uid}-relation`}>{t("createForm.relationLabel")}</FieldLabel>
            <Input
              id={`${uid}-relation`}
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder={t("createForm.relationPlaceholder")}
            />
          </Field>
        )}
      </form.Field>
      <form.Subscribe<{ isSubmitting: boolean; displayName: string }>
        selector={(s) => ({
          isSubmitting: s.isSubmitting,
          displayName: s.values.displayName,
        })}
      >
        {({ isSubmitting, displayName }) => (
          <div className="flex items-center justify-end gap-2">
            <MutationError message={error} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              {t("actions.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting || !displayName}>
              <BusyLabel
                idle={t("actions.createProfile")}
                busy={t("actions.creating")}
                isBusy={isSubmitting}
              />
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}

function LinkForm({
  persons,
  error,
  onSubmit,
  onCancel,
}: {
  persons: Person[];
  /** Message from the last failed submit, rendered beside the submit row. */
  error: string | null;
  onSubmit: (personId: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation("people");
  const uid = useId();
  const form = useForm({
    defaultValues: { selectedId: "" },
    onSubmit: async ({ value }) => {
      if (!value.selectedId) return;
      await onSubmit(value.selectedId);
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="mt-3 space-y-3 rounded-8 border border-border-subtle bg-surface-muted/60 p-3"
      style={{ animation: "rome-activity-rise 0.18s ease-out" }}
    >
      <form.Field name="selectedId">
        {(field) => (
          <Field>
            <FieldLabel htmlFor={`${uid}-person`}>{t("linkForm.label")}</FieldLabel>
            <Select value={field.state.value || undefined} onValueChange={field.handleChange}>
              <SelectTrigger id={`${uid}-person`} className="w-full">
                <SelectValue placeholder={t("linkForm.selectPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {persons.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.displayName} · {t(bondMeta(p.bondLevel).labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      <form.Subscribe<{ isSubmitting: boolean; selectedId: string }>
        selector={(s) => ({
          isSubmitting: s.isSubmitting,
          selectedId: s.values.selectedId,
        })}
      >
        {({ isSubmitting, selectedId }) => (
          <div className="flex items-center justify-end gap-2">
            <MutationError message={error} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              {t("actions.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting || !selectedId}>
              <BusyLabel
                idle={t("actions.linkSubmit")}
                busy={t("actions.linking")}
                isBusy={isSubmitting}
              />
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}

function SenderCard({
  sender,
  persons,
  onRefresh,
}: {
  sender: UnknownSender;
  persons: Person[];
  onRefresh: () => void;
}) {
  const { t } = useTranslation("people");
  const [action, setAction] = useState<"create" | "link" | null>(null);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Marking a sender as a stranger writes a permanent channel mapping the
  // product cannot reverse, so it goes through a confirm that names the sender
  // and the consequence before anything is posted.
  const [confirmingStranger, setConfirmingStranger] = useState(false);
  const senderName = sender.displayName || sender.channelUserId;

  /** Opening, switching or cancelling a form drops the previous failure. */
  function openAction(next: "create" | "link" | null) {
    setError(null);
    setAction(next);
  }

  async function handleCreate(data: { displayName: string; bondLevel: string; relation: string }) {
    setError(null);
    const res = await postPersonMutation(
      "/api/persons/create",
      { ...data, channel: sender.channel, channelUserId: sender.channelUserId },
      t,
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setAction(null);
    onRefresh();
  }

  async function handleLink(personId: string) {
    setError(null);
    const res = await postPersonMutation(
      "/api/persons/link",
      {
        channel: sender.channel,
        channelUserId: sender.channelUserId,
        existingPersonId: personId,
        displayName: sender.displayName,
      },
      t,
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setAction(null);
    onRefresh();
  }

  async function handleMarkStranger() {
    // The card's own trigger names the running operation, so the dialog steps
    // out of the way the moment the write starts rather than sitting there
    // disabled with nothing to say.
    setConfirmingStranger(false);
    setActing(true);
    setError(null);
    try {
      const res = await postPersonMutation(
        "/api/persons/mark-stranger",
        {
          channel: sender.channel,
          channelUserId: sender.channelUserId,
          displayName: sender.displayName,
        },
        t,
      );
      // A write that didn't land leaves the sender exactly where they were.
      // Say so on the card — closing the dialog silently reads as success,
      // which is the opposite of what this confirmation exists to do.
      if (res.ok) onRefresh();
      else setError(res.error);
    } finally {
      setActing(false);
    }
  }

  return (
    <CardShell accent="border-warning">
      <div className="flex items-start gap-3">
        <Avatar name={sender.displayName} tone="bg-warning-bg text-warning-fg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-ui text-foreground">
              {sender.displayName || t("unmapped.unknownSender")}
            </span>
            <ChannelPill channel={sender.channel} />
            <span className="text-aux tabular-nums text-subtle-foreground">
              {timeAgo(t, sender.lastMessageAt)}
            </span>
          </div>
          <p className="mt-1 truncate font-mono text-aux text-muted-foreground">
            {sender.channelUserId}
          </p>
          {sender.lastMessage && (
            <p className="mt-2 line-clamp-2 rounded-8 border border-border-subtle bg-surface-muted px-2 py-1 text-aux text-muted-foreground">
              {sender.lastMessage}
            </p>
          )}
        </div>
        {!action && (
          <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row">
            {/* The card holds one error, so nothing else may start while
                mark-stranger runs — otherwise its failure lands beside a form
                the guardian opened in the meantime. */}
            <Button type="button" size="sm" onClick={() => openAction("create")} disabled={acting}>
              {t("actions.create")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => openAction("link")}
              disabled={acting}
            >
              {t("actions.link")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => setConfirmingStranger(true)}
              disabled={acting}
            >
              <BusyLabel
                idle={t("actions.markStranger")}
                busy={t("actions.markingStranger")}
                isBusy={acting}
              />
            </Button>
          </div>
        )}
      </div>

      <RomeConfirmDialog
        open={confirmingStranger}
        destructive
        title={t("strangerConfirm.title", { name: senderName })}
        // The mapping only removes the sender from the unmapped list — a
        // WhatsApp sender who is also in the synced address book keeps their
        // card in the contacts section below — so name the section, not the page.
        description={t("strangerConfirm.description", {
          name: senderName,
          section: t("unmapped.heading"),
        })}
        // Deliberately the same words as the trigger: the button that opens the
        // confirm and the button that carries it out promise the same thing.
        confirmLabel={t("actions.markStranger")}
        cancelLabel={t("actions.cancel")}
        onCancel={() => setConfirmingStranger(false)}
        onConfirm={() => void handleMarkStranger()}
      />

      {/* With no form open the failure belongs to mark-stranger, whose button
          row lives in the header above. */}
      {!action && error && (
        <div className="mt-2 flex justify-end">
          <MutationError message={error} />
        </div>
      )}

      {action === "create" && (
        <CreateProfileForm
          sender={sender}
          error={error}
          onSubmit={handleCreate}
          onCancel={() => openAction(null)}
        />
      )}
      {action === "link" && (
        <LinkForm
          persons={persons}
          error={error}
          onSubmit={handleLink}
          onCancel={() => openAction(null)}
        />
      )}
    </CardShell>
  );
}

function PersonCard({ person }: { person: Person }) {
  const { t } = useTranslation("people");
  const meta = bondMeta(person.bondLevel);
  const [showMessages, setShowMessages] = useState(false);
  const waMapping = person.channelMappings.find((m) => m.channel === "whatsapp");
  return (
    <CardShell accent={meta.bar}>
      <div className="flex items-center gap-3">
        <Avatar name={person.displayName} tone={meta.avatar} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-ui text-foreground">{person.displayName}</span>
            <BondPill level={person.bondLevel} />
          </div>
          <p className="mt-1 truncate font-mono text-aux text-subtle-foreground">{person.id}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex flex-wrap justify-end gap-2">
            {person.channelMappings.length === 0 ? (
              <span className="text-aux text-subtle-foreground">{t("known.noChannels")}</span>
            ) : (
              person.channelMappings.map((m) => (
                <ChannelPill
                  key={`${m.channel}:${m.channelUserId}`}
                  channel={m.channel}
                  onClick={m.channel === "whatsapp" ? () => setShowMessages(true) : undefined}
                  title={m.channel === "whatsapp" ? t("whatsapp.messages") : undefined}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {waMapping && (
        <MessagesDialog
          jid={waMapping.channelUserId}
          title={person.displayName}
          subtitle={formatWhatsAppPhone(waMapping.channelUserId) ?? waMapping.channelUserId}
          isGroup={false}
          avatarTone={meta.avatar}
          open={showMessages}
          onClose={() => setShowMessages(false)}
        />
      )}
    </CardShell>
  );
}

type SendStatus = "sending" | "sent" | "failed";

// A rendered chat message: a stored WhatsApp message, or an optimistic one the
// guardian just sent (carrying a transient `status` until the server echoes it).
interface ChatMessage extends WhatsAppMessage {
  status?: SendStatus;
}

// One emoji pinned to a message, with how many people reacted with it.
interface ReactionBadge {
  emoji: string;
  count: number;
}

type ChatRenderItem =
  | {
      kind: "bubble";
      message: ChatMessage;
      showDate: boolean;
      firstInGroup: boolean;
      senderLabel?: string;
      reactions?: ReactionBadge[];
    }
  // The rare reaction whose target message isn't in the loaded window — shown as
  // a standalone note so the reaction isn't silently dropped.
  | { kind: "reaction-note"; message: ChatMessage };

/**
 * Split a chat stream into renderable items. A reaction is an emoji pinned to
 * another message, so it never renders as a bubble of its own (that was the
 * empty-bubble bug); instead each reaction is folded onto its target as a badge,
 * falling back to a "reacted" note when the target is out of the loaded window.
 */
function buildChatItems(messages: ChatMessage[], isGroupChat: boolean): ChatRenderItem[] {
  const bubbleIds = new Set(messages.filter((m) => m.type !== "reaction").map((m) => m.id));

  const reactionsByTarget = new Map<string, ReactionBadge[]>();
  for (const m of messages) {
    if (m.type !== "reaction" || !m.text || !m.reactsToId) continue;
    if (!bubbleIds.has(m.reactsToId)) continue;
    const list = reactionsByTarget.get(m.reactsToId) ?? [];
    const existing = list.find((r) => r.emoji === m.text);
    if (existing) existing.count += 1;
    else list.push({ emoji: m.text, count: 1 });
    reactionsByTarget.set(m.reactsToId, list);
  }

  const items: ChatRenderItem[] = [];
  let prevBubble: ChatMessage | undefined;
  for (const m of messages) {
    if (m.type === "reaction") {
      if (!m.text) continue;
      // Target visible → already drawn as a badge on it; otherwise keep a note.
      if (m.reactsToId && bubbleIds.has(m.reactsToId)) continue;
      items.push({ kind: "reaction-note", message: m });
      continue;
    }
    const showDate = !prevBubble || dayKey(prevBubble.timestamp) !== dayKey(m.timestamp);
    const senderChanged = isGroupChat && !m.fromMe && prevBubble?.senderJid !== m.senderJid;
    const firstInGroup = showDate || prevBubble!.fromMe !== m.fromMe || senderChanged;
    items.push({
      kind: "bubble",
      message: m,
      showDate,
      firstInGroup,
      senderLabel: isGroupChat && !m.fromMe && firstInGroup ? waSenderName(m) : undefined,
      reactions: reactionsByTarget.get(m.id),
    });
    prevBubble = m;
  }
  return items;
}

function formatClock(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Day key (local) used to group messages and decide separators. */
function dayKey(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(t: TFunction<"people">, tsSeconds: number): string {
  const now = new Date();
  const today = dayKey(Math.floor(now.getTime() / 1000));
  const yesterday = dayKey(Math.floor(now.getTime() / 1000) - 86_400);
  const key = dayKey(tsSeconds);
  if (key === today) return t("whatsapp.today");
  if (key === yesterday) return t("whatsapp.yesterday");
  return new Date(tsSeconds * 1000).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
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

function ReactionNote({ message }: { message: ChatMessage }) {
  const { t } = useTranslation("people");
  const label = message.fromMe
    ? t("whatsapp.reactedToYou", { emoji: message.text })
    : t("whatsapp.reactedTo", { emoji: message.text });
  return (
    <div className="my-1 flex justify-center">
      <span className="rounded-8 bg-surface/90 px-2 py-1 text-badge text-muted-foreground shadow-1 ring-1 ring-inset ring-border-subtle">
        {label}
      </span>
    </div>
  );
}

function StatusTicks({ status }: { status?: SendStatus }) {
  if (status === "sending") return <Clock className="size-3 opacity-60" aria-hidden="true" />;
  if (status === "failed")
    return <AlertCircle className="size-3 text-destructive" aria-hidden="true" />;
  return <CheckCheck className="size-3.5 opacity-60" aria-hidden="true" />;
}

function MessageBubble({
  message,
  firstInGroup,
  senderLabel,
  reactions,
  onRetry,
}: {
  message: ChatMessage;
  firstInGroup: boolean;
  senderLabel?: string;
  /** Emoji reactions pinned to this message (deduped, with multiplicity count). */
  reactions?: ReactionBadge[];
  onRetry?: () => void;
}) {
  const { t } = useTranslation("people");
  const body =
    message.text ||
    (message.hasMedia ? t("whatsapp.mediaPlaceholder", { type: message.type ?? "media" }) : "");
  const mine = message.fromMe;
  const failed = message.status === "failed";
  const hasReactions = reactions != null && reactions.length > 0;
  // Tail corner sits on the first bubble of a same-sender run, WhatsApp-style.
  const tail = firstInGroup ? (mine ? "rounded-tr-4" : "rounded-tl-4") : "";
  return (
    <div
      className={`flex ${mine ? "justify-end" : "justify-start"} ${firstInGroup ? "mt-2" : "mt-1"} ${
        // A reaction pill hangs below the bubble; reserve room so it never
        // overlaps the next message.
        hasReactions ? "mb-3" : ""
      }`}
    >
      <div
        {...(onRetry
          ? {
              role: "button" as const,
              tabIndex: 0,
              onClick: onRetry,
              title: t("whatsapp.sendFailed"),
            }
          : {})}
        className={`relative max-w-[80%] rounded-12 px-2 py-1 text-body shadow-1 ${tail} ${
          mine
            ? "bg-success-bg text-success-fg"
            : "bg-surface text-foreground ring-1 ring-inset ring-border-subtle"
        } ${failed ? "cursor-pointer ring-1 ring-inset ring-destructive-border" : ""}`}
      >
        {senderLabel && (
          <p className="mb-1 max-w-56 truncate text-badge text-success-fg">{senderLabel}</p>
        )}
        {body && <p className="whitespace-pre-wrap break-words pr-1">{body}</p>}
        <span
          className={`float-right ml-2 mt-1 flex translate-y-0.5 items-center gap-1 text-aux tabular-nums ${
            mine ? "text-success-fg/70" : "text-subtle-foreground"
          }`}
        >
          {formatClock(message.timestamp)}
          {mine && <StatusTicks status={message.status} />}
        </span>
        <span className="clear-both block" />
        {hasReactions && (
          <div
            className={`absolute -bottom-2 flex items-center gap-1 rounded-full bg-surface px-2 py-1 text-badge shadow-1 ring-1 ring-inset ring-border-subtle ${
              // Sit on the side facing the conversation, like WhatsApp.
              mine ? "left-2" : "right-2"
            }`}
          >
            {reactions.map((r) => (
              <span key={r.emoji}>
                {r.emoji}
                {r.count > 1 && (
                  <span className="ml-1 tabular-nums text-badge text-muted-foreground">
                    {r.count}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const MESSAGE_POLL_MS = 4_000;

// Drop optimistic bubbles once the server has echoed an equivalent sent message
// (same text, sent at/after the optimistic timestamp). Failed sends are kept so
// the guardian can retry them.
function reconcilePending(server: WhatsAppMessage[], pending: ChatMessage[]): ChatMessage[] {
  const used = new Set<string>();
  return pending.filter((p) => {
    if (p.status === "failed") return true;
    const match = server.find(
      (m) =>
        m.fromMe &&
        !used.has(m.id) &&
        (m.text ?? "") === (p.text ?? "") &&
        m.timestamp >= p.timestamp - 120,
    );
    if (match) {
      used.add(match.id);
      return false;
    }
    return true;
  });
}

function Composer({
  onSend,
  disabled,
  channel = "whatsapp",
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
  channel?: "whatsapp" | "linkedin";
}) {
  const { t } = useTranslation("people");
  const [text, setText] = useState("");
  const placeholder =
    channel === "linkedin" ? t("linkedin.composerPlaceholder") : t("whatsapp.composerPlaceholder");
  const sendLabel = channel === "linkedin" ? t("linkedin.send") : t("whatsapp.send");

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
        label={sendLabel}
        icon={<Send aria-hidden="true" />}
        // Hover reads the border step because this family has no `-hover-bg`.
        // It moves the fill away from the canvas in both modes — darker in
        // light, lighter in dark — which is the direction the families that do
        // have the step take.
        className={cn(
          "rounded-full border shadow-1",
          channel === "linkedin"
            ? "border-info-border bg-info-bg text-info-fg hover:bg-info-border"
            : "border-success-border bg-success-bg text-success-fg hover:bg-success-border",
        )}
      />
    </form>
  );
}

function MessagesDialog({
  jid,
  title,
  subtitle,
  isGroup,
  avatarTone,
  open,
  onClose,
}: {
  jid: string;
  title: string;
  subtitle?: string;
  isGroup: boolean;
  avatarTone: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("people");
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const localSeq = useRef(0);

  // The thread is read through the query layer rather than a hand-rolled
  // fetch+interval: the initial load, the poll, the post-send refetch and the
  // retry button all overlap, and only react-query's own newest-wins handling
  // (plus the abort signal it threads through) keeps a slow older failure from
  // landing on top of a newer success. A failure leaves `data` alone, which is
  // exactly the property this page needs — a failed load is not an empty thread.
  const messagesQuery = useQuery<WhatsAppMessage[]>({
    queryKey: ["whatsapp-messages", jid],
    enabled: open,
    refetchInterval: MESSAGE_POLL_MS,
    queryFn: ({ signal }) =>
      fetchJson<WhatsAppMessage[]>(
        `/api/whatsapp/contacts/${encodeURIComponent(jid)}/messages?limit=100`,
        { signal, fallback: t("errors.messagesFailed") },
      ),
  });
  const serverMessages = messagesQuery.data ?? null;
  const loading = messagesQuery.isPending;
  const loadError = messagesQuery.error ? messagesQuery.error.message : null;
  const reload = messagesQuery.refetch;

  // Optimistic bubbles are local, so they are reset per opening and reconciled
  // whenever a fresh server copy arrives.
  useEffect(() => {
    if (!open) return;
    setPending([]);
    setSendError(null);
  }, [open]);

  useEffect(() => {
    if (!messagesQuery.data) return;
    const server = messagesQuery.data;
    setPending((prev) => reconcilePending(server, prev));
  }, [messagesQuery.data]);

  const messages: ChatMessage[] = useMemo(
    () => [...(serverMessages ?? []), ...pending],
    [serverMessages, pending],
  );

  const chatItems = useMemo(() => buildChatItems(messages, isGroup), [messages, isGroup]);

  // Pin to the newest message whenever the rendered count changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, open]);

  const sendText = useCallback(
    async (text: string) => {
      const id = `local-${localSeq.current++}`;
      const optimistic: ChatMessage = {
        id,
        senderJid: null,
        senderName: null,
        senderPhoneNumber: null,
        fromMe: true,
        timestamp: Math.floor(Date.now() / 1000),
        type: "text",
        text,
        hasMedia: false,
        pushName: null,
        reactsToId: null,
        status: "sending",
      };
      setPending((prev) => [...prev, optimistic]);
      setSendError(null);

      const res = await fetch(`/api/whatsapp/contacts/${encodeURIComponent(jid)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ text }),
      }).catch(() => null);

      if (!res || !res.ok) {
        let msg = t("whatsapp.sendFailed");
        if (res?.status === 503) {
          msg = t("whatsapp.notConnected");
        } else if (res) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          if (body?.error) msg = body.error;
        }
        setSendError(msg);
        setPending((prev) => prev.map((m) => (m.id === id ? { ...m, status: "failed" } : m)));
        return;
      }
      // The echo lands a beat later; refetch swaps the optimistic bubble for the
      // stored one (reconcilePending drops the local copy once it matches).
      setTimeout(() => void reload(), 1_200);
    },
    [jid, reload, t],
  );

  const retry = useCallback(
    (m: ChatMessage) => {
      setPending((prev) => prev.filter((p) => p.id !== m.id));
      void sendText(m.text ?? "");
    },
    [sendText],
  );

  const hasMessages = messages.length > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      ariaLabel={t("whatsapp.dialogTitle", { name: title })}
    >
      <DialogHeader onClose={onClose} closeLabel={t("actions.close")}>
        <div className="flex items-center gap-3">
          <Avatar name={title} tone={avatarTone} />
          <div className="min-w-0">
            <DialogTitle className="truncate text-body">{title}</DialogTitle>
            {subtitle && (
              <p className="truncate font-mono text-aux text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
      </DialogHeader>

      <div
        ref={scrollRef}
        className="flex h-[58vh] flex-col overflow-y-auto bg-surface-muted px-4 py-3"
      >
        {loading && serverMessages === null ? (
          <p className="m-auto text-ui text-muted-foreground">{t("whatsapp.loading")}</p>
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
            <p className="text-ui text-muted-foreground">{t("whatsapp.noMessages")}</p>
            <p className="mt-1 text-aux text-subtle-foreground">{t("whatsapp.noMessagesHint")}</p>
          </div>
        ) : (
          chatItems.map((item) => {
            const m = item.message;
            if (item.kind === "reaction-note") {
              return <ReactionNote key={m.id} message={m} />;
            }
            return (
              <div key={m.id}>
                {item.showDate && <DateSeparator label={dayLabel(t, m.timestamp)} />}
                <MessageBubble
                  message={m}
                  firstInGroup={item.firstInGroup}
                  senderLabel={item.senderLabel}
                  reactions={item.reactions}
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

      <Composer onSend={sendText} />
    </Dialog>
  );
}

function WhatsAppContactCard({
  contact,
  persons,
  onRefresh,
}: {
  contact: WhatsAppContact;
  persons: Person[];
  onRefresh: () => void;
}) {
  const { t } = useTranslation("people");
  const [action, setAction] = useState<"create" | "link" | null>(null);
  const [showMessages, setShowMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = waBestName(contact);
  const subtitle = waSubtitle(t, contact);
  const sender: UnknownSender = {
    channel: "whatsapp",
    channelUserId: contact.jid,
    displayName: name,
    lastMessage: null,
    lastMessageAt: contact.lastMessageAt,
  };

  /** Opening, switching or cancelling a form drops the previous failure. */
  function openAction(next: "create" | "link" | null) {
    setError(null);
    setAction(next);
  }

  async function handleCreate(data: { displayName: string; bondLevel: string; relation: string }) {
    setError(null);
    const res = await postPersonMutation(
      "/api/persons/create",
      { ...data, channel: "whatsapp", channelUserId: contact.jid },
      t,
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setAction(null);
    onRefresh();
  }

  async function handleLink(personId: string) {
    setError(null);
    const res = await postPersonMutation(
      "/api/persons/link",
      {
        channel: "whatsapp",
        channelUserId: contact.jid,
        existingPersonId: personId,
        displayName: name,
      },
      t,
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setAction(null);
    onRefresh();
  }

  return (
    <CardShell accent="border-success">
      <div className="flex items-start gap-3">
        <Avatar name={name} tone="bg-success-bg text-success-fg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-ui text-foreground">{name}</span>
            {contact.linkedPersonId && (
              <span className="inline-flex items-center rounded-full bg-success-bg px-2 py-1 text-badge text-success-fg ring-1 ring-inset ring-success-border">
                {t("whatsapp.linkedTo", {
                  name: contact.linkedPersonName ?? "",
                })}
              </span>
            )}
            {contact.isGroup && (
              <span className="inline-flex items-center rounded-full bg-surface-muted px-2 py-1 text-badge text-muted-foreground ring-1 ring-inset ring-border">
                {t("whatsapp.groupChat")}
              </span>
            )}
            {contact.lastMessageAt && (
              <span className="text-aux tabular-nums text-subtle-foreground">
                {timeAgo(t, contact.lastMessageAt)}
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-aux text-muted-foreground">{subtitle}</p>
          {contact.lastMessagePreview && (
            <p className="mt-2 line-clamp-2 rounded-8 border border-border-subtle bg-surface-muted px-2 py-1 text-aux text-muted-foreground">
              {contact.lastMessagePreview}
            </p>
          )}
        </div>
        {!action && (
          <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row">
            {!contact.linkedPersonId && (
              <>
                <Button type="button" size="sm" onClick={() => openAction("create")}>
                  {t("actions.create")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => openAction("link")}
                >
                  {t("actions.link")}
                </Button>
              </>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => setShowMessages(true)}>
              <MessageCircle data-icon="inline-start" aria-hidden="true" />
              {t("whatsapp.messages")}
            </Button>
          </div>
        )}
      </div>

      {action === "create" && (
        <CreateProfileForm
          sender={sender}
          error={error}
          onSubmit={handleCreate}
          onCancel={() => openAction(null)}
        />
      )}
      {action === "link" && (
        <LinkForm
          persons={persons}
          error={error}
          onSubmit={handleLink}
          onCancel={() => openAction(null)}
        />
      )}

      <MessagesDialog
        jid={contact.jid}
        title={name}
        subtitle={subtitle}
        isGroup={contact.isGroup}
        avatarTone="bg-success-bg text-success-fg"
        open={showMessages}
        onClose={() => setShowMessages(false)}
      />
    </CardShell>
  );
}

// The mirror refreshes on the poller's 15–30 minute cadence, so the dialog's
// poll only needs to catch a sync landing while it happens to be open.
const LINKEDIN_MESSAGE_POLL_MS = 30_000;

interface LinkedInChatMessage extends LinkedInMessage {
  status?: SendStatus;
}

// A successful safe-send appears in the mirror on a later inbox sync. Keep its
// local bubble until an equivalent server row arrives, then let the durable row
// take over. Failed replies remain available for retry.
function reconcileLinkedInPending(
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
        {...(onRetry
          ? {
              role: "button" as const,
              tabIndex: 0,
              onClick: onRetry,
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
          {formatClock(message.timestamp)}
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
  const title = liThreadName(thread);
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
          <Avatar name={title} tone="bg-info-bg text-info-fg" />
          <div className="min-w-0">
            <DialogTitle className="truncate text-body">{title}</DialogTitle>
            <a
              href={thread.threadUrl}
              target="_blank"
              rel="noreferrer"
              className="truncate text-aux text-muted-foreground underline-offset-2 hover:underline"
            >
              {t("linkedin.openInLinkedIn")}
            </a>
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
            const showDate = !prev || dayKey(prev.timestamp) !== dayKey(m.timestamp);
            const senderChanged =
              !prev ||
              prev.senderIsSelf !== m.senderIsSelf ||
              (isGroup && prev.senderName !== m.senderName);
            const firstInGroup = showDate || senderChanged;
            return (
              <div key={m.messageId}>
                {showDate && <DateSeparator label={dayLabel(t, m.timestamp)} />}
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

      <Composer onSend={sendText} disabled={sending} channel="linkedin" />
    </Dialog>
  );
}

function LinkedInThreadCard({ thread }: { thread: LinkedInThread }) {
  const { t } = useTranslation("people");
  const [showMessages, setShowMessages] = useState(false);
  const name = liThreadName(thread);
  const isGroup = thread.isGroup === true;

  return (
    <CardShell accent="border-info">
      <div className="flex items-start gap-3">
        <Avatar name={name} tone="bg-info-bg text-info-fg" />
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
    </CardShell>
  );
}

/** Either the decoded payload of a load, or the reason it failed. */
type LoadOutcome<T> = { data: T } | { error: string };

/**
 * Read one settled load. A rejected request (offline), a non-ok response and an
 * undecodable body are all failures — none of them may be reported as an empty
 * list, which is what the page used to do.
 */
async function readLoad<T>(
  settled: PromiseSettledResult<Response>,
  fallback: string,
): Promise<LoadOutcome<T>> {
  if (settled.status === "rejected") return { error: fallback };
  if (!settled.value.ok) {
    // The same rule the mutation path follows (see `postPersonMutation`): a 4xx
    // body explains the request, but a 5xx body is the API error handler
    // serializing an unhandled exception — a diagnostic, never copy to put in
    // front of a guardian.
    if (settled.value.status >= 500) return { error: fallback };
    return { error: await getApiErrorMessage(settled.value, fallback) };
  }
  try {
    return { data: (await settled.value.json()) as T };
  } catch {
    return { error: fallback };
  }
}

/**
 * The header's freshness line. Four honest states rather than "live or bust":
 * every source failed reads differently from some of them failing, and a page
 * that has never completed a full load reads differently from a stale one.
 * `lastFetchedAt` is the last fetch where *every* source answered, so it is
 * never used to imply a section refreshed when it didn't.
 */
export function describeFreshness(
  t: TFunction<"people">,
  { failed, total, lastFetchedAt }: { failed: number; total: number; lastFetchedAt: number | null },
): { label: string; live: boolean } {
  const time = lastFetchedAt === null ? null : timeAgo(t, Math.floor(lastFetchedAt / 1000));
  if (failed === 0) {
    return time === null
      ? { label: t("header.loading"), live: false }
      : { label: t("header.liveUpdated", { time }), live: true };
  }
  if (failed >= total) {
    return time === null
      ? { label: t("header.loadFailed"), live: false }
      : { label: t("header.staleUpdated", { time }), live: false };
  }
  // Something did load: don't report a total outage over data that is on screen.
  return time === null
    ? { label: t("header.partialFailed"), live: false }
    : { label: t("header.partialUpdated", { time }), live: false };
}

/** Placeholder for a section whose first load is still in flight. */
function SectionLoading({ label }: { label: string }) {
  return (
    <div className="py-12 text-center">
      <div
        className="mx-auto mb-3 h-5 w-5 rounded-full border-2 border-border-strong border-t-gray-800"
        style={{ animation: "spin 0.9s linear infinite" }}
        aria-hidden="true"
      />
      <p className="text-ui text-muted-foreground">{label}</p>
    </div>
  );
}

/** Failure panel shown in place of a section's empty state when its load failed. */
function LoadErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation("people");
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{t("errors.loadFailedTitle")}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          {t("errors.retry")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export default function PeoplePage() {
  const { t } = useTranslation("people");
  const { t: tCommon } = useTranslation("common");
  const invalidatePeople = useInvalidatePeople();
  const [unknowns, setUnknowns] = useState<UnknownSender[]>([]);
  const [persons, setPersons] = useState<Person[]>([]);
  const [whatsappContacts, setWhatsappContacts] = useState<WhatsAppContact[]>([]);
  const [waSearch, setWaSearch] = useState("");
  const [linkedinThreads, setLinkedinThreads] = useState<LinkedInThread[]>([]);
  const [liSearch, setLiSearch] = useState("");
  const [loading, setLoading] = useState(true);
  // Only ever advanced by a fetch where every source succeeded, so the header
  // never claims a freshness the page doesn't have. `null` = never loaded.
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [errors, setErrors] = useState<{
    unknowns: string | null;
    persons: string | null;
    whatsapp: string | null;
    linkedin: string | null;
  }>({ unknowns: null, persons: null, whatsapp: null, linkedin: null });
  const [, setTick] = useState(0);
  const [knownFilter, setKnownFilter] = useState<KnownFilter>("all");
  // The poll, the header refresh and every section retry all call `fetchData`,
  // so refreshes overlap. Only the newest one may commit, or a slow failure
  // landing after a fast retry would put the error back and make the retry look
  // like it failed.
  const fetchSeq = useRef(0);

  const fetchData = useCallback(async () => {
    const fallback = t("errors.loadFailedFallback");
    const seq = ++fetchSeq.current;
    try {
      // Settled, not `all`: one dead endpoint must not take the other two
      // sections down with it.
      const settled = await Promise.allSettled([
        fetch("/api/persons/unknown", { credentials: "include" }),
        fetch("/api/persons", { credentials: "include" }),
        fetch("/api/whatsapp/contacts", { credentials: "include" }),
        fetch("/api/linkedin/threads", { credentials: "include" }),
      ]);
      const unknownOut = await readLoad<UnknownSender[]>(settled[0], fallback);
      const personsOut = await readLoad<Person[]>(settled[1], fallback);
      const waOut = await readLoad<WhatsAppContact[]>(settled[2], fallback);
      const liOut = await readLoad<LinkedInThread[]>(settled[3], fallback);
      if (seq !== fetchSeq.current) return;

      if ("data" in unknownOut) setUnknowns(unknownOut.data);
      if ("data" in personsOut) {
        setPersons(personsOut.data.filter((p) => p.id !== STRANGER_PERSON_ID));
        invalidatePeople();
      }
      if ("data" in waOut) setWhatsappContacts(waOut.data);
      if ("data" in liOut) setLinkedinThreads(liOut.data);

      setErrors({
        unknowns: "error" in unknownOut ? unknownOut.error : null,
        persons: "error" in personsOut ? personsOut.error : null,
        whatsapp: "error" in waOut ? waOut.error : null,
        linkedin: "error" in liOut ? liOut.error : null,
      });
      // Freshness is only earned when every source answered.
      if ([unknownOut, personsOut, waOut, liOut].every((out) => "data" in out)) {
        setLastFetchedAt(Date.now());
      }
      // No `catch`: `Promise.allSettled` never rejects and `readLoad` reports
      // its own failures per source, so a catch here could only flatten that
      // granularity back into one message for all three sections.
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [invalidatePeople, t]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);

  const counts = useMemo(() => {
    const innerCircle = persons.filter((p) => p.bondLevel === "inner-circle").length;
    const acquaintance = persons.filter((p) => p.bondLevel === "acquaintance").length;
    const other = persons.filter(
      (p) => p.bondLevel !== "inner-circle" && p.bondLevel !== "acquaintance",
    ).length;
    return {
      unmapped: unknowns.length,
      innerCircle,
      acquaintance,
      other,
      known: persons.length,
    };
  }, [unknowns, persons]);

  const filteredPersons = useMemo(() => {
    const sorted = [...persons].sort((a, b) => a.displayName.localeCompare(b.displayName));
    if (knownFilter === "all") return sorted;
    if (knownFilter === "other") {
      return sorted.filter((p) => p.bondLevel !== "inner-circle" && p.bondLevel !== "acquaintance");
    }
    return sorted.filter((p) => p.bondLevel === knownFilter);
  }, [persons, knownFilter]);

  const filteredWhatsappContacts = useMemo(() => {
    const q = waSearch.trim().toLowerCase();
    if (!q) return whatsappContacts;
    return whatsappContacts.filter((c) => {
      const haystack = [
        c.name,
        c.notify,
        c.verifiedName,
        c.chatName,
        c.phoneNumber,
        waPhone(c),
        c.isGroup ? t("whatsapp.groupChat") : null,
        c.jid,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [t, whatsappContacts, waSearch]);

  const filteredLinkedinThreads = useMemo(() => {
    const q = liSearch.trim().toLowerCase();
    if (!q) return linkedinThreads;
    return linkedinThreads.filter((thread) => {
      const haystack = [thread.personName, thread.conversationName, thread.lastMessagePreview]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [linkedinThreads, liSearch]);

  const failedCount = [errors.unknowns, errors.persons, errors.whatsapp, errors.linkedin].filter(
    Boolean,
  ).length;
  const hasLoadError = failedCount > 0;
  const freshness = describeFreshness(t, {
    failed: failedCount,
    total: 4,
    lastFetchedAt,
  });

  const filters: { value: KnownFilter; label: string; count: number }[] = [
    { value: "all", label: t("filters.all"), count: counts.known },
    {
      value: "inner-circle",
      label: t("filters.innerCircle"),
      count: counts.innerCircle,
    },
    {
      value: "acquaintance",
      label: t("filters.acquaintance"),
      count: counts.acquaintance,
    },
    { value: "other", label: t("filters.other"), count: counts.other },
  ];

  return (
    <PageShell>
      <PageBody>
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-title text-foreground">{tCommon("nav.people")}</h1>
            <div className="mt-1 flex items-center gap-2 text-aux text-muted-foreground">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  freshness.live
                    ? "bg-success"
                    : hasLoadError
                      ? "bg-destructive"
                      : "bg-border-strong"
                }`}
                style={
                  freshness.live
                    ? {
                        animation: "rome-activity-breathe 2.4s ease-in-out infinite",
                      }
                    : undefined
                }
                aria-hidden="true"
              />
              <span>{freshness.label}</span>
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={fetchData}>
            {t("header.refresh")}
          </Button>
        </div>

        {/* Unmapped callout */}
        {counts.unmapped > 0 && (
          <Alert variant="warning" className="flex items-center gap-3 px-4 py-2">
            <AlertDescription className="flex items-center gap-2">
              <span
                className="h-1.5 w-1.5 rounded-full bg-warning"
                style={{
                  animation: "rome-activity-pulse 1.6s ease-in-out infinite",
                }}
                aria-hidden="true"
              />
              <span>
                {t(counts.unmapped === 1 ? "unmappedCalloutSingular" : "unmappedCalloutPlural", {
                  count: counts.unmapped,
                })}
              </span>
            </AlertDescription>
          </Alert>
        )}

        {/* Unmapped section */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-section text-foreground">{t("unmapped.heading")}</h2>
              <p className="mt-1 text-aux text-muted-foreground">{t("unmapped.description")}</p>
            </div>
          </div>

          {loading && unknowns.length === 0 ? (
            <SectionLoading label={t("unmapped.loading")} />
          ) : errors.unknowns && unknowns.length === 0 ? (
            <LoadErrorPanel message={errors.unknowns} onRetry={fetchData} />
          ) : unknowns.length === 0 ? (
            <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-10 text-center">
              <p className="text-ui text-muted-foreground">{t("unmapped.emptyTitle")}</p>
              <p className="mt-1 text-aux text-subtle-foreground">{t("unmapped.emptyHint")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {unknowns.map((sender, i) => (
                <div
                  key={`${sender.channel}:${sender.channelUserId}`}
                  style={{
                    animationDelay: `${Math.min(i, 8) * 35}ms`,
                    animationFillMode: "both",
                  }}
                >
                  <SenderCard sender={sender} persons={persons} onRefresh={fetchData} />
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Known persons section */}
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-section text-foreground">{t("known.heading")}</h2>
              <p className="mt-1 text-aux text-muted-foreground">{t("known.description")}</p>
            </div>
          </div>

          {persons.length > 0 && (
            <FilterChipGroup
              aria-label={t("filters.groupLabel")}
              options={filters}
              value={knownFilter}
              onValueChange={setKnownFilter}
              className="mb-4"
            />
          )}

          {loading && persons.length === 0 ? (
            <SectionLoading label={t("known.loading")} />
          ) : errors.persons && persons.length === 0 ? (
            <LoadErrorPanel message={errors.persons} onRetry={fetchData} />
          ) : persons.length === 0 ? (
            <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-10 text-center">
              <p className="text-ui text-muted-foreground">{t("known.emptyTitle")}</p>
              <p className="mt-1 text-aux text-subtle-foreground">{t("known.emptyHint")}</p>
            </div>
          ) : filteredPersons.length === 0 ? (
            <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-8 text-center">
              <p className="text-ui text-muted-foreground">{t("known.emptyForFilter")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredPersons.map((person, i) => (
                <div
                  key={person.id}
                  style={{
                    animationDelay: `${Math.min(i, 8) * 25}ms`,
                    animationFillMode: "both",
                  }}
                >
                  <PersonCard person={person} />
                </div>
              ))}
            </div>
          )}
        </section>

        {/* WhatsApp contacts section — always rendered, so "not connected", "not
          synced yet" and "the endpoint failed" stay distinguishable from each
          other instead of all reading as "this page has no WhatsApp". */}
        <section>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-section text-foreground">{t("whatsapp.heading")}</h2>
              <p className="mt-1 text-aux text-muted-foreground">{t("whatsapp.description")}</p>
            </div>
            {whatsappContacts.length > 0 && (
              <Input
                type="search"
                value={waSearch}
                onChange={(e) => setWaSearch(e.target.value)}
                placeholder={t("whatsapp.searchPlaceholder")}
                className="w-full sm:w-64"
              />
            )}
          </div>
          {loading && whatsappContacts.length === 0 ? (
            <SectionLoading label={t("whatsapp.loadingContacts")} />
          ) : errors.whatsapp && whatsappContacts.length === 0 ? (
            <LoadErrorPanel message={errors.whatsapp} onRetry={fetchData} />
          ) : whatsappContacts.length === 0 ? (
            <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-8 text-center">
              <p className="text-ui text-muted-foreground">{t("whatsapp.emptyTitle")}</p>
              {/* The client can't tell "connected, nothing synced" from "never
                linked", so name the likely cause without asserting either. */}
              <p className="mt-1 text-aux text-subtle-foreground">{t("whatsapp.emptyHint")}</p>
            </div>
          ) : filteredWhatsappContacts.length === 0 ? (
            <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-8 text-center">
              <p className="text-ui text-muted-foreground">{t("whatsapp.emptyForSearch")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredWhatsappContacts.map((c, i) => (
                <div
                  key={c.jid}
                  style={{
                    animationDelay: `${Math.min(i, 8) * 30}ms`,
                    animationFillMode: "both",
                  }}
                >
                  <WhatsAppContactCard contact={c} persons={persons} onRefresh={fetchData} />
                </div>
              ))}
            </div>
          )}
        </section>

        {/* LinkedIn messages section — same always-rendered contract as the
          WhatsApp one: "not connected", "not synced yet" and "the endpoint
          failed" stay distinguishable. */}
        <section>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-section text-foreground">{t("linkedin.heading")}</h2>
              <p className="mt-1 text-aux text-muted-foreground">{t("linkedin.description")}</p>
            </div>
            {linkedinThreads.length > 0 && (
              <Input
                type="search"
                value={liSearch}
                onChange={(e) => setLiSearch(e.target.value)}
                placeholder={t("linkedin.searchPlaceholder")}
                className="w-full sm:w-64"
              />
            )}
          </div>
          {loading && linkedinThreads.length === 0 ? (
            <SectionLoading label={t("linkedin.loadingThreads")} />
          ) : errors.linkedin && linkedinThreads.length === 0 ? (
            <LoadErrorPanel message={errors.linkedin} onRetry={fetchData} />
          ) : linkedinThreads.length === 0 ? (
            <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-8 text-center">
              <p className="text-ui text-muted-foreground">{t("linkedin.emptyTitle")}</p>
              <p className="mt-1 text-aux text-subtle-foreground">{t("linkedin.emptyHint")}</p>
            </div>
          ) : filteredLinkedinThreads.length === 0 ? (
            <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-8 text-center">
              <p className="text-ui text-muted-foreground">{t("linkedin.emptyForSearch")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredLinkedinThreads.map((thread, i) => (
                <div
                  key={thread.threadId}
                  style={{
                    animationDelay: `${Math.min(i, 8) * 30}ms`,
                    animationFillMode: "both",
                  }}
                >
                  <LinkedInThreadCard thread={thread} />
                </div>
              ))}
            </div>
          )}
        </section>
      </PageBody>
    </PageShell>
  );
}
