import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { LinkedInStoreRepository } from "../db/repositories/linkedin-store.js";
import { LinkedInAccounts } from "./linkedin-accounts.js";

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

describe("LinkedInAccounts", () => {
  let testDb: TestDb;
  let repo: LinkedInStoreRepository;
  let accounts: LinkedInAccounts;

  beforeEach(async () => {
    testDb = createTestDb();
    repo = new LinkedInStoreRepository(testDb.db);
    accounts = new LinkedInAccounts(repo);
    await repo.upsertThreads([
      {
        threadId: "t1",
        threadUrl: "https://www.linkedin.com/messaging/thread/t1/",
        personName: "Ada Lovelace",
        unread: false,
      },
    ]);
    await repo.upsertThreadParticipants("t1", [ada, grace, self]);
  });

  afterEach(() => testDb.close());

  it("resolves a profile URL and a bare member id to one account", async () => {
    const fromUrl = await accounts.resolve("https://www.linkedin.com/in/ACoAAAda0001/");
    const fromId = await accounts.resolve("ACoAAAda0001");

    expect(fromUrl).not.toBeNull();
    expect(fromUrl!.id).toBe("ACoAAAda0001");
    expect(fromId!.id).toBe(fromUrl!.id);
    expect((await accounts.resolve(fromUrl!.id))!.id).toBe(fromUrl!.id);
  });

  it("describes an account by label and namespaced identifier", async () => {
    const account = (await accounts.resolve("ACoAAAda0001"))!;

    expect(account.label).toBe("Ada Lovelace");
    expect(account.identifiers).toEqual({ "linkedin:member_id": "ACoAAAda0001" });
  });

  it("excludes the guardian's own row", async () => {
    const page = await accounts.listAccounts({ limit: 50 });

    expect(page.accounts.map((a) => a.id)).toEqual(["ACoAAAda0001", "ACoAAGrace002"]);
    expect(await accounts.resolve("ACoAASelf0003")).toBeNull();
  });

  it("lists the member ids it holds, the guardian's own excluded", async () => {
    expect([...(await accounts.listAddresses()).entries()]).toEqual([
      ["ACoAAAda0001", "ACoAAAda0001"],
      ["ACoAAGrace002", "ACoAAGrace002"],
    ]);
  });

  it("returns null for an unknown identifier", async () => {
    expect(await accounts.resolve("ACoAANobody999")).toBeNull();
    expect(await accounts.resolve("https://www.linkedin.com/in/ada-lovelace/")).toBeNull();
    expect(await accounts.resolve("")).toBeNull();
  });

  it("pages and filters by query", async () => {
    const first = await accounts.listAccounts({ limit: 1 });
    expect(first.accounts.map((a) => a.label)).toEqual(["Ada Lovelace"]);
    expect(first.nextCursor).toBeDefined();

    const second = await accounts.listAccounts({ limit: 1, cursor: first.nextCursor });
    expect(second.accounts.map((a) => a.label)).toEqual(["Grace Hopper"]);
    expect(second.nextCursor).toBeUndefined();

    const byLabel = await accounts.listAccounts({ limit: 50, query: "hopper" });
    expect(byLabel.accounts.map((a) => a.id)).toEqual(["ACoAAGrace002"]);
  });

  describe("activity", () => {
    beforeEach(async () => {
      // `t1` from the outer setup already holds Ada, Grace and the guardian, so
      // it is a group by membership. Ada gets a 1:1 alongside it.
      await repo.upsertThreads([
        {
          threadId: "t-direct",
          threadUrl: "https://www.linkedin.com/messaging/thread/t-direct/",
          personName: "Ada Lovelace",
          unread: false,
        },
      ]);
      await repo.upsertThreadParticipants("t-direct", [ada, self]);
      await repo.upsertMessages([
        {
          messageId: "m-1",
          threadId: "t-direct",
          sentAt: new Date("2026-08-19T10:00:00Z"),
          senderName: "Ada Lovelace",
          senderProfileUrl: "https://www.linkedin.com/in/ACoAAAda0001/",
          senderHeadline: null,
          senderType: "member",
          senderIsSelf: false,
          text: "See you Thursday",
          subject: null,
          reactionCount: null,
        },
        {
          messageId: "m-2",
          threadId: "t1",
          sentAt: new Date("2026-08-20T10:00:00Z"),
          senderName: "Grace Hopper",
          senderProfileUrl: "https://www.linkedin.com/in/ACoAAGrace002/",
          senderHeadline: null,
          senderType: "member",
          senderIsSelf: false,
          text: "hello everyone",
          subject: null,
          reactionCount: null,
        },
      ]);
    });

    it("reports what a member's direct threads carried", async () => {
      const activity = await accounts.listActivity();

      expect(activity.get("ACoAAAda0001" as never)).toEqual({
        lastMessageAt: Math.floor(Date.parse("2026-08-19T10:00:00Z") / 1000),
        lastMessagePreview: "See you Thursday",
        messageCount: 1,
      });
    });

    it("leaves a member Rome only shares a group with absent, not zeroed", async () => {
      // The contract's "silent" is one condition to test, and a group message is
      // nobody's: a `TimelineEntry` names no sender.
      const activity = await accounts.listActivity();

      expect(activity.has("ACoAAGrace002" as never)).toBe(false);
      // Still an account, though — silence is not absence from the address book.
      expect((await accounts.resolve("ACoAAGrace002"))!.label).toBe("Grace Hopper");
    });
  });
});
