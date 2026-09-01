import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import type { Messages } from "./messages.js";
import { inList, scopeColumn, scopeValues, sqlMessages } from "./messages-sql.js";

/**
 * `Messages` over the LinkedIn inbox mirror (`linkedin_messages`).
 *
 * A LinkedIn message hangs off a thread rather than off a member, so the two
 * questions reach it two ways rather than by one scope with a condition on it.
 *
 * A member's history goes through the thread's membership — a member's history
 * is the messages of the threads they are on — restricted to threads that are
 * a conversation between two people. Two conditions keep it there, and both
 * are needed: LinkedIn's own group flag is null until a thread has been
 * snapshotted, so the membership decides the threads it has not answered for
 * yet.
 *
 * A message is answered once for each scoped member of its thread, and the
 * read above folds those together. That is what makes a person holding two
 * member ids on one thread read one history rather than the same messages
 * twice — and, unlike picking a single member per thread, it holds however
 * many members of however many people the scope names at once, which a read
 * grouping a whole directory into one pass depends on.
 *
 * A conversation is the thread itself, so nothing is reached through: the
 * thread id is on the message row. Nor is anything restricted — a thread of
 * three, and a thread LinkedIn flags as a group, are exactly the conversations
 * no member's history can reach, and answering them is what this read is for.
 * One member per message rather than one row per participant, since a thread
 * named once is a thread answered once.
 */
export function linkedInMessages(db: DrizzleDb): Messages {
  return sqlMessages({
    channel: "linkedin",
    db,
    view(scope) {
      if (scope.by === "conversation") {
        const threads = inList(sql`m.thread_id`, scopeValues(scope));
        if (threads === null) return null;
        return sql`
          SELECT
            'linkedin' AS source,
            m.thread_id AS ${scopeColumn(scope)},
            coalesce(m.sent_at, m.created_at) AS at,
            CASE WHEN m.sender_is_self THEN 1 ELSE 0 END AS outbound,
            m.thread_id || ':' || m.message_id AS ref,
            m.text AS body
          FROM linkedin_messages m
          WHERE ${threads}`;
      }
      const members = inList(sql`tp.participant_id`, scopeValues(scope));
      if (members === null) return null;
      return sql`
        SELECT
          'linkedin' AS source,
          tp.participant_id AS ${scopeColumn(scope)},
          coalesce(m.sent_at, m.created_at) AS at,
          CASE WHEN m.sender_is_self THEN 1 ELSE 0 END AS outbound,
          m.thread_id || ':' || m.message_id AS ref,
          m.text AS body
        FROM linkedin_messages m
        JOIN linkedin_threads t ON t.thread_id = m.thread_id
        JOIN linkedin_thread_participants tp
          ON tp.thread_id = m.thread_id AND ${members}
        WHERE coalesce(t.is_group, 0) = 0
          AND (
            SELECT count(*) FROM linkedin_thread_participants x WHERE x.thread_id = m.thread_id
          ) <= 2`;
    },
  });
}
