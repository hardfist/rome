import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { OpencliAuthError } from "../../channels/linkedin-cli.js";
import { linkedinThreadsRoutes } from "./linkedin-threads.js";
import type {
  LinkedInParticipantContactRow,
  LinkedInThreadRow,
} from "../../db/repositories/linkedin-store.js";
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

const ADA: LinkedInParticipantContactRow = {
  participantId: "ACoAAAda0001",
  name: "Ada Lovelace",
  headline: "Engineer",
  type: "member",
  isSelf: false,
  threadCount: 2,
  linkedPersonId: null,
  linkedPersonName: null,
  lastMessageAt: 1_776_000_000,
  lastMessagePreview: "See you Thursday",
  messageCount: 2,
};

function buildDeps(threads = [THREAD], participants = [ADA]): ApiDeps {
  return {
    linkedInStoreRepo: {
      listThreads: async () => threads,
      listParticipants: async () => participants,
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

describe("GET /linkedin/participants", () => {
  // Promotion goes through `/api/persons/create` + `/api/persons/link`; this
  // route exists so a caller can tell which identities have already been there.
  it("serves each mirrored identity with its promotion state", async () => {
    const res = await mount(successfulSender()).request("/linkedin/participants");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([ADA]);
  });

  it("carries the person a promoted identity resolves to", async () => {
    const promoted = {
      ...ADA,
      linkedPersonId: "ada-lovelace",
      linkedPersonName: "Ada Lovelace",
    };
    const res = await mount(successfulSender(), buildDeps([THREAD], [promoted])).request(
      "/linkedin/participants",
    );

    const rows = (await res.json()) as LinkedInParticipantContactRow[];
    expect(rows[0].linkedPersonId).toBe("ada-lovelace");
    // The headline stays on the mirror row — `channel_mappings` has no column
    // for it, and it belongs in the person's memory profile.
    expect(rows[0].headline).toBe("Engineer");
  });
});

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
