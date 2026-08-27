import { describe, expect, it } from "vitest";
import type { AccountDirectory, DirectoryAccount, PersonResource } from "@rome/api-types/people";
import {
  directoryGroups,
  levelCounts,
  peopleRows,
  rowHandle,
  streamRows,
  type PeopleRow,
} from "./people-model";

// The People page reads two nouns — a person and the accounts they are reachable
// at — and renders one ladder over both. What is pinned here is the join: which
// contract row becomes which ladder position, how the two interleave in the
// stream, and whose numbers the chips and headings show.

const now = Math.floor(Date.now() / 1000);

function person(over: Partial<PersonResource> = {}): PersonResource {
  return {
    id: over.id ?? "ray-oster",
    displayName: "Ray Oster",
    bondLevel: "inner-circle",
    accounts: [{ channel: "telegram", channelUserId: "418820113", displayName: "Ray" }],
    messageCount: 2,
    latest: { source: "telegram", timestamp: now - 600, preview: "see you thursday" },
    ...over,
  };
}

function account(over: Partial<DirectoryAccount> = {}): DirectoryAccount {
  const channelUserId = over.channelUserId ?? "883104221";
  return {
    channel: "telegram",
    channelUserId,
    addresses: [channelUserId],
    displayName: "Jules Marchetti",
    state: "unlinked",
    personId: null,
    personName: null,
    latest: { source: "telegram", timestamp: now - 300, preview: "is this the right number?" },
    messageCount: 1,
    ...over,
  };
}

function directory(accounts: DirectoryAccount[], over: Partial<AccountDirectory> = {}) {
  const counts = { unlinked: 0, linked: 0, dismissed: 0 };
  for (const row of accounts) counts[row.state] += 1;
  return { accounts, nextCursor: null, counts, silentTotal: 0, ...over } satisfies AccountDirectory;
}

const rowsOf = (rows: PeopleRow[]) => rows.map((row) => row.displayName);

