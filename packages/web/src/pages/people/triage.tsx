import { useId, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { PersonResource } from "@rome/api-types/people";
import { normalizeBondLevel } from "@rome/api-types/identities";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { cn } from "@/lib/utils";
import { UnknownRow } from "./rows";
import { levelLabelKey } from "./rows";
import type { PeopleRow } from "./people-model";

// Placing an account that nobody has decided about: create a person for it,
// link it onto one that exists, or dismiss it.
//
// These are the page's one set of write gestures, and they are carried forward
// rather than rebuilt: they still post to the legacy `/api/persons/*` routes,
// and repointing them onto the /people contract — where they become one "move"
// along the ladder, from a row menu — is rome-os/rome#67. What this module owes
// the rebuild is the row they hang off, which is the new one.

const BOND_FORM_OPTIONS = ["inner-circle", "acquaintance", "other"] as const;

/**
 * A submit label that swaps to a busy phrasing while the request is in flight.
 *
 * Both strings share one grid cell, so the box is always as wide as the longer
 * of the two and the swap never resizes the button. The inactive one is
 * `invisible` (which browsers already drop from the accessibility tree) *and*
 * `aria-hidden`, because jsdom computes accessible names without layout —
 * without the attribute a test would read both labels concatenated.
 */
export function BusyLabel({ idle, busy, isBusy }: { idle: string; busy: string; isBusy: boolean }) {
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

/**
 * POST a person mutation and reduce whatever comes back to "it worked" or a
 * message worth showing. Never throws — the callers are event handlers, where
 * an unhandled rejection would leave the row silent.
 *
 * Only a 4xx body is treated as copy. These routes answer a rejected request
 * with an `{ error }` naming the missing field, which is exactly what the
 * guardian needs. A 5xx body carries the same shape but not the same meaning:
 * the API error handler serializes an unhandled exception as
 * `{ error: err.message }`, so trusting it would put a raw SQLite or repository
 * message on screen.
 */
export async function postPersonMutation(
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
  const payload = (await res.json().catch(() => null)) as { error?: string } | null;
  return { ok: false, error: payload?.error || t("errors.requestFailed") };
}

/** Why the last write failed, sitting at the left end of a button row. */
export function MutationError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mr-auto text-aux text-destructive-fg">
      {message}
    </p>
  );
}

function CreateProfileForm({
  defaultName,
  error,
  onSubmit,
  onCancel,
}: {
  /** What the account's own platform calls it — the name a person is most
   *  likely to be created under, and never a linked person's. */
  defaultName: string;
  error: string | null;
  onSubmit: (data: { displayName: string; bondLevel: string; relation: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation("people");
  const uid = useId();
  const form = useForm({
    defaultValues: { displayName: defaultName, bondLevel: "acquaintance", relation: "" },
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
      className="mb-2 space-y-3 rounded-8 border border-border-subtle bg-surface-muted/60 p-3"
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
                      {t(levelLabelKey(value))}
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
        selector={(s) => ({ isSubmitting: s.isSubmitting, displayName: s.values.displayName })}
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
  people,
  error,
  onSubmit,
  onCancel,
}: {
  people: PersonResource[];
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
      className="mb-2 space-y-3 rounded-8 border border-border-subtle bg-surface-muted/60 p-3"
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
                {people.map((person) => (
                  <SelectItem key={person.id} value={person.id}>
                    {person.displayName} · {t(levelLabelKey(normalizeBondLevel(person.bondLevel)))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      <form.Subscribe<{ isSubmitting: boolean; selectedId: string }>
        selector={(s) => ({ isSubmitting: s.isSubmitting, selectedId: s.values.selectedId })}
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

/**
 * One unplaced account, with the gestures that place it.
 *
 * The row is the rebuild's; the gestures are the page's existing ones, which
 * still name an account by the pair (channel, channelUserId) the contract says
 * is its identity. A dismissal is confirmed first: it writes a permanent
 * mapping the dashboard cannot reverse.
 */
export function UnknownEntry({
  row,
  people,
  onSettled,
}: {
  row: PeopleRow;
  /** The people a link can land on — the listing's own rows. */
  people: PersonResource[];
  onSettled: () => void;
}) {
  const { t } = useTranslation("people");
  const [action, setAction] = useState<"create" | "link" | null>(null);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingStranger, setConfirmingStranger] = useState(false);
  const account = row.accounts[0];
  const name = row.displayName || account?.channelUserId || "";

  /** Opening, switching or cancelling a form drops the previous failure. */
  function openAction(next: "create" | "link" | null) {
    setError(null);
    setAction(next);
  }

  async function handleCreate(data: { displayName: string; bondLevel: string; relation: string }) {
    if (!account) return;
    setError(null);
    const res = await postPersonMutation(
      "/api/persons/create",
      { ...data, channel: account.channel, channelUserId: account.channelUserId },
      t,
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setAction(null);
    onSettled();
  }

  async function handleLink(personId: string) {
    if (!account) return;
    setError(null);
    const res = await postPersonMutation(
      "/api/persons/link",
      {
        channel: account.channel,
        channelUserId: account.channelUserId,
        existingPersonId: personId,
        displayName: row.displayName,
      },
      t,
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setAction(null);
    onSettled();
  }

  async function handleMarkStranger() {
    if (!account) return;
    // The row's own trigger names the running operation, so the dialog steps out
    // of the way the moment the write starts rather than sitting there disabled
    // with nothing to say.
    setConfirmingStranger(false);
    setActing(true);
    setError(null);
    try {
      const res = await postPersonMutation(
        "/api/persons/mark-stranger",
        {
          channel: account.channel,
          channelUserId: account.channelUserId,
          displayName: row.displayName,
        },
        t,
      );
      // A write that didn't land leaves the account exactly where it was. Say
      // so — closing the dialog silently reads as success, which is the
      // opposite of what this confirmation exists to do.
      if (res.ok) onSettled();
      else setError(res.error);
    } finally {
      setActing(false);
    }
  }

  return (
    <div>
      <UnknownRow
        row={row}
        actions={
          !action && (
            <span className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                onClick={() => openAction("create")}
                disabled={acting}
              >
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
            </span>
          )
        }
      />

      {/* With no form open the failure belongs to the dismissal, whose button
          sits on the row above. */}
      {!action && error && (
        <div className="flex justify-end px-2 pb-2">
          <MutationError message={error} />
        </div>
      )}

      {action === "create" && (
        <CreateProfileForm
          defaultName={row.displayName}
          error={error}
          onSubmit={handleCreate}
          onCancel={() => openAction(null)}
        />
      )}
      {action === "link" && (
        <LinkForm
          people={people}
          error={error}
          onSubmit={handleLink}
          onCancel={() => openAction(null)}
        />
      )}

      <RomeConfirmDialog
        open={confirmingStranger}
        destructive
        title={t("strangerConfirm.title", { name })}
        // A dismissal does not take the account off the directory — it moves it
        // to the Stranger end of the ladder, which has a chip of its own — so
        // the copy names the listing it leaves.
        description={t("strangerConfirm.description", {
          name,
          section: t("levels.unknown"),
        })}
        // Deliberately the same words as the trigger: the button that opens the
        // confirm and the button that carries it out promise the same thing.
        confirmLabel={t("actions.markStranger")}
        cancelLabel={t("actions.cancel")}
        onCancel={() => setConfirmingStranger(false)}
        onConfirm={() => void handleMarkStranger()}
      />
    </div>
  );
}
