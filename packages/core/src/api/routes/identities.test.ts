import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { IdentityPage, IdentityRow } from "@rome/api-types/identities";
import { identitiesRoutes } from "./identities.js";
import { createTestDb, buildTestDeps, type TestDb, type TestDeps } from "../../test/helpers.js";
import { seedBaseline, type BaselineIds } from "../../test/seeds.js";
import { persons, sentinelLog } from "../../db/schema.js";
import { STRANGER_PERSON_ID } from "../../constants.js";

// GET /identities is the People page's one read: a union of curated persons and
// the senders the sentinel log saw but nobody placed, all in the shared
// IdentityRow shape. These tests pin the union's behavior — what shows up, under
// which typed id and level, and that reading never writes.

describe("Identities API", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;
  let baseline: BaselineIds;

  beforeEach(async () => {
    testDb = createTestDb();
    baseline = await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", identitiesRoutes(deps));
  });

  afterEach(() => testDb.close());

  async function fetchPage(query = ""): Promise<IdentityPage> {
    const res = await app.request(`/identities${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as IdentityPage;
  }

  async function fetchRows(): Promise<IdentityRow[]> {
    return (await fetchPage()).identities;
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

  it("returns unmapped sentinel senders as unknown channel-form rows", async () => {
    const rows = await fetchRows();
    const unknown = rows.find((r) => r.id === "channel:telegram:tg-stranger-999");
    expect(unknown).toBeDefined();
    expect(unknown!.level).toBe("unknown");
    // A mapped sender is a person, never also a channel row.
    expect(rows.find((r) => r.id === "channel:telegram:tg-alice")).toBeUndefined();
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
    const unknown = rows.find((r) => r.id === "channel:telegram:tg-stranger-999")!;
    expect(unknown.latest?.source).toBe("telegram");
    expect(unknown.latest?.preview).toBe("who are you");
    expect(unknown.messageCount).toBe(1);
    // Nothing has ever been said to Bob, so his row carries no dynamic at all.
    expect(
      rows.find((r) => r.id === `person:${baseline.persons.acquaintanceId}`)!.latest,
    ).toBeNull();
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

  it("answers a search over names and channel identifiers", async () => {
    const byName = await fetchPage("?q=bob");
    expect(byName.identities.map((r) => r.id)).toEqual([
      `person:${baseline.persons.acquaintanceId}`,
    ]);

    const byChannelId = await fetchPage("?q=tg-stranger-999");
    expect(byChannelId.identities.map((r) => r.id)).toEqual(["channel:telegram:tg-stranger-999"]);
  });

  it("answers for one identity by id, whatever page it would land on", async () => {
    const page = await fetchPage(`?id=${encodeURIComponent("channel:telegram:tg-stranger-999")}`);
    expect(page.identities.map((r) => r.id)).toEqual(["channel:telegram:tg-stranger-999"]);
    expect(page.nextCursor).toBeNull();
  });

  it("pages by activity, and the cursor resumes without repeating a row", async () => {
    const first = await fetchPage("?limit=2");
    expect(first.identities).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await fetchPage(`?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
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
    const full = await fetchPage();
    // One row per page, so a count taken over the page would report at most one
    // of anything — the failure the Unknown chip's signal depends on avoiding.
    const firstOfMany = await fetchPage("?limit=1");
    expect(firstOfMany.identities).toHaveLength(1);
    expect(firstOfMany.counts).toEqual(full.counts);
    expect(firstOfMany.totals).toEqual(full.totals);
    expect(full.counts.unknown).toBe(
      full.identities.filter((row) => row.level === "unknown" && row.latest !== null).length,
    );
  });

  it("leaves the guardian out of the chip counts, but not the totals", async () => {
    const page = await fetchPage();
    expect(page.counts.guardian).toBe(0);
    // The directory's headings count the rows they show, guardian included —
    // a heading over one visible row that reads 0 is the number being wrong.
    expect(page.totals.guardian).toBe(
      page.identities.filter((row) => row.level === "guardian").length,
    );
  });

  it("filters by level before paging, so a level's view is the whole union", async () => {
    const page = await fetchPage("?level=unknown");
    expect(page.identities.every((row) => row.level === "unknown")).toBe(true);
    // The other chips keep their numbers while one chip's view is on screen.
    const all = await fetchPage();
    expect(page.counts).toEqual(all.counts);
  });

  it('excludes both unplaced ends of the ladder from the "all" view', async () => {
    await deps.personMappingRepo.addChannelMapping(
      STRANGER_PERSON_ID,
      "telegram",
      "tg-spammer",
      "Spammer",
    );
    const page = await fetchPage("?level=all");
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

  it("sorts identities with a dynamic newest first, and the rest last", async () => {
    const rows = await fetchRows();
    const at = (id: string) => rows.findIndex((r) => r.id === id);
    // Alice's sentinel history is the newest thing in the baseline, and Bob has
    // none at all.
    expect(at(`person:${baseline.persons.innerCircleId}`)).toBeLessThan(
      at(`person:${baseline.persons.acquaintanceId}`),
    );
    const firstSilent = rows.findIndex((row) => row.latest === null);
    expect(firstSilent).toBeGreaterThan(0);
    expect(rows.slice(firstSilent).every((row) => row.latest === null)).toBe(true);
  });
});
