// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TraceSnapshot } from "@rome/api-types/trace-segments";
import type { TraceDrawerTarget } from "@/components/agent-trace/TraceDrawer";
import {
  getRomeSession,
  listRomeSessionMessages,
  listRomeSessions,
  listSessionTurns,
  openTurnStream,
} from "@/lib/chat-api";
import SessionsPage from "./SessionsPage";

// A stable `t` matters: TraceDrawer's loader effect depends on it, so a fresh
// function per render would spin that effect forever.
const translate = (key: string) => key;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));

// Stands in for the transcript's own trace triggers: one live, one stored.
vi.mock("@/components/chat/MessageList", () => ({
  MessageList: ({
    onOpenLiveTrace,
    onOpenStoredTrace,
  }: {
    onOpenLiveTrace: () => void;
    onOpenStoredTrace: (target: TraceDrawerTarget) => void;
  }) => (
    <div data-testid="session-messages">
      <button type="button" onClick={onOpenLiveTrace}>
        open live trace
      </button>
      <button
        type="button"
        onClick={() =>
          onOpenStoredTrace({
            kind: "stored",
            messageId: "trace-message",
            sessionId: "fork-session",
            turnId: "fork-turn",
            summary: TRACE_SUMMARY,
          })
        }
      >
        open stored trace
      </button>
    </div>
  ),
}));

vi.mock("@/components/chat/blocks", () => ({
  renderFlatBlocks: () => null,
  renderSingleBlock: (block: { type: string; content?: string }, key: string) => (
    <span key={key}>{block.content}</span>
  ),
}));

vi.mock("@/lib/chat-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat-api")>();
  return {
    ...actual,
    getRomeSession: vi.fn(),
    listRomeSessionMessages: vi.fn(),
    listRomeSessions: vi.fn(),
    listSessionTurns: vi.fn(),
    openTurnStream: vi.fn(),
  };
});

const SESSION = {
  id: "fork-session",
  name: "feedback: original chat",
  displayTitle: "Feedback",
  personaId: null,
  largeModelSelection: null,
  projectName: "default",
  projectPath: "default",
  agentName: null,
  type: "fork",
  sourceChannel: "webchat",
  sourceThreadId: "original-chat",
  sourceThreadName: "Original chat",
  sourceThreadType: "private",
  triggerKind: "fork",
  triggerName: "feedback",
  triggerActionName: null,
  triggerExecutionId: null,
  rootActionExecutionId: null,
  parentActionExecutionId: null,
  parentSessionId: "original-chat",
  parentTurnId: "rated-turn",
  createdAt: "2026-07-12T00:00:00.000Z",
  activityAt: "2026-07-12T00:00:00.000Z",
  messageCount: 1,
  owner: { type: "core", id: "core", label: "Rome", iconUrl: null },
  stats: {
    runCount: 1,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costUsd: 0.01,
      costedRunCount: 1,
    },
    outcomes: { completed: 1, interrupted: 0, error: 0, unknown: 0 },
  },
  lineage: {
    parent: {
      id: "original-chat",
      displayTitle: "Original chat",
      type: "webchat",
      agentName: null,
      parentTurnId: null,
      activityAt: "2026-07-12T00:00:00.000Z",
    },
    children: [],
  },
} as const;

const TRACE_SUMMARY = { distinctApps: [], totalSteps: 2, invocationCounts: {} };

const COLON_MESSAGE_ID = "action:execution-1:reviewer";

const MESSAGES = [
  {
    id: COLON_MESSAGE_ID,
    sessionId: "fork-session",
    turnId: "fork-turn",
    role: "assistant" as const,
    content: "[]",
    createdAt: "2026-07-12T00:00:00.000Z",
    traceSummary: TRACE_SUMMARY,
  },
  {
    id: "trace-message",
    sessionId: "fork-session",
    turnId: "fork-turn",
    role: "assistant" as const,
    content: "[]",
    createdAt: "2026-07-12T00:00:00.000Z",
    traceSummary: TRACE_SUMMARY,
  },
];

function snapshot(text: string): TraceSnapshot {
  return {
    summary: TRACE_SUMMARY,
    segments: [{ kind: "block", id: "seg-1", ordinal: 0, block: { type: "text", content: text } }],
  } as TraceSnapshot;
}

