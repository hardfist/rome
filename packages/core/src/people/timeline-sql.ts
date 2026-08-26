// The SQL half of the timeline seam: a store that lives in this database
// becomes a {@link TimelineSource} by describing its rows as timeline entries
// once, and this module pages, orders and scopes them.

import { sql, type SQL } from "drizzle-orm";
import type { TimelineEntry } from "@rome/api-types/people";
import type { DrizzleDb } from "../db/index.js";
import type { TimelineAccount, TimelineSource, TimelineRead } from "./timeline.js";

/**
 * A store's rows as timeline entries: a SELECT producing exactly the columns
 * `source`, `address`, `at`, `outbound`, `ref`, `body`.
 *
 * - `source` is the channel the entry arrived on, and `address` the account
 *   address it belongs to. Together they are how {@link sqlTimelineSource}
 *   answers which accounts the store holds, so both have to name the account
 *   the caller asked about rather than whatever the row stores.
 * - `at` is epoch seconds, `outbound` is 1 for something Rome said and 0 for
 *   something it was told, `body` is the line to render or NULL.
 * - `ref` must be unique across everything the store can put on one person's
 *   timeline. Ids that are unique only within a conversation (a WhatsApp
 *   message id, a LinkedIn message id) are qualified by the conversation.
 */
export type TimelineViewSql = SQL;

/**
 * A {@link TimelineSource} over one SQL view.
 *
 * `view` returns null when the request can hold nothing — no accounts on a
 * channel this store serves — and the store then answers empty without a query.
 *
 * `body` maps the view's `body` column to the rendered line, for a store whose
 * text is not stored as text. It runs on the page, not on the scope, so it can
 * be as expensive as the parse it wraps.
 */
export function sqlTimelineSource(options: {
  name: string;
  db: DrizzleDb;
  view(accounts: readonly TimelineAccount[]): TimelineViewSql | null;
  body?(raw: string | null): string | null;
}): TimelineSource {
  const { name, db, view } = options;
  return {
    name,

    async holds(accounts) {
      const rows = view(accounts);
      if (rows === null) return [];
      const found = (await db.all(sql`SELECT DISTINCT source, address FROM (${rows})`)) as Array<
        Record<string, unknown>
      >;
      const held = new Set(found.map((row) => addressKey(String(row.source), String(row.address))));
      return accounts.filter((account) =>
        account.addresses.some((address) => held.has(addressKey(account.channel, address))),
      );
    },

    async read(request: TimelineRead) {
      const rows = view(request.accounts);
      if (rows === null) return [];
      const page = (await db.all(sql`
        SELECT source, at, outbound, ref, body
        FROM (${rows})
        WHERE ${afterCursor(request.cursor)}
        ORDER BY at DESC, outbound DESC, source ASC, ref ASC
        LIMIT ${Math.max(1, Math.floor(request.limit))}
      `)) as Array<Record<string, unknown>>;
      return page.map((row) => {
        const body = (row.body as string | null) ?? null;
        return {
          source: String(row.source),
          timestamp: Number(row.at),
          direction: Number(row.outbound) === 1 ? ("outbound" as const) : ("inbound" as const),
          ref: String(row.ref),
          body: options.body ? options.body(body) : body,
        };
      });
    },
  };
}

const addressKey = (channel: string, address: string) => `${channel}\n${address}`;

/**
 * The rows that fall strictly after `cursor`, in the order the ORDER BY above
 * imposes — which is `compareTimelineEntries` read as SQL.
 *
 * The whole tuple, not `at < cursor.timestamp`: a second holds more than one
 * entry, and resuming from the bare timestamp drops the rest of that second.
 *
 * The two text comparisons ride SQLite's BINARY collation, which orders UTF-8
 * by byte and therefore by code point — the same answer `compareCodePoints`
 * gives, which is what makes a cursor mean one position on both ends.
 */
function afterCursor(cursor: TimelineEntry | null): SQL {
  if (cursor === null) return sql`1 = 1`;
  const outbound = cursor.direction === "outbound" ? 1 : 0;
  return sql`
    at < ${cursor.timestamp}
    OR (at = ${cursor.timestamp}
        AND (outbound < ${outbound}
             OR (outbound = ${outbound}
                 AND (source > ${cursor.source}
                      OR (source = ${cursor.source} AND ref > ${cursor.ref})))))`;
}

/** `column IN (…)` over `values`, or null when there is nothing to match —
 *  `IN ()` is not SQL, and a caller that emitted it would fail the whole read
 *  rather than answer the empty page an empty scope means. */
export function inList(column: SQL, values: readonly string[]): SQL | null {
  if (values.length === 0) return null;
  return sql`${column} IN (${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

/** Every address of every account, for a store that serves one channel. */
export function addressesOn(accounts: readonly TimelineAccount[], channel: string): string[] {
  return accounts.filter((account) => account.channel === channel).flatMap((a) => a.addresses);
}

/** `(channel, address)` matched as a pair, so an address on one channel never
 *  selects a row another channel stores under the same string. */
export function accountPairs(
  accounts: readonly TimelineAccount[],
  channelColumn: SQL,
  addressColumn: SQL,
): SQL | null {
  const clauses = accounts
    .map((account) => {
      const addresses = inList(addressColumn, account.addresses);
      return addresses === null
        ? null
        : sql`(${channelColumn} = ${account.channel} AND ${addresses})`;
    })
    .filter((clause): clause is SQL => clause !== null);
  if (clauses.length === 0) return null;
  return sql`(${sql.join(clauses, sql` OR `)})`;
}
