import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { countingDb, createTestDb, type TestDb } from "../test/helpers.js";
import { linkedinMessages, linkedinThreadParticipants, linkedinThreads } from "../db/schema.js";
import { testMessagesContract, WHOLE_HISTORY } from "./messages-contract.js";
import { linkedInMessages } from "./linkedin-messages.js";
import type { MessageAccount } from "./messages.js";

// `linkedin_messages` as a `Messages` store. The mirror holds group threads
// and rooms the guardian is one of many in; a person's history is the threads
// that are a conversation between two people, and that scope is what the cases
// below pin.

const SELF = "ACoAASELF";
const MEMBER = "ACoAAMEMBER";
const OTHER = "ACoAAOTHER";
// One person holding two member ids, both on one thread of their own — the
// case an attribution that answered per participant would show twice.
const TWIN_A = "ACoAATWINA";
const TWIN_B = "ACoAATWINB";

const account = { channel: "linkedin", addresses: [MEMBER] };
const accounts = [account];
const silent = [{ channel: "linkedin", addresses: ["ACoAASILENT"] }];

interface ThreadSeed {
  thread: string;
  participants: string[];
  isGroup?: boolean | null;
  messages: Array<{ id: string; at: number; self?: boolean; text?: string; sentAt?: boolean }>;
}

const threads: ThreadSeed[] = [
  {
    thread: "t-direct",
    participants: [SELF, MEMBER],
    messages: [
      { id: "a", at: 100, text: "first" },
      // No `sent_at`: the mirror falls back on when it stored the message.
      { id: "b", at: 200, text: "no delivery time", sentAt: false },
      { id: "c", at: 300, self: true, text: "answered" },
      // The same second as `c`; the direction settles the tie.
      { id: "d", at: 300, text: "crossed in flight" },
      { id: "e", at: 500, text: "latest" },
    ],
  },
  // Three on the thread: nobody's direct history, whatever LinkedIn's own flag
  // says about it — and all of it is what the thread holds.
  {
    thread: "t-room",
    participants: [SELF, MEMBER, OTHER],
    messages: [
      { id: "f", at: 700, text: "in the room" },
      { id: "f2", at: 720, self: true, text: "said back" },
      // The same second as `f2`; the direction settles the tie.
      { id: "f3", at: 720, text: "crossed in flight" },
      { id: "f4", at: 900, text: "newest in the room" },
    ],
  },
  // Two on the thread, but LinkedIn calls it a group.
  {
    thread: "t-flagged",
    participants: [SELF, MEMBER],
    isGroup: true,
    messages: [{ id: "g", at: 800, text: "flagged as a group" }],
  },
  {
    thread: "t-other",
    participants: [SELF, OTHER],
    messages: [{ id: "h", at: 900, text: "another member" }],
  },
  {
    thread: "t-twins",
    participants: [TWIN_A, TWIN_B],
    messages: [{ id: "i", at: 1000, text: "one message, two member ids" }],
  },
];

function seedMirror(testDb: TestDb): void {
  const now = new Date();
  testDb.db
    .insert(linkedinThreads)
    .values(
      threads.map((seed) => ({
        threadId: seed.thread,
        threadUrl: `https://www.linkedin.com/messaging/thread/${seed.thread}/`,
        isGroup: seed.isGroup ?? null,
        unread: false,
        firstSyncedAt: now,
        updatedAt: now,
      })),
    )
    .run();

  testDb.db
    .insert(linkedinThreadParticipants)
    .values(
      threads.flatMap((seed) =>
        seed.participants.map((participantId) => ({
          threadId: seed.thread,
          participantId,
          firstSyncedAt: now,
        })),
      ),
    )
    .run();

  testDb.db
    .insert(linkedinMessages)
    .values(
      threads.flatMap((seed) =>
        seed.messages.map((message) => ({
          messageId: message.id,
          threadId: seed.thread,
          sentAt: message.sentAt === false ? null : new Date(message.at * 1000),
          senderIsSelf: message.self ?? false,
          text: message.text ?? null,
          createdAt: new Date(message.at * 1000),
        })),
      ),
    )
    .run();
}