function CurrentPath() {
  return <div data-testid="path">{useLocation().pathname}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CurrentPath />
      <Routes>
        <Route path="/sessions/*" element={<SessionsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const path = () => screen.getByTestId("path").textContent;

beforeEach(() => {
  vi.mocked(getRomeSession).mockResolvedValue(SESSION);
  vi.mocked(listRomeSessionMessages).mockResolvedValue(MESSAGES);
  vi.mocked(listSessionTurns).mockResolvedValue([]);
  vi.mocked(listRomeSessions).mockResolvedValue({
    sessions: [],
    total: 0,
    offset: 0,
    limit: 5,
    nextOffset: null,
    facets: { types: [], sourceChannels: [] },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      if (url.includes("/api/sessions/messages/")) {
        const messageId = decodeURIComponent(url.split("/messages/")[1].split("/")[0]);
        return new Response(JSON.stringify({ trace: snapshot(`stored trace body: ${messageId}`) }));
      }
      if (url.includes("/trace?")) {
        return new Response(JSON.stringify({ trace: snapshot("turn trace body") }));
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("session detail surfaces render from their URL", () => {
  it("opens the details sheet on the details URL", async () => {
    renderAt("/sessions/fork-session/details");

    const sheet = await screen.findByRole("dialog", { name: "Session details" });
    expect(sheet.textContent).toContain("Feedback");
    expect(sheet.textContent).toContain("fork-session");
  });

  it("opens the trace drawer for the message a stored-trace URL names", async () => {
    renderAt("/sessions/fork-session/messages/trace-message/trace");

    const drawer = await screen.findByRole("dialog", { name: "trace.drawer.ariaLabel" });
    expect(await screen.findByText("stored trace body: trace-message")).toBeTruthy();
    expect(drawer.getAttribute("aria-hidden")).toBe("false");
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain(
      "/api/sessions/messages/trace-message/content",
    );
  });

  it("opens the trace drawer for the turn a turn-trace URL names", async () => {
    renderAt("/sessions/fork-session/turns/fork-turn/trace");

    await screen.findByRole("dialog", { name: "trace.drawer.ariaLabel" });
    expect(await screen.findByText("turn trace body")).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain(
      "/api/sessions/fork-session/turns/fork-turn/trace",
    );
  });

  it("sends a path that names no surface back to the session URL", async () => {
    renderAt("/sessions/fork-session/nonsense");

    await screen.findByTestId("session-messages");
    expect(path()).toBe("/sessions/fork-session");
  });

  it("names a message whose id needs escaping", async () => {
    renderAt(`/sessions/fork-session/messages/${encodeURIComponent(COLON_MESSAGE_ID)}/trace`);

    expect(await screen.findByText(`stored trace body: ${COLON_MESSAGE_ID}`)).toBeTruthy();
  });

  it("keeps the session URL when no surface is open", async () => {
    renderAt("/sessions/fork-session");

    await screen.findByTestId("session-messages");
    expect(screen.queryByRole("dialog", { name: "Session details" })).toBeNull();
    expect(path()).toBe("/sessions/fork-session");
  });
});

describe("only one trace drawer is open at a time", () => {
  function attachToLiveTurn() {
    vi.mocked(listSessionTurns).mockResolvedValue([
      {
        turnId: "live-turn",
        streamId: "live-turn",
        startedAt: "2026-07-12T00:00:00.000Z",
        status: "running",
      },
    ]);
    vi.mocked(openTurnStream).mockImplementation(
      async () => new Response(new ReadableStream<Uint8Array>({ start() {} })),
    );
  }

  it("closes a stored trace opened over a live one back to the session", async () => {
    attachToLiveTurn();
    renderAt("/sessions/fork-session");

    fireEvent.click(await screen.findByRole("button", { name: "open live trace" }));
    await screen.findByRole("dialog", { name: "trace.drawer.ariaLabel" });

    fireEvent.click(screen.getByRole("button", { name: "open stored trace" }));
    await waitFor(() => expect(path()).toBe("/sessions/fork-session/messages/trace-message/trace"));

    fireEvent.click(screen.getByRole("button", { name: "trace.drawer.closeAriaLabel" }));
    await waitFor(() => expect(path()).toBe("/sessions/fork-session"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "trace.drawer.ariaLabel" })).toBeNull(),
    );
  });

  it("leaves the trace URL when the live trace opens over it", async () => {
    attachToLiveTurn();
    renderAt("/sessions/fork-session/messages/trace-message/trace");

    await screen.findByText("stored trace body: trace-message");
    fireEvent.click(screen.getByRole("button", { name: "open live trace" }));

    await waitFor(() => expect(path()).toBe("/sessions/fork-session"));
    expect(screen.getByRole("dialog", { name: "trace.drawer.ariaLabel" })).toBeTruthy();
  });
});

describe("session detail surfaces move the address bar", () => {
  it("pushes the details URL on open and returns to the session URL on close", async () => {
    renderAt("/sessions/fork-session");

    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    await waitFor(() => expect(path()).toBe("/sessions/fork-session/details"));

    fireEvent.click(await screen.findByRole("button", { name: "Close details" }));
    await waitFor(() => expect(path()).toBe("/sessions/fork-session"));
  });

  it("closes the trace drawer back to the session URL", async () => {
    renderAt("/sessions/fork-session/messages/trace-message/trace");

    fireEvent.click(await screen.findByRole("button", { name: "trace.drawer.closeAriaLabel" }));
    await waitFor(() => expect(path()).toBe("/sessions/fork-session"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "trace.drawer.ariaLabel" })).toBeNull(),
    );
  });
});
