import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { LinkedInStoreRepository } from "../db/repositories/linkedin-store.js";
import { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import {
  promoteLinkedInParticipant,
  LinkedInPromotionError,
  type LinkedInPromotionDeps,
} from "./linkedin-promote.js";

const ADA = "ACoAABuildingEngine";
const SELF = "ACoAASelfViewer";

describe("promoteLinkedInParticipant", () => {
  let testDb: TestDb;
  let linkedIn: LinkedInStoreRepository;
  let personsRepo: PersonMappingRepository;
  let deps: LinkedInPromotionDeps;

  beforeEach(async () => {
    testDb = createTestDb();
    linkedIn = new LinkedInStoreRepository(testDb.db);
    personsRepo = new PersonMappingRepository(testDb.db);
    deps = { participants: linkedIn, persons: personsRepo };

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
      { participantId: SELF, name: "Me", headline: null, type: "member", isSelf: true },
    ]);
  });

  afterEach(() => {
    testDb.close();
  });

  // Acceptance: promoting a participant creates a person and a `linkedin`
  // channel mapping carrying the member id.
  it("creates a person and a linkedin mapping carrying the member id", async () => {
    const result = await promoteLinkedInParticipant(ADA, deps);

    expect(result.created).toBe(true);

    const person = await personsRepo.findById(result.personId);
    expect(person).not.toBeNull();
    expect(person!.displayName).toBe("Ada Lovelace");
    expect(person!.channelMappings).toContainEqual({
      channel: "linkedin",
      channelUserId: ADA,
    });
  });

  it("reuses the shared person create flow, so the person is reachable by id and by identity", async () => {
    const { personId } = await promoteLinkedInParticipant(ADA, deps);

    // Both reads are the ordinary person reads — promotion adds no second
    // person store of its own.
    const byId = await personsRepo.findById(personId);
    const byIdentity = await personsRepo.findByChannelUser("linkedin", ADA);
    expect(byIdentity?.id).toBe(byId!.id);
    expect(byId!.profilePath).toBe(`memory/relationship/${personId}.md`);
  });

  // The headline has no column on `channel_mappings`; it stays on
  // `linkedin_participants` and belongs in the memory profile.
  it("does not smuggle the headline into the channel mapping", async () => {
    await promoteLinkedInParticipant(ADA, deps);

    const rows = (await testDb.db.all(
      // biome-ignore lint/suspicious/noExplicitAny: raw row read for assertion
      "SELECT display_name FROM channel_mappings WHERE channel = 'linkedin'" as any,
    )) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].display_name).toBe("Ada Lovelace");

    // The headline is still readable where it lives.
    const stored = await linkedIn.getParticipant(ADA);
    expect(stored?.headline).toBe("Building the analytical engine");
  });

  // Acceptance: promoting a participant that is already mapped does not create
  // a second person.
  it("is idempotent — re-promoting returns the same person and creates no second one", async () => {
    const first = await promoteLinkedInParticipant(ADA, deps);
    const second = await promoteLinkedInParticipant(ADA, deps);

    expect(second.personId).toBe(first.personId);
    expect(second.created).toBe(false);

    const persons = (await testDb.db.all(
      // biome-ignore lint/suspicious/noExplicitAny: raw row read for assertion
      "SELECT id FROM persons" as any,
    )) as Array<Record<string, unknown>>;
    expect(persons).toHaveLength(1);
  });

  it("returns the existing person when the identity was already claimed elsewhere", async () => {
    // The identity is already mapped to a person created by another path.
    await personsRepo.create({
      displayName: "Ada L.",
      bondLevel: "acquaintance",
      channelMappings: [{ channel: "linkedin", channelUserId: ADA }],
    });

    const result = await promoteLinkedInParticipant(ADA, deps);
    expect(result.created).toBe(false);

    const persons = (await testDb.db.all(
      // biome-ignore lint/suspicious/noExplicitAny: raw row read for assertion
      "SELECT id FROM persons" as any,
    )) as Array<Record<string, unknown>>;
    expect(persons).toHaveLength(1);
    // The pre-existing person keeps its own name — promotion claims nothing it
    // did not create.
    const person = await personsRepo.findById(result.personId);
    expect(person!.displayName).toBe("Ada L.");
  });

  it("refuses an unknown participant rather than minting a nameless person", async () => {
    await expect(promoteLinkedInParticipant("ACoAAGhost", deps)).rejects.toBeInstanceOf(
      LinkedInPromotionError,
    );

    const persons = (await testDb.db.all(
      // biome-ignore lint/suspicious/noExplicitAny: raw row read for assertion
      "SELECT id FROM persons" as any,
    )) as Array<Record<string, unknown>>;
    expect(persons).toHaveLength(0);
  });

  it("refuses to promote the account owner", async () => {
    await expect(promoteLinkedInParticipant(SELF, deps)).rejects.toBeInstanceOf(
      LinkedInPromotionError,
    );
  });

  it("accepts a caller-chosen bond level and display name", async () => {
    const { personId } = await promoteLinkedInParticipant(ADA, deps, {
      bondLevel: "inner-circle",
      displayName: "Ada (work)",
    });

    const person = await personsRepo.findById(personId);
    expect(person!.bondLevel).toBe("inner-circle");
    expect(person!.displayName).toBe("Ada (work)");
  });

  it("defaults to the acquaintance bond level", async () => {
    const { personId } = await promoteLinkedInParticipant(ADA, deps);
    const person = await personsRepo.findById(personId);
    expect(person!.bondLevel).toBe("acquaintance");
  });

  it("falls back to the member id when the participant has no stored name", async () => {
    await linkedIn.upsertThreadParticipants("t1", [
      { participantId: "ACoAANoName", name: null, headline: null, type: "member", isSelf: false },
    ]);

    const { personId } = await promoteLinkedInParticipant("ACoAANoName", deps);
    const person = await personsRepo.findById(personId);
    expect(person!.displayName).toBe("ACoAANoName");
    expect(person!.channelMappings).toContainEqual({
      channel: "linkedin",
      channelUserId: "ACoAANoName",
    });
  });
});
