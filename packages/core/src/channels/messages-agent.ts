// `rome_agent_messages` as a {@link Messages} store: what Rome was told and
// what it said back, for every channel with no mirror of its own.

import { sql, type SQL } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import type { MessagePart } from "../types.js";
import type { Messages } from "./messages.js";
import { scopeColumn, scopePairs, sqlMessages } from "./messages-sql.js";

/**
 * The sender id Rome stamps on a message it sent itself.
 *
 * Written by every outbound path that records a channel message — the
 * `send_message` action and the backend turn — and already how
 * `loadConversationContext` picks Rome's own rows out of the pending
 * notifications. Read here for the same reason: it is the one persisted mark
 * that survives a row whose role does not say which way it went.
 */
const ROME_SENDER_ID = "rome";

/**
 * Which way a stored agent message went, as SQL over its role and sender.
 *
 * The role alone cannot answer it. `assistant` is Rome's and `user` is the
 * person's, but `notification` is written in both directions:
 * `addConversationMessage` stores an inbound line that did not wake the agent
 * under it, and `recordOutboundConversationMessage` stores a *delivered* Rome
 * message under it whenever the send was not tied to a turn
 * (`knownToProvider: false`). Reading the role alone puts those replies on the
 * person's side of the conversation.
 *
 * So the sender settles what the role leaves open, and this is stated once for
 * both stores that read these rows: two spellings would put one message on two
 * sides.
 */
export function agentMessageOutbound(role: SQL, senderId: SQL): SQL {
  return sql`CASE
    WHEN ${role} = 'assistant' THEN 1
    -- Asked of a notification alone, and not as a rule over every row: a
    -- sender id is a provider's own opaque string, so a channel is free to
    -- hand out one that reads as Rome's marker. Where the role already
    -- answers, that collision decides nothing.
    WHEN ${role} = 'notification' AND ${senderId} = ${ROME_SENDER_ID} THEN 1
    ELSE 0
  END`;
}

/**
 * Rome's own transcript of a channel conversation.
 *
 * A channel session is keyed by the thread it belongs to, so the session's
 * thread id is what both questions reach a message through — and the same
 * column answers each, since a direct conversation is addressed by the account
 * whose thread it is.
 *
 * What differs is which threads each may select. An account read takes the
 * ones an account addresses, so a group's session — addressed by the group
 * rather than by anyone on it — is named by no account and never matches.
 * Which sender a message carries makes no difference either way: a line the
 * account wrote into a group belongs to the group's thread, and that thread is
 * what a conversation read asks for.
 */
export function agentMessages(db: DrizzleDb): Messages {
  // No `channel`: the transcript holds every channel that has no mirror of its
  // own, side by side, so it is scoped by the pair throughout.
  return sqlMessages({
    db,
    view(scope) {
      const named = scopePairs(scope, sql`s.source_channel`, sql`s.source_thread_id`);
      if (named === null) return null;
      // Addressing already leaves a group out of an account read, since a
      // group's session is keyed by the group and no account answers to that.
      // Said again on the store's own terms so the guarantee survives a caller
      // that hands over a group id as if it were an account's address.
      const direct =
        scope.by === "address" ? sql` AND coalesce(s.source_thread_type, '') <> 'group'` : sql``;
      return sql`
        SELECT
          s.source_channel AS source,
          s.source_thread_id AS ${scopeColumn(scope)},
          m.created_at AS at,
          ${agentMessageOutbound(sql`m.role`, sql`m.sender_id`)} AS outbound,
          'agent:' || m.id AS ref,
          m.content AS body
        FROM rome_agent_messages m
        JOIN rome_sessions s ON s.id = m.session_id
        WHERE s.type = 'channel'
          AND ${named}${direct}
          -- 'notification' is a line that passed outside a turn — something
          -- the person said without waking the agent, or something Rome sent
          -- untied to one. Either way it is conversation, and the direction
          -- above is what tells the two apart. 'trace' is the turn's own
          -- machinery and belongs to no conversation, a group's included.
          AND m.role IN ('user', 'assistant', 'notification')`;
    },
    body: messageContentText,
  });
}

/** The line a stored agent message renders as: its text parts, joined.
 *  Non-text parts (cards, recaps, errors) carry no conversation, and content
 *  that does not parse is a row with nothing to show rather than a failed read. */
export function messageContentText(raw: string | null): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const text = parsed
    .filter((part): part is Extract<MessagePart, { type: "text" }> => {
      if (typeof part !== "object" || part === null) return false;
      const candidate = part as { type?: unknown; content?: unknown };
      return candidate.type === "text" && typeof candidate.content === "string";
    })
    .map((part) => part.content)
    .join("\n");
  return text.length > 0 ? text : null;
}
