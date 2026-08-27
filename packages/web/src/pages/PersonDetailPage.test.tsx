// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TimelineEntry } from "@rome/api-types/identities";
import type { PersonResource } from "@rome/api-types/people";
import i18n from "@/i18n";
import PersonDetailPage from "./PersonDetailPage";

// The person page: identity on top, the merged timeline below. What is under
// test is that the page reads the two routes that own it — `GET /api/people/:id`
// and `GET /api/people/:id/messages` — and that the timeline it renders is
// channel-blind: a Telegram entry renders the way a WhatsApp one does, grouped
// by the calendar day it happened on.

beforeAll(async () => {
  await i18n.changeLanguage("en");
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Anchored at noon today rather than at "now": the timeline groups by calendar
// day, so a fixture minutes old is labelled "Yesterday" when the suite happens
// to run just after midnight. Noon is the same day whatever time the run starts.
const NOW = (() => {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  return Math.floor(noon.getTime() / 1000);
})();

const PERSON: PersonResource = {
  id: "wei-chen",
  displayName: "Wei Chen",
  bondLevel: "acquaintance",
  accounts: [
    { channel: "whatsapp", channelUserId: "6591881123@s.whatsapp.net", displayName: "Wei" },
    { channel: "telegram", channelUserId: "418820113", displayName: "wei_c" },
  ],
  messageCount: 12,
  latest: { source: "whatsapp", timestamp: NOW - 300, preview: "the landlord replies fast" },
};

const ENTRIES: TimelineEntry[] = [
  {
    source: "whatsapp",
    timestamp: NOW - 300,
    body: "the landlord replies fast",
    direction: "inbound",
    ref: "wa-1",
  },
  {
    source: "whatsapp",
    timestamp: NOW - 600,
    body: "I will call him this afternoon",
    direction: "outbound",
    ref: "wa-2",
  },
  {
    source: "telegram",
    timestamp: NOW - 90_000,
    body: "dinner was great",
    direction: "inbound",
    ref: "sentinel:7",
  },
];

interface FetchCall {
  url: string;
  method: string;
}

function mockApi(
  options: {
    person?: PersonResource | "missing" | "fail";
    entries?: TimelineEntry[] | "fail";
    nextCursor?: string | null;
    older?: TimelineEntry[];
  } = {},
) {
  const calls: FetchCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    const json = (body: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => body }) as Response;

    if (url.includes("/messages")) {
      if (options.entries === "fail") return json({ error: "timeline unavailable" }, 500);
      const cursor = new URL(url, "http://localhost").searchParams.get("cursor");
      if (cursor) return json({ entries: options.older ?? [], nextCursor: null });
      return json({
        entries: options.entries ?? ENTRIES,
        nextCursor: options.nextCursor ?? null,
      });
    }
    if (url.includes("/api/people/")) {
      if (options.person === "missing") return json({ error: "Unknown person" }, 404);
      if (options.person === "fail") return json({ error: "person store unavailable" }, 500);
      return json(options.person ?? PERSON);
    }
    return json({});
  }) as typeof fetch);
  return calls;
}

function renderPage(id = "wei-chen") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/people/${id}`]}>
        <Routes>
          <Route path="/people" element={<div>people page</div>} />
          <Route path="/people/:personId" element={<PersonDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PersonDetailPage", () => {
  it("reads the person and their history from the two routes that own them", async () => {
    const calls = mockApi();
    renderPage();

    expect(await screen.findByRole("heading", { name: "Wei Chen" })).toBeTruthy();
    expect(calls.some((call) => call.url.includes("/api/people/wei-chen"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/api/people/wei-chen/messages"))).toBe(true);
    // One request across every account, not one per channel.
    expect(calls.filter((call) => call.url.includes("/messages"))).toHaveLength(1);
  });

  it("renders every account the person is reachable at", async () => {
    mockApi();
    renderPage();

    // The WhatsApp jid renders as the number a guardian would recognize; a
    // channel with no phone shape keeps its own identifier.
    expect(await screen.findByText("+6591881123")).toBeTruthy();
    expect(screen.getByText("418820113")).toBeTruthy();
  });

  it("groups the merged timeline by day, channel-blind", async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText("the landlord replies fast")).toBeTruthy();
    // A Telegram entry renders the way a WhatsApp one does — nothing here knows
    // which store an entry came from.
    expect(screen.getByText("dinner was great")).toBeTruthy();
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Yesterday")).toBeTruthy();
    // Rome's own half of an exchange is marked as such rather than read as the
    // other person's words.
    expect(screen.getByText("You:")).toBeTruthy();
  });

  it("pages older entries by the cursor the page it holds ended on", async () => {
    const user = userEvent.setup();
    const calls = mockApi({
      nextCursor: "older-1",
      older: [
        {
          source: "telegram",
          timestamp: NOW - 400_000,
          body: "first hello",
          direction: "inbound",
          ref: "sentinel:1",
        },
      ],
    });
    renderPage();

    await screen.findByText("the landlord replies fast");
    await user.click(screen.getByRole("button", { name: "Load older" }));

    expect(await screen.findByText("first hello")).toBeTruthy();
    // Appended, not swapped in: the head of the history stays above it.
    expect(screen.getByText("the landlord replies fast")).toBeTruthy();
    expect(calls.some((call) => call.url.includes("cursor=older-1"))).toBe(true);
  });

  it("says a person is gone only when the server said so", async () => {
    mockApi({ person: "missing" });
    renderPage("ghost");

    expect(await screen.findByText("That person is not here")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("offers a retry when the read failed rather than claiming they were merged away", async () => {
    mockApi({ person: "fail" });
    renderPage();

    expect(await screen.findByText("Couldn't load")).toBeTruthy();
    expect(screen.queryByText("That person is not here")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("reports a failed timeline instead of an empty history", async () => {
    mockApi({ entries: "fail" });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Wei Chen" })).toBeTruthy();
    expect(await screen.findByText("Couldn't load")).toBeTruthy();
    // "Nothing has happened yet" is a claim about this person, and a failed
    // fetch has not earned it.
    expect(screen.queryByText("Nothing has happened on any channel yet.")).toBeNull();
  });

  it("keeps a genuinely empty history on its own empty state", async () => {
    mockApi({ entries: [] });
    renderPage();

    expect(await screen.findByText("Nothing has happened on any channel yet.")).toBeTruthy();
  });

  it("goes back to the roster", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    await screen.findByRole("heading", { name: "Wei Chen" });
    await user.click(screen.getByRole("button", { name: "People" }));

    expect(await screen.findByText("people page")).toBeTruthy();
  });
});
