// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { LinkedInSection, openableHref } from "./linkedin";

// The LinkedIn mirror on the People page. It reads its own endpoints rather
// than the identity union, so it is exercised on its own: the section's four
// states, what the group badge is allowed to key on, and the reply round-trip.

beforeAll(async () => {
  await i18n.changeLanguage("en");
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

const liThread = {
  threadId: "2-abc==",
  threadUrl: "https://www.linkedin.com/messaging/thread/2-abc==/",
  personName: "Ada Lovelace",
  conversationName: null,
  lastMessagePreview: "See you Thursday",
  lastMessageAt: NOW - 3600,
  unread: true,
  isGroup: false,
  participantCount: 2,
  counterpartyType: "member",
  category: "INBOX,PRIMARY_INBOX",
  messageCount: 2,
};

const liMessages = [
  {
    messageId: "li-m1",
    senderName: "Ada Lovelace",
    senderHeadline: "Engineer",
    senderProfileUrl: "https://www.linkedin.com/in/ada/",
    senderIsSelf: false,
    timestamp: NOW - 7200,
    text: "Great meeting you!",
    subject: "Following up",
    reactionCount: null,
  },
  {
    messageId: "li-m2",
    senderName: "Rome Guardian",
    senderHeadline: null,
    senderProfileUrl: null,
    senderIsSelf: true,
    timestamp: NOW - 3600,
    text: "See you Thursday",
    subject: null,
    reactionCount: null,
  },
];

function mockFetch(reply: (url: string) => { ok: boolean; status?: number; json: unknown }) {
  const calls: FetchCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), body });
    const answer = reply(url);
    return {
      ok: answer.ok,
      status: answer.status ?? (answer.ok ? 200 : 500),
      json: async () => answer.json,
    } as Response;
  }) as typeof fetch);
  return calls;
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LinkedInSection />
    </QueryClientProvider>,
  );
}

