// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  countPeople,
  linkConflict,
  parseAccountCursor,
  parseAccountState,
  parsePersonFilterLevel,
  personMatchesLevel,
  personMatchesQuery,
  sliceAccountDirectory,
  type DirectoryAccount,
  type PersonResource,
} from "@rome/api-types/people";
import i18n from "@/i18n";
import PeoplePage from "./PeoplePage";

// The People page as the guardian drives it: a stream that routes to whoever
// has something new, and a directory that reads the roster. The derivations
// behind grouping and counts are pinned in `people/people-model.test.ts`; what
// is under test here is the page wiring — which request a control sends, what
// it shows afterwards, and where a click takes the guardian.
//
// The backend is stubbed through the contract's own helpers rather than
// restated, so a fixture cannot drift from the routes on ordering, filtering,
// counting or paging.

beforeAll(async () => {
  await i18n.changeLanguage("en");
  // Radix Select and the chip rail drive pointer capture and scroll, neither of
  // which jsdom implements.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Every field any of the contract's write bodies carries, so one shape reads
 *  them all — the mock below dispatches on the path, not on the body. */
interface WriteBody {
  displayName?: string;
  bondLevel?: string;
  accounts?: { channel: string; channelUserId: string }[];
  channel?: string;
  channelUserId?: string;
  transferFrom?: string;
  from?: string;
}

interface FetchCall {
  url: string;
  method: string;
  body: WriteBody | undefined;
}

const NOW = Math.floor(Date.now() / 1000);

const GUARDIAN: PersonResource = {
  id: "me",
  displayName: "Zhangfan Dong",
  bondLevel: "guardian",
  accounts: [{ channel: "webchat", channelUserId: "wc-1", displayName: "wc-1" }],
  messageCount: 0,
  latest: null,
};

const FRIEND: PersonResource = {
  id: "wei-chen",
  displayName: "Wei Chen",
  bondLevel: "inner-circle",
  accounts: [{ channel: "telegram", channelUserId: "418820113", displayName: "wei_c" }],
  messageCount: 30,
  latest: { source: "telegram", timestamp: NOW - 600, preview: "on my way" },
};

const QUIET_PERSON: PersonResource = {
  id: "nadia",
  displayName: "Nadia Petrova",
  bondLevel: "acquaintance",
  accounts: [],
  messageCount: 0,
  latest: null,
};

const UNKNOWN_SENDER: DirectoryAccount = {
  channel: "whatsapp",
  channelUserId: "6591234472@s.whatsapp.net",
  addresses: ["6591234472", "6591234472@s.whatsapp.net"],
  displayName: "Rachel Lim",
  state: "unlinked",
  personId: null,
  personName: null,
  latest: { source: "whatsapp", timestamp: NOW - 7_200, preview: "Are you free Saturday?" },
  messageCount: 12,
};

const SILENT_CONTACT: DirectoryAccount = {
  channel: "whatsapp",
  channelUserId: "6588021147@s.whatsapp.net",
  addresses: ["6588021147@s.whatsapp.net"],
  displayName: "Jonas Tan",
  state: "unlinked",
  personId: null,
  personName: null,
  latest: null,
  messageCount: 0,
};

const DISMISSED: DirectoryAccount = {
  channel: "whatsapp",
  channelUserId: "447700900123@s.whatsapp.net",
  addresses: ["447700900123@s.whatsapp.net"],
  displayName: "Crypto signals",
  state: "dismissed",
  personId: null,
  personName: null,
  latest: { source: "whatsapp", timestamp: NOW - 90_000, preview: "100x gains guaranteed" },
  messageCount: 6,
};

const LINKED_ACCOUNT: DirectoryAccount = {
  channel: "telegram",
  channelUserId: "418820113",
  addresses: ["418820113"],
  displayName: "wei_c",
  state: "linked",
  personId: "wei-chen",
  personName: "Wei Chen",
  latest: { source: "telegram", timestamp: NOW - 600, preview: "on my way" },
  messageCount: 30,
};

/** The world both reads are served from, and every write applies to. */
interface World {
  people: PersonResource[];
  accounts: DirectoryAccount[];
  peopleFail: boolean;
  accountsFail: boolean;
}

type Json = (payload: unknown, status?: number) => Response;

interface AccountRef {
  channel: string;
  channelUserId: string;
}

function findAccount(world: World, ref: AccountRef) {
  return world.accounts.find(
    (account) => account.channel === ref.channel && account.channelUserId === ref.channelUserId,
  );
}

/** Move an account under a person, on both sides of the join. */
function attach(world: World, person: PersonResource, ref: AccountRef) {
  const account = findAccount(world, ref);
  if (!account) return;
  const previous = account.personId && world.people.find((p) => p.id === account.personId);
  if (previous) {
    previous.accounts = previous.accounts.filter(
      (held) => held.channel !== account.channel || held.channelUserId !== account.channelUserId,
    );
  }
  account.state = "linked";
  account.personId = person.id;
  account.personName = person.displayName;
  person.accounts = [
    ...person.accounts,
    {
      channel: account.channel,
      channelUserId: account.channelUserId,
      displayName: account.displayName,
    },
  ];
  person.messageCount += account.messageCount;
  person.latest = account.latest ?? person.latest;
}

/**
 * The write half of the contract, applied to the same world the reads serve.
 *
 * Every verb answers the row it changed and leaves the listing to be read
 * again, which is what lets a test tell a page that settles by refetching from
 * one that patched what it already had.
 */
function applyWrite(
  world: World,
  method: string,
  path: string,
  body: WriteBody,
  json: Json,
): Response {
  const holder = (account: DirectoryAccount) => ({
    id: account.personId ?? "",
    displayName: account.personName ?? "",
  });

  const decision = /^\/api\/accounts\/([^/]+)\/(.+)\/(dismiss|restore)$/.exec(path);
  if (decision) {
    const [, channel, rawId, verb] = decision;
    const account = findAccount(world, {
      channel: decodeURIComponent(channel ?? ""),
      channelUserId: decodeURIComponent(rawId ?? ""),
    });
    if (!account) return json({ error: "Unknown account" }, 404);
    if (account.state === "linked") return json(linkConflict(account, holder(account)), 409);
    account.state = verb === "dismiss" ? "dismissed" : "unlinked";
    return json(account);
  }

  if (path === "/api/people" && method === "POST") {
    const refs = body.accounts ?? [];
    for (const ref of refs) {
      const held = findAccount(world, ref);
      if (held?.state === "linked") return json(linkConflict(ref, holder(held)), 409);
    }
    const person: PersonResource = {
      id: (body.displayName ?? "").toLowerCase().replace(/\s+/g, "-"),
      displayName: body.displayName ?? "",
      bondLevel: body.bondLevel ?? "other",
      accounts: [],
      messageCount: 0,
      latest: null,
    };
    world.people.push(person);
    for (const ref of refs) attach(world, person, ref);
    return json(person, 201);
  }

  const link = /^\/api\/people\/([^/]+)\/accounts$/.exec(path);
  if (link && method === "POST") {
    const person = world.people.find((p) => p.id === decodeURIComponent(link[1] ?? ""));
    if (!person) return json({ error: "Unknown person" }, 404);
    const ref = { channel: body.channel ?? "", channelUserId: body.channelUserId ?? "" };
    const held = findAccount(world, ref);
    // Compare-and-swap on the current owner: taking an account from another
    // person needs `transferFrom` naming them exactly.
    if (held?.state === "linked" && held.personId !== person.id) {
      if (body.transferFrom !== held.personId) return json(linkConflict(ref, holder(held)), 409);
    }
    attach(world, person, ref);
    return json(person);
  }

  const merge = /^\/api\/people\/([^/]+)\/merge$/.exec(path);
  if (merge && method === "POST") {
    const into = world.people.find((p) => p.id === decodeURIComponent(merge[1] ?? ""));
    const from = world.people.find((p) => p.id === body.from);
    if (!into || !from) return json({ error: "Unknown person" }, 404);
    for (const ref of [...from.accounts]) attach(world, into, ref);
    world.people = world.people.filter((p) => p.id !== from.id);
    return json(into);
  }

  const one = /^\/api\/people\/([^/]+)$/.exec(path);
  if (one && method === "PATCH") {
    const person = world.people.find((p) => p.id === decodeURIComponent(one[1] ?? ""));
    if (!person) return json({ error: "Unknown person" }, 404);
    if (body.displayName !== undefined) person.displayName = body.displayName;
    if (body.bondLevel !== undefined) person.bondLevel = body.bondLevel;
    return json(person);
  }

  return json({ error: "Unknown route" }, 404);
}

/**
 * Serves both reads from mutable lists, through the same contract helpers the
 * routes are built on — so a fixture cannot drift from them on ordering,
 * filtering, counting or paging, and a write followed by the page's refetch
 * hands back a different world rather than a patched local state.
 */
function mockApi(
  world: { people?: PersonResource[]; accounts?: DirectoryAccount[] } = {},
  options: {
    limit?: number;
    peopleFail?: boolean;
    accountsFail?: boolean;
    writes?: "fail";
    /** Holds every transfer in flight until this resolves, so a test can act
     *  while one is still running. */
    holdTransfers?: Promise<void>;
  } = {},
) {
  // Cloned rather than shared: the writes below mutate this world, and the
  // fixtures are module constants every other test reads.
  const state: World = {
    people: (world.people ?? []).map((person) => ({ ...person, accounts: [...person.accounts] })),
    accounts: (world.accounts ?? []).map((account) => ({ ...account })),
    peopleFail: options.peopleFail ?? false,
    accountsFail: options.accountsFail ?? false,
  };
  const calls: FetchCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = (typeof init?.body === "string" ? JSON.parse(init.body) : undefined) as
      | WriteBody
      | undefined;
    calls.push({ url, method, body });
    const parsed = new URL(url, "http://localhost");
    const params = parsed.searchParams;
    const json: Json = (payload: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => payload }) as Response;

    if (method !== "GET") {
      if (options.writes === "fail") return json({ error: "write refused" }, 500);
      if (body?.transferFrom && options.holdTransfers) await options.holdTransfers;
      return applyWrite(state, method, parsed.pathname, body ?? {}, json);
    }

    if (url.includes("/api/accounts")) {
      if (state.accountsFail) return json({ error: "directory unavailable" }, 500);
      return json(
        sliceAccountDirectory(state.accounts, {
          query: params.get("q"),
          state: parseAccountState(params.get("state")),
          cursor: parseAccountCursor(params.get("cursor")),
          limit: options.limit ?? null,
          includeSilent: params.get("includeSilent") === "true",
        }),
      );
    }

    if (url.includes("/api/people")) {
      if (state.peopleFail) return json({ error: "person store unavailable" }, 500);
      // The whole `?q=` match, before `?level=` narrows it: the counts describe
      // that, so every chip's number stays true while another is selected.
      const matching = state.people.filter((person) =>
        personMatchesQuery(person, params.get("q") ?? ""),
      );
      const level = parsePersonFilterLevel(params.get("level"));
      return json({
        people: matching.filter((person) => personMatchesLevel(person, level ?? "all")),
        counts: countPeople(matching),
      });
    }

    // The page also carries the LinkedIn mirror, which reads its own endpoint.
    // These tests are about the two contract views, so it answers empty.
    if (url.includes("/api/linkedin/threads")) return json([]);
    return json({});
  }) as typeof fetch);
  return { calls, state };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/people"]}>
        <Routes>
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/people/:personId" element={<div>person page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function chip(name: RegExp) {
  return screen.getByRole("radio", { name });
}

