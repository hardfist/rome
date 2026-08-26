import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { IdentityPage, IdentityRow, TimelinePage } from "@rome/api-types/identities";
import { identitiesRoutes } from "./identities.js";
import { createTestDb, buildTestDeps, type TestDb, type TestDeps } from "../../test/helpers.js";
import { seedBaseline, type BaselineIds } from "../../test/seeds.js";
import { persons, sentinelLog } from "../../db/schema.js";
import { STRANGER_PERSON_ID } from "../../constants.js";

// GET /identities is the People page's one read: a union of curated persons,
// unmapped sentinel-log senders, and the mirrored address books nobody has
// placed yet — WhatsApp contacts and LinkedIn participants — all in the shared
// IdentityRow shape. These tests pin the union's behavior: what shows up, under
// which typed id and level, and that reading never writes.
//
// GET /identities/:id/timeline is the dossier's read: one identity's history,
// merged across its channels and paged.

const SILENT_JID = "15550001111@s.whatsapp.net";
const TALKING_JID = "15550002222@s.whatsapp.net";
const LINKED_JID = "15550003333@s.whatsapp.net";
const GROUP_JID = "120363000000000001@g.us";

describe("Identities API", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;
  let baseline: BaselineIds;
  let waOnlyPersonId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    baseline = await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", identitiesRoutes(deps));

    // The WhatsApp mirror: a silent address-book contact, a talking unlinked
    // contact, a contact linked to a curated person, and a group chat.
    await deps.whatsAppStoreRepo.upsertContacts([
      { jid: SILENT_JID, phoneNumber: "15550001111", name: "Silent Sam" },
      { jid: TALKING_JID, phoneNumber: "15550002222", notify: "Talky Tina" },
      { jid: LINKED_JID, phoneNumber: "15550003333", name: "Alice WA" },
    ]);
    await deps.whatsAppStoreRepo.upsertChats([
      { jid: GROUP_JID, name: "Sunday hikes", isGroup: true },
    ]);
    await deps.whatsAppStoreRepo.upsertMessages([
      {
        id: "wa-1",
        chatJid: TALKING_JID,
        senderJid: TALKING_JID,
        fromMe: false,
        timestamp: new Date("2026-08-17T10:00:00Z"),
        type: "text",
        text: "hello from tina",
        hasMedia: false,
      },
      {
        id: "wa-2",
        chatJid: LINKED_JID,
        senderJid: LINKED_JID,
        fromMe: false,
        timestamp: new Date("2026-08-17T11:00:00Z"),
        type: "text",
        text: "hello from alice's wa",
        hasMedia: false,
      },
    ]);
    // A curated person known only through WhatsApp, so the mirror is the only
    // history their row can carry. Baseline's Alice is deliberately not reused
    // here: she also has sentinel history, which is its own test below.
    waOnlyPersonId = await deps.personMappingRepo.create({
      displayName: "WhatsApp Only",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "whatsapp", channelUserId: LINKED_JID }],
    });
  });

  afterEach(() => testDb.close());

  async function fetchPage(query = ""): Promise<IdentityPage> {
    const res = await app.request(`/identities${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as IdentityPage;
  }

  /** The rows of the first page, with silent contacts included — what most of
   *  these tests assert over. */
  async function fetchRows(): Promise<IdentityRow[]> {
    return (await fetchPage("?includeNeverMessaged=true")).identities;
  }

  it("returns curated persons as person-form rows with their level and channels", async () => {
    const rows = await fetchRows();
    const alice = rows.find((r) => r.id === `person:${baseline.persons.innerCircleId}`);
    expect(alice).toBeDefined();
    expect(alice!.level).toBe("inner-circle");
    expect(alice!.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "telegram", channelUserId: "tg-alice" }),
      ]),
    );

    const guardian = rows.find((r) => r.id === `person:${baseline.persons.guardianId}`);
    expect(guardian?.level).toBe("guardian");
  });

  it("projects WhatsApp history onto the person a contact is linked to", async () => {
    const rows = await fetchRows();
    const person = rows.find((r) => r.id === `person:${waOnlyPersonId}`)!;
    expect(person.latest?.preview).toBe("hello from alice's wa");
    expect(person.latest?.source).toBe("whatsapp");
    expect(person.messageCount).toBeGreaterThan(0);
    // The linked contact never shows up a second time as an unknown row.
    expect(rows.find((r) => r.id === `channel:whatsapp:${LINKED_JID}`)).toBeUndefined();
  });

  it("takes the newest word when a person has history on two surfaces", async () => {
    // Baseline stamps Alice's sentinel entry at seed time; her WhatsApp mirror
    // row is older, so the sentinel is what her row reports.
    await deps.personMappingRepo.addChannelMapping(
      baseline.persons.innerCircleId,
      "whatsapp",
      TALKING_JID,
      "Alice WA",
    );
    const rows = await fetchRows();
    const alice = rows.find((r) => r.id === `person:${baseline.persons.innerCircleId}`)!;
    expect(alice.latest?.preview).not.toBe("hello from tina");
    expect(alice.latest?.source).toBe("telegram");
  });

  it("returns unmapped sentinel senders as unknown channel-form rows", async () => {
    const rows = await fetchRows();
    const unknown = rows.find((r) => r.id === "channel:telegram:tg-stranger-999");
    expect(unknown).toBeDefined();
    expect(unknown!.level).toBe("unknown");
    expect(unknown!.neverMessaged).toBe(false);
    // A mapped sender is a person, never also a channel row.
    expect(rows.find((r) => r.id === "channel:telegram:tg-alice")).toBeUndefined();
  });

  it("returns unlinked WhatsApp contacts as unknown rows, flagging the silent ones", async () => {
    const rows = await fetchRows();
    const silent = rows.find((r) => r.id === `channel:whatsapp:${SILENT_JID}`);
    expect(silent).toBeDefined();
    expect(silent!.level).toBe("unknown");
    expect(silent!.displayName).toBe("Silent Sam");
    expect(silent!.neverMessaged).toBe(true);

    const talking = rows.find((r) => r.id === `channel:whatsapp:${TALKING_JID}`);
    expect(talking).toBeDefined();
    expect(talking!.displayName).toBe("Talky Tina");
    expect(talking!.neverMessaged).toBe(false);
    expect(talking!.latest?.preview).toBe("hello from tina");
  });

  it("excludes group chats — a group cannot hold a bond", async () => {
    const rows = await fetchRows();
    expect(rows.find((r) => r.id.includes(GROUP_JID))).toBeUndefined();
  });

  it("renders each stranger mapping as its own channel-form row, never the sentinel person", async () => {
    await deps.personMappingRepo.addChannelMapping(
      STRANGER_PERSON_ID,
      "telegram",
      "tg-spammer",
      "Spammer",
    );
    const rows = await fetchRows();
    const stranger = rows.find((r) => r.id === "channel:telegram:tg-spammer");
    expect(stranger).toBeDefined();
    expect(stranger!.level).toBe("stranger");
    expect(rows.find((r) => r.id === `person:${STRANGER_PERSON_ID}`)).toBeUndefined();
  });

  it('buckets a bond level outside today\'s enum under "other"', async () => {
    await testDb.db
      .update(persons)
      .set({ bondLevel: "colleague" as never })
      .where(eq(persons.id, baseline.persons.otherId));
    const rows = await fetchRows();
    const row = rows.find((r) => r.id === `person:${baseline.persons.otherId}`);
    expect(row?.level).toBe("other");
  });

  it("carries each identity's newest dynamic, naming the surface it came from", async () => {
    const rows = await fetchRows();
    const tina = rows.find((r) => r.id === `channel:whatsapp:${TALKING_JID}`)!;
    expect(tina.latest).toEqual({
      source: "whatsapp",
      timestamp: Math.floor(new Date("2026-08-17T10:00:00Z").getTime() / 1000),
      preview: "hello from tina",
    });
    expect(rows.find((r) => r.id === `channel:whatsapp:${SILENT_JID}`)!.latest).toBeNull();
  });

  it("leaves never-messaged contacts out of the default page", async () => {
    const page = await fetchPage();
    expect(page.identities.find((r) => r.id === `channel:whatsapp:${SILENT_JID}`)).toBeUndefined();
  });

  it("still counts the silent contacts the default page hides", async () => {
    // The toggle governs the rows, never the numbers: the offer to show them is
    // the only place this count is read, and it is made from the view that
    // hides them.
    const hidden = await fetchPage();
    const shown = await fetchPage("?includeNeverMessaged=true");
    expect(hidden.neverMessagedTotal).toBe(shown.neverMessagedTotal);
    expect(hidden.neverMessagedTotal).toBeGreaterThan(0);
    expect(hidden.totals).toEqual(shown.totals);
    expect(hidden.counts).toEqual(shown.counts);
  });

  it("takes the newest word across a person's channels, and counts them all", async () => {
    // Alice's sentinel history is on telegram; a second mapping with newer
    // history has to win, whichever channel it sits on.
    await deps.personMappingRepo.addChannelMapping(
      baseline.persons.innerCircleId,
      "webchat",
      "web-alice",
      "Alice Inner",
    );
    const webId = await deps.sentinelLogRepo.create({
      messageId: "msg-web-1",
      channel: "webchat",
      channelUserId: "web-alice",
      displayName: "Alice Inner",
      text: "from the web",
      action: "ignored",
    });
    // Stamped a minute past the baseline rather than left to the clock: the
    // baseline's rows are written in the same second this one would be, and the
    // order settles a tie on the channel name, which is not what this test is
    // about.
    const seeded = (await fetchRows()).find(
      (r) => r.id === `person:${baseline.persons.innerCircleId}`,
    )!.latest!.timestamp;
    await testDb.db
      .update(sentinelLog)
      .set({ createdAt: new Date((seeded + 60) * 1000) })
      .where(eq(sentinelLog.id, webId));

    const alice = (await fetchRows()).find(
      (r) => r.id === `person:${baseline.persons.innerCircleId}`,
    )!;
    expect(alice.latest?.source).toBe("webchat");
    expect(alice.latest?.preview).toBe("from the web");
    // Two telegram exchanges and one on webchat: the count is over the person,
    // not over whichever channel answered most recently.
    expect(alice.messageCount).toBe(3);
  });

  it("rejects a cursor that names no position rather than answering the first page", async () => {
    const res = await app.request("/identities?cursor=not-a-cursor");
    expect(res.status).toBe(400);
  });

  it("is one row for a WhatsApp contact its owner and its history address differently", async () => {
    // The address book consolidates a phone jid and a `@lid` jid into one
    // contact. A person mapped to one of them and a sentinel row under the
    // other is one identity, not a curated person plus an unknown sender.
    const phoneJid = "15550007777@s.whatsapp.net";
    const lidJid = "88817260077@lid";
    await deps.whatsAppStoreRepo.upsertContacts([
      { jid: phoneJid, phoneNumber: "15550007777", name: "One Contact" },
      { jid: lidJid, phoneNumber: "15550007777", name: "One Contact" },
    ]);
    await deps.sentinelLogRepo.create({
      messageId: "msg-lid-1",
      channel: "whatsapp",
      channelUserId: lidJid,
      displayName: "One Contact",
      text: "from the lid address",
      action: "ignored",
    });
    const personId = await deps.personMappingRepo.create({
      displayName: "One Contact",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "whatsapp", channelUserId: phoneJid }],
    });

    const rows = await fetchRows();
    expect(rows.filter((r) => r.channels.some((ch) => ch.channelUserId === lidJid))).toHaveLength(
      1,
    );
    expect(rows.find((r) => r.id === `channel:whatsapp:${lidJid}`)).toBeUndefined();
    const person = rows.find((r) => r.id === `person:${personId}`)!;
    expect(person.channels.map((ch) => ch.channelUserId).sort()).toEqual([lidJid, phoneJid].sort());
    expect(person.latest?.preview).toBe("from the lid address");
  });

  it("answers a search over names and channel identifiers, silent contacts included", async () => {
    const byName = await fetchPage("?q=silent");
    expect(byName.identities.map((r) => r.id)).toEqual([`channel:whatsapp:${SILENT_JID}`]);

    const byNumber = await fetchPage("?q=15550001111");
    expect(byNumber.identities.map((r) => r.id)).toEqual([`channel:whatsapp:${SILENT_JID}`]);
  });

  it("answers for one identity by id, whatever page it would land on", async () => {
    const page = await fetchPage(`?id=${encodeURIComponent(`channel:whatsapp:${SILENT_JID}`)}`);
    expect(page.identities.map((r) => r.id)).toEqual([`channel:whatsapp:${SILENT_JID}`]);
    expect(page.nextCursor).toBeNull();
  });

  it("pages by activity, and the cursor resumes without repeating a row", async () => {
    const first = await fetchPage("?includeNeverMessaged=true&limit=2");
    expect(first.identities).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await fetchPage(
      `?includeNeverMessaged=true&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    // A cursor the route ignored would answer an empty page here, and every
    // "no repeats" assertion below would hold vacuously.
    expect(second.identities.length).toBeGreaterThan(0);
    const firstIds = first.identities.map((r) => r.id);
    expect(second.identities.some((r) => firstIds.includes(r.id))).toBe(false);

    const all = await fetchRows();
    expect([...firstIds, ...second.identities.map((r) => r.id)]).toEqual(
      all.slice(0, firstIds.length + second.identities.length).map((r) => r.id),
    );
  });

  it("counts every level over the whole union, not the page it returned", async () => {
    const full = await fetchPage("?includeNeverMessaged=true");
    // One row per page, so a count taken over the page would report at most one
    // of anything — the failure the Unknown chip's signal depends on avoiding.
    const firstOfMany = await fetchPage("?includeNeverMessaged=true&limit=1");
    expect(firstOfMany.identities).toHaveLength(1);
    expect(firstOfMany.counts).toEqual(full.counts);
    expect(firstOfMany.totals).toEqual(full.totals);
    expect(firstOfMany.neverMessagedTotal).toEqual(full.neverMessagedTotal);
    expect(full.counts.unknown).toBe(
      full.identities.filter((row) => row.level === "unknown" && row.latest !== null).length,
    );
  });

  it("leaves the guardian and silent contacts out of the chip counts, but not the totals", async () => {
    const page = await fetchPage("?includeNeverMessaged=true");
    expect(page.counts.guardian).toBe(0);
    // The directory's headings count the rows they show, guardian included —
    // a heading over one visible row that reads 0 is the number being wrong.
    expect(page.totals.guardian).toBe(
      page.identities.filter((row) => row.level === "guardian").length,
    );
    expect(page.totals.unknown).toBeGreaterThan(page.counts.unknown);
    expect(page.neverMessagedTotal).toBeGreaterThan(0);
    // A contact that has never said anything is not waiting on a decision.
    const silent = page.identities.filter((row) => row.neverMessaged);
    expect(silent.length).toBe(page.neverMessagedTotal);
  });

  it("filters by level before paging, so a level's view is the whole union", async () => {
    const page = await fetchPage("?level=unknown&includeNeverMessaged=true");
    expect(page.identities.every((row) => row.level === "unknown")).toBe(true);
    // The other chips keep their numbers while one chip's view is on screen.
    const all = await fetchPage("?includeNeverMessaged=true");
    expect(page.counts).toEqual(all.counts);
  });

  it('excludes both unplaced ends of the ladder from the "all" view', async () => {
    await deps.personMappingRepo.addChannelMapping(
      STRANGER_PERSON_ID,
      "telegram",
      "tg-spammer",
      "Spammer",
    );
    const page = await fetchPage("?level=all&includeNeverMessaged=true");
    expect(page.identities.some((row) => row.level === "unknown")).toBe(false);
    expect(page.identities.some((row) => row.level === "stranger")).toBe(false);
  });

  it("rejects a level that names no view rather than answering as all", async () => {
    expect((await app.request("/identities?level=nonsense")).status).toBe(400);
  });

  it("never materializes a person row — reads are a union", async () => {
    const before = await testDb.db.select({ id: persons.id }).from(persons);
    await fetchRows();
    const after = await testDb.db.select({ id: persons.id }).from(persons);
    expect(after.length).toBe(before.length);
  });

  it("sorts talked-to identities newest first and silent ones last", async () => {
    const rows = await fetchRows();
    const at = (id: string) => rows.findIndex((r) => r.id === id);
    // The WhatsApp-only person's message (11:00) is newer than Tina's (10:00);
    // Silent Sam said nothing and sorts after everyone with history.
    expect(at(`person:${waOnlyPersonId}`)).toBeLessThan(at(`channel:whatsapp:${TALKING_JID}`));
    const silentIndex = at(`channel:whatsapp:${SILENT_JID}`);
    for (const row of rows) {
      if (row.latest != null) {
        expect(at(row.id)).toBeLessThan(silentIndex);
      }
    }
  });
  describe("person timeline", () => {
    async function fetchTimeline(id: string, query = ""): Promise<TimelinePage> {
      const res = await app.request(`/identities/${encodeURIComponent(id)}/timeline${query}`);
      expect(res.status).toBe(200);
      return (await res.json()) as TimelinePage;
    }

    it("merges a person's channels into one newest-first timeline", async () => {
      // Alice already carries sentinel history on Telegram; this gives her a
      // newer WhatsApp thread, so both producers have to land in one list.
      await deps.personMappingRepo.addChannelMapping(
        baseline.persons.innerCircleId,
        "whatsapp",
        TALKING_JID,
        "Alice WA",
      );
      await deps.whatsAppStoreRepo.upsertMessages([
        {
          id: "wa-out",
          chatJid: TALKING_JID,
          senderJid: null,
          fromMe: true,
          timestamp: new Date("2026-08-17T10:05:00Z"),
          type: "text",
          text: "on my way",
          hasMedia: false,
        },
      ]);

      const page = await fetchTimeline(`person:${baseline.persons.innerCircleId}`);
      expect(page.entries.map((entry) => entry.source)).toContain("whatsapp");
      expect(page.entries.map((entry) => entry.source)).toContain("telegram");
      const timestamps = page.entries.map((entry) => entry.timestamp);
      expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);

      const outbound = page.entries.find((entry) => entry.ref === "wa-out")!;
      expect(outbound).toMatchObject({
        source: "whatsapp",
        body: "on my way",
        direction: "outbound",
      });
      // Rome's own reply on Telegram is the other outbound entry: the sentinel
      // log records both halves of an exchange, and the dossier shows both.
      const reply = page.entries.find((entry) => entry.body === "hello")!;
      expect(reply).toMatchObject({ source: "telegram", direction: "outbound" });
      expect(
        page.entries
          .filter((entry) => entry.direction === "outbound")
          .map((entry) => entry.ref)
          .sort(),
      ).toEqual(["wa-out", `sentinel:${baseline.sentinelLog.repliedId}:reply`].sort());
    });

    it("sorts a reply above the message it answers, sharing its second", async () => {
      const page = await fetchTimeline(`person:${baseline.persons.innerCircleId}`);
      const reply = page.entries.findIndex((entry) => entry.body === "hello");
      const inbound = page.entries.findIndex((entry) => entry.body === "hi");
      expect(reply).toBeGreaterThanOrEqual(0);
      expect(reply).toBeLessThan(inbound);
    });

    it("answers for a channel-form identity that has no person row", async () => {
      const page = await fetchTimeline(`channel:whatsapp:${TALKING_JID}`);
      expect(page.entries.map((entry) => entry.ref)).toEqual(["wa-1"]);
      expect(page.entries[0]!.direction).toBe("inbound");
    });

    it("stops at the end of a thread that fits in one page", async () => {
      const first = await fetchTimeline(`channel:whatsapp:${TALKING_JID}`, "?limit=1");
      expect(first.entries).toHaveLength(1);
      // One message in the thread: the page is complete, so there is nothing to
      // resume from.
      expect(first.nextCursor).toBeNull();
    });

    it("pages through a single channel's history past the first page", async () => {
      // The common case: one channel, more history than a page. Each producer
      // answers capped at the page size, so "is there more" cannot be read off
      // the merged length alone.
      await deps.whatsAppStoreRepo.upsertMessages(
        [1, 2, 3, 4, 5].map((n) => ({
          id: `wa-long-${n}`,
          chatJid: SILENT_JID,
          senderJid: SILENT_JID,
          fromMe: false,
          timestamp: new Date(Date.UTC(2026, 7, 17, 12, n)),
          type: "text",
          text: `message ${n}`,
          hasMedia: false,
        })),
      );

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const body: TimelinePage = await fetchTimeline(
          `channel:whatsapp:${SILENT_JID}`,
          `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        seen.push(...body.entries.map((entry) => entry.ref));
        cursor = body.nextCursor;
        if (!cursor) break;
      }

      expect(cursor).toBeNull();
      expect(seen).toEqual(["wa-long-5", "wa-long-4", "wa-long-3", "wa-long-2", "wa-long-1"]);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("keeps every entry of a second that straddles a page boundary", async () => {
      // Timestamps are whole seconds and collide, so a cursor that named only
      // the second would drop whatever else shared it.
      const sameSecond = new Date("2026-08-17T13:00:00Z");
      await deps.whatsAppStoreRepo.upsertMessages(
        ["a", "b", "c"].map((suffix) => ({
          id: `wa-tie-${suffix}`,
          chatJid: SILENT_JID,
          senderJid: SILENT_JID,
          fromMe: false,
          timestamp: sameSecond,
          type: "text",
          text: `tie ${suffix}`,
          hasMedia: false,
        })),
      );

      const first = await fetchTimeline(`channel:whatsapp:${SILENT_JID}`, "?limit=2");
      expect(first.nextCursor).not.toBeNull();
      const second = await fetchTimeline(
        `channel:whatsapp:${SILENT_JID}`,
        `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
      );
      const refs = [...first.entries, ...second.entries].map((entry) => entry.ref);
      expect(refs).toEqual(["wa-tie-a", "wa-tie-b", "wa-tie-c"].sort());
      expect(new Set(refs).size).toBe(3);
    });

    it("pages a second that holds more entries than a page, losing none", async () => {
      // Four messages in one second with a two-entry page: the cursor's second
      // has to be re-read whole, because the order inside it is not the order
      // the store can page by.
      const sameSecond = new Date("2026-08-17T15:00:00Z");
      await deps.whatsAppStoreRepo.upsertMessages(
        ["a", "b", "c", "d"].map((suffix) => ({
          id: `wa-crowd-${suffix}`,
          chatJid: SILENT_JID,
          senderJid: SILENT_JID,
          fromMe: false,
          timestamp: sameSecond,
          type: "text",
          text: `crowd ${suffix}`,
          hasMedia: false,
        })),
      );

      const refs: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const query: string = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const answer: TimelinePage = await fetchTimeline(`channel:whatsapp:${SILENT_JID}`, query);
        refs.push(...answer.entries.map((entry) => entry.ref));
        cursor = answer.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(refs.sort()).toEqual(["wa-crowd-a", "wa-crowd-b", "wa-crowd-c", "wa-crowd-d"]);
    });

    it("rejects a cursor that is not a timeline cursor", async () => {
      const res = await app.request(
        `/identities/${encodeURIComponent(`channel:whatsapp:${TALKING_JID}`)}/timeline?cursor=1234`,
      );
      expect(res.status).toBe(400);
    });

    it("reads a WhatsApp thread through whichever alias the person is mapped to", async () => {
      // One person, two addresses: the address book consolidates them, and the
      // thread may hang off either. A mapping onto the phone jid still has to
      // find history recorded against the `@lid` one.
      const phoneJid = "15550009999@s.whatsapp.net";
      const lidJid = "88817260012@lid";
      await deps.whatsAppStoreRepo.upsertContacts([
        { jid: phoneJid, phoneNumber: "15550009999", name: "Two Addresses" },
        { jid: lidJid, phoneNumber: "15550009999", name: "Two Addresses" },
      ]);
      await deps.whatsAppStoreRepo.upsertMessages([
        {
          id: "wa-lid-1",
          chatJid: lidJid,
          senderJid: lidJid,
          fromMe: false,
          timestamp: new Date("2026-08-17T14:00:00Z"),
          type: "text",
          text: "sent from the lid thread",
          hasMedia: false,
        },
      ]);
      const personId = await deps.personMappingRepo.create({
        displayName: "Two Addresses",
        bondLevel: "acquaintance",
        approved: true,
        channelMappings: [{ channel: "whatsapp", channelUserId: phoneJid }],
      });

      const page = await fetchTimeline(`person:${personId}`);
      expect(page.entries.map((entry) => entry.ref)).toEqual(["wa-lid-1"]);
    });

    it("is empty, not an error, for an identity nothing was ever said to", async () => {
      const page = await fetchTimeline(`channel:whatsapp:${SILENT_JID}`);
      expect(page.entries).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });

    it("rejects an id that is neither typed form, and 404s an unknown person", async () => {
      expect((await app.request("/identities/not-an-id/timeline")).status).toBe(400);
      expect((await app.request("/identities/person%3Anobody/timeline")).status).toBe(404);
    });
  });

  // LinkedIn is the union's second mirror, and it folds identities on its own
  // terms: a member id is the identity, a profile URL naming one is the same
  // identity, and only a direct thread's messages are attributable to one
  // person. These pin that it lands in the same row shape as WhatsApp.

  // LinkedIn is the union's second mirror, and it folds identities on its own
  // terms: a member id is the identity, a profile URL naming one is the same
  // identity, and only a direct thread's messages are attributable to one
  // person. These pin that it lands in the same row shape as WhatsApp.
  describe("LinkedIn identities", () => {
    const ADA = "ACoAAAda0001";
    const GRACE = "ACoAAGrace002";
    const SELF = "ACoAASelf0003";
    const LINUS = "ACoAALinus004";
    const ADA_URL = `https://www.linkedin.com/in/${ADA}/`;
    const VANITY_URL = "https://www.linkedin.com/in/ada-lovelace/";

    const participant = (participantId: string, name: string, isSelf = false) => ({
      participantId,
      name,
      headline: null,
      type: "member",
      isSelf,
    });

    const liMessage = (
      threadId: string,
      messageId: string,
      at: string,
      text: string | null,
      overrides: { senderIsSelf?: boolean; subject?: string | null } = {},
    ) => ({
      messageId,
      threadId,
      sentAt: new Date(at),
      senderIsSelf: overrides.senderIsSelf ?? false,
      text,
      subject: overrides.subject ?? null,
    });

    const ada = participant(ADA, "Ada Lovelace");
    const grace = participant(GRACE, "Grace Hopper");
    const linus = participant(LINUS, "Linus Linked");
    const me = participant(SELF, "Me Myself", true);

    beforeEach(async () => {
      const thread = (threadId: string) => ({
        threadId,
        threadUrl: `https://www.linkedin.com/messaging/thread/${threadId}/`,
        unread: false,
      });
      await deps.linkedInStoreRepo.upsertThreads([
        thread("li-ada"),
        thread("li-group"),
        thread("li-linus"),
      ]);
      await deps.linkedInStoreRepo.upsertThreadParticipants("li-ada", [ada, me]);
      await deps.linkedInStoreRepo.upsertThreadParticipants("li-group", [ada, grace, me]);
      await deps.linkedInStoreRepo.upsertThreadParticipants("li-linus", [linus, me]);
      await deps.linkedInStoreRepo.upsertMessages([
        liMessage("li-ada", "m-1", "2026-08-17T09:00:00Z", "hello from ada"),
        liMessage("li-ada", "m-2", "2026-08-17T09:30:00Z", "thanks", { senderIsSelf: true }),
        liMessage("li-group", "m-1", "2026-08-18T09:00:00Z", "a blast to everyone"),
        liMessage("li-linus", "m-1", "2026-08-17T12:30:00Z", "hi from linus"),
      ]);
    });

    it("returns an unplaced participant as an unknown row under their member id", async () => {
      const row = (await fetchRows()).find((r) => r.id === `channel:linkedin:${ADA}`);
      expect(row).toBeDefined();
      expect(row!.level).toBe("unknown");
      expect(row!.displayName).toBe("Ada Lovelace");
      expect(row!.neverMessaged).toBe(false);
      // Both directions of the direct thread, newest word first.
      expect(row!.latest).toEqual({
        source: "linkedin",
        timestamp: Math.floor(new Date("2026-08-17T09:30:00Z").getTime() / 1000),
        preview: "thanks",
      });
      expect(row!.messageCount).toBe(2);
    });

    it("counts a group thread as nobody's news — a group cannot hold a bond", async () => {
      const rows = await fetchRows();
      const grace_ = rows.find((r) => r.id === `channel:linkedin:${GRACE}`)!;
      // Grace posts only in the group, so she is a mirrored identity with
      // nothing attributable to her: silent, and held behind the toggle.
      expect(grace_.latest).toBeNull();
      expect(grace_.neverMessaged).toBe(true);
      const hidden = await fetchPage();
      expect(hidden.identities.some((r) => r.id === `channel:linkedin:${GRACE}`)).toBe(false);
      // And the group's newer message is not Ada's either.
      const ada_ = rows.find((r) => r.id === `channel:linkedin:${ADA}`)!;
      expect(ada_.latest!.timestamp).toBeLessThan(
        Math.floor(new Date("2026-08-18T09:00:00Z").getTime() / 1000),
      );
    });

    it("never offers the account owner as an identity to place", async () => {
      const rows = await fetchRows();
      expect(rows.some((r) => r.channels.some((ch) => ch.channelUserId === SELF))).toBe(false);
    });

    it("projects LinkedIn history onto the person a participant was promoted into", async () => {
      const personId = await deps.personMappingRepo.create({
        displayName: "Linus Linked",
        bondLevel: "acquaintance",
        approved: true,
        channelMappings: [{ channel: "linkedin", channelUserId: LINUS }],
      });

      const rows = await fetchRows();
      const person = rows.find((r) => r.id === `person:${personId}`)!;
      expect(person.latest?.preview).toBe("hi from linus");
      expect(person.latest?.source).toBe("linkedin");
      expect(person.messageCount).toBe(1);
      // The promoted participant never shows up a second time as an unknown row.
      expect(rows.find((r) => r.id === `channel:linkedin:${LINUS}`)).toBeUndefined();
    });

    it("is one row for a participant whose mapping names their profile URL", async () => {
      // Promotion writes the bare member id, but the guardian's own mapping is
      // conferred at connect time as a URL, and an inbound message resolves its
      // sender's URL to a member id. All name one identity, and comparing them
      // as strings would show one person as two rows.
      const personId = await deps.personMappingRepo.create({
        displayName: "Ada Lovelace",
        bondLevel: "acquaintance",
        approved: true,
        channelMappings: [{ channel: "linkedin", channelUserId: ADA_URL }],
      });

      const rows = await fetchRows();
      expect(rows.filter((r) => r.channels.some((ch) => ch.channelUserId === ADA))).toHaveLength(1);
      expect(rows.find((r) => r.id === `channel:linkedin:${ADA}`)).toBeUndefined();
      const person = rows.find((r) => r.id === `person:${personId}`)!;
      expect(person.latest?.preview).toBe("thanks");
      // The mapping's own form leads, so a client mutating the row addresses
      // the mapping that exists rather than the one it wishes existed.
      expect(person.channels.map((ch) => ch.channelUserId)).toEqual([ADA_URL, ADA]);
    });

    it("folds a sentinel sender onto the participant whose URL it named", async () => {
      await deps.sentinelLogRepo.create({
        messageId: "msg-li-1",
        channel: "linkedin",
        channelUserId: ADA_URL,
        displayName: "Ada Lovelace",
        text: "from the url form",
        action: "ignored",
      });

      const rows = await fetchRows();
      const matching = rows.filter((r) =>
        r.channels.some((ch) => ch.channel === "linkedin" && ch.channelUserId === ADA),
      );
      expect(matching).toHaveLength(1);
      // The row is offered under the member id, which is the identifier a
      // placement writes.
      expect(matching[0].id).toBe(`channel:linkedin:${ADA}`);
      expect(matching[0].latest?.preview).toBe("from the url form");
    });
    describe("timeline", () => {
      async function fetchTimeline(id: string, query = ""): Promise<TimelinePage> {
        const res = await app.request(`/identities/${encodeURIComponent(id)}/timeline${query}`);
        expect(res.status).toBe(200);
        return (await res.json()) as TimelinePage;
      }

      it("reads a direct thread for an identity with no person row", async () => {
        const page = await fetchTimeline(`channel:linkedin:${ADA}`);
        // Refs carry the thread, because a LinkedIn message id is unique
        // within a thread and this list merges a person's threads.
        expect(page.entries.map((entry) => entry.ref)).toEqual(["li-ada:m-2", "li-ada:m-1"]);
        expect(page.entries[0]).toMatchObject({
          source: "linkedin",
          body: "thanks",
          direction: "outbound",
        });
        expect(page.entries[1]!.direction).toBe("inbound");
      });

      it("merges LinkedIn into a person's other channels, newest first", async () => {
        await deps.personMappingRepo.addChannelMapping(
          baseline.persons.innerCircleId,
          "linkedin",
          ADA,
          "Ada Lovelace",
        );
        const page = await fetchTimeline(`person:${baseline.persons.innerCircleId}`);
        const sources = page.entries.map((entry) => entry.source);
        expect(sources).toContain("linkedin");
        expect(sources).toContain("telegram");
        const timestamps = page.entries.map((entry) => entry.timestamp);
        expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
      });

      it("reads the mirror through a mapping written as a profile URL", async () => {
        const personId = await deps.personMappingRepo.create({
          displayName: "Ada Lovelace",
          bondLevel: "acquaintance",
          approved: true,
          channelMappings: [{ channel: "linkedin", channelUserId: ADA_URL }],
        });
        const page = await fetchTimeline(`person:${personId}`);
        expect(page.entries.map((entry) => entry.ref)).toEqual(["li-ada:m-2", "li-ada:m-1"]);
      });

      it("renders an InMail's subject with the body it was sent apart from", async () => {
        await deps.linkedInStoreRepo.upsertMessages([
          liMessage("li-linus", "m-inmail", "2026-08-17T13:00:00Z", "Are you open to a chat?", {
            subject: "An opportunity",
          }),
        ]);
        const page = await fetchTimeline(`channel:linkedin:${LINUS}`);
        expect(page.entries[0]!.body).toBe("An opportunity\nAre you open to a chat?");
      });

      it("falls back to the sentinel log for a mapping that names no member", async () => {
        // A vanity URL is the form the guardian's own mapping is conferred in,
        // and it can never appear in the participant mirror — so the sentinel
        // log is where that identity's history actually is.
        await deps.sentinelLogRepo.create({
          messageId: "msg-vanity-1",
          channel: "linkedin",
          channelUserId: VANITY_URL,
          displayName: "Ada Lovelace",
          text: "sent under a vanity handle",
          action: "replied",
          response: "answered",
        });
        const personId = await deps.personMappingRepo.create({
          displayName: "Vanity Ada",
          bondLevel: "acquaintance",
          approved: true,
          channelMappings: [{ channel: "linkedin", channelUserId: VANITY_URL }],
        });

        const page = await fetchTimeline(`person:${personId}`);
        expect(page.entries.map((entry) => entry.body)).toEqual([
          "answered",
          "sent under a vanity handle",
        ]);
      });

      it("pages a participant's direct threads without repeating an entry", async () => {
        const refs: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 5; page += 1) {
          const answer: TimelinePage = await fetchTimeline(
            `channel:linkedin:${ADA}`,
            `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          );
          refs.push(...answer.entries.map((entry) => entry.ref));
          cursor = answer.nextCursor;
          if (!cursor) break;
        }
        expect(cursor).toBeNull();
        expect(refs).toEqual(["li-ada:m-2", "li-ada:m-1"]);
      });
    });
  });
});
