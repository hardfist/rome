import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { LinkedInStoreRepository } from "../../db/repositories/linkedin-store.js";
import { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import { promoteLinkedInParticipant } from "../../channels/linkedin-promote.js";
import { toHistoryNormalizedMessage } from "./linkedin.js";
import type { LinkedInHistoryMessage } from "../../channels/linkedin-sync.js";

const ADA = "ACoAABuildingEngine";

const historyRow = (over: Partial<LinkedInHistoryMessage> = {}): LinkedInHistoryMessage => ({
  messageId: "m1",
  threadId: "t1",
  threadName: "Ada Lovelace",
  sentAt: new Date("2026-08-19T20:00:00Z"),
  senderName: "Ada Lovelace",
  senderProfileUrl: `https://www.linkedin.com/in/${ADA}/`,
  senderIsSelf: false,
  text: "See you Sunday?",
  subject: null,
  ...over,
});

describe("toHistoryNormalizedMessage", () => {
  // The bare member id is what `linkedin_participants.participant_id` and
  // therefore `channel_mappings.channel_user_id` hold. An inbound message that
  // carried the whole profile URL instead would never match a promoted person.
  it("maps the sender to the bare member id, not the profile URL", () => {
    const normalized = toHistoryNormalizedMessage(historyRow());
    expect(normalized.channel).toBe("linkedin");
    expect(normalized.channelUserId).toBe(ADA);
  });

  it("reads the member id out of any of LinkedIn's profile URL shapes", () => {
    for (const url of [
      `https://www.linkedin.com/in/${ADA}/`,
      `https://www.linkedin.com/in/${ADA}`,
      `https://linkedin.com/in/${ADA}/?originalSubdomain=uk`,
    ]) {
      expect(toHistoryNormalizedMessage(historyRow({ senderProfileUrl: url })).channelUserId).toBe(
        ADA,
      );
    }
  });

  // A vanity handle is a public alias, not the member id the tables key on.
  // Keeping the URL verbatim is honest; inventing a member id from it is not.
  it("keeps the URL verbatim when it carries a vanity handle instead of a member id", () => {
    const url = "https://www.linkedin.com/in/ada-lovelace/";
    expect(toHistoryNormalizedMessage(historyRow({ senderProfileUrl: url })).channelUserId).toBe(
      url,
    );
  });

  it("still labels self and unknown senders when no profile URL was mirrored", () => {
    expect(
      toHistoryNormalizedMessage(historyRow({ senderProfileUrl: null, senderIsSelf: true }))
        .channelUserId,
    ).toBe("linkedin:self");
    expect(
      toHistoryNormalizedMessage(historyRow({ senderProfileUrl: null, senderIsSelf: false }))
        .channelUserId,
    ).toBe("linkedin:unknown");
  });
});

describe("promoted participant resolution", () => {
  let testDb: TestDb;
  let linkedIn: LinkedInStoreRepository;
  let personsRepo: PersonMappingRepository;

  beforeEach(async () => {
    testDb = createTestDb();
    linkedIn = new LinkedInStoreRepository(testDb.db);
    personsRepo = new PersonMappingRepository(testDb.db);

    await linkedIn.upsertThreads([
      {
        threadId: "t1",
        threadUrl: "https://www.linkedin.com/messaging/thread/t1/",
        personName: "Ada Lovelace",
        lastMessagePreview: "See you Sunday?",
        lastMessageAt: new Date("2026-08-19T20:00:00Z"),
        unread: true,
        counterpartyType: "member",
        category: "INBOX,PRIMARY_INBOX",
      },
    ]);
    await linkedIn.upsertThreadParticipants("t1", [
      {
        participantId: ADA,
        name: "Ada Lovelace",
        headline: "Building the analytical engine",
        type: "member",
        isSelf: false,
      },
    ]);
  });

  afterEach(() => {
    testDb.close();
  });

  // Acceptance: a message from a promoted participant resolves to that person.
  it("resolves a message from a promoted participant to that person", async () => {
    const { personId } = await promoteLinkedInParticipant(ADA, {
      participants: linkedIn,
      persons: personsRepo,
    });

    // The next inbound message, normalized exactly as the talker does it.
    const normalized = toHistoryNormalizedMessage(historyRow());
    const resolved = await personsRepo.findByChannelUser(
      normalized.channel,
      normalized.channelUserId,
    );

    expect(resolved?.id).toBe(personId);
    expect(resolved?.displayName).toBe("Ada Lovelace");
  });

  it("does not resolve a participant that was never promoted", async () => {
    const normalized = toHistoryNormalizedMessage(historyRow());
    expect(
      await personsRepo.findByChannelUser(normalized.channel, normalized.channelUserId),
    ).toBeNull();
  });
});
