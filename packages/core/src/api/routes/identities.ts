import { Hono } from "hono";
import { sql } from "drizzle-orm";
import {
  channelIdentityId,
  compareCodePoints,
  compareIdentityRows,
  identityMatchesQuery,
  normalizeBondLevel,
  parseIdentityCursor,
  parseIdentityFilterLevel,
  personIdentityId,
  sliceIdentityPage,
  type IdentityDynamic,
  type IdentityRow,
} from "@rome/api-types/identities";
import { STRANGER_PERSON_ID } from "../../constants.js";
import type { ApiDeps } from "../deps.js";

// The People page's one read: a union of curated persons and the senders the
// sentinel log saw but nobody placed, every row in the shared `IdentityRow`
// shape and carrying its newest dynamic. A read — no person row is
// materialized here, ever; writes stay on the `/persons/*` mutation routes.

interface SentinelActivity {
  channel: string;
  channelUserId: string;
  displayName: string | null;
  lastMessage: string | null;
  lastMessageAt: number | null;
  messageCount: number;
}

interface ChannelActivity {
  latest: IdentityDynamic | null;
  messageCount: number;
}

const activityKey = (channel: string, channelUserId: string) => `${channel}\n${channelUserId}`;

/** The newer of two dynamics, or whichever one exists. */
function newer(a: IdentityDynamic | null, b: IdentityDynamic | null): IdentityDynamic | null {
  if (!a) return b;
  if (!b) return a;
  return b.timestamp > a.timestamp ? b : a;
}

export function identitiesRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/identities", async (c) => {
    const query = c.req.query("q") ?? "";
    const includeNeverMessaged = c.req.query("includeNeverMessaged") === "true";
    const wanted = c.req.query("id");
    const limit = parsePositiveInt(c.req.query("limit"));
    const cursor = c.req.query("cursor") ?? null;
    const rawLevel = c.req.query("level");
    const level = parseIdentityFilterLevel(rawLevel);
    if (rawLevel != null && rawLevel !== "" && level === null) {
      return c.json({ error: `level must name a bond level or "all"` }, 400);
    }

    const parsedCursor = parseIdentityCursor(cursor);
    if (cursor != null && cursor !== "" && parsedCursor === null) {
      return c.json({ error: "cursor is not an identity cursor" }, 400);
    }

    const matching = (await buildIdentityUnion(deps)).filter((row) =>
      identityMatchesQuery(row, query),
    );
    matching.sort(compareIdentityRows);

    // Everything below the query is the page's business, not the union's: the
    // level, the cursor, and `?id=` all scope which rows come back while the
    // counts stay whole-union.
    return c.json(
      sliceIdentityPage(matching, {
        cursor: parsedCursor,
        limit,
        level,
        id: wanted ?? null,
        includeNeverMessaged: includeNeverMessaged || query.trim() !== "",
      }),
    );
  });

  return app;
}

/** The full union, unordered and unfiltered. */
async function buildIdentityUnion(deps: ApiDeps): Promise<IdentityRow[]> {
  // Bare display_name/text ride SQLite's guarantee that with a lone MAX()
  // aggregate the other selected columns come from the row that supplied the
  // max — i.e. the newest message names the sender.
  const sentinelRows = (await deps.db.all(sql`
    SELECT
      channel,
      channel_user_id AS channelUserId,
      display_name AS displayName,
      text AS lastMessage,
      MAX(created_at) AS lastMessageAt,
      COUNT(*) AS messageCount
    FROM sentinel_log
    GROUP BY channel, channel_user_id
  `)) as Array<Record<string, unknown>>;

  const sentinel = new Map<string, SentinelActivity>();
  const senders: SentinelActivity[] = [];
  for (const row of sentinelRows) {
    const activity: SentinelActivity = {
      channel: String(row.channel),
      channelUserId: String(row.channelUserId),
      displayName: (row.displayName as string | null) ?? null,
      lastMessage: (row.lastMessage as string | null) ?? null,
      lastMessageAt: row.lastMessageAt == null ? null : Number(row.lastMessageAt),
      messageCount: Number(row.messageCount ?? 0),
    };
    senders.push(activity);
    sentinel.set(activityKey(activity.channel, activity.channelUserId), activity);
  }

  const activityFor = (channel: string, channelUserId: string): ChannelActivity => {
    const entry = sentinel.get(activityKey(channel, channelUserId));
    return {
      latest:
        entry?.lastMessageAt == null
          ? null
          : { source: channel, timestamp: entry.lastMessageAt, preview: entry.lastMessage },
      messageCount: entry?.messageCount ?? 0,
    };
  };

  /** Best name on record for an identity with no person row: what the sender
   *  called themselves, then the raw channel user id. */
  const displayNameFor = (channel: string, channelUserId: string): string =>
    sentinel.get(activityKey(channel, channelUserId))?.displayName ?? channelUserId;

  // One statement, so an identity moving between two people mid-read cannot
  // land under both of them.
  const persons = (await deps.personMappingRepo.findAllWithMappings()).sort((a, b) =>
    compareCodePoints(a.id, b.id),
  );
  const rows: IdentityRow[] = [];
  const mapped = new Set<string>();

  for (const person of persons) {
    for (const mapping of person.channelMappings) {
      mapped.add(activityKey(mapping.channel, mapping.channelUserId));
    }

    if (person.id === STRANGER_PERSON_ID) {
      // The sentinel is a person row, but each dismissed identity is its own
      // row on the ladder — a channel-form id, so recovering one is the same
      // move that places an unknown sender.
      for (const mapping of person.channelMappings) {
        rows.push({
          id: channelIdentityId(mapping.channel, mapping.channelUserId),
          displayName: displayNameFor(mapping.channel, mapping.channelUserId),
          level: "stranger",
          channels: [{ channel: mapping.channel, channelUserId: mapping.channelUserId }],
          ...activityFor(mapping.channel, mapping.channelUserId),
          neverMessaged: false,
        });
      }
      continue;
    }

    const activity = person.channelMappings
      .map((mapping) => activityFor(mapping.channel, mapping.channelUserId))
      .reduce<ChannelActivity>(
        (best, next) => ({
          latest: newer(best.latest, next.latest),
          messageCount: best.messageCount + next.messageCount,
        }),
        { latest: null, messageCount: 0 },
      );

    rows.push({
      id: personIdentityId(person.id),
      displayName: person.displayName,
      level: person.bondLevel === "guardian" ? "guardian" : normalizeBondLevel(person.bondLevel),
      channels: person.channelMappings.map((mapping) => ({
        channel: mapping.channel,
        channelUserId: mapping.channelUserId,
      })),
      ...activity,
      neverMessaged: false,
    });
  }

  // Unknown = seen but never placed.
  for (const sender of senders) {
    const key = activityKey(sender.channel, sender.channelUserId);
    if (mapped.has(key)) continue;
    mapped.add(key);
    rows.push({
      id: channelIdentityId(sender.channel, sender.channelUserId),
      displayName: displayNameFor(sender.channel, sender.channelUserId),
      level: "unknown",
      channels: [{ channel: sender.channel, channelUserId: sender.channelUserId }],
      ...activityFor(sender.channel, sender.channelUserId),
      neverMessaged: false,
    });
  }

  return rows;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
