import { Hono } from "hono";
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
  type IdentityChannel,
  type IdentityDynamic,
  type IdentityRow,
} from "@rome/api-types/identities";
import { STRANGER_PERSON_ID } from "../../constants.js";
import {
  addressKey,
  foldAccountRecords,
  mirrorRegistry,
  newer,
  type AccountRecord,
  type MirrorPlane,
} from "../../channels/account-fold.js";
import type { ApiDeps } from "../deps.js";

// The People page's one read: a union of curated persons, unmapped senders from
// the sentinel log, and the mirrored accounts nobody has placed yet — WhatsApp
// contacts, LinkedIn participants — every row in the shared `IdentityRow` shape
// and carrying its newest dynamic. A read — no person row is materialized here,
// ever; writes stay on the `/persons/*` mutation routes.

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
    // level, the silent contacts, the cursor, and `?id=` all scope which rows
    // come back while the counts stay whole-union. Pruning the silent ones here
    // instead would answer `neverMessagedTotal: 0` in the very view whose
    // toggle that number is for.
    //
    // A search does reach them: the toggle holds the address book out of the
    // browsing views, not out of a lookup for a name or number the guardian
    // typed.
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
  const [senders, unsorted] = await Promise.all([
    deps.sentinelLogRepo.listSenderActivity(),
    // One statement, so an identity moving between two people mid-read cannot
    // land under both of them.
    deps.personMappingRepo.findAllWithMappings(),
  ]);
  const persons = unsorted.sort((a, b) => compareCodePoints(a.id, b.id));

  const fold = await foldAccountRecords(mirrorRegistry<MirrorPlane>(deps), {
    senders,
    stored: [...senders, ...persons.flatMap((person) => person.channelMappings)],
  });
  const canonicalId = (channel: string, channelUserId: string) =>
    fold.canonical(channel, channelUserId);
  const identityKey = (channel: string, channelUserId: string) => fold.key(channel, channelUserId);
  const activityFor = (channel: string, channelUserId: string): AccountRecord =>
    fold.recordFor(channel, channelUserId);

  /**
   * Every identifier a row's channels answer to.
   *
   * A mirrored identity is one identity under several identifiers, and a
   * mapping names only one of them. The contract asks for all of them because
   * a search reads this list: an omitted alias is a contact the guardian
   * cannot reach by the phone number they know. The mapping's own form leads,
   * so a client mutating the row addresses the mapping that exists.
   */
  const channelsOf = (channels: IdentityChannel[]): IdentityChannel[] => {
    const seen = new Set<string>();
    const out: IdentityChannel[] = [];
    const add = (channel: string, channelUserId: string) => {
      const key = addressKey(channel, channelUserId);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ channel, channelUserId });
    };
    for (const channel of channels) {
      add(channel.channel, channel.channelUserId);
      for (const alias of fold.mirrorFor(channel.channel, channel.channelUserId)?.aliases ?? []) {
        add(channel.channel, alias);
      }
    }
    return out;
  };

  /** Best name on record for an identity with no person row: the channel's own
   *  name for it, then what the sender called themselves, then the raw
   *  identifier. */
  const displayNameFor = (channel: string, channelUserId: string): string => {
    const named = fold
      .sendersFor(channel, channelUserId)
      .reduce<{ displayName: string | null; lastMessageAt: number | null } | null>(
        (best, entry) =>
          best == null || (entry.lastMessageAt ?? 0) > (best.lastMessageAt ?? 0) ? entry : best,
        null,
      );
    return (
      fold.mirrorFor(channel, channelUserId)?.name ??
      named?.displayName ??
      canonicalId(channel, channelUserId)
    );
  };

  const rows: IdentityRow[] = [];
  const mapped = new Set<string>();

  // Which person owns each identity, decided once before any row is built. The
  // unique index already holds one mapping per identifier, but two people can
  // map two aliases of one identity, and that identity is one row: the lowest
  // person id takes it, so the union never shows or counts it twice, and shows
  // the same one on every read.
  const ownerOf = new Map<string, string>();
  for (const person of persons) {
    for (const mapping of person.channelMappings) {
      const key = identityKey(mapping.channel, mapping.channelUserId);
      if (!ownerOf.has(key)) ownerOf.set(key, person.id);
    }
  }

  for (const person of persons) {
    const owned = person.channelMappings.filter(
      (mapping) => ownerOf.get(identityKey(mapping.channel, mapping.channelUserId)) === person.id,
    );
    for (const mapping of person.channelMappings) {
      mapped.add(identityKey(mapping.channel, mapping.channelUserId));
    }

    if (person.id === STRANGER_PERSON_ID) {
      // The sentinel is a person row, but each dismissed identity is its own
      // row on the ladder — a channel-form id, so recovering one is the same
      // move that places an unknown sender.
      for (const mapping of owned) {
        rows.push({
          id: channelIdentityId(
            mapping.channel,
            canonicalId(mapping.channel, mapping.channelUserId),
          ),
          displayName: displayNameFor(mapping.channel, mapping.channelUserId),
          level: "stranger",
          channels: channelsOf([
            { channel: mapping.channel, channelUserId: mapping.channelUserId },
          ]),
          ...activityFor(mapping.channel, mapping.channelUserId),
          neverMessaged: false,
        });
      }
      continue;
    }

    // Only the identities this person owns contribute: an alias another person
    // already took is that person's history, not a second copy of it here.
    const activity = owned
      .map((mapping) => activityFor(mapping.channel, mapping.channelUserId))
      .reduce<AccountRecord>(
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
      channels: channelsOf(person.channelMappings),
      ...activity,
      neverMessaged: false,
    });
  }

  // Unknown = seen (or synced) but never placed. Senders first…
  for (const sender of senders) {
    const key = identityKey(sender.channel, sender.channelUserId);
    if (mapped.has(key)) continue;
    mapped.add(key);
    rows.push({
      id: channelIdentityId(sender.channel, canonicalId(sender.channel, sender.channelUserId)),
      displayName: displayNameFor(sender.channel, sender.channelUserId),
      level: "unknown",
      channels: channelsOf([{ channel: sender.channel, channelUserId: sender.channelUserId }]),
      ...activityFor(sender.channel, sender.channelUserId),
      neverMessaged: false,
    });
  }

  // …then mirrored identities the sentinel never saw. `neverMessaged` marks the
  // silent ones so the page can keep a 9,000-contact address book out of the
  // stream while search still reaches it.
  for (const identity of fold.accounts) {
    // A promoted contact is already a person row above, and it was reached
    // through the same fold, so `mapped` is what holds it back — no second
    // read of who owns what.
    const key = identityKey(identity.channel, identity.channelUserId);
    if (mapped.has(key)) continue;
    mapped.add(key);
    const activity = activityFor(identity.channel, identity.channelUserId);
    rows.push({
      id: channelIdentityId(identity.channel, identity.channelUserId),
      displayName: displayNameFor(identity.channel, identity.channelUserId),
      level: "unknown",
      channels: identity.aliases.map((alias) => ({
        channel: identity.channel,
        channelUserId: alias,
      })),
      ...activity,
      neverMessaged: activity.latest == null,
    });
  }

  return rows;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
