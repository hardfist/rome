import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { TimelinePage } from "@rome/api-types/people";
import { peopleRoutes } from "./people.js";
import { createTestDb, buildTestDeps, type TestDb, type TestDeps } from "../../test/helpers.js";
import { seedBaseline, type BaselineIds } from "../../test/seeds.js";
import { romeAgentMessages } from "../../db/schema.js";
import { STRANGER_PERSON_ID } from "../../constants.js";

// GET /people/:id/messages — one person's history merged across every account
// they are linked to. These tests pin what the merge answers over real stores:
// which of the overlapping ones an account's entries come from, that a channel
// filter narrows to one, and that walking the cursor visits each entry once.

const WA_JID = "15550009999@s.whatsapp.net";
const WA_LID = "88881111@lid";
const TG_THREAD = "tg-timeline";
const GROUP_THREAD = "tg-group-timeline";

const at = (iso: string) => new Date(iso);
const textContent = (text: string) => JSON.stringify([{ type: "text", content: text }]);

describe("People timeline API", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;
  let baseline: BaselineIds;
  let personId: string;
  let telegramSessionId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    baseline = await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", peopleRoutes(deps));

    personId = await deps.personMappingRepo.create({
      displayName: "Nadia Cross",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [
        { channel: "whatsapp", channelUserId: WA_JID },
        { channel: "telegram", channelUserId: TG_THREAD },
      ],
    });

    // WhatsApp: a mirrored direct thread, plus a group chat she is not read
    // through, plus a reaction the timeline does not render.
    await deps.whatsAppStoreRepo.upsertContacts([
      { jid: WA_JID, phoneNumber: "15550009999", name: "Nadia Cross" },
    ]);
    await deps.whatsAppStoreRepo.upsertMessages([
      {
        id: "wa-old",
        chatJid: WA_JID,
        senderJid: WA_JID,
        fromMe: false,
        timestamp: at("2026-08-01T09:00:00Z"),
        type: "text",
        text: "are we still on for friday",
        hasMedia: false,
      },
      {
        id: "wa-reply",
        chatJid: WA_JID,
        senderJid: WA_JID,
        fromMe: true,
        timestamp: at("2026-08-01T09:05:00Z"),
        type: "text",
        text: "yes — 7pm",
        hasMedia: false,
      },
      {
        id: "wa-react",
        chatJid: WA_JID,
        senderJid: WA_JID,
        fromMe: false,
        timestamp: at("2026-08-01T09:06:00Z"),
        type: "reaction",
        text: "👍",
        hasMedia: false,
        reactsToId: "wa-reply",
      },
      {
        id: "wa-group",
        chatJid: "120363000000000009@g.us",
        senderJid: WA_JID,
        fromMe: false,
        timestamp: at("2026-08-02T10:00:00Z"),
        type: "text",
        text: "posted in the group",
        hasMedia: false,
      },
    ]);

    // Telegram: no mirror, so her direct conversation is the channel session's
    // own transcript.
    const conversation = await deps.webchatRepo.ensureChannelConversation({
      channel: "telegram",
      threadId: TG_THREAD,
      threadType: "private",
      agentName: "main",
    });
    await deps.webchatRepo.addConversationMessage({
      sessionId: conversation.id,
      role: "user",
      content: textContent("did you see the invite"),
      platformMessageId: "tg-100",
      senderId: TG_THREAD,
      senderName: "Nadia Cross",
      createdAt: at("2026-08-03T08:00:00Z"),
    });
    telegramSessionId = conversation.id;
    await testDb.db.insert(romeAgentMessages).values({
      id: "tg-100-reply",
      sessionId: conversation.id,
      role: "assistant",
      content: textContent("just did — replying now"),
      createdAt: at("2026-08-03T08:01:00Z"),
    });
  });

  afterEach(() => testDb.close());

  async function fetchTimeline(id: string, query = ""): Promise<TimelinePage> {
    const res = await app.request(`/people/${id}/messages${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as TimelinePage;
  }

  it("returns entries across every account of the person, newest first", async () => {
    const page = await fetchTimeline(personId);
    expect(page.entries.map((entry) => [entry.source, entry.body])).toEqual([
      ["telegram", "just did — replying now"],
      ["telegram", "did you see the invite"],
      ["whatsapp", "yes — 7pm"],
      ["whatsapp", "are we still on for friday"],
    ]);
    expect(page.entries.map((entry) => entry.direction)).toEqual([
      "outbound",
      "inbound",
      "outbound",
      "inbound",
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("leaves out group conversations and reactions", async () => {
    const bodies = (await fetchTimeline(personId)).entries.map((entry) => entry.body);
    expect(bodies).not.toContain("posted in the group");
    expect(bodies).not.toContain("👍");
  });

  it("pages by nextCursor with no duplicate and no missing entry", async () => {
    const whole = (await fetchTimeline(personId)).entries;

    const walked: TimelinePage["entries"] = [];
    let query = "?limit=1";
    for (let page = 0; page < 10; page += 1) {
      const next = await fetchTimeline(personId, query);
      expect(next.entries).toHaveLength(1);
      walked.push(...next.entries);
      if (next.nextCursor === null) break;
      query = `?limit=1&cursor=${encodeURIComponent(next.nextCursor)}`;
    }
    expect(walked).toEqual(whole);
  });

  it("resumes inside a second that two stores both wrote to", async () => {
    // Whole seconds collide across stores, so the cursor has to name an entry
    // rather than a moment: resuming from the bare timestamp would drop
    // whatever else landed in the same second.
    const collide = at("2026-08-07T11:11:11Z");
    await deps.whatsAppStoreRepo.upsertMessages([
      {
        id: "wa-tie-in",
        chatJid: WA_JID,
        senderJid: WA_JID,
        fromMe: false,
        timestamp: collide,
        type: "text",
        text: "whatsapp inbound",
        hasMedia: false,
      },
      {
        id: "wa-tie-out",
        chatJid: WA_JID,
        senderJid: WA_JID,
        fromMe: true,
        timestamp: collide,
        type: "text",
        text: "whatsapp outbound",
        hasMedia: false,
      },
    ]);
    await deps.webchatRepo.addConversationMessage({
      sessionId: telegramSessionId,
      role: "user",
      content: textContent("telegram inbound"),
      platformMessageId: "tg-tie",
      senderId: TG_THREAD,
      createdAt: collide,
    });

    const whole = (await fetchTimeline(personId)).entries;
    const tied = whole.filter((entry) => entry.timestamp === Math.floor(collide.getTime() / 1000));
    expect(tied.map((entry) => entry.body)).toEqual([
      "whatsapp outbound",
      "telegram inbound",
      "whatsapp inbound",
    ]);

    const walked: TimelinePage["entries"] = [];
    let query = "?limit=1";
    for (let page = 0; page < 20; page += 1) {
      const next = await fetchTimeline(personId, query);
      walked.push(...next.entries);
      if (next.nextCursor === null) break;
      query = `?limit=1&cursor=${encodeURIComponent(next.nextCursor)}`;
    }
    expect(walked).toEqual(whole);
  });

  it("narrows to one source with ?channel=", async () => {
    const page = await fetchTimeline(personId, "?channel=whatsapp");
    expect(page.entries.map((entry) => entry.source)).toEqual(["whatsapp", "whatsapp"]);

    // A channel the person holds no account on is an empty history rather than
    // a bad request — channels are open-ended.
    expect((await fetchTimeline(personId, "?channel=discord")).entries).toEqual([]);
  });

  it("gives a sender with only sentinel history both halves of the exchange", async () => {
    const sentinelOnly = await deps.personMappingRepo.create({
      displayName: "Sentinel Only",
      bondLevel: "other",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: "tg-triaged" }],
    });
    await deps.sentinelLogRepo.create({
      messageId: "tg-900",
      channel: "telegram",
      channelUserId: "tg-triaged",
      displayName: "Sentinel Only",
      threadId: "tg-triaged",
      text: "is this the right number for bookings?",
      action: "replied",
      response: "it is — sending you the link",
    });

    const page = await fetchTimeline(sentinelOnly);
    expect(page.entries.map((entry) => [entry.direction, entry.body])).toEqual([
      ["outbound", "it is — sending you the link"],
      ["inbound", "is this the right number for bookings?"],
    ]);
  });

  it("reads a mirrored account from the mirror and never twice", async () => {
    // One WhatsApp exchange, written down three times: by the mirror, by Rome's
    // own transcript of the channel session, and by the sentinel that triaged
    // it. Production stores the same words in all three; the wording differs
    // here only so the assertion can say which store answered.
    const conversation = await deps.webchatRepo.ensureChannelConversation({
      channel: "whatsapp",
      threadId: WA_JID,
      threadType: "private",
      agentName: "main",
    });
    await deps.webchatRepo.addConversationMessage({
      sessionId: conversation.id,
      role: "notification",
      content: textContent("as the transcript has it"),
      platformMessageId: "wa-old",
      senderId: WA_JID,
      createdAt: at("2026-08-01T09:00:02Z"),
    });
    await deps.sentinelLogRepo.create({
      messageId: "wa-old",
      channel: "whatsapp",
      channelUserId: WA_JID,
      threadId: WA_JID,
      text: "as the sentinel logged it",
      action: "replied",
      response: "as the sentinel answered it",
    });

    const whatsapp = (await fetchTimeline(personId, "?channel=whatsapp")).entries;
    expect(whatsapp.map((entry) => entry.body)).toEqual([
      "yes — 7pm",
      "are we still on for friday",
    ]);
  });

  it("falls back to the channel transcript for an account no mirror holds", async () => {
    // The same overlap without a mirror: the transcript outranks the sentinel,
    // so the exchange reads as Rome's own record of it.
    const triaged = await deps.personMappingRepo.create({
      displayName: "Triaged Talker",
      bondLevel: "other",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: "tg-both" }],
    });
    const conversation = await deps.webchatRepo.ensureChannelConversation({
      channel: "telegram",
      threadId: "tg-both",
      threadType: "private",
      agentName: "main",
    });
    await deps.webchatRepo.addConversationMessage({
      sessionId: conversation.id,
      role: "notification",
      content: textContent("as the transcript has it"),
      platformMessageId: "tg-800",
      senderId: "tg-both",
      createdAt: at("2026-08-04T08:00:00Z"),
    });
    await deps.sentinelLogRepo.create({
      messageId: "tg-800",
      channel: "telegram",
      channelUserId: "tg-both",
      threadId: "tg-both",
      text: "as the sentinel logged it",
      action: "replied",
      response: "as the sentinel answered it",
    });

    const bodies = (await fetchTimeline(triaged)).entries.map((entry) => entry.body);
    expect(bodies).toEqual(["as the transcript has it"]);
  });

  it("holds a sentinel row back when the thread it names is a group", async () => {
    const inGroup = await deps.personMappingRepo.create({
      displayName: "Group Talker",
      bondLevel: "other",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: "tg-in-group" }],
    });
    await deps.webchatRepo.ensureChannelConversation({
      channel: "telegram",
      threadId: GROUP_THREAD,
      threadType: "group",
      agentName: "main",
    });
    await deps.sentinelLogRepo.create({
      messageId: "tg-901",
      channel: "telegram",
      channelUserId: "tg-in-group",
      threadId: GROUP_THREAD,
      text: "said in a group",
      action: "ignored",
    });
    await deps.sentinelLogRepo.create({
      messageId: "tg-902",
      channel: "telegram",
      channelUserId: "tg-in-group",
      threadId: "tg-in-group",
      text: "said to rome",
      action: "ignored",
    });

    const bodies = (await fetchTimeline(inGroup)).entries.map((entry) => entry.body);
    expect(bodies).toEqual(["said to rome"]);
  });

  it("reads one account through every address the channel folds onto it", async () => {
    // She is mapped under the LID, and the conversation hangs off the phone
    // JID. Both address one account, so the timeline is one conversation.
    await deps.whatsAppStoreRepo.upsertContacts([
      { jid: WA_LID, phoneNumber: "15550009999", notify: "Nadia" },
    ]);
    const byLid = await deps.personMappingRepo.create({
      displayName: "Nadia By LID",
      bondLevel: "other",
      approved: true,
      channelMappings: [{ channel: "whatsapp", channelUserId: WA_LID }],
    });

    const page = await fetchTimeline(byLid);
    expect(page.entries.map((entry) => entry.body)).toEqual([
      "yes — 7pm",
      "are we still on for friday",
    ]);
  });

  it("reads LinkedIn direct threads and leaves group threads out", async () => {
    const member = "ACoAAtimeline01";
    await deps.linkedInStoreRepo.upsertThreads([
      { threadId: "li-direct", threadUrl: "https://x/li-direct", unread: false },
      { threadId: "li-group", threadUrl: "https://x/li-group", unread: false },
      { threadId: "li-unread-group", threadUrl: "https://x/li-ug", unread: false },
    ]);
    await deps.linkedInStoreRepo.markThreadSynced("li-direct", { isGroup: false });
    // Flagged a group before its membership was read whole, so the flag is the
    // only thing that keeps it out.
    await deps.linkedInStoreRepo.markThreadSynced("li-unread-group", { isGroup: true });
    await deps.linkedInStoreRepo.upsertThreadParticipants("li-direct", [
      { participantId: member, name: "Priya Nair", isSelf: false },
      { participantId: "ACoAAself", name: "Guardian", isSelf: true },
    ]);
    await deps.linkedInStoreRepo.upsertThreadParticipants("li-group", [
      { participantId: member, name: "Priya Nair", isSelf: false },
      { participantId: "ACoAAself", name: "Guardian", isSelf: true },
      { participantId: "ACoAAthird", name: "Someone Else", isSelf: false },
    ]);
    await deps.linkedInStoreRepo.upsertThreadParticipants("li-unread-group", [
      { participantId: member, name: "Priya Nair", isSelf: false },
      { participantId: "ACoAAself", name: "Guardian", isSelf: true },
    ]);
    await deps.linkedInStoreRepo.upsertMessages([
      {
        messageId: "li-1",
        threadId: "li-direct",
        sentAt: at("2026-08-05T12:00:00Z"),
        senderIsSelf: false,
        text: "sent you a note about the role",
      },
      {
        messageId: "li-2",
        threadId: "li-direct",
        sentAt: at("2026-08-05T12:30:00Z"),
        senderIsSelf: true,
        text: "thanks — reading it now",
      },
      {
        messageId: "li-3",
        threadId: "li-group",
        sentAt: at("2026-08-06T12:00:00Z"),
        senderIsSelf: false,
        text: "posted in the group thread",
      },
      {
        messageId: "li-4",
        threadId: "li-unread-group",
        sentAt: at("2026-08-06T13:00:00Z"),
        senderIsSelf: false,
        text: "posted in the unread group",
      },
    ]);
    const priya = await deps.personMappingRepo.create({
      displayName: "Priya Nair",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "linkedin", channelUserId: member }],
    });

    const page = await fetchTimeline(priya);
    expect(page.entries.map((entry) => [entry.source, entry.direction, entry.body])).toEqual([
      ["linkedin", "outbound", "thanks — reading it now"],
      ["linkedin", "inbound", "sent you a note about the role"],
    ]);
  });

  it("answers 404 for an unknown person and for the stranger sentinel", async () => {
    expect((await app.request("/people/nobody-here/messages")).status).toBe(404);
    expect((await app.request(`/people/${STRANGER_PERSON_ID}/messages`)).status).toBe(404);
    expect(baseline.persons.strangerId).toBe(STRANGER_PERSON_ID);
  });

  it("refuses a cursor that is not one", async () => {
    const res = await app.request(`/people/${personId}/messages?cursor=not-a-cursor`);
    expect(res.status).toBe(400);
  });

  it("answers an empty page for a person with no accounts", async () => {
    const unreachable = await deps.personMappingRepo.create({
      displayName: "No Channels",
      bondLevel: "other",
      approved: true,
      channelMappings: [],
    });
    expect(await fetchTimeline(unreachable)).toEqual({ entries: [], nextCursor: null });
  });
});
