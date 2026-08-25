import { Hono } from "hono";
import {
  OpencliAuthError,
  safeSendLinkedInReply,
  type LinkedInSafeSendInput,
  type LinkedInSafeSendResult,
} from "../../channels/linkedin-cli.js";
import {
  LinkedInPromotionError,
  promoteLinkedInParticipant,
  type LinkedInPromotionOptions,
  type LinkedInPromotionResult,
  type PromotableBondLevel,
} from "../../channels/linkedin-promote.js";
import type { ApiDeps } from "../deps.js";

/**
 * Views over the LinkedIn inbox mirror and the guarded reply endpoint backing
 * the People tab's "LinkedIn messages" section. The mirror is fed by the
 * LinkedIn connection's poller (channels/linkedin.ts). Replies go through
 * opencli `linkedin safe-send`. It verifies the visible thread and recipient
 * before sending.
 *
 * Promotion of a mirrored participant into `persons` also lives here, as an
 * explicit endpoint. The poller has no route into it: promotion is a guardian
 * action, and an inbox full of strangers must not walk itself into the person
 * graph. The UI that calls this is out of scope.
 */
export interface LinkedInThreadsSeams {
  sendReply?: (input: LinkedInSafeSendInput) => Promise<LinkedInSafeSendResult>;
  promoteParticipant?: (
    participantId: string,
    options: LinkedInPromotionOptions,
  ) => Promise<LinkedInPromotionResult>;
}

/** The bond levels this endpoint accepts. `guardian` is deliberately absent —
 *  it is conferred at the terminal, not by pointing at an inbox row. */
const PROMOTABLE_BOND_LEVELS: readonly PromotableBondLevel[] = [
  "inner-circle",
  "acquaintance",
  "other",
];

export function linkedinThreadsRoutes(deps: ApiDeps, seams: LinkedInThreadsSeams = {}): Hono {
  const app = new Hono();
  const sendReply = seams.sendReply ?? safeSendLinkedInReply;
  const promoteParticipant: NonNullable<LinkedInThreadsSeams["promoteParticipant"]> =
    seams.promoteParticipant ??
    ((participantId, options) =>
      promoteLinkedInParticipant(
        participantId,
        { participants: deps.linkedInStoreRepo, persons: deps.personMappingRepo },
        options,
      ));

  app.get("/linkedin/threads", async (c) => {
    const rows = await deps.linkedInStoreRepo.listThreads();
    return c.json(rows);
  });

  app.get("/linkedin/threads/:threadId/messages", async (c) => {
    const threadId = c.req.param("threadId");
    const limit = parsePositiveInt(c.req.query("limit"));
    const before = parsePositiveInt(c.req.query("before"));
    const messages = await deps.linkedInStoreRepo.getMessages(threadId, { limit, before });
    return c.json(messages);
  });

  app.get("/linkedin/threads/:threadId/participants", async (c) => {
    const participants = await deps.linkedInStoreRepo.getThreadParticipants(
      c.req.param("threadId"),
    );
    return c.json(participants);
  });

  // Promote one mirrored identity into the person graph. Idempotent: an
  // identity already mapped comes back as `created: false` rather than as an
  // error, because "this participant is already a person" is the outcome the
  // caller wanted, not a failure to achieve it.
  app.post("/linkedin/participants/:participantId/promote", async (c) => {
    const participantId = c.req.param("participantId");
    const body = await c.req
      .json<{ displayName?: unknown; bondLevel?: unknown }>()
      .catch(() => ({}) as { displayName?: unknown; bondLevel?: unknown });

    const options: LinkedInPromotionOptions = {};
    if (typeof body.displayName === "string" && body.displayName.trim()) {
      options.displayName = body.displayName.trim();
    }
    if (body.bondLevel !== undefined) {
      if (!PROMOTABLE_BOND_LEVELS.includes(body.bondLevel as PromotableBondLevel)) {
        return c.json(
          { error: `bondLevel must be one of: ${PROMOTABLE_BOND_LEVELS.join(", ")}` },
          400,
        );
      }
      options.bondLevel = body.bondLevel as PromotableBondLevel;
    }

    try {
      const result = await promoteParticipant(participantId, options);
      return c.json(result);
    } catch (err) {
      // A participant that cannot be promoted is a statement about the request,
      // not a server fault — the caller pointed at something that is not a
      // promotable identity.
      if (err instanceof LinkedInPromotionError) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
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
