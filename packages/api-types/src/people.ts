// The people contract: Person, Account, Link.
//
// Vocabulary and invariants live in docs/concepts/identity.md — an account is
// a platform-owned identity keyed by (channel, channelUserId), a link is the
// recorded fact that an account belongs to a person, and dismissal is a state
// of the account, never a person a client can see. These types are the wire
// contract for the surface that supersedes the /api/identities union:
//
//   GET    /api/people                    -> PeopleList (curated people only)
//   POST   /api/people                    -> PersonResource (201; atomic create-and-link)
//   GET    /api/people/:id                -> PersonResource
//   PATCH  /api/people/:id               -> PersonResource
//   POST   /api/people/:id/accounts       -> PersonResource | LinkConflict (409)
//   DELETE /api/people/:id/accounts/:channel/:channelUserId -> PersonResource
//   POST   /api/people/:id/merge          -> PersonResource
//   GET    /api/people/:id/messages       -> TimelinePage (./identities.js owns
//                                            the timeline types and cursors)
//   GET    /api/accounts[?state=]         -> AccountDirectory
//   POST   /api/accounts/:channel/:channelUserId/dismiss  -> AccountDirectoryRow
//   POST   /api/accounts/:channel/:channelUserId/restore  -> AccountDirectoryRow
//
// No core route serves this contract yet. The dashboard's mock backend is its
// reference implementation, and typing both sides here is what keeps them from
// drifting apart before the backend lands.

import type { AssignableBondLevel, IdentityDynamic } from "./identities.js";
import { STRANGER_PERSON_ID } from "./persons.js";

/** An account's identity: the pair that names it on its platform. Rome never
 *  mints these — every ref is observed from a message or a mirror. */
export interface AccountRef {
  channel: string;
  channelUserId: string;
}

/**
 * The three states an account can be in, from Rome's viewpoint.
 *
 * Mutually exclusive and exhaustive: `unlinked` (observed, attributed to no
 * one), `linked` (attributed to a person), `dismissed` (deliberately
 * attributed to no one the guardian tracks — distinct from `unlinked` because
 * discovery must not resurface it). The state is derived from the link
 * machinery at read time; nothing stores it, so no stored value can disagree
 * with the link it describes.
 */
export const ACCOUNT_STATES = ["unlinked", "linked", "dismissed"] as const;

export type AccountState = (typeof ACCOUNT_STATES)[number];

/** Parse a `?state=` filter, or null when it names no state — an unknown
 *  filter is a caller error, not an empty view. */
export function parseAccountStateFilter(raw: string | undefined | null): AccountState | null {
  return (ACCOUNT_STATES as readonly string[]).includes(raw ?? "") ? (raw as AccountState) : null;
}

/**
 * How an account's owner serializes onto the wire.
 *
 * This function is the rule that keeps the stranger sentinel out of the
 * contract: a dismissal is stored as a link to the sentinel row, and every
 * producer — route and mock alike — reads this rule instead of leaking that
 * row's id and name as if it were a person. `personId` and `personName` are
 * non-null exactly when `state` is `linked`.
 */
export function accountPresentation(
  owner: { id: string; displayName: string } | null | undefined,
): Pick<AccountDirectoryRow, "state" | "personId" | "personName"> {
  if (!owner) return { state: "unlinked", personId: null, personName: null };
  if (owner.id === STRANGER_PERSON_ID) {
    return { state: "dismissed", personId: null, personName: null };
  }
  return { state: "linked", personId: owner.id, personName: owner.displayName };
}

/** One account as it appears under the person that holds its link.
 *  `displayName` is platform-supplied — each provider's directory answers what
 *  its platform calls the account, and the raw id is only the last resort. */
export interface LinkedAccount extends AccountRef {
  displayName: string;
}

/**
 * A person with their linked accounts and cross-account activity.
 *
 * `bondLevel` is the stored value, free text included: older rows carry levels
 * outside the assignable set ("colleague"), and a client buckets them rather
 * than the contract pretending they cannot exist. `latest` and `messageCount`
 * aggregate over every linked account, with the same record-counting rule as
 * the identities union: reactions and Rome's own replies count as records even
 * where the timeline does not render them as entries.
 */
export interface PersonResource {
  id: string;
  displayName: string;
  bondLevel: string;
  accounts: LinkedAccount[];
  messageCount: number;
  latest: IdentityDynamic | null;
}

/** `GET /api/people` — curated people only. The stranger sentinel is
 *  structure, not a person, and never appears here. */
export interface PeopleList {
  people: PersonResource[];
}

/**
 * One account in the directory, whatever its state.
 *
 * The directory is the discovery surface: `?state=unlinked` is the queue of
 * senders waiting to be linked or dismissed, and replaces both the
 * /api/persons/unknown queue and the union's unknown rows.
 */
export interface AccountDirectoryRow extends AccountRef {
  displayName: string;
  state: AccountState;
  /** The linked person, or null. Never the stranger sentinel — a dismissed
   *  account answers `state: "dismissed"` with both fields null. */
  personId: string | null;
  personName: string | null;
  messageCount: number;
  latest: IdentityDynamic | null;
}

/** `GET /api/accounts` — every account ever observed, from links, the
 *  sentinel log, and the channel mirrors. */
export interface AccountDirectory {
  accounts: AccountDirectoryRow[];
}

/**
 * `POST /api/people` — create, with optional atomic linking.
 *
 * Atomic means both-or-neither: if any named account is linked to a real
 * person, the whole request refuses with a {@link LinkConflict} and no person
 * is created. Accounts held by the dismissal machinery link silently, same as
 * {@link LinkAccountRequest}.
 */
export interface CreatePersonRequest {
  displayName: string;
  /** Defaults to "other". */
  bondLevel?: AssignableBondLevel;
  accounts?: AccountRef[];
}

/** `PATCH /api/people/:id`. The guardian's bond level refuses to change. */
export interface UpdatePersonRequest {
  displayName?: string;
  bondLevel?: AssignableBondLevel;
}

/**
 * `POST /api/people/:id/accounts` — the link verb.
 *
 * Compare-and-swap on the account's current owner: linking an unlinked or
 * dismissed account needs no `transferFrom`, re-linking to the same person is
 * an idempotent no-op, and taking an account from another person requires
 * `transferFrom` naming that person exactly. Anything else answers 409 with a
 * {@link LinkConflict}. The explicitness is the point — a transfer
 * re-attributes the account's whole message history, so it never happens as a
 * side effect of an optimistic retry.
 */
export interface LinkAccountRequest extends AccountRef {
  transferFrom?: string;
}

/** The 409 body for a refused link: names the current owner so the caller can
 *  render the conflict and offer an explicit transfer. */
export interface LinkConflict {
  error: string;
  channel: string;
  channelUserId: string;
  linkedPersonId: string;
  linkedPersonName: string;
}

/** `POST /api/people/:id/merge` — :id absorbs `from`: every link transfers
 *  atomically, then `from` is deleted. First-class rather than N transfers
 *  and a delete, because history re-attribution must not half-happen. */
export interface MergeRequest {
  from: string;
}
