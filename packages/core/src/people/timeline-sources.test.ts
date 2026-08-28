import { describe, expect, it } from "vitest";
import type { Account, AccountId } from "../channels/accounts.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { romeSessions } from "../db/schema.js";
import { createTestDb } from "../test/helpers.js";
import { agentMessagesSource, timelineAccounts } from "./timeline-sources.js";

const account = (id: string, addresses: string[] = [id]): Account => ({
  id: id as AccountId,
  addresses,
  name: null,
  identifiers: {},
});

/** A channel that answers the listing and `resolve`, and holds no separate
 *  address map — so a caller that reaches for one fails here. */
class FakeAccounts {
  listings = 0;

  constructor(private readonly accounts: readonly Account[]) {}

  async listAccounts(_input: { query?: string; cursor?: string; limit: number }) {
    this.listings++;
    return { accounts: [...this.accounts] };
  }

  async resolve(address: string): Promise<Account | null> {
    return this.accounts.find((candidate) => candidate.addresses.includes(address)) ?? null;
  }
}

const ada = "12025550100@s.whatsapp.net";
const adaLid = "77770001@lid";
const grace = "12025550111@s.whatsapp.net";

describe("timelineAccounts", () => {
  it("collapses two addressings of one account onto one account", async () => {
    const whatsAppAccounts = new FakeAccounts([account(ada, [ada, adaLid])]);

    const [accounts] = await timelineAccounts({ whatsAppAccounts }, [
      [
        { channel: "whatsapp", channelUserId: ada },
        { channel: "whatsapp", channelUserId: adaLid },
      ],
    ]);

    expect(accounts).toEqual([{ channel: "whatsapp", addresses: [ada, adaLid] }]);
    expect(whatsAppAccounts.listings).toBe(1);
  });

  it("carries every address of an account a mapping names under one of them", async () => {
    const whatsAppAccounts = new FakeAccounts([account(ada, [ada, adaLid])]);

    const [accounts] = await timelineAccounts({ whatsAppAccounts }, [
      [{ channel: "whatsapp", channelUserId: adaLid }],
    ]);

    expect(accounts).toHaveLength(1);
    expect([...(accounts[0]?.addresses ?? [])].sort()).toEqual([ada, adaLid].sort());
  });

  it("keeps two accounts apart", async () => {
    const whatsAppAccounts = new FakeAccounts([account(ada, [ada, adaLid]), account(grace)]);

    const [accounts] = await timelineAccounts({ whatsAppAccounts }, [
      [
        { channel: "whatsapp", channelUserId: adaLid },
        { channel: "whatsapp", channelUserId: grace },
      ],
    ]);

    expect(accounts).toHaveLength(2);
  });

  it("gives an address the address book does not hold its own timeline", async () => {
    const whatsAppAccounts = new FakeAccounts([account(ada, [ada, adaLid])]);

    const [accounts] = await timelineAccounts({ whatsAppAccounts }, [
      [{ channel: "whatsapp", channelUserId: "12025550999@s.whatsapp.net" }],
    ]);

    expect(accounts).toEqual([{ channel: "whatsapp", addresses: ["12025550999@s.whatsapp.net"] }]);
  });

  it("gives a channel with no account plane the mapping's own address", async () => {
    const whatsAppAccounts = new FakeAccounts([account(ada, [ada, adaLid])]);

    const [accounts] = await timelineAccounts({ whatsAppAccounts }, [
      [{ channel: "linkedin", channelUserId: "ACoAAAda0001" }],
    ]);

    expect(accounts).toEqual([{ channel: "linkedin", addresses: ["ACoAAAda0001"] }]);
    // No mapping named WhatsApp, so its address book is never read.
    expect(whatsAppAccounts.listings).toBe(0);
  });

  it("answers one result per group, in the order given", async () => {
    const whatsAppAccounts = new FakeAccounts([account(ada, [ada, adaLid]), account(grace)]);

    const groups = await timelineAccounts({ whatsAppAccounts }, [
      [{ channel: "whatsapp", channelUserId: grace }],
      [],
      [{ channel: "whatsapp", channelUserId: adaLid }],
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual([{ channel: "whatsapp", addresses: [grace] }]);
    expect(groups[1]).toEqual([]);
    expect(groups[2]?.[0]?.channel).toBe("whatsapp");
    // One read serves every group.
    expect(whatsAppAccounts.listings).toBe(1);
  });
});

describe("agentMessagesSource", () => {
  const CHANNEL = "telegram";
  const THREAD = "tg-777";
  const accounts = [{ channel: CHANNEL, addresses: [THREAD] }];

  /** A channel session for the thread, and the repository that writes to it —
   *  the rows this source reads come from the writer that really stores them. */
  async function conversation() {
    const { db } = createTestDb();
    const now = new Date(0);
    await db.insert(romeSessions).values({
      id: "session",
      name: "session",
      type: "channel",
      sourceChannel: CHANNEL,
      sourceThreadId: THREAD,
      sourceThreadType: "private",
      createdAt: now,
      activityAt: now,
    });
    return { source: agentMessagesSource(db), repo: new WebChatRepository(db) };
  }

  const content = (line: string) => JSON.stringify([{ type: "text", content: line }]);

  // `notification` is written in both directions, so the role cannot settle
  // one on its own: a Rome message the send path did not tie to a turn is
  // stored under it, and reading the role alone puts Rome's own line on the
  // person's side of their timeline.
  it("puts a notification Rome sent on Rome's side", async () => {
    const { source, repo } = await conversation();
    await repo.recordOutboundConversationMessage({
      sessionId: "session",
      content: content("delivered without a turn"),
      platformMessageId: "pm-out-of-band",
      senderId: "rome",
      senderName: "Rome",
      knownToProvider: false,
    });

    const [entry] = await source.read({ accounts, cursor: null, limit: 10 });
    expect(entry).toMatchObject({ direction: "outbound", body: "delivered without a turn" });
  });

  it("puts a notification the person sent on theirs", async () => {
    const { source, repo } = await conversation();
    await repo.addConversationMessage({
      sessionId: "session",
      role: "notification",
      content: content("said while Rome slept"),
      platformMessageId: "pm-unwoken",
      senderId: THREAD,
      senderName: "Ada",
    });

    const [entry] = await source.read({ accounts, cursor: null, limit: 10 });
    expect(entry).toMatchObject({ direction: "inbound", body: "said while Rome slept" });
  });
});