describe("peopleRows", () => {
  it("places a person by their stored bond level, off-ladder values included", () => {
    const rows = peopleRows([person({ bondLevel: "colleague" })], []);
    // The column is free text and older rows carry values like "colleague".
    // Dropping one would take a person the guardian can see off every chip.
    expect(rows[0].level).toBe("other");
    expect(rows[0].kind).toBe("person");
  });

  it("reads an account's ladder position off the decision the guardian made", () => {
    const rows = peopleRows(
      [],
      [
        account({ channelUserId: "1", state: "unlinked" }),
        account({ channelUserId: "2", state: "dismissed" }),
      ],
    );
    expect(rows.map((row) => row.level)).toEqual(["unknown", "stranger"]);
  });

  it("leaves a linked account to the person it resolves to", () => {
    // The account and the person are the same human seen from two sides. Two
    // rows is the duplication the one-row-per-identity rule exists to remove —
    // and the person is the row that can carry a bond.
    const rows = peopleRows(
      [person()],
      [
        account({
          channel: "telegram",
          channelUserId: "418820113",
          state: "linked",
          personId: "ray-oster",
          personName: "Ray Oster",
        }),
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("person");
  });

  it("carries every addressing the server folded onto one account", () => {
    // The `@lid` consolidation is the contract's `addresses`: the server decides
    // which addressings are one account, and the client renders what it decided.
    const rows = peopleRows(
      [],
      [
        account({
          channelUserId: "1555@s.whatsapp.net",
          addresses: ["1555", "1555@s.whatsapp.net"],
        }),
      ],
    );
    expect(rows[0].addresses).toEqual(["1555", "1555@s.whatsapp.net"]);
  });
});

describe("streamRows", () => {
  it("interleaves people and accounts by what happened last", () => {
    const rows = peopleRows(
      [person({ latest: { source: "telegram", timestamp: now - 900, preview: "older" } })],
      [
        account({
          channelUserId: "new",
          displayName: "Devika",
          latest: { source: "whatsapp", timestamp: now - 60, preview: "newer" },
        }),
      ],
    );
    // One stream over both nouns rather than a section each: a search spans the
    // whole ladder, and the two orders have to be one order for that to mean
    // anything.
    expect(rowsOf(streamRows(rows, { search: "dev", filter: "all" }))).toEqual(["Devika"]);
    expect(rowsOf(streamRows(rows, { search: "a", filter: "all" }))).toEqual([
      "Devika",
      "Ray Oster",
    ]);
  });

  it("holds both unplaced ends out of All, and lets each chip in", () => {
    const rows = peopleRows(
      [person()],
      [
        account({ channelUserId: "waiting", displayName: "Jules" }),
        account({ channelUserId: "spam", displayName: "Prize", state: "dismissed" }),
      ],
    );
    expect(rowsOf(streamRows(rows, { search: "", filter: "all" }))).toEqual(["Ray Oster"]);
    expect(rowsOf(streamRows(rows, { search: "", filter: "unknown" }))).toEqual(["Jules"]);
    expect(rowsOf(streamRows(rows, { search: "", filter: "stranger" }))).toEqual(["Prize"]);
  });

  it("holds back the guardian and anyone who has done nothing", () => {
    const rows = peopleRows(
      [
        person({ id: "me", displayName: "Mock Guardian", bondLevel: "guardian" }),
        person({ id: "quiet", displayName: "Nadia", latest: null, messageCount: 0 }),
      ],
      [account({ channelUserId: "silent", displayName: "Jonas", latest: null, messageCount: 0 })],
    );
    // A stream row is something that happened, and it is about somebody else.
    expect(rowsOf(streamRows(rows, { search: "", filter: "all" }))).toEqual([]);
  });

  it("lets a search reach the quiet ones, whatever chip is lit — guardian excepted", () => {
    const rows = peopleRows(
      [person({ id: "me", displayName: "Mock Guardian", bondLevel: "guardian" })],
      [account({ channelUserId: "silent", displayName: "Jonas Tan", latest: null })],
    );
    // Someone typing a name wants that person wherever they sit on the ladder.
    expect(rowsOf(streamRows(rows, { search: "jonas", filter: "inner-circle" }))).toEqual([
      "Jonas Tan",
    ]);
    expect(rowsOf(streamRows(rows, { search: "mock", filter: "all" }))).toEqual([]);
  });
});

describe("directoryGroups", () => {
  const roster = () =>
    peopleRows(
      [
        person({ id: "me", displayName: "Mock Guardian", bondLevel: "guardian" }),
        person({ id: "ray", displayName: "Ray Oster", bondLevel: "inner-circle" }),
        person({ id: "sam", displayName: "Sam Okafor", bondLevel: "colleague" }),
      ],
      [
        account({ channelUserId: "waiting", displayName: "Jules" }),
        account({ channelUserId: "spam", displayName: "Prize", state: "dismissed" }),
        account({ channelUserId: "quiet", displayName: "Jonas Tan", latest: null }),
      ],
    );

  const groupsOf = (options: Parameters<typeof directoryGroups>[1]) =>
    directoryGroups(roster(), options).map((group) => [
      group.level,
      group.rows.map((row) => row.displayName),
    ]);

  it("groups everyone in ladder order, holding the address book back", () => {
    expect(groupsOf({ filter: "all", search: "", showSilent: false })).toEqual([
      ["unknown", ["Jules"]],
      ["guardian", ["Mock Guardian"]],
      ["inner-circle", ["Ray Oster"]],
      ["other", ["Sam Okafor"]],
    ]);
  });

  it("keeps the Unknown heading when the toggle is what emptied it", () => {
    const groups = directoryGroups(
      peopleRows([person({ id: "ray" })], [account({ channelUserId: "quiet", latest: null })]),
      { filter: "all", search: "", showSilent: false },
    );
    // The heading carries the toggle, so an address book with no waiting
    // senders in front of it would otherwise have no way back on screen.
    const unknown = groups.find((group) => group.level === "unknown");
    expect(unknown?.rows).toEqual([]);
    expect(unknown).toBeDefined();
  });

  it("shows the silent contacts once they are asked for", () => {
    const groups = groupsOf({ filter: "all", search: "", showSilent: true });
    expect(groups.find(([level]) => level === "unknown")?.[1]).toEqual(["Jules", "Jonas Tan"]);
  });

  it("holds both unplaced ends back from All, and enters each on purpose", () => {
    // "All" means the placed people plus the senders waiting on a decision;
    // dismissal is entered deliberately.
    expect(
      groupsOf({ filter: "all", search: "", showSilent: false }).map(([level]) => level),
    ).not.toContain("stranger");
    // The guardian rides along, as in every view — see below.
    expect(groupsOf({ filter: "stranger", search: "", showSilent: false })).toEqual([
      ["guardian", ["Mock Guardian"]],
      ["stranger", ["Prize"]],
    ]);
  });

  it("keeps the guardian in their own people list, whatever the chip says", () => {
    const groups = groupsOf({ filter: "inner-circle", search: "", showSilent: false });
    expect(groups.map(([level]) => level)).toContain("guardian");
  });

  it("reaches the address book through a search whatever the toggle says", () => {
    const groups = groupsOf({ filter: "all", search: "jonas", showSilent: false });
    expect(groups).toEqual([["unknown", ["Jonas Tan"]]]);
  });
});

describe("levelCounts", () => {
  it("reads every number off the server, never off the loaded rows", () => {
    const counts = levelCounts(
      { all: 9, guardian: 1, "inner-circle": 3, acquaintance: 4, other: 1 },
      directory([], { counts: { unlinked: 6, linked: 12, dismissed: 2 } }),
    );

    expect(counts).toEqual({
      unknown: 6,
      guardian: 1,
      "inner-circle": 3,
      acquaintance: 4,
      other: 1,
      stranger: 2,
    });
    // Linked accounts are counted under the person they resolve to, never again
    // as accounts — the two nouns describe one roster.
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(9 + 6 + 2);
  });
});

describe("rowHandle", () => {
  it("renders a WhatsApp account as its phone number", () => {
    const [row] = peopleRows(
      [],
      [account({ channel: "whatsapp", channelUserId: "14155550142@s.whatsapp.net" })],
    );
    expect(rowHandle(row)).toBe("+1 (415) 555-0142");
  });

  it("falls back to the raw identifier on a channel with no phone shape", () => {
    const [row] = peopleRows([], [account({ channel: "discord", channelUserId: "6128843201" })]);
    expect(rowHandle(row)).toBe("6128843201");
  });
});
