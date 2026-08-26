import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import {
  LinkedInStoreRepository,
  linkedInMemberId,
  linkedInMemberIdFromProfileUrl,
} from "./linkedin-store.js";
import { PersonMappingRepository } from "./person-mapping.js";

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
    });

    const cursor = (await repo.getThreadCursors(["t1"])).get("t1");
    expect(cursor?.lastSyncedAt).not.toBeNull();
    const row = (await repo.listThreads()).find((t) => t.threadId === "t1");
    expect(row?.conversationName).toBe("Weekend plans");
    expect(row?.isGroup).toBe(true);
  });

  it("null snapshot metadata never clears what an earlier snapshot learned", async () => {
    await repo.upsertThreads([thread("t1", new Date())]);
    await repo.markThreadSynced("t1", {
      conversationTitle: "Weekend plans",
      isGroup: true,
    });
    // A later snapshot from an older plugin reports nothing.
    await repo.markThreadSynced("t1", {
      conversationTitle: null,
      isGroup: null,
    });

    const row = (await repo.listThreads()).find((t) => t.threadId === "t1");
    expect(row?.conversationName).toBe("Weekend plans");
    expect(row?.isGroup).toBe(true);
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

    it("the migrations add the per-thread membership read timestamp", () => {
      const columns = testDb.db.all(
        sql`SELECT name FROM pragma_table_info('linkedin_threads')`,
      ) as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toContain("participants_last_read_at");
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

    it("a failure part-way through a replace leaves the previous set intact", async () => {
      await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
      await repo.upsertThreadParticipants("t1", [grace]);

      // More than one chunk, with the failure in the last one: without a
      // transaction the earlier chunks land and the thread ends up
      // over-inclusive — new members added, the departed one never deleted.
      const many = Array.from({ length: 200 }, (_, i) => ({
        participantId: `ACoAAFill${String(i).padStart(4, "0")}`,
        name: `Filler ${i}`,
        headline: null,
        type: "member",
        isSelf: false,
      }));
      // better-sqlite3 refuses to bind an object, so this throws mid-replace.
      const unbindable = {
        participantId: {} as unknown as string,
        name: "Boom",
        headline: null,
        type: "member",
        isSelf: false,
      };

      await expect(repo.upsertThreadParticipants("t1", [...many, unbindable])).rejects.toThrow();

      expect((await repo.getThreadParticipants("t1")).map((p) => p.participantId)).toEqual([
        grace.participantId,
      ]);
      const identities = testDb.db.all(sql`
        SELECT COUNT(*) AS c FROM linkedin_participants
      `) as Array<{ c: number }>;
      expect(Number(identities[0].c)).toBe(1);
    });

    it("is_self survives a re-snapshot and follows the viewer's answer", async () => {
      await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
      await repo.upsertThreadParticipants("t1", [ada, self]);
      // A later snapshot reporting the same set must not flip the owner's row.
      await repo.upsertThreadParticipants("t1", [ada, self]);

      const after = await repo.getThreadParticipants("t1");
      expect(after.find((p) => p.participantId === self.participantId)?.isSelf).toBe(true);
      expect(after.find((p) => p.participantId === ada.participantId)?.isSelf).toBe(false);
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

    // These tables are a cache of a pull-only mirror, so a read of them has to
    // say when it was taken. `getThreadParticipantSet` pairs the membership
    // with that timestamp; a null one means "never authoritatively read".
    describe("membership freshness", () => {
      it("a thread that has never been read reports a null last-read time", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);

        const set = await repo.getThreadParticipantSet("t1");
        expect(set.participants).toEqual([]);
        expect(set.lastReadAt).toBeNull();
      });

      it("replacing a thread's participants records when the membership was read", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        const before = Date.now();
        await repo.upsertThreadParticipants("t1", [ada, self]);
        const after = Date.now();

        const set = await repo.getThreadParticipantSet("t1");
        expect(set.participants.map((p) => p.participantId)).toEqual([
          ada.participantId,
          self.participantId,
        ]);
        const readAt = set.lastReadAt?.getTime() ?? 0;
        // Second-resolution storage: floor the window so a read taken at
        // x.9s and stored as x.0s still lands inside it.
        expect(readAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
        expect(readAt).toBeLessThanOrEqual(after);
      });

      it("a later read advances the last-read time", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertThreadParticipants("t1", [ada]);
        // Backdate the first read so the second is unambiguously newer than it.
        testDb.db.run(
          sql`UPDATE linkedin_threads SET participants_last_read_at = 1000 WHERE thread_id = 't1'`,
        );

        await repo.upsertThreadParticipants("t1", [ada, grace]);

        const set = await repo.getThreadParticipantSet("t1");
        expect(set.lastReadAt?.getTime()).toBeGreaterThan(1000 * 1000);
      });

      it("a re-read whose membership changed leaves the stored set matching it", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertThreadParticipants("t1", [ada, grace, self]);
        // Grace left, a new member joined.
        await repo.upsertThreadParticipants("t1", [
          ada,
          self,
          { ...grace, participantId: "ACoAANew00004", name: "New Person" },
        ]);

        const set = await repo.getThreadParticipantSet("t1");
        expect(set.participants.map((p) => p.participantId).sort()).toEqual([
          ada.participantId,
          "ACoAANew00004",
          self.participantId,
        ]);
        expect(set.lastReadAt).not.toBeNull();
      });
    });

    // The count a reader sees is a fact about the stored membership, not a
    // scalar the thread snapshot volunteered. The two used to be independent —
    // the number said "5" while the table held three people and nothing could
    // tell which was wrong.
    describe("participant count derived from membership", () => {
      it("the count a reader sees is the size of the stored membership", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertThreadParticipants("t1", [ada, grace, self]);

        const row = (await repo.listThreads()).find((t) => t.threadId === "t1");
        expect(row?.participantCount).toBe(3);
        expect(row?.participantCount).toBe((await repo.getThreadParticipants("t1")).length);
      });

      it("a re-read that changed the membership moves the count with it", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertThreadParticipants("t1", [ada, grace, self]);
        // Grace left.
        await repo.upsertThreadParticipants("t1", [ada, self]);

        const row = (await repo.listThreads()).find((t) => t.threadId === "t1");
        expect(row?.participantCount).toBe(2);
      });

      it("a snapshot cannot set a count that disagrees with the membership", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertThreadParticipants("t1", [ada, self]);
        // A snapshot lands afterwards; whatever it claims about the thread, the
        // count still describes the two people actually stored.
        await repo.markThreadSynced("t1", { conversationTitle: "Weekend plans", isGroup: true });

        const row = (await repo.listThreads()).find((t) => t.threadId === "t1");
        expect(row?.participantCount).toBe(2);
      });

      it("a thread whose membership has never been read reports no count", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.markThreadSynced("t1", { conversationTitle: null, isGroup: false });

        const row = (await repo.listThreads()).find((t) => t.threadId === "t1");
        expect(row?.participantCount).toBeNull();
        expect((await repo.getThreadParticipantSet("t1")).lastReadAt).toBeNull();
      });

      it("a thread seeded only from stored messages reports no count", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertMessages([
          {
            messageId: "m1",
            threadId: "t1",
            sentAt: new Date("2026-08-19T19:00:00Z"),
            senderName: "Ada Lovelace",
            senderProfileUrl: `https://www.linkedin.com/in/${ada.participantId}/`,
            senderHeadline: "Engineer",
            senderType: "member",
            senderIsSelf: false,
            text: "hi",
            subject: null,
            reactionCount: null,
          },
        ]);
        await repo.backfillParticipantsFromMessages();

        // The seed proves Ada is in the thread but says nothing about anyone
        // who has not posted, so "1" would be a number nobody vouched for.
        expect(await repo.getThreadParticipants("t1")).toHaveLength(1);
        const row = (await repo.listThreads()).find((t) => t.threadId === "t1");
        expect(row?.participantCount).toBeNull();
      });

      it("a thread read as empty reports zero rather than unknown", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertThreadParticipants("t1", []);

        const row = (await repo.listThreads()).find((t) => t.threadId === "t1");
        expect(row?.participantCount).toBe(0);
      });

      it("each thread's count is its own", async () => {
        await repo.upsertThreads([
          thread("t1", new Date("2026-08-19T20:00:00Z")),
          thread("t2", new Date("2026-08-18T20:00:00Z")),
          thread("t3", new Date("2026-08-17T20:00:00Z")),
        ]);
        await repo.upsertThreadParticipants("t1", [ada, grace, self]);
        await repo.upsertThreadParticipants("t2", [ada, self]);

        const byThread = new Map(
          (await repo.listThreads()).map((t) => [t.threadId, t.participantCount]),
        );
        expect(byThread.get("t1")).toBe(3);
        expect(byThread.get("t2")).toBe(2);
        expect(byThread.get("t3")).toBeNull();
      });

      // The scalar column is what allowed the disagreement in the first place;
      // with the count derived there is nothing left for it to hold.
      it("the migrations drop the standalone participant_count column", () => {
        const columns = testDb.db.all(
          sql`SELECT name FROM pragma_table_info('linkedin_threads')`,
        ) as Array<{ name: string }>;
        expect(columns.map((c) => c.name)).not.toContain("participant_count");
      });
    });

    // A mirrored participant becomes a Rome person through the existing person
    // create/link flow — there is no second write path here. The bare member id
    // is the channel identity on both sides, so promotion needs no translation
    // step and nothing in this repository ever writes `persons`.
    describe("promotion to a person", () => {
      let people: PersonMappingRepository;

      const personCount = () =>
        Number(
          (testDb.db.all(sql`SELECT COUNT(*) AS n FROM persons`) as Array<{ n: number }>)[0].n,
        );

      beforeEach(async () => {
        people = new PersonMappingRepository(testDb.db);
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertThreadParticipants("t1", [ada, self]);
      });

      it("lists a mirrored identity as unpromoted until a person claims it", async () => {
        const rows = await repo.listParticipants();

        expect(rows.map((r) => r.participantId)).toEqual([ada.participantId, self.participantId]);
        expect(rows.map((r) => r.linkedPersonId)).toEqual([null, null]);
        expect(rows[0].threadCount).toBe(1);
      });

      it("promoting writes a person and a linkedin mapping carrying the member id", async () => {
        await people.createWithChannelMapping(
          "ada-lovelace",
          { displayName: "Ada Lovelace", bondLevel: "acquaintance", approved: true },
          { channel: "linkedin", channelUserId: ada.participantId, displayName: ada.name },
        );

        const mapping = (
          testDb.db.all(
            sql`SELECT channel, channel_user_id AS channelUserId, person_id AS personId
                FROM channel_mappings`,
          ) as Array<Record<string, string>>
        )[0];
        expect(mapping).toEqual({
          channel: "linkedin",
          channelUserId: ada.participantId,
          personId: "ada-lovelace",
        });

        const rows = await repo.listParticipants();
        const promoted = rows.find((r) => r.participantId === ada.participantId);
        expect(promoted?.linkedPersonId).toBe("ada-lovelace");
        expect(promoted?.linkedPersonName).toBe("Ada Lovelace");
        // The headline stays on the mirror row: `channel_mappings` has nowhere
        // to put it, and it belongs in the person's memory profile.
        expect(promoted?.headline).toBe("Engineer");
        // Promoting one identity says nothing about the rest of the inbox.
        expect(rows.find((r) => r.participantId === self.participantId)?.linkedPersonId).toBeNull();
      });

      it("refuses to promote a participant a person already holds", async () => {
        await people.createWithChannelMapping(
          "ada-lovelace",
          { displayName: "Ada Lovelace", bondLevel: "acquaintance", approved: true },
          { channel: "linkedin", channelUserId: ada.participantId },
        );

        await expect(
          people.createWithChannelMapping(
            "ada-lovelace-2",
            { displayName: "Ada Lovelace", bondLevel: "acquaintance", approved: true },
            { channel: "linkedin", channelUserId: ada.participantId },
          ),
        ).rejects.toThrow(/already belongs to person/);

        expect(personCount()).toBe(1);
        expect((await repo.listParticipants())[0].linkedPersonId).toBe("ada-lovelace");
      });

      it("linking an already-promoted participant re-points the one mapping", async () => {
        await people.createWithChannelMapping(
          "ada-lovelace",
          { displayName: "Ada Lovelace", bondLevel: "acquaintance", approved: true },
          { channel: "linkedin", channelUserId: ada.participantId, displayName: "Ada Lovelace" },
        );
        await people.createWithId("ada-byron", {
          displayName: "Ada Byron",
          bondLevel: "inner-circle",
        });

        await people.addChannelMapping("ada-byron", "linkedin", ada.participantId);

        expect(personCount()).toBe(2);
        const rows = await repo.listParticipants();
        expect(rows.find((r) => r.participantId === ada.participantId)).toMatchObject({
          linkedPersonId: "ada-byron",
          linkedPersonName: "Ada Byron",
        });
      });
    });

    // Every sender the mirror already stored carries its member id inside
    // `linkedin_messages.sender_profile_url`, so the tables can be seeded from
    // data on disk rather than a fresh crawl.
    describe("backfill from stored messages", () => {
      const message = (
        threadId: string,
        messageId: string,
        overrides: Record<string, unknown> = {},
      ) => ({
        messageId,
        threadId,
        sentAt: new Date("2026-08-19T19:00:00Z"),
        senderName: "Ada Lovelace",
        senderProfileUrl: "https://www.linkedin.com/in/ACoAAAda0001/",
        senderHeadline: "Engineer",
        senderType: "member",
        senderIsSelf: false,
        text: "hi",
        subject: null,
        reactionCount: null,
        ...overrides,
      });

      it("seeds participants and membership from stored messages", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertMessages([
          message("t1", "m1"),
          message("t1", "m2", {
            senderName: "Me Myself",
            senderProfileUrl: "https://www.linkedin.com/in/ACoAASelf0003/",
            senderIsSelf: true,
            senderHeadline: null,
          }),
        ]);

        const result = await repo.backfillParticipantsFromMessages();
        expect(result.threads).toBe(1);
        expect(result.participants).toBe(2);

        const set = await repo.getThreadParticipantSet("t1");
        expect(set.participants.map((p) => p.participantId)).toEqual([
          "ACoAAAda0001",
          "ACoAASelf0003",
        ]);
        const seeded = set.participants.find((p) => p.participantId === "ACoAAAda0001");
        expect(seeded?.name).toBe("Ada Lovelace");
        expect(seeded?.headline).toBe("Engineer");
        expect(seeded?.type).toBe("member");
        expect(set.participants.find((p) => p.participantId === "ACoAASelf0003")?.isSelf).toBe(
          true,
        );
      });

      it("a seeded thread is not marked as read — the seed is not an authoritative read", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertMessages([message("t1", "m1")]);

        await repo.backfillParticipantsFromMessages();

        // Senders alone cannot prove membership: a lurker is invisible here, so
        // the set must not claim the authority of a real participant read.
        expect((await repo.getThreadParticipantSet("t1")).lastReadAt).toBeNull();
      });

      it("skips a thread whose membership has already been read", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        // The authoritative read says Grace is the only member; Ada has since
        // left, even though her messages are still mirrored.
        await repo.upsertThreadParticipants("t1", [grace]);
        await repo.upsertMessages([message("t1", "m1")]);

        const result = await repo.backfillParticipantsFromMessages();
        expect(result.threads).toBe(0);

        expect((await repo.getThreadParticipants("t1")).map((p) => p.participantId)).toEqual([
          grace.participantId,
        ]);
      });

      it("is idempotent and never duplicates an identity across threads", async () => {
        await repo.upsertThreads([
          thread("t1", new Date("2026-08-19T20:00:00Z")),
          thread("t2", new Date("2026-08-18T20:00:00Z")),
        ]);
        await repo.upsertMessages([message("t1", "m1"), message("t2", "m2")]);

        await repo.backfillParticipantsFromMessages();
        await repo.backfillParticipantsFromMessages();

        const identities = testDb.db.all(
          sql`SELECT participant_id FROM linkedin_participants`,
        ) as Array<{ participant_id: string }>;
        expect(identities.map((r) => r.participant_id)).toEqual(["ACoAAAda0001"]);
        expect(await repo.getParticipantThreadIds("ACoAAAda0001")).toEqual(["t1", "t2"]);
      });

      it("keeps facts an authoritative read already learned", async () => {
        await repo.upsertThreads([
          thread("t1", new Date("2026-08-19T20:00:00Z")),
          thread("t2", new Date("2026-08-18T20:00:00Z")),
        ]);
        // t1 was read properly and learned Ada's headline; t2 only has her
        // messages, which report a stale headline.
        await repo.upsertThreadParticipants("t1", [{ ...ada, headline: "Countess of Lovelace" }]);
        await repo.upsertMessages([message("t2", "m1", { senderHeadline: "Engineer" })]);

        await repo.backfillParticipantsFromMessages();

        const t2 = await repo.getThreadParticipants("t2");
        expect(t2[0]?.headline).toBe("Countess of Lovelace");
      });

      it("ignores senders whose profile URL carries no member id", async () => {
        await repo.upsertThreads([thread("t1", new Date("2026-08-19T20:00:00Z"))]);
        await repo.upsertMessages([
          // A vanity URL is a public handle, not the member id the participant
          // tables key on, so it must not become a participant_id.
          message("t1", "m1", { senderProfileUrl: "https://www.linkedin.com/in/ada-lovelace/" }),
          message("t1", "m2", { senderProfileUrl: null }),
          message("t1", "m3"),
        ]);

        const result = await repo.backfillParticipantsFromMessages();
        expect(result.participants).toBe(1);
        expect((await repo.getThreadParticipants("t1")).map((p) => p.participantId)).toEqual([
          "ACoAAAda0001",
        ]);
      });
    });
  });

  // The identity union reads a participant as a person-shaped row: who they
  // are, what was last said, and how much of it there is. "What was said" is
  // the direct threads only — a timeline entry names no sender, so a group
  // thread's messages cannot be attributed to one of its members.
  describe("participant activity", () => {
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
      headline: null,
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

    const message = (
      threadId: string,
      messageId: string,
      at: string,
      text: string | null,
      overrides: { senderIsSelf?: boolean; subject?: string | null } = {},
    ) => ({
      messageId,
      threadId,
      sentAt: new Date(at),
      senderName: "Ada Lovelace",
      senderProfileUrl: `https://www.linkedin.com/in/${ada.participantId}/`,
      senderHeadline: null,
      senderType: "member",
      senderIsSelf: overrides.senderIsSelf ?? false,
      text,
      subject: overrides.subject ?? null,
      reactionCount: null,
    });

    const seconds = (at: string) => Math.floor(Date.parse(at) / 1000);

    beforeEach(async () => {
      await repo.upsertThreads([
        thread("t-direct", new Date("2026-08-19T20:00:00Z")),
        thread("t-group", new Date("2026-08-20T20:00:00Z")),
      ]);
      await repo.upsertThreadParticipants("t-direct", [ada, self]);
      await repo.upsertThreadParticipants("t-group", [ada, grace, self]);
      await repo.upsertMessages([
        message("t-direct", "m-1", "2026-08-19T10:00:00Z", "hello from the 1:1"),
        message("t-direct", "m-2", "2026-08-19T11:00:00Z", "on my way", { senderIsSelf: true }),
        message("t-group", "m-3", "2026-08-20T10:00:00Z", "hello everyone"),
      ]);
    });

    it("reports a direct thread's newest message, both directions counted", async () => {
      const row = (await repo.listParticipants()).find(
        (r) => r.participantId === ada.participantId,
      )!;
      expect(row.lastMessageAt).toBe(seconds("2026-08-19T11:00:00Z"));
      expect(row.lastMessagePreview).toBe("on my way");
      expect(row.messageCount).toBe(2);
    });

    it("leaves a group thread out of a member's activity", async () => {
      const rows = await repo.listParticipants();
      // Grace is only ever on the group thread, so nothing is attributable to
      // her — the newer group message is not her news, and never Ada's either.
      expect(rows.find((r) => r.participantId === grace.participantId)).toMatchObject({
        lastMessageAt: null,
        lastMessagePreview: null,
        messageCount: 0,
      });
      const ada_ = rows.find((r) => r.participantId === ada.participantId)!;
      expect(ada_.lastMessageAt).toBeLessThan(seconds("2026-08-20T10:00:00Z"));
    });

    it("counts a thread LinkedIn calls a group as one, whatever its membership says", async () => {
      // The flag gets a veto over the membership: a two-row participant set on
      // a thread the snapshot flagged as a group is a set that was read before
      // the rest of the members were.
      await repo.upsertThreads([thread("t-flagged", new Date("2026-08-21T20:00:00Z"))]);
      await repo.markThreadSynced("t-flagged", { isGroup: true });
      await repo.upsertThreadParticipants("t-flagged", [grace, self]);
      await repo.upsertMessages([
        message("t-flagged", "m-4", "2026-08-21T10:00:00Z", "in a group"),
      ]);

      const row = (await repo.listParticipants()).find(
        (r) => r.participantId === grace.participantId,
      )!;
      expect(row.messageCount).toBe(0);
    });

    it("bounds the participant read by default, and reads it whole on request", async () => {
      // The paged identity union cannot inherit a cutoff: an identity past it
      // is one the guardian cannot find and no count includes.
      expect(await repo.listParticipants({ limit: 2 })).toHaveLength(2);
      expect(await repo.listParticipants({ limit: null })).toHaveLength(3);
    });
  });
});

