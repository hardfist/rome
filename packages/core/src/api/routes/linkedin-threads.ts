import { Hono } from "hono";
import {
  OpencliAuthError,
  safeSendLinkedInReply,
  type LinkedInSafeSendInput,
  type LinkedInSafeSendResult,
} from "../../channels/linkedin-cli.js";
import type { ApiDeps } from "../deps.js";

/**
 * Views over the LinkedIn inbox mirror and the guarded reply endpoint backing
 * the People tab's "LinkedIn messages" section. The mirror is fed by the
 * LinkedIn connection's poller (channels/linkedin.ts). Replies go through
 * opencli `linkedin safe-send`. It verifies the visible thread and recipient
 * before sending.
 *
 * Promoting a mirrored participant to a curated `persons` entry reuses the
 * existing `/api/persons/create` + `/api/persons/link` routes — a participant's
 * bare member id is the `channelUserId` those endpoints expect for LinkedIn,
 * and it is what an inbound LinkedIn message resolves through. Nothing here
 * promotes: the mirror is read-only towards the person graph, and the guardian
 * decides which of an inbox's many identities earns a person.
 */
export interface LinkedInThreadsSeams {
  sendReply?: (input: LinkedInSafeSendInput) => Promise<LinkedInSafeSendResult>;
}

export function linkedinThreadsRoutes(deps: ApiDeps, seams: LinkedInThreadsSeams = {}): Hono {
  const app = new Hono();
  const sendReply = seams.sendReply ?? safeSendLinkedInReply;

  app.get("/linkedin/threads", async (c) => {
    const rows = await deps.linkedInStoreRepo.listThreads();
    return c.json(rows);
  });

  // Every mirrored identity, each row carrying the person it was promoted into
  // (or null). A caller needs that to tell "promote" from "already promoted"
  // without guessing — the same annotation `/api/whatsapp/contacts` carries.
  app.get("/linkedin/participants", async (c) => {
    const rows = await deps.linkedInStoreRepo.listParticipants();
    return c.json(rows);
  });

  app.get("/linkedin/threads/:threadId/messages", async (c) => {
    const threadId = c.req.param("threadId");
    const limit = parsePositiveInt(c.req.query("limit"));
    const before = parsePositiveInt(c.req.query("before"));
    const messages = await deps.linkedInStoreRepo.getMessages(threadId, { limit, before });
    return c.json(messages);
  });

  app.post("/linkedin/threads/:threadId/send", async (c) => {
    const threadId = c.req.param("threadId");
    const body = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown });
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "text is required" }, 400);

    // Resolve the safety-critical URL/name from the server-owned mirror rather
    // than trusting the browser to choose where the write lands.
    const thread = (await deps.linkedInStoreRepo.listThreads()).find(
      (candidate) => candidate.threadId === threadId,
    );
    if (!thread) return c.json({ error: "LinkedIn thread not found" }, 404);

    const expectedName = thread.personName || thread.conversationName;
    if (!expectedName) {
      return c.json({ error: "LinkedIn recipient is not available yet" }, 409);
    }

    try {
      const result = await sendReply({
        threadUrl: thread.threadUrl,
        expectedName,
        message: text,
      });
      return c.json({ ok: true, recipient: result.recipient });
    } catch (err) {
      if (err instanceof OpencliAuthError) {
        return c.json({ error: "LinkedIn is not connected" }, 503);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  return app;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
