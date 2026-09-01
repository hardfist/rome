import { describe, expect, it } from "@rstest/core";
import type { TimelineEntry } from "@rome/api-types/people";
import { memoryMessages, type HeldMessage } from "./messages-memory.js";
import { testMessagesContract, WHOLE_HISTORY } from "./messages-contract.js";

// The reference store, and the contract suite proved against it: a suite that
// passed nothing would enroll every adapter and assert none of them.

const PHONE = "1555@s.whatsapp.net";
const LID = "77@lid";
const MEMBER = "ACoAA1";
// A thread the accounts below are not on, carrying messages from two addresses
// — the shape a LinkedIn thread has, where what addresses a message and what
// names the conversation it was said in are two different things.
const ROOM = "li-thread-room";
const ROOM_A = "ACoAAROOMA";
const ROOM_B = "ACoAAROOMB";

const entry = (
  source: string,
  timestamp: number,
  ref: string,
  direction: "inbound" | "outbound" = "inbound",
): TimelineEntry => ({ source, timestamp, ref, direction, body: `${ref}@${timestamp}` });

const held: HeldMessage[] = [
  { channel: "whatsapp", address: PHONE, entry: entry("whatsapp", 100, "wa:a") },
  { channel: "whatsapp", address: PHONE, entry: entry("whatsapp", 300, "wa:c", "outbound") },
  // The same second as wa:c, on the account's other address: the direction
  // settles the tie, and both have to survive a page boundary.
  { channel: "whatsapp", address: LID, entry: entry("whatsapp", 300, "wa:d") },
  { channel: "whatsapp", address: PHONE, entry: entry("whatsapp", 500, "wa:e") },
  { channel: "linkedin", address: MEMBER, entry: entry("linkedin", 200, "li:b") },
  { channel: "linkedin", address: MEMBER, entry: entry("linkedin", 400, "li:f", "outbound") },
  // Out of every scope below: another account on the same channel, and the
  // same string as a WhatsApp address on a channel that is not WhatsApp.
  { channel: "whatsapp", address: "9999@s.whatsapp.net", entry: entry("whatsapp", 600, "wa:x") },
  { channel: "linkedin", address: PHONE, entry: entry("linkedin", 700, "li:x") },

  // The room. Every message names its own sender and the one conversation they
  // were all said in, and no account below is addressed on it.
  {
    channel: "linkedin",
    address: ROOM_A,
    conversation: ROOM,
    entry: entry("linkedin", 800, "li:r1"),
  },
  {
    channel: "linkedin",
    address: ROOM_B,
    conversation: ROOM,
    entry: entry("linkedin", 900, "li:r2", "outbound"),
  },
  // The same second as li:r2, from the other member: the direction settles the
  // tie, and both have to survive a page boundary.
  {
    channel: "linkedin",
    address: ROOM_A,
    conversation: ROOM,
    entry: entry("linkedin", 900, "li:r3"),
  },
  {
    channel: "linkedin",
    address: ROOM_B,
    conversation: ROOM,
    entry: entry("linkedin", 1000, "li:r4"),
  },
];

const accounts = [
  { channel: "whatsapp", addresses: [PHONE, LID] },
  { channel: "linkedin", addresses: [MEMBER] },
];

testMessagesContract("memoryMessages", () => ({
  messages: memoryMessages(held),
  accounts,
  silent: [{ channel: "whatsapp", addresses: ["4444@s.whatsapp.net"] }],
  conversation: { channel: "linkedin", id: ROOM },
  silentConversation: { channel: "linkedin", id: "li-thread-nobody" },
}));

describe("memoryMessages", () => {
  const messages = memoryMessages(held);

  it("merges every address of every account into one newest-first history", async () => {
    const page = await messages.read({ accounts, limit: WHOLE_HISTORY });
    expect(page.map((e) => e.ref)).toEqual(["wa:e", "li:f", "wa:c", "wa:d", "li:b", "wa:a"]);
  });

  it("scopes by the channel and the address together", async () => {
    const page = await messages.read({
      accounts: [{ channel: "whatsapp", addresses: [PHONE] }],
      limit: WHOLE_HISTORY,
    });
    expect(page.map((e) => e.ref)).toEqual(["wa:e", "wa:c", "wa:a"]);
  });

  it("answers a message once when two accounts name its address", async () => {
    const shared = [
      { channel: "whatsapp", addresses: [PHONE] },
      { channel: "whatsapp", addresses: [PHONE, LID] },
    ];
    expect(await messages.count(shared)).toBe(4);
  });

  it("holds nothing for an empty scope", async () => {
    expect(await messages.latest([])).toBeNull();
    expect(await messages.count([])).toBe(0);
    expect(await messages.read({ accounts: [], limit: WHOLE_HISTORY })).toEqual([]);
  });

  it("merges every address of a conversation into one newest-first history", async () => {
    const page = await messages.readConversation({
      conversation: { channel: "linkedin", id: ROOM },
      limit: WHOLE_HISTORY,
    });
    expect(page.map((e) => e.ref)).toEqual(["li:r4", "li:r2", "li:r3", "li:r1"]);
  });

  // A message held with no conversation of its own was said in the one the
  // person on it addresses, so asking for that conversation answers exactly
  // what the person's account read answers.
  it("names a direct conversation by the address it arrived at", async () => {
    const byConversation = await messages.readConversation({
      conversation: { channel: "whatsapp", id: PHONE },
      limit: WHOLE_HISTORY,
    });
    const byAccount = await messages.read({
      accounts: [{ channel: "whatsapp", addresses: [PHONE] }],
      limit: WHOLE_HISTORY,
    });
    expect(byConversation).toEqual(byAccount);
  });

  it("scopes a conversation by the channel and the id together", async () => {
    expect(
      await messages.readConversation({
        conversation: { channel: "whatsapp", id: ROOM },
        limit: WHOLE_HISTORY,
      }),
    ).toEqual([]);
  });
});