describe("linkedInMessages", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    seedMirror(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  const refs = (entries: { ref: string }[]) => entries.map((entry) => entry.ref);

  it("answers the member's direct thread, newest first", async () => {
    const messages = linkedInMessages(testDb.db);
    const page = await messages.read({ accounts, limit: WHOLE_HISTORY });
    expect(refs(page)).toEqual([
      "t-direct:e",
      "t-direct:c",
      "t-direct:d",
      "t-direct:b",
      "t-direct:a",
    ]);
    expect(page[0]).toEqual({
      source: "linkedin",
      timestamp: 500,
      direction: "inbound",
      ref: "t-direct:e",
      body: "latest",
    });
  });

  it("leaves out a thread of more than two participants", async () => {
    const messages = linkedInMessages(testDb.db);
    const page = await messages.read({ accounts, limit: WHOLE_HISTORY });
    expect(refs(page)).not.toContain("t-room:f");
  });

  it("leaves out a thread LinkedIn calls a group", async () => {
    const messages = linkedInMessages(testDb.db);
    const page = await messages.read({ accounts, limit: WHOLE_HISTORY });
    expect(refs(page)).not.toContain("t-flagged:g");
  });

  it("answers a message once when the person holds both member ids on it", async () => {
    const messages = linkedInMessages(testDb.db);
    const twins = [
      { channel: "linkedin", addresses: [TWIN_A] },
      { channel: "linkedin", addresses: [TWIN_B] },
    ];
    expect(refs(await messages.read({ accounts: twins, limit: WHOLE_HISTORY }))).toEqual([
      "t-twins:i",
    ]);
    expect(await messages.count(twins)).toBe(1);
  });

  // The acceptance the milestone turns on: the mirror already held these rows
  // and nothing asked for them.
  it("answers a group thread's messages when asked for that thread", async () => {
    const messages = linkedInMessages(testDb.db);
    const page = await messages.readConversation({
      conversation: { channel: "linkedin", id: "t-room" },
      limit: WHOLE_HISTORY,
    });
    expect(refs(page)).toEqual(["t-room:f4", "t-room:f2", "t-room:f3", "t-room:f"]);
    expect(page[0]).toEqual({
      source: "linkedin",
      timestamp: 900,
      direction: "inbound",
      ref: "t-room:f4",
      body: "newest in the room",
    });
  });

  it("answers none of a group thread's messages to any account read", async () => {
    const messages = linkedInMessages(testDb.db);
    const held = await messages.readConversation({
      conversation: { channel: "linkedin", id: "t-room" },
      limit: WHOLE_HISTORY,
    });
    expect(held.length).toBeGreaterThan(0);

    // Every member of the room asked for as an account, and the thread id
    // handed over as if it were one.
    for (const address of [MEMBER, OTHER, SELF, "t-room"]) {
      const scope: MessageAccount[] = [{ channel: "linkedin", addresses: [address] }];
      expect(refs(await messages.read({ accounts: scope, limit: WHOLE_HISTORY }))).not.toContain(
        "t-room:f4",
      );
    }
    const asThread: MessageAccount[] = [{ channel: "linkedin", addresses: ["t-room"] }];
    expect(await messages.latest(asThread)).toBeNull();
    expect(await messages.count(asThread)).toBe(0);
  });

  // LinkedIn's own flag is the other way a thread is a group, and it settles
  // threads the participant count would call direct.
  it("answers a thread LinkedIn calls a group when asked for that thread", async () => {
    const messages = linkedInMessages(testDb.db);
    const page = await messages.readConversation({
      conversation: { channel: "linkedin", id: "t-flagged" },
      limit: WHOLE_HISTORY,
    });
    expect(refs(page)).toEqual(["t-flagged:g"]);
    expect(refs(await messages.read({ accounts, limit: WHOLE_HISTORY }))).not.toContain(
      "t-flagged:g",
    );
  });

  it("answers a direct thread asked for as a conversation exactly as its account reads it", async () => {
    const messages = linkedInMessages(testDb.db);
    const byConversation = await messages.readConversation({
      conversation: { channel: "linkedin", id: "t-direct" },
      limit: WHOLE_HISTORY,
    });
    expect(byConversation).toEqual(await messages.read({ accounts, limit: WHOLE_HISTORY }));
  });

  it("holds nothing for a conversation on another channel", async () => {
    const messages = linkedInMessages(testDb.db);
    expect(
      await messages.readConversation({
        conversation: { channel: "whatsapp", id: "t-room" },
        limit: WHOLE_HISTORY,
      }),
    ).toEqual([]);
  });

  // The store takes the database and nothing else, so the read that reaches a
  // group answers with no LinkedIn session open.
  it("answers a conversation from the database alone", async () => {
    expect(linkedInMessages.length).toBe(1);
    const page = await linkedInMessages(testDb.db).readConversation({
      conversation: { channel: "linkedin", id: "t-room" },
      limit: 1,
    });
    expect(refs(page)).toEqual(["t-room:f4"]);
  });

  it("holds nothing for an account on another channel", async () => {
    const messages = linkedInMessages(testDb.db);
    const elsewhere: MessageAccount[] = [{ channel: "whatsapp", addresses: [MEMBER] }];
    expect(await messages.latest(elsewhere)).toBeNull();
    expect(await messages.count(elsewhere)).toBe(0);
    expect(await messages.read({ accounts: elsewhere, limit: WHOLE_HISTORY })).toEqual([]);
  });

  it("holds nothing for an empty scope", async () => {
    const messages = linkedInMessages(testDb.db);
    expect(await messages.latest([])).toBeNull();
    expect(await messages.count([])).toBe(0);
    expect(await messages.read({ accounts: [], limit: WHOLE_HISTORY })).toEqual([]);
  });

  // The scope is the member ids an account answers to, and the three verbs
  // answer one history over it: `count` is the length of the full read and
  // `latest` its first entry. Per scope rather than once, because a store that
  // scoped `read` one way and `count` another would still agree on the widest
  // scope there is.
  it.each([
    {
      of: "a member's direct thread",
      scope: accounts,
      refs: ["t-direct:e", "t-direct:c", "t-direct:d", "t-direct:b", "t-direct:a"],
    },
    // `t-room` is three-handed and `t-flagged` is a group, so neither is any
    // member's direct history — only `t-other` is.
    {
      of: "a member reached on one direct thread",
      scope: [{ channel: "linkedin", addresses: [OTHER] }],
      refs: ["t-other:h"],
    },
    // One person holding two member ids, both on the thread: one message, not
    // one per participant.
    {
      of: "one account under two member ids",
      scope: [
        { channel: "linkedin", addresses: [TWIN_A] },
        { channel: "linkedin", addresses: [TWIN_B] },
      ],
      refs: ["t-twins:i"],
    },
    { of: "a member the mirror holds nothing for", scope: silent, refs: [] },
  ])("answers read, count and latest over $of", async ({ scope, refs: expected }) => {
    const messages = linkedInMessages(testDb.db);
    const page = await messages.read({ accounts: scope, limit: WHOLE_HISTORY });

    expect(refs(page)).toEqual(expected);
    expect(await messages.count(scope)).toBe(page.length);
    expect(await messages.latest(scope)).toEqual(page[0] ?? null);
  });

  it("serves concurrent latest and read calls from one store pass", async () => {
    const cursor = await linkedInMessages(testDb.db).latest(accounts);
    if (!cursor) throw new Error("the mirror answered nothing to resume from");

    const counted = countingDb(testDb.db);
    const messages = linkedInMessages(counted.db);
    const before = counted.passes();

    const [newest, otherNewest, page, tail, total] = await Promise.all([
      messages.latest(accounts),
      messages.latest([{ channel: "linkedin", addresses: [OTHER] }]),
      messages.read({ accounts, limit: 2 }),
      messages.read({ accounts, after: cursor, limit: WHOLE_HISTORY }),
      messages.count(accounts),
    ]);

    expect(counted.passes() - before).toBe(1);
    expect(newest?.ref).toBe("t-direct:e");
    expect(otherNewest?.ref).toBe("t-other:h");
    expect(refs(page)).toEqual(["t-direct:e", "t-direct:c"]);
    expect(refs(tail)).toEqual(["t-direct:c", "t-direct:d", "t-direct:b", "t-direct:a"]);
    expect(total).toBe(5);
  });

  it("costs one pass per round of calls, not one per account", async () => {
    const counted = countingDb(testDb.db);
    const messages = linkedInMessages(counted.db);
    const directory = [MEMBER, OTHER, TWIN_A, TWIN_B, "ACoAASILENT"].map(
      (address): MessageAccount[] => [{ channel: "linkedin", addresses: [address] }],
    );

    const before = counted.passes();
    await Promise.all(directory.map((row) => messages.latest(row)));
    expect(counted.passes() - before).toBe(1);
  });
});

testMessagesContract("linkedInMessages", () => {
  const testDb = createTestDb();
  seedMirror(testDb);
  return {
    messages: linkedInMessages(testDb.db),
    accounts,
    silent,
    conversation: { channel: "linkedin", id: "t-room" },
    silentConversation: { channel: "linkedin", id: "t-nobody" },
  };
});
