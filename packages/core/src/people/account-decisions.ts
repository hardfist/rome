// The two writes that decide an account: dismiss it, or restore it to nobody's
// decision. What they mean is the account contract's (@rome/api-types/people);
// where they are stored is the stranger sentinel, which is what "dismissed" has
// always been in this database.
//
// Neither verb invents storage. A dismissal is a channel mapping onto the
// sentinel — the row `/persons/mark-stranger` has always written — and a
// restore is that row's removal. What is new is that both are addressed at an
// account rather than at the sentinel, and that neither can reach an account a
// real person holds: linking and unlinking are that account's verbs, and a
// dismissal that quietly displaced a placement would lose the guardian's work.
//
// The account, not the addressing. A channel that reaches one account several
// ways is folded by `readAccountDirectory`, so a caller holding any address of
// an account decides the account — otherwise a dismissal by the address the
// guardian happened to see would leave the account undismissed by every other
// one.

import {
  accountPresentation,
  linkConflict,
  type AccountDecision,
  type DirectoryAccount,
  type LinkConflict,
} from "@rome/api-types/people";
import { STRANGER_PERSON_DISPLAY_NAME, STRANGER_PERSON_ID } from "../constants.js";
import { readAccountDirectory, type AccountDirectoryDeps } from "./account-directory.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";

export interface AccountDecisionDeps extends AccountDirectoryDeps {
  personMappingRepo: AccountDirectoryDeps["personMappingRepo"] &
    Pick<PersonMappingRepository, "addChannelMapping" | "releaseStrangerClaims">;
}

/** The account a write names: any address the channel reaches it at. */
export interface AccountRef {
  channel: string;
  channelUserId: string;
}

/**
 * What a decision came to.
 *
 * "unknown" is its own answer rather than a decision on an empty account: Rome
 * never mints an account, so a pair no source has observed is a caller's stale
 * page or typo, and writing a dismissal for it would file a decision about
 * nobody that nothing can ever show or undo.
 */
export type AccountDecisionOutcome =
  | { outcome: "decided"; decision: AccountDecision }
  | { outcome: "unknown" }
  | { outcome: "conflict"; conflict: LinkConflict };

/**
 * File an account under the stranger sentinel.
 *
 * Idempotent: an account already dismissed is answered as dismissed and not
 * written again, so a double-click cannot leave two claims on one account.
 */
export async function dismissAccount(
  deps: AccountDecisionDeps,
  ref: AccountRef,
): Promise<AccountDecisionOutcome> {
  const account = await locate(deps, ref);
  if (account == null) return { outcome: "unknown" };

  const conflict = linkConflict(account);
  if (conflict) return { outcome: "conflict", conflict };

  if (account.state !== "dismissed") {
    // The name stays the channel's. This write records a decision, not news
    // about what the platform calls the account, and the naming seam
    // (`AccountNames`) answers that question for every reader anyway.
    await deps.personMappingRepo.addChannelMapping(
      STRANGER_PERSON_ID,
      account.channel,
      account.channelUserId,
    );
  }

  return decided(account, {
    personId: STRANGER_PERSON_ID,
    displayName: STRANGER_PERSON_DISPLAY_NAME,
  });
}

/**
 * Undo a dismissal, leaving the account observed and nobody's.
 *
 * Idempotent in the same way, and refuses a placed account for the same reason
 * dismiss does: restoring is the undo of a dismissal, and an account a person
 * holds carries none — clearing their link is unlink's job, under their name.
 */
export async function restoreAccount(
  deps: AccountDecisionDeps,
  ref: AccountRef,
): Promise<AccountDecisionOutcome> {
  const account = await locate(deps, ref);
  if (account == null) return { outcome: "unknown" };

  const conflict = linkConflict(account);
  if (conflict) return { outcome: "conflict", conflict };

  if (account.state === "dismissed") {
    // Every address, because the dismissal is stored against whichever one it
    // was made by, and an account still claimed by one of its other addresses
    // would read as dismissed the moment the fold ran again.
    await deps.personMappingRepo.releaseStrangerClaims(account.channel, account.addresses);
  }

  return decided(account, null);
}

/**
 * The account behind an address, or null when nothing has observed it.
 *
 * Read through the directory rather than through the mapping table: the
 * directory is what decided the account's state, which addresses are one
 * account, and which person holds it, and a write that answered those questions
 * a second way could refuse what the guardian is looking at, or dismiss an
 * addressing of an account it is not allowed to touch.
 */
async function locate(
  deps: AccountDecisionDeps,
  ref: AccountRef,
): Promise<DirectoryAccount | null> {
  const directory = await readAccountDirectory(deps);
  return (
    directory.find(
      (account) =>
        account.channel === ref.channel &&
        (account.channelUserId === ref.channelUserId ||
          account.addresses.includes(ref.channelUserId)),
    ) ?? null
  );
}

/** The answer a landed write gives, read through the same presentation seam a
 *  directory row is — which is what keeps the sentinel off the wire here. */
function decided(
  account: DirectoryAccount,
  link: { personId: string; displayName: string } | null,
): AccountDecisionOutcome {
  return {
    outcome: "decided",
    decision: {
      channel: account.channel,
      channelUserId: account.channelUserId,
      ...accountPresentation(link),
    },
  };
}