describe("LinkedInSection", () => {
  it("keeps the section with an empty state that names the cause when nothing syncs", async () => {
    mockFetch(() => ({ ok: true, json: [] }));
    renderSection();

    expect(await screen.findByText("No LinkedIn conversations")).toBeTruthy();
    // The heading stays put through every state, so "nothing synced" reads as
    // an empty LinkedIn section rather than as no section at all.
    expect(screen.getByText("LinkedIn messages")).toBeTruthy();
    expect(screen.getByText(/Nothing has synced yet — if LinkedIn isn't connected/i)).toBeTruthy();
  });

  it("keeps the section with an error state when the threads endpoint fails", async () => {
    mockFetch((url) => {
      if (url.includes("/api/linkedin/threads")) {
        return { ok: false, status: 400, json: { error: "threads unavailable" } };
      }
      return { ok: true, json: [] };
    });
    renderSection();

    expect(await screen.findByText("LinkedIn messages")).toBeTruthy();
    expect(await screen.findByText("threads unavailable")).toBeTruthy();
    expect(screen.queryByText("No LinkedIn conversations")).toBeNull();
  });

  it("group badges come from isGroup alone, never from conversationName", async () => {
    // A legacy 1:1 row can carry the counterparty's name in conversationName
    // (the producer's old display ladder) with isGroup unknown; a real group
    // can lack a personName entirely. Only the flag may decide.
    const legacyOneToOne = {
      ...liThread,
      threadId: "2-legacy==",
      personName: "Evan Ye",
      conversationName: "Evan Ye",
      isGroup: null,
    };
    const group = {
      ...liThread,
      threadId: "2-group==",
      personName: null,
      conversationName: "Founder pitch review",
      isGroup: true,
      participantCount: 3,
      unread: false,
    };
    mockFetch(() => ({ ok: true, json: [legacyOneToOne, group] }));
    renderSection();

    expect(await screen.findByText("Evan Ye")).toBeTruthy();
    // The group card titles itself from the conversation title.
    expect(screen.getByText("Founder pitch review")).toBeTruthy();
    // Exactly one badge, on the group card — the legacy 1:1 gets none.
    expect(screen.getAllByText("Group conversation")).toHaveLength(1);
  });

  it("opens the thread dialog with mirrored messages and a reply composer", async () => {
    const user = userEvent.setup();
    mockFetch((url) => {
      if (url.includes("/api/linkedin/threads/") && url.includes("/messages")) {
        return { ok: true, json: liMessages };
      }
      return { ok: true, json: [liThread] };
    });
    renderSection();

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("Unread")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Messages" }));

    expect(await screen.findByText("Great meeting you!")).toBeTruthy();
    // The InMail subject renders as its own line above the body.
    expect(screen.getByText("Following up")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in LinkedIn" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Reply on LinkedIn")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("replies through the LinkedIn safe-send endpoint", async () => {
    const user = userEvent.setup();
    const calls = mockFetch((url) => {
      if (url.includes(`/api/linkedin/threads/${encodeURIComponent(liThread.threadId)}/send`)) {
        return { ok: true, json: { ok: true, recipient: "Ada Lovelace" } };
      }
      if (url.includes("/api/linkedin/threads/") && url.includes("/messages")) {
        return { ok: true, json: liMessages };
      }
      return { ok: true, json: [liThread] };
    });
    renderSection();

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Messages" }));
    expect(await screen.findByPlaceholderText("Reply on LinkedIn")).toBeTruthy();

    await user.type(screen.getByPlaceholderText("Reply on LinkedIn"), "Thursday works!");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "POST" && call.url.includes("/api/linkedin/threads/2-abc%3D%3D/send"),
        ),
      ).toBe(true),
    );
    const send = calls.find(
      (call) =>
        call.method === "POST" && call.url.includes("/api/linkedin/threads/2-abc%3D%3D/send"),
    );
    expect(send?.body).toEqual({ text: "Thursday works!" });
    expect(await screen.findByText("Thursday works!")).toBeTruthy();
  });

  it("retries a failed reply from the keyboard, not just the mouse", async () => {
    const user = userEvent.setup();
    // The failed bubble takes focus and calls itself a button, so Enter and
    // Space have to do what a button does — otherwise the retry is reachable
    // only with a pointer, on the one control a failed send leaves behind.
    let sends = 0;
    mockFetch((url) => {
      if (url.includes("/send")) {
        sends += 1;
        return { ok: false, status: 500, json: { error: "send refused" } };
      }
      if (url.includes("/api/linkedin/threads/") && url.includes("/messages")) {
        return { ok: true, json: liMessages };
      }
      return { ok: true, json: [liThread] };
    });
    renderSection();

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Messages" }));
    await user.type(await screen.findByPlaceholderText("Reply on LinkedIn"), "again");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sends).toBe(1));
    // Named by the message text, not the title — the bubble has content, so
    // that is what the accessible name comes from.
    const failed = await screen.findByRole("button", { name: /again/ });

    failed.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sends).toBe(2));
  });

  it("withholds the thread link when its URL is not one a browser may follow", async () => {
    const user = userEvent.setup();
    // `threadUrl` is mirrored from LinkedIn by the poller, and it lands in an
    // `href`. A `javascript:` URI there would run on click rather than
    // navigate, so a thread that carries one gets no link at all.
    const hostile = { ...liThread, threadUrl: "javascript:alert(1)" };
    mockFetch((url) => {
      if (url.includes("/api/linkedin/threads/") && url.includes("/messages")) {
        return { ok: true, json: liMessages };
      }
      return { ok: true, json: [hostile] };
    });
    renderSection();

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Messages" }));

    // The thread still opens and still reads; only the link is gone.
    expect(await screen.findByText("Great meeting you!")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open in LinkedIn" })).toBeNull();
  });
});

describe("openableHref", () => {
  it("passes the schemes a thread can actually live on", () => {
    expect(openableHref("https://www.linkedin.com/messaging/thread/2-abc==/")).toBe(
      "https://www.linkedin.com/messaging/thread/2-abc==/",
    );
    expect(openableHref("http://linkedin.com/x")).toBe("http://linkedin.com/x");
  });

  it("refuses the ones that execute instead of navigating", () => {
    expect(openableHref("javascript:alert(1)")).toBeNull();
    expect(openableHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    // Case and leading space are not a way around it — `URL` normalizes both.
    expect(openableHref("  JavaScript:alert(1)")).toBeNull();
  });

  it("refuses anything that is not an absolute URL at all", () => {
    // A relative href would resolve against the dashboard's own origin, which
    // is never where a LinkedIn thread lives.
    expect(openableHref("/messaging/thread/2-abc==/")).toBeNull();
    expect(openableHref("")).toBeNull();
    expect(openableHref(null)).toBeNull();
  });
});
