import type { TFunction } from "i18next";
import type {
  CreatePersonRequest,
  DirectoryAccount,
  LinkAccountRequest,
  LinkConflict,
  PersonResource,
  UpdatePersonRequest,
} from "@rome/api-types/people";

// The People page's writes, at the wire: one function per verb of the /people
// contract (@rome/api-types/people), and no view logic. What each verb means,
// when it refuses and what a refusal carries are the contract's; this module
// only names the route and reduces the answer to something a click handler can
// render.
//
// An account is named by the pair the contract says is its identity, never by
// one of the addresses it answers to. The server folds a WhatsApp contact's
// phone jid and `@lid` jid into one account and reports both in `addresses`, so
// a gesture on a row already covers every address it stands for — the reason
// none of these takes a list.

/** An account, named the way every verb here names one. */
export interface AccountRef {
  channel: string;
  channelUserId: string;
}

/**
 * What a write answers.
 *
 * A conflict is its own outcome rather than an error string: the caller has to
 * name the person who holds the account and offer an explicit transfer, and a
 * sentence it would have to parse is not a person's id.
 */
export type WriteOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; conflict: LinkConflict }
  | { ok: false; message: string };

function isLinkConflict(payload: unknown): payload is LinkConflict {
  if (typeof payload !== "object" || payload === null) return false;
  const body = payload as Record<string, unknown>;
  return typeof body.channel === "string" && typeof body.channelUserId === "string";
}

/**
 * The path an account occupies, escaped, with its own separators left in place.
 *
 * The routes take the rest of the path as the identifier: a channel mints its
 * own addresses and channels are open — a Rome App brings one — so nothing
 * promises they avoid "/", and a percent-escaped one would name a segment the
 * route never sees.
 */
function accountPath(account: AccountRef): string {
  const identifier = account.channelUserId.split("/").map(encodeURIComponent).join("/");
  return `${encodeURIComponent(account.channel)}/${identifier}`;
}

/**
 * Send one write and reduce whatever comes back. Never throws — every caller is
 * an event handler, where an unhandled rejection leaves the gesture silent.
 *
 * Only a 4xx body is treated as copy. These routes answer a rejected request
 * with an `{ error }` naming what is wrong with it, which is what the guardian
 * needs. A 5xx body carries the same shape and not the same meaning: the API
 * error handler serializes an unhandled exception as `{ error: err.message }`,
 * so trusting it would put a raw SQLite or repository message on screen.
 */
async function send<T>(
  url: string,
  init: { method: string; json?: unknown },
  t: TFunction<"people">,
): Promise<WriteOutcome<T>> {
  const response = await fetch(url, {
    method: init.method,
    credentials: "include",
    cache: "no-store",
    ...(init.json === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.json) }),
  }).catch(() => null);

  if (!response) return { ok: false, message: t("errors.network") };
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) return { ok: true, value: payload as T };
  if (response.status === 409 && isLinkConflict(payload)) return { ok: false, conflict: payload };
  if (response.status >= 500) return { ok: false, message: t("errors.requestFailed") };
  const error = (payload as { error?: unknown } | null)?.error;
  return {
    ok: false,
    message: typeof error === "string" && error !== "" ? error : t("errors.requestFailed"),
  };
}

/** `POST /api/people`. Both-or-neither: a create naming an account somebody
 *  holds refuses whole, so a person never exists without the account that was
 *  the reason to create them. */
export function createPerson(
  request: CreatePersonRequest,
  t: TFunction<"people">,
): Promise<WriteOutcome<PersonResource>> {
  return send("/api/people", { method: "POST", json: request }, t);
}

/** `POST /api/people/:id/accounts`. `transferFrom` names the person the account
 *  is taken from, and is what makes a transfer something the guardian asked
 *  for rather than the side effect of a retry. */
export function linkAccount(
  personId: string,
  request: LinkAccountRequest,
  t: TFunction<"people">,
): Promise<WriteOutcome<PersonResource>> {
  return send(
    `/api/people/${encodeURIComponent(personId)}/accounts`,
    { method: "POST", json: request },
    t,
  );
}

/**
 * `DELETE /api/people/:id/accounts/:channel/:channelUserId`.
 *
 * No gesture calls this yet — the row menu that would is still ahead. It sits
 * here because this module is the contract's verbs and a wire missing one reads
 * as a verb that does not exist; `./use-writes.ts` carries only the gestures the
 * page has.
 */
export function unlinkAccount(
  personId: string,
  account: AccountRef,
  t: TFunction<"people">,
): Promise<WriteOutcome<PersonResource>> {
  return send(
    `/api/people/${encodeURIComponent(personId)}/accounts/${accountPath(account)}`,
    { method: "DELETE" },
    t,
  );
}

/** `POST /api/accounts/:channel/:channelUserId/dismiss`. Dismissal is a state
 *  the account is in, not a merge into a sentinel, so {@link restoreAccount} is
 *  the whole way back. */
export function dismissAccount(
  account: AccountRef,
  t: TFunction<"people">,
): Promise<WriteOutcome<DirectoryAccount>> {
  return send(`/api/accounts/${accountPath(account)}/dismiss`, { method: "POST" }, t);
}

/** `POST /api/accounts/:channel/:channelUserId/restore`. */
export function restoreAccount(
  account: AccountRef,
  t: TFunction<"people">,
): Promise<WriteOutcome<DirectoryAccount>> {
  return send(`/api/accounts/${accountPath(account)}/restore`, { method: "POST" }, t);
}

/** `POST /api/people/:id/merge`. The survivor is named in the path and the
 *  duplicate in the body: every link transfers atomically, then the duplicate
 *  is gone. */
export function mergePeople(
  into: string,
  from: string,
  t: TFunction<"people">,
): Promise<WriteOutcome<PersonResource>> {
  return send(
    `/api/people/${encodeURIComponent(into)}/merge`,
    { method: "POST", json: { from } },
    t,
  );
}

/** `PATCH /api/people/:id`. An omitted field is one the update leaves alone, so
 *  a bond change carries the bond and nothing else. */
export function updatePerson(
  personId: string,
  update: UpdatePersonRequest,
  t: TFunction<"people">,
): Promise<WriteOutcome<PersonResource>> {
  return send(`/api/people/${encodeURIComponent(personId)}`, { method: "PATCH", json: update }, t);
}
