import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { LinkedInStoreRepository } from "./linkedin-store.js";

describe("LinkedInStoreRepository", () => {
  let testDb: TestDb;
  let repo: LinkedInStoreRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new LinkedInStoreRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  const thread = (threadId: string, at: Date) => ({
    threadId,
    threadUrl: `https://www.linkedin.com/messaging/thread/${threadId}/`,
    personName: "Ada Lovelace",
    lastMessagePreview: "See you Sunday?",
    lastMessageAt: at,
    unread: true,
    counterpartyType: "member",
    category: "INBOX,PRIMARY_INBOX",
  });

  it("upserts threads and reads back watermarks", async () => {
    const at = new Date("2026-08-19T20:00:00Z");
    await repo.upsertThreads([thread("t1", at)]);

    const cursors = await repo.getThreadCursors(["t1", "missing"]);
    expect(cursors.size).toBe(1);
    const cursor = cursors.get("t1");
    expect(cursor?.lastMessageAt?.getTime()).toBe(at.getTime());
    expect(cursor?.lastMessagePreview).toBe("See you Sunday?");
    expect(cursor?.lastSyncedAt).toBeNull();
  });

  it("a re-listed thread keeps learned fields when the listing drops them", async () => {
    const at = new Date("2026-08-19T20:00:00Z");
    await repo.upsertThreads([thread("t1", at)]);
    await repo.upsertThreads([
      {
        threadId: "t1",
        threadUrl: "https://www.linkedin.com/messaging/thread/t1/",
        personName: null,
        lastMessagePreview: null,
        lastMessageAt: null,
        unread: false,
      },
    ]);

    const cursor = (await repo.getThreadCursors(["t1"])).get("t1");
    expect(cursor?.lastMessagePreview).toBe("See you Sunday?");
    expect(cursor?.lastMessageAt?.getTime()).toBe(at.getTime());
  });

  it("markThreadSynced advances the watermark and records group metadata", async () => {
    await repo.upsertThreads([thread("t1", new Date())]);
    await repo.markThreadSynced("t1", {
      conversationTitle: "Weekend plans",
      isGroup: true,
      participantCount: 3,
    });

    const cursor = (await repo.getThreadCursors(["t1"])).get("t1");
    expect(cursor?.lastSyncedAt).not.toBeNull();
    const row = (await repo.listThreads()).find((t) => t.threadId === "t1");
    expect(row?.conversationName).toBe("Weekend plans");
    expect(row?.isGroup).toBe(true);
    expect(row?.participantCount).toBe(3);
  });

  it("null snapshot metadata never clears what an earlier snapshot learned", async () => {
    await repo.upsertThreads([thread("t1", new Date())]);
    await repo.markThreadSynced("t1", {
      conversationTitle: "Weekend plans",
      isGroup: true,
      participantCount: 3,
    });
    // A later snapshot from an older plugin reports nothing.
    await repo.markThreadSynced("t1", {
      conversationTitle: null,
      isGroup: null,
      participantCount: null,
    });

    const row = (await repo.listThreads()).find((t) => t.threadId === "t1");
    expect(row?.conversationName).toBe("Weekend plans");
    expect(row?.isGroup).toBe(true);
    expect(row?.participantCount).toBe(3);
  });

  it("a never-snapshotted thread reads isGroup as unknown, not 1:1", async () => {
    await repo.upsertThreads([thread("t1", new Date())]);
    const row = (await repo.listThreads()).find((t) => t.threadId === "t1");
    expect(row?.isGroup).toBeNull();
    expect(row?.participantCount).toBeNull();
  });

  it("message upsert is idempotent and refreshes mutable fields", async () => {
    await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
    const base = {
      messageId: "m1",
      threadId: "t1",
      sentAt: new Date("2026-08-19T19:00:00Z"),
      senderName: "Ada Lovelace",
      senderProfileUrl: "https://www.linkedin.com/in/ada/",
      senderHeadline: "Engineer",
      senderType: "member",
      senderIsSelf: false,
      text: "See you Sunday?",
      subject: null,
      reactionCount: null,
    };
    await repo.upsertMessages([base]);
    // The same message re-snapshotted later: an edit and a new reaction.
    await repo.upsertMessages([{ ...base, text: "See you Sunday at 7?", reactionCount: 2 }]);

    const history = await repo.fetchHistory("t1", new Date(0));
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe("See you Sunday at 7?");
  });

  it("listThreads returns newest-conversation-first with message counts", async () => {
    await repo.upsertThreads([
      thread("t-old", new Date("2026-08-10T10:00:00Z")),
      thread("t-new", new Date("2026-08-19T10:00:00Z")),
      {
        threadId: "t-silent",
        threadUrl: "https://www.linkedin.com/messaging/thread/t-silent/",
        personName: "Quiet Contact",
        lastMessagePreview: null,
        lastMessageAt: null,
        unread: false,
      },
    ]);
    await repo.upsertMessages([
      {
        messageId: "m1",
        threadId: "t-new",
        sentAt: new Date("2026-08-19T10:00:00Z"),
        senderName: "Ada Lovelace",
        senderProfileUrl: null,
        senderHeadline: null,
        senderType: "member",
        senderIsSelf: false,
        text: "hello",
        subject: null,
        reactionCount: null,
      },
    ]);

    const rows = await repo.listThreads();
    expect(rows.map((r) => r.threadId)).toEqual(["t-new", "t-old", "t-silent"]);
    expect(rows[0].messageCount).toBe(1);
    expect(rows[0].lastMessageAt).toBe(Math.floor(Date.parse("2026-08-19T10:00:00Z") / 1000));
    expect(rows[0].unread).toBe(true);
    expect(rows[2].lastMessageAt).toBeNull();
  });

  it("getMessages returns the newest slice oldest-first and honors before", async () => {
    await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
    const msg = (messageId: string, iso: string) => ({
      messageId,
      threadId: "t1",
      sentAt: new Date(iso),
      senderName: "Ada Lovelace",
      senderProfileUrl: null,
      senderHeadline: "Engineer",
      senderType: "member",
      senderIsSelf: false,
      text: messageId,
      subject: null,
      reactionCount: null,
    });
    await repo.upsertMessages([
      msg("m1", "2026-08-19T10:00:00Z"),
      msg("m2", "2026-08-19T11:00:00Z"),
      msg("m3", "2026-08-19T12:00:00Z"),
    ]);

    const latestTwo = await repo.getMessages("t1", { limit: 2 });
    expect(latestTwo.map((m) => m.messageId)).toEqual(["m2", "m3"]);
    expect(latestTwo[0].timestamp).toBe(Math.floor(Date.parse("2026-08-19T11:00:00Z") / 1000));

    const beforeM3 = await repo.getMessages("t1", {
      before: Math.floor(Date.parse("2026-08-19T12:00:00Z") / 1000),
    });
    expect(beforeM3.map((m) => m.messageId)).toEqual(["m1", "m2"]);
  });

  it("fetchHistory scopes by thread, filters by since, and orders chronologically", async () => {
    await repo.upsertThreads([
      thread("t1", new Date("2026-08-19T20:00:00Z")),
      thread("t2", new Date("2026-08-19T20:00:00Z")),
    ]);
    const msg = (threadId: string, messageId: string, iso: string, text: string) => ({
      messageId,
      threadId,
      sentAt: new Date(iso),
      senderName: "Ada Lovelace",
      senderProfileUrl: null,
      senderHeadline: null,
      senderType: "member",
      senderIsSelf: false,
      text,
      subject: null,
      reactionCount: null,
    });
    await repo.upsertMessages([
      msg("t1", "m-old", "2026-08-10T10:00:00Z", "old"),
      msg("t1", "m-new", "2026-08-19T10:00:00Z", "new"),
      msg("t2", "m-other", "2026-08-19T11:00:00Z", "other thread"),
    ]);

    const all = await repo.fetchHistory(null, new Date("2026-08-01T00:00:00Z"));
    expect(all.map((m) => m.messageId)).toEqual(["m-old", "m-new", "m-other"]);

    const recentT1 = await repo.fetchHistory("t1", new Date("2026-08-15T00:00:00Z"));
    expect(recentT1.map((m) => m.messageId)).toEqual(["m-new"]);
    expect(recentT1[0].threadName).toBe("Ada Lovelace");
  });

  describe("thread participants", () => {
    const ada = {
      participantId: "ACoAAAda0001",
      name: "Ada Lovelace",
      headline: "Engineer",
      type: "member",
      isSelf: false,
    };
    const grace = {
      participantId: "ACoAAGrace002",
      name: "Grace Hopper",
      headline: "Rear Admiral",
      type: "member",
      isSelf: false,
    };
    const self = {
      participantId: "ACoAASelf0003",
      name: "Me Myself",
      headline: null,
      type: "member",
      isSelf: true,
    };

    // createTestDb applies the real migration folder, so reaching these tables
    // at all proves the generated migration created them.
    it("the migrations create both tables and the participant_id index", () => {
      const objects = testDb.db.all(sql`
        SELECT name, type FROM sqlite_master
        WHERE name IN (
          'linkedin_participants',
          'linkedin_thread_participants',
          'idx_linkedin_thread_participants_participant'
        )
      `) as Array<{ name: string; type: string }>;
      const byName = new Map(objects.map((o) => [o.name, o.type]));

      expect(byName.get("linkedin_participants")).toBe("table");
      expect(byName.get("linkedin_thread_participants")).toBe("table");
      expect(byName.get("idx_linkedin_thread_participants_participant")).toBe("index");
    });

    it("upserting the same participant set twice leaves one row per participant", async () => {
      await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
      await repo.upsertThreadParticipants("t1", [ada, grace, self]);
      await repo.upsertThreadParticipants("t1", [ada, grace, self]);

      const participants = await repo.getThreadParticipants("t1");
      expect(participants.map((p) => p.participantId)).toEqual([
        ada.participantId,
        grace.participantId,
        self.participantId,
      ]);

      // Person-level facts are stored once, not once per thread.
      const personRows = testDb.db.all(sql`
        SELECT COUNT(*) AS c FROM linkedin_participants
      `) as Array<{ c: number }>;
      expect(Number(personRows[0].c)).toBe(3);
    });

    it("upserting a smaller set for a thread drops the members that are gone", async () => {
      await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
      await repo.upsertThreadParticipants("t1", [ada, grace, self]);
      await repo.upsertThreadParticipants("t1", [ada, self]);

      const participants = await repo.getThreadParticipants("t1");
      expect(participants.map((p) => p.participantId)).toEqual([
        ada.participantId,
        self.participantId,
      ]);
      // Membership went away; the person identity is kept for other threads.
      const personRows = testDb.db.all(sql`
        SELECT COUNT(*) AS c FROM linkedin_participants WHERE participant_id = ${grace.participantId}
      `) as Array<{ c: number }>;
      expect(Number(personRows[0].c)).toBe(1);
    });

    it("returns each participant's person-level facts, refreshed by a later snapshot", async () => {
      await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
      await repo.upsertThreadParticipants("t1", [ada, self]);
      // A later snapshot: Ada changed her headline, and reports no type.
      await repo.upsertThreadParticipants("t1", [
        { ...ada, headline: "Countess of Lovelace", type: null },
        self,
      ]);

      const participants = await repo.getThreadParticipants("t1");
      const row = participants.find((p) => p.participantId === ada.participantId);
      expect(row?.name).toBe("Ada Lovelace");
      expect(row?.headline).toBe("Countess of Lovelace");
      // Null means "the snapshot did not say", never "unset what we learned".
      expect(row?.type).toBe("member");
      expect(row?.isSelf).toBe(false);
      expect(participants.find((p) => p.participantId === self.participantId)?.isSelf).toBe(true);
    });

    it("the reverse lookup returns every thread a participant belongs to", async () => {
      await repo.upsertThreads([
        thread("t1", new Date("2026-08-19T20:00:00Z")),
        thread("t2", new Date("2026-08-18T20:00:00Z")),
        thread("t3", new Date("2026-08-17T20:00:00Z")),
      ]);
      await repo.upsertThreadParticipants("t1", [ada, self]);
      await repo.upsertThreadParticipants("t2", [ada, grace, self]);
      await repo.upsertThreadParticipants("t3", [grace, self]);

      expect(await repo.getParticipantThreadIds(ada.participantId)).toEqual(["t1", "t2"]);
      expect(await repo.getParticipantThreadIds(grace.participantId)).toEqual(["t2", "t3"]);
      expect(await repo.getParticipantThreadIds(self.participantId)).toEqual(["t1", "t2", "t3"]);
      expect(await repo.getParticipantThreadIds("ACoAANobody")).toEqual([]);
    });

    it("an empty set clears a thread's membership and reads back empty", async () => {
      await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
      await repo.upsertThreadParticipants("t1", [ada, self]);
      await repo.upsertThreadParticipants("t1", []);

      expect(await repo.getThreadParticipants("t1")).toEqual([]);
      expect(await repo.getParticipantThreadIds(ada.participantId)).toEqual([]);
    });

    it("membership is per thread — one thread's set never disturbs another's", async () => {
      await repo.upsertThreads([
        thread("t1", new Date("2026-08-19T20:00:00Z")),
        thread("t2", new Date("2026-08-18T20:00:00Z")),
      ]);
      await repo.upsertThreadParticipants("t1", [ada, grace]);
      await repo.upsertThreadParticipants("t2", [ada]);
      // Rewriting t2 down to nothing leaves t1 untouched.
      await repo.upsertThreadParticipants("t2", []);

      expect((await repo.getThreadParticipants("t1")).map((p) => p.participantId)).toEqual([
        ada.participantId,
        grace.participantId,
      ]);
      expect(await repo.getParticipantThreadIds(ada.participantId)).toEqual(["t1"]);
    });
  });
});