async function showDirectory(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: "Directory" }));
}

describe("PeoplePage stream", () => {
  it("opens on the stream, and reaches a waiting sender through its chip", async () => {
    mockApi({ people: [GUARDIAN, FRIEND], accounts: [UNKNOWN_SENDER] });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("Wei Chen");
    // A stream row carries the dynamic, not the bond.
    expect(screen.getByText("on my way")).toBeTruthy();

    await user.click(chip(/^Unknown/));
    expect(await screen.findByText("Rachel Lim")).toBeTruthy();
    expect(screen.getByText("Are you free Saturday?")).toBeTruthy();
  });

  it("keeps people with no dynamics out of the stream, and the guardian too", async () => {
    mockApi({ people: [GUARDIAN, FRIEND, QUIET_PERSON] });
    renderPage();

    await screen.findByText("Wei Chen");
    expect(screen.queryByText("Nadia Petrova")).toBeNull();
    expect(screen.queryByText("Zhangfan Dong")).toBeNull();
  });

  it("holds both unplaced ends out of All — each chip is their way in", async () => {
    const user = userEvent.setup();
    mockApi({ people: [GUARDIAN, FRIEND], accounts: [UNKNOWN_SENDER, DISMISSED] });
    renderPage();

    await screen.findByText("Wei Chen");
    expect(screen.queryByText("Rachel Lim")).toBeNull();
    expect(screen.queryByText("Crypto signals")).toBeNull();

    await user.click(chip(/^Unknown/));
    expect(await screen.findByText("Rachel Lim")).toBeTruthy();

    await user.click(chip(/^Stranger/));
    expect(await screen.findByText("Crypto signals")).toBeTruthy();
  });

  it("shows one row per human, never the account beside the person it resolves to", async () => {
    mockApi({ people: [FRIEND], accounts: [LINKED_ACCOUNT] });
    renderPage();

    // Wei Chen's Telegram account is Wei Chen. Two rows would put the bond on
    // one and the history on the other.
    expect(await screen.findByText("Wei Chen")).toBeTruthy();
    expect(screen.queryByText("wei_c")).toBeNull();
  });

  it("counts waiting senders on the Unknown chip, and nowhere else", async () => {
    mockApi({ people: [GUARDIAN, FRIEND], accounts: [UNKNOWN_SENDER, SILENT_CONTACT] });
    renderPage();

    await screen.findByText("Wei Chen");
    // The silent contact is not waiting on a decision, so the browsing view's
    // count leaves it out — and the number is the server's either way.
    await waitFor(() => expect(within(chip(/^Unknown/)).getByText("1")).toBeTruthy());
    expect(within(chip(/^All/)).queryByText(/^\d+$/)).toBeNull();
  });

  it("asks each endpoint for the chip's own narrowing rather than filtering a page", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ people: [FRIEND], accounts: [UNKNOWN_SENDER, DISMISSED] });
    renderPage();

    await screen.findByText("Wei Chen");
    await user.click(chip(/^Stranger/));
    // The directory pages, so a chip that filtered loaded rows would show only
    // the matches that happened to land on page one.
    await waitFor(() => expect(calls.some((c) => c.url.includes("state=dismissed"))).toBe(true));

    await user.click(chip(/^Inner circle/));
    // A bond level is the people read's own parameter.
    await waitFor(() => expect(calls.some((c) => c.url.includes("level=inner-circle"))).toBe(true));
  });

  it("reads no channel mirror for a roster the contract already answers", async () => {
    const { calls } = mockApi({ people: [FRIEND], accounts: [UNKNOWN_SENDER] });
    renderPage();

    await screen.findByText("Wei Chen");
    const reads = calls.filter((call) => call.method === "GET").map((call) => call.url);
    expect(reads.filter((url) => url.includes("/api/whatsapp/contacts"))).toEqual([]);
  });

  it("opens a person's dossier from their row", async () => {
    const user = userEvent.setup();
    mockApi({ people: [FRIEND] });
    renderPage();

    await user.click(await screen.findByText("Wei Chen"));
    expect(await screen.findByText("person page")).toBeTruthy();
  });

  it("searches the server, reaching contacts no page has loaded", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ people: [FRIEND], accounts: [SILENT_CONTACT] });
    renderPage();

    await screen.findByText("Wei Chen");
    await user.type(screen.getByRole("searchbox", { name: /search people/i }), "jonas");

    // A search reaches the address book whatever the toggle says — the
    // endpoint's rule, and the reason the term goes to the server at all.
    expect(await screen.findByText("Jonas Tan")).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url.includes("q=jonas"))).toBe(true));
  });

  it("sends one request for a typed word rather than one per letter", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ people: [FRIEND] });
    renderPage();

    await screen.findByText("Wei Chen");
    await user.type(screen.getByRole("searchbox", { name: /search people/i }), "wei");

    await waitFor(() => expect(calls.some((c) => c.url.includes("q=wei"))).toBe(true));
    // "w" and "we" never reach the wire.
    expect(
      calls.filter((c) => /[?&]q=w(e)?(&|$)/.test(c.url) && c.url.includes("/api/people")),
    ).toHaveLength(0);
  });
});

