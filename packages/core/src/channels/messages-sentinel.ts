// `sentinel_log` as a {@link Messages} store: the triage record, and the only
// place an exchange the sentinel handled alone is written down.

import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import type { Messages } from "./messages.js";
import { scopeColumn, scopePairs, sqlMessages } from "./messages-sql.js";

/**
 * What the sentinel logged, one row read as the two lines it records: what the
 * sender said, and what Rome answered when it answered at all.
 *
 * Both halves share the row's one timestamp, and the ordering puts the reply
 * above the line it answers. Each carries its own `ref`, so the two never
 * collapse to one cursor position.
 *
 * A row names both the sender it came from and the thread it was said in, so
 * the two questions read two different columns of it rather than one column
 * two ways.
 */
export function sentinelLogMessages(db: DrizzleDb): Messages {
  // No `channel`: the log holds every channel's triage side by side, so it is
  // scoped by the pair throughout.
  return sqlMessages({
    db,
    view(scope) {
      const key = scope.by === "address" ? sql`l.channel_user_id` : sql`l.thread_id`;
      const named = scopePairs(scope, sql`l.channel`, key);
      if (named === null) return null;
      // A log row names its sender but not whether they were alone. The
      // session that recorded the same thread does, so a thread Rome knows to
      // be a group is what an account read subtracts — a row whose thread no
      // session covers is a direct exchange until something says otherwise. A
      // conversation read subtracts nothing: the thread named is the thread
      // answered, group or not.
      const held =
        scope.by === "conversation"
          ? named
          : sql`
        ${named}
        AND NOT EXISTS (
          SELECT 1 FROM rome_sessions s
          WHERE s.type = 'channel'
            AND s.source_channel = l.channel
            AND s.source_thread_id = l.thread_id
            AND s.source_thread_type = 'group'
        )`;
      return sql`
        SELECT
          l.channel AS source,
          ${key} AS ${scopeColumn(scope)},
          l.created_at AS at,
          0 AS outbound,
          'sentinel:' || l.id AS ref,
          l.text AS body
        FROM sentinel_log l
        WHERE ${held}
        UNION ALL
        SELECT
          l.channel,
          ${key},
          l.created_at,
          1,
          'sentinel:' || l.id || ':reply',
          l.response
        FROM sentinel_log l
        WHERE ${held} AND l.response IS NOT NULL AND l.response <> ''`;
    },
  });
}
