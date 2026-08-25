import type { LinkedInParticipantRow } from "./linkedin-sync.js";

/**
 * Promotion of a mirrored LinkedIn identity into the curated person graph.
 *
 * The mirror (`linkedin_participants`) and the person graph (`persons` +
 * `channel_mappings`) answer different questions: the mirror records everyone
 * a polled inbox happens to contain, while the person graph records who the
 * guardian has decided to know. Promotion is the one-way door between them, and
 * it only ever opens on a guardian action — never from the poller, which would
 * otherwise drag a whole inbox of recruiters into the graph.
 *
 * The bridge itself needs no translation. `linkedin_participants.participant_id`
 * holds the bare member id (`ACoAA…`), which is exactly what an inbound
 * LinkedIn message normalizes its sender to, so writing that value as
 * `channel_mappings.channel_user_id` is all it takes for the promoted person to
 * resolve on their next message — the same trick the `wa_*` mirror plays with
 * the JID.
 */

/** The channel name a promoted LinkedIn identity is mapped under. */
export const LINKEDIN_CHANNEL = "linkedin";

/** Bond levels promotion may confer. `guardian` is deliberately absent: it is
 *  conferred by the terminal, not by pointing at an inbox row. */
export type PromotableBondLevel = "inner-circle" | "acquaintance" | "other";

const DEFAULT_BOND_LEVEL: PromotableBondLevel = "acquaintance";

/** A participant that has never been mirrored, or must not become a person. */
export class LinkedInPromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkedInPromotionError";
  }
}

/** The slice of the LinkedIn store promotion reads. */
export interface LinkedInParticipantReader {
  getParticipant(participantId: string): Promise<LinkedInParticipantRow | null>;
}

/**
 * The slice of {@link PersonMappingRepository} promotion writes through. Named
 * as an interface rather than taking the repository itself so this stays a
 * caller of the existing person create/link flow instead of a second one.
 */
export interface PersonGraphWriter {
  findByChannelUser(
    channel: string,
    channelUserId: string,
  ): Promise<{ id: string; displayName: string } | null>;
  generatePersonId(displayName: string): Promise<string>;
  createWithChannelMapping(
    id: string,
    data: {
      displayName: string;
      bondLevel: "guardian" | "inner-circle" | "acquaintance" | "other";
      profilePath?: string;
      approved?: boolean;
    },
    mapping: { channel: string; channelUserId: string; displayName?: string },
  ): Promise<string>;
}

export interface LinkedInPromotionDeps {
  participants: LinkedInParticipantReader;
  persons: PersonGraphWriter;
}

export interface LinkedInPromotionOptions {
  /** Overrides the mirrored name. Falls back to it, then to the member id. */
  displayName?: string;
  /** Defaults to `acquaintance` — promotion says "this is a person", not "this
   *  person is close". Re-grading is the person graph's own business. */
  bondLevel?: PromotableBondLevel;
}

export interface LinkedInPromotionResult {
  personId: string;
  /** False when the identity was already mapped, so nothing new was written. */
  created: boolean;
}

/**
 * Promote one mirrored LinkedIn participant into a Rome person.
 *
 * Idempotent by identity, not by call: the `(channel, channel_user_id)` unique
 * constraint already makes a second mapping impossible, so the only real risk
 * is a second *person* orphaning the first. Checking the mapping before minting
 * anything closes that, and re-promoting simply reports the person already
 * standing there.
 *
 * The headline is not written anywhere here. `channel_mappings` has no column
 * for it, and it stays authoritative on `linkedin_participants`; a person's
 * headline belongs in their memory profile, which is prose, not a mapping row.
 */
export async function promoteLinkedInParticipant(
  participantId: string,
  deps: LinkedInPromotionDeps,
  options: LinkedInPromotionOptions = {},
): Promise<LinkedInPromotionResult> {
  const memberId = participantId.trim();
  if (!memberId) {
    throw new LinkedInPromotionError("a LinkedIn member id is required to promote a participant");
  }

  // Ask the person graph first. An identity already claimed has an answer that
  // does not depend on the mirror still holding a row for it.
  const existing = await deps.persons.findByChannelUser(LINKEDIN_CHANNEL, memberId);
  if (existing) return { personId: existing.id, created: false };

  const participant = await deps.participants.getParticipant(memberId);
  if (!participant) {
    throw new LinkedInPromotionError(`unknown LinkedIn participant: ${memberId}`);
  }
  if (participant.isSelf) {
    throw new LinkedInPromotionError(
      "refusing to promote the account owner: the guardian is not a contact of their own inbox",
    );
  }

  // A person must be nameable. The member id is a poor name but an honest one,
  // and it keeps a nameless mirror row from blocking a deliberate promotion.
  const displayName = options.displayName?.trim() || participant.name?.trim() || memberId;
  const bondLevel = options.bondLevel ?? DEFAULT_BOND_LEVEL;

  const personId = await deps.persons.generatePersonId(displayName);
  // The shared create/link flow, transactional: a person whose mapping failed
  // to write would be unreachable, and an unreachable person is worse than none.
  await deps.persons.createWithChannelMapping(
    personId,
    {
      displayName,
      bondLevel,
      profilePath: `memory/relationship/${personId}.md`,
      approved: true,
    },
    { channel: LINKEDIN_CHANNEL, channelUserId: memberId, displayName },
  );

  return { personId, created: true };
}