describe("PeoplePage directory", () => {
  it("groups the roster by bond, with the server's totals on each heading", async () => {
    const user = userEvent.setup();
    mockApi({
      people: [GUARDIAN, FRIEND, QUIET_PERSON],
      accounts: [UNKNOWN_SENDER, SILENT_CONTACT],
    });
    renderPage();

    await screen.findByText("Wei Chen");
    await showDirectory(user);

    // Everyone is in a group, the quiet person included — a roster answers
    // "who does Rome know", not "who said something".
    expect(await screen.findByText("Nadia Petrova")).toBeTruthy();
    expect(screen.getByText("Zhangfan Dong")).toBeTruthy();
    // The heading's number is the directory's own, not the rows on screen.
    const unknown = screen.getByRole("heading", { name: "Unknown" }).parentElement!;
    expect(within(unknown).getByText("1")).toBeTruthy();
  });

  it("offers the silent contacts it is holding back, and asks the server for them", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ people: [FRIEND], accounts: [UNKNOWN_SENDER, SILENT_CONTACT] });
    renderPage();

    await screen.findByText("Wei Chen");
    await showDirectory(user);

    // Browsing holds the address book back; the toggle says how many are there.
    expect(screen.queryByText("Jonas Tan")).toBeNull();
    await user.click(await screen.findByLabelText(/Include never-messaged contacts \(1\)/));

    expect(await screen.findByText("Jonas Tan")).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url.includes("includeSilent=true"))).toBe(true));
  });

  it("keeps the Unknown heading when the toggle is what emptied it", async () => {
    const user = userEvent.setup();
    mockApi({ people: [FRIEND], accounts: [SILENT_CONTACT] });
    renderPage();

    await screen.findByText("Wei Chen");
    await showDirectory(user);

    // The heading carries the toggle, so an address book with no waiting
    // senders in front of it would otherwise have no way back on screen.
    expect(await screen.findByRole("heading", { name: "Unknown" })).toBeTruthy();
  });

  it("pages the directory by the cursor the server named", async () => {
    const user = userEvent.setup();
    const second: DirectoryAccount = {
      ...UNKNOWN_SENDER,
      channelUserId: "6580001111@s.whatsapp.net",
      addresses: ["6580001111@s.whatsapp.net"],
      displayName: "Priya Nair",
      latest: { source: "whatsapp", timestamp: NOW - 20_000, preview: "hello!" },
    };
    const { calls } = mockApi({ accounts: [UNKNOWN_SENDER, second] }, { limit: 1 });
    renderPage();

    await user.click(chip(/^Unknown/));
    // Newest first, so the older sender sits on the page after this one.
    expect(await screen.findByText("Rachel Lim")).toBeTruthy();
    expect(screen.queryByText("Priya Nair")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show more" }));

    // Appended, not swapped in: paging is reading further down a listing.
    expect(await screen.findByText("Priya Nair")).toBeTruthy();
    expect(screen.getByText("Rachel Lim")).toBeTruthy();
    expect(calls.some((c) => c.url.includes("cursor="))).toBe(true);
  });
});