describe("linkedInMemberIdFromProfileUrl", () => {
  it("extracts the member id from the stored profile URL forms", () => {
    expect(linkedInMemberIdFromProfileUrl("https://www.linkedin.com/in/ACoAAAda0001/")).toBe(
      "ACoAAAda0001",
    );
    expect(
      linkedInMemberIdFromProfileUrl("https://www.linkedin.com/in/ACoAAAda0001?trk=messaging"),
    ).toBe("ACoAAAda0001");
    expect(linkedInMemberIdFromProfileUrl("/in/ACoAAAda0001/")).toBe("ACoAAAda0001");
  });

  it("returns null for anything that is not a member id", () => {
    expect(linkedInMemberIdFromProfileUrl("https://www.linkedin.com/in/ada-lovelace/")).toBeNull();
    expect(linkedInMemberIdFromProfileUrl("https://www.linkedin.com/company/acme/")).toBeNull();
    expect(linkedInMemberIdFromProfileUrl(null)).toBeNull();
    expect(linkedInMemberIdFromProfileUrl("")).toBeNull();
  });
});

describe("linkedInMemberId", () => {
  it("accepts both forms a stored channel identity is written in", () => {
    expect(linkedInMemberId("ACoAAAda0001")).toBe("ACoAAAda0001");
    expect(linkedInMemberId("https://www.linkedin.com/in/ACoAAAda0001/")).toBe("ACoAAAda0001");
  });

  it("refuses the vanity form, which names no mirrored participant", () => {
    // `linkedin_participants` is primary keyed by the bare member id, so null
    // here tells a reader the mirror holds nothing for this identifier without
    // asking — and the guardian's own mapping is conferred in exactly this form.
    expect(linkedInMemberId("https://www.linkedin.com/in/ada-lovelace/")).toBeNull();
    expect(linkedInMemberId("linkedin:self")).toBeNull();
    expect(linkedInMemberId(null)).toBeNull();
    expect(linkedInMemberId("")).toBeNull();
  });
});
