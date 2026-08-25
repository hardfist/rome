import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { OpencliAuthError } from "../../channels/linkedin-cli.js";
import { linkedinThreadsRoutes } from "./linkedin-threads.js";
import type { LinkedInThreadRow } from "../../db/repositories/linkedin-store.js";
import type { ApiDeps } from "../deps.js";

type SendReplySpy = ReturnType<typeof vi.fn>;

const THREAD: LinkedInThreadRow = {
  threadId: "2-abc==",
  threadUrl: "https://www.linkedin.com/messaging/thread/2-abc==/",
  personName: "Ada Lovelace",
  conversationName: null,
  lastMessagePreview: "See you Thursday",
  lastMessageAt: 1_776_000_000,
  unread: true,
  isGroup: false,
  participantCount: 2,
  counterpartyType: "member",
  category: "INBOX,PRIMARY_INBOX",
  messageCount: 2,
};

function buildDeps(threads = [THREAD]): ApiDeps {
  return {
    linkedInStoreRepo: {
      listThreads: async () => threads,
      getMessages: async () => [],
    },
  } as unknown as ApiDeps;
}

function mount(sendReply: SendReplySpy, deps = buildDeps()): Hono {
  return new Hono().route("/", linkedinThreadsRoutes(deps, { sendReply }));
}

async function post(app: Hono, body: unknown): Promise<Response> {
  return await app.request(`/linkedin/threads/${encodeURIComponent(THREAD.threadId)}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function successfulSender(): SendReplySpy {
  return vi.fn(async () => ({
    status: "sent" as const,
    recipient: "Ada Lovelace",
    reason: "verified",
    threadUrl: THREAD.threadUrl,
    messageChars: 15,
  }));
}

describe("GET /linkedin/threads", () => {
  // The count is now derived from stored membership rather than copied off the
  // thread snapshot; the People tab still reads it off this row, same name,
  // same nullability.
  it("serves each thread's participant count to the reader", async () => {
    const res = await mount(successfulSender()).request("/linkedin/threads");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([THREAD]);
  });

  it("passes through a thread whose membership has never been read", async () => {
    const neverRead = { ...THREAD, participantCount: null };
    const res = await mount(successfulSender(), buildDeps([neverRead])).request(
      "/linkedin/threads",
    );

    const rows = (await res.json()) as Array<{ participantCount: number | null }>;
    expect(rows[0].participantCount).toBeNull();
  });
});

describe("POST /linkedin/threads/:threadId/send", () => {
  it("sends through opencli safe-send using server-owned thread identity", async () => {
    const sendReply = successfulSender();
    const res = await post(mount(sendReply), {
      text: "  Thursday works  ",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recipient: "Ada Lovelace" });
    expect(sendReply).toHaveBeenCalledWith({
      threadUrl: THREAD.threadUrl,
      expectedName: "Ada Lovelace",
      message: "Thursday works",
    });
  });

  it("rejects an empty reply", async () => {
    const sendReply = successfulSender();

    expect((await post(mount(sendReply), { text: "   " })).status).toBe(400);
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("does not send when the mirrored thread is missing", async () => {
    const sendReply = successfulSender();
    const res = await post(mount(sendReply, buildDeps([])), {
      text: "Thursday works",
    });

    expect(res.status).toBe(404);
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("maps a signed-out LinkedIn browser session to 503", async () => {
    const sendReply = vi.fn(async () => {
      throw new OpencliAuthError("signed out");
    });
    const res = await post(mount(sendReply), {
      text: "Thursday works",
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "LinkedIn is not connected" });
  });

  it("surfaces a failed safety verification as a bad gateway", async () => {
    const sendReply = vi.fn(async () => {
      throw new Error("opencli linkedin safe-send failed: recipient_mismatch");
    });
    const res = await post(mount(sendReply), {
      text: "Thursday works",
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "opencli linkedin safe-send failed: recipient_mismatch",
    });
  });
});

// Promotion is a guardian action, so it has an explicit endpoint — the poller
// has no route into this. The UI that calls it is out of scope here.
describe("LinkedIn participant routes", () => {
  const ADA = "ACoAAAda0001";

  function promoteDeps(over: Partial<Record<string, unknown>> = {}) {
    return {
      linkedInStoreRepo: {
        listThreads: async () => [THREAD],
        getMessages: async () => [],
        getThreadParticipants: async () => [
          {
            participantId: ADA,
            name: "Ada Lovelace",
            headline: "Building the analytical engine",
            type: "member",
            isSelf: false,
          },
        ],
        ...over,
      },
    } as unknown as ApiDeps;
  }

  function mountPromote(promote: ReturnType<typeof vi.fn>, deps = promoteDeps()): Hono {
    return new Hono().route("/", linkedinThreadsRoutes(deps, { promoteParticipant: promote }));
  }

  it("lists a thread's stored participants", async () => {
    const app = new Hono().route("/", linkedinThreadsRoutes(promoteDeps(), {}));
    const res = await app.request(
      `/linkedin/threads/${encodeURIComponent(THREAD.threadId)}/participants`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        participantId: ADA,
        name: "Ada Lovelace",
        headline: "Building the analytical engine",
        type: "member",
        isSelf: false,
      },
    ]);
  });

  it("promotes a participant and reports the person it created", async () => {
    const promote = vi.fn(async () => ({ personId: "ada-lovelace", created: true }));
    const res = await mountPromote(promote).request(
      `/linkedin/participants/${encodeURIComponent(ADA)}/promote`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bondLevel: "inner-circle" }),
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ personId: "ada-lovelace", created: true });
    expect(promote).toHaveBeenCalledWith(
      ADA,
      expect.objectContaining({ bondLevel: "inner-circle" }),
    );
  });

  it("reports an already-promoted participant as created: false, not as an error", async () => {
    const promote = vi.fn(async () => ({ personId: "ada-lovelace", created: false }));
    const res = await mountPromote(promote).request(
      `/linkedin/participants/${encodeURIComponent(ADA)}/promote`,
      { method: "POST" },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ personId: "ada-lovelace", created: false });
  });

  it("rejects a bond level the person graph does not define", async () => {
    const promote = vi.fn();
    const res = await mountPromote(promote).request(
      `/linkedin/participants/${encodeURIComponent(ADA)}/promote`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bondLevel: "best-friend" }),
      },
    );

    expect(res.status).toBe(400);
    expect(promote).not.toHaveBeenCalled();
  });

  it("never lets the endpoint confer guardian", async () => {
    const promote = vi.fn();
    const res = await mountPromote(promote).request(
      `/linkedin/participants/${encodeURIComponent(ADA)}/promote`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bondLevel: "guardian" }),
      },
    );

    expect(res.status).toBe(400);
    expect(promote).not.toHaveBeenCalled();
  });

  it("turns an unpromotable participant into a 404 rather than a 500", async () => {
    const { LinkedInPromotionError } = await import("../../channels/linkedin-promote.js");
    const promote = vi.fn(async () => {
      throw new LinkedInPromotionError("unknown LinkedIn participant");
    });
    const res = await mountPromote(promote).request("/linkedin/participants/ACoAAGhost/promote", {
      method: "POST",
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("unknown LinkedIn participant");
  });
});
