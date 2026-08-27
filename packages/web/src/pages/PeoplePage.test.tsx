// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  countPeople,
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

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
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

/**
 * Serves both reads from mutable lists, through the same contract helpers the
 * routes are built on — so a fixture cannot drift from them on ordering,
 * filtering, counting or paging, and a write followed by the page's refetch
 * hands back a different world rather than a patched local state.
 */
function mockApi(
  world: { people?: PersonResource[]; accounts?: DirectoryAccount[] } = {},
  options: { limit?: number; peopleFail?: boolean; accountsFail?: boolean; writes?: "fail" } = {},
) {
  const state = {
    people: world.people ?? [],
    accounts: world.accounts ?? [],
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
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const params = new URL(url, "http://localhost").searchParams;
    const json = (payload: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => payload }) as Response;

    if (method === "POST") {
      return options.writes === "fail"
        ? json({ error: "write refused" }, 500)
        : json({ success: true, personId: "new-person" });
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

  it("reads no identity union and no legacy person listing", async () => {
    const { calls } = mockApi({ people: [FRIEND], accounts: [UNKNOWN_SENDER] });
    renderPage();

    await screen.findByText("Wei Chen");
    const reads = calls.filter((call) => call.method === "GET").map((call) => call.url);
    expect(reads.filter((url) => url.includes("/api/identities"))).toEqual([]);
    expect(reads.filter((url) => url.includes("/api/persons"))).toEqual([]);
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
  // The gestures that place an account are carried forward unchanged — they
  // still post to the legacy `/api/persons/*` routes, and repointing them onto
  // this contract is rome-os/rome#67. What the rebuild owes them is the row
  // they hang off.

  it("creates a person for a waiting sender, naming the account it came from", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ accounts: [UNKNOWN_SENDER] });
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await user.click(screen.getByRole("button", { name: "Create profile" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/persons/create"))).toBe(
        true,
      ),
    );
    expect(calls.find((c) => c.url.includes("/api/persons/create"))?.body).toMatchObject({
      displayName: "Rachel Lim",
      bondLevel: "acquaintance",
      channel: "whatsapp",
      channelUserId: "6591234472@s.whatsapp.net",
    });
  });

  it("links a waiting sender onto a person the roster already holds", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ people: [GUARDIAN, FRIEND], accounts: [UNKNOWN_SENDER] });
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    await user.click(screen.getByRole("button", { name: "Link" }));
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /Wei Chen/ }));
    await user.click(screen.getByRole("button", { name: "Link" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/persons/link"))).toBe(
        true,
      ),
    );
    expect(calls.find((c) => c.url.includes("/api/persons/link"))?.body).toMatchObject({
      channel: "whatsapp",
      channelUserId: "6591234472@s.whatsapp.net",
      existingPersonId: "wei-chen",
    });
  });

  it("confirms a dismissal before writing it, and says so when it fails", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ accounts: [UNKNOWN_SENDER] }, { writes: "fail" });
    renderPage();

    await user.click(chip(/^Unknown/));
    await screen.findByText("Rachel Lim");
    await user.click(screen.getByRole("button", { name: "Treat as stranger" }));

    // A dismissal writes a mapping the dashboard cannot reverse, so nothing is
    // posted until the confirmation is accepted.
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Rachel Lim");
    expect(calls.some((c) => c.url.includes("mark-stranger"))).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Treat as stranger" }));

    // A write that didn't land leaves the account where it was, and says so —
    // closing the dialog silently would read as success.
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url.includes("mark-stranger"))).toBe(true);
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