describe("PeoplePage placement", () => {
  // The write half of the page, on the /people contract's verbs. What the union
  // page called one "move" decomposes here: placing a sender is a create or a
  // link, dismissing one is a decision about the account, and the ladder's
  // dismissed end has a way back.

  it("places a waiting sender by creating the person and linking the account at once", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ accounts: [UNKNOWN_SENDER] });
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await user.click(screen.getByRole("button", { name: "Create profile" }));

    const create = await waitFor(() => {
      const call = calls.find((c) => c.method === "POST" && c.url === "/api/people");
      expect(call).toBeTruthy();
      return call!;
    });
    // One request, not a create followed by a link: a person created for an
    // account must never exist without it.
    expect(create.body).toMatchObject({
      displayName: "Rachel Lim",
      bondLevel: "acquaintance",
      accounts: [{ channel: "whatsapp", channelUserId: "6591234472@s.whatsapp.net" }],
    });
    // The sender is placed, so it is no longer waiting on a decision.
    await waitFor(() => expect(screen.queryByText("Rachel Lim")).toBeNull());
  });

  it("links a waiting sender onto a person the roster already holds", async () => {
    const user = userEvent.setup();
    const { calls, state } = mockApi({ people: [GUARDIAN, FRIEND], accounts: [UNKNOWN_SENDER] });
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    await user.click(screen.getByRole("button", { name: "Link" }));
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /Wei Chen/ }));
    await user.click(screen.getByRole("button", { name: "Link" }));

    const link = await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/people/wei-chen/accounts");
      expect(call).toBeTruthy();
      return call!;
    });
    expect(link.method).toBe("POST");
    expect(link.body).toEqual({
      channel: "whatsapp",
      channelUserId: "6591234472@s.whatsapp.net",
    });
    expect(state.accounts[0]!.personId).toBe("wei-chen");
  });

  it("confirms a dismissal before writing it, and says so when it fails", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ accounts: [UNKNOWN_SENDER] }, { writes: "fail" });
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    await user.click(screen.getByRole("button", { name: "Treat as stranger" }));

    // A dismissal changes how Rome answers this sender, so nothing is posted
    // until the confirmation is accepted.
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Rachel Lim");
    expect(calls.some((c) => c.url.includes("/dismiss"))).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Treat as stranger" }));

    // A write that didn't land leaves the account where it was, and says so —
    // closing the dialog silently would read as success.
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/dismiss"))).toBe(true);
  });

  it("takes a dismissed sender out of Unknown, and the count that drops is the server's", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ accounts: [UNKNOWN_SENDER, SILENT_CONTACT] });
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    await waitFor(() => expect(within(chip(/^Unknown/)).getByText("1")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "Treat as stranger" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Treat as stranger" }));

    // The row leaves the view because the directory no longer serves it under
    // `state=unlinked`, and the chip loses its number because the directory's
    // own `counts` came back one lower. Neither is a patch of what was cached:
    // the page holds nothing it could have patched.
    await waitFor(() => expect(screen.queryByText("Rachel Lim")).toBeNull());
    expect(within(chip(/^Unknown/)).queryByText(/^\d+$/)).toBeNull();
    const dismiss = calls.find((c) => c.url.includes("/dismiss"))!;
    // Named by the pair the contract says is the account's identity, so every
    // address it answers to travels with it.
    expect(dismiss.url).toBe("/api/accounts/whatsapp/6591234472%40s.whatsapp.net/dismiss");
  });

  it("restores a dismissed sender back onto the ladder", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ accounts: [DISMISSED] });
    renderPage();

    await user.click(chip(/^Stranger/));
    await screen.findByText("Crypto signals");
    await user.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" &&
            c.url === "/api/accounts/whatsapp/447700900123%40s.whatsapp.net/restore",
        ),
      ).toBe(true),
    );
    // Dismissal is a state an account is in, not a merge into a sentinel, so
    // the way back is the same account under the Unknown chip.
    await waitFor(() => expect(screen.queryByText("Crypto signals")).toBeNull());
    await user.click(chip(/^Unknown/));
    expect(await screen.findByText("Crypto signals")).toBeTruthy();
  });

  it("offers a transfer only after naming who holds the account, and only on a second yes", async () => {
    const user = userEvent.setup();
    const { calls, state } = mockApi({ people: [FRIEND], accounts: [UNKNOWN_SENDER] });
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    // Somebody else claimed the account between the read and the click — the
    // race the contract's compare-and-swap exists to catch.
    state.accounts[0]!.state = "linked";
    state.accounts[0]!.personId = "mira";
    state.accounts[0]!.personName = "Mira Chen";

    await user.click(screen.getByRole("button", { name: "Link" }));
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /Wei Chen/ }));
    await user.click(screen.getByRole("button", { name: "Link" }));

    // The refusal names the owner rather than reporting a failed write.
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Mira Chen");
    expect(calls.filter((c) => c.url.endsWith("/accounts") && c.body?.transferFrom)).toHaveLength(
      0,
    );

    await user.click(within(dialog).getByRole("button", { name: "Move it here" }));

    await waitFor(() => expect(state.accounts[0]!.personId).toBe("wei-chen"));
    // A transfer re-attributes the account's whole history, so it never happens
    // as the side effect of a retry: the second request is the one that names
    // the person it is taken from.
    expect(calls.filter((c) => c.url === "/api/people/wei-chen/accounts")).toHaveLength(2);
    expect(calls.find((c) => c.body?.transferFrom)?.body).toEqual({
      channel: "whatsapp",
      channelUserId: "6591234472@s.whatsapp.net",
      transferFrom: "mira",
    });
  });

  it("fires one transfer however many times the confirm is clicked", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, state } = mockApi(
      { people: [FRIEND], accounts: [UNKNOWN_SENDER] },
      { holdTransfers: held },
    );
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    state.accounts[0]!.state = "linked";
    state.accounts[0]!.personId = "mira";
    state.accounts[0]!.personName = "Mira Chen";

    await user.click(screen.getByRole("button", { name: "Link" }));
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /Wei Chen/ }));
    await user.click(screen.getByRole("button", { name: "Link" }));

    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Move it here" });
    await user.click(confirm);
    await user.click(confirm);

    // The dialog stays up until the write settles, so the confirm is still on
    // screen while the first transfer is in flight. A second one would re-attribute
    // the account's history again — and would arrive naming an owner the first
    // has already replaced, so it refuses and reports a conflict against the
    // person the guardian just moved it to.
    expect(calls.filter((call) => call.body?.transferFrom)).toHaveLength(1);

    release();
    await waitFor(() => expect(state.accounts[0]!.personId).toBe("wei-chen"));
  });
});

describe("PeoplePage load failures", () => {
  it("reports a failed read instead of rendering it as an empty roster", async () => {
    mockApi({ people: [FRIEND] }, { peopleFail: true, accountsFail: true });
    renderPage();

    expect(await screen.findByText("Couldn't load")).toBeTruthy();
    expect(screen.queryByText("Nothing new yet")).toBeNull();
  });

  it("retries in place, without a page reload", async () => {
    const user = userEvent.setup();
    const { state } = mockApi({ people: [FRIEND] }, { peopleFail: true, accountsFail: true });
    renderPage();

    await screen.findByText("Couldn't load");
    state.peopleFail = false;
    state.accountsFail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Wei Chen")).toBeTruthy();
    expect(screen.queryByText("Couldn't load")).toBeNull();
  });

  it("keeps a genuinely empty roster on its own empty state", async () => {
    mockApi({});
    renderPage();

    expect(await screen.findByText("Nothing new yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
