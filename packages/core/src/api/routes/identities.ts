import { Hono } from "hono";
import { sql } from "drizzle-orm";
import {
  channelIdentityId,
  compareCodePoints,
  compareIdentityRows,
  compareTimelineEntries,
  identityMatchesQuery,
  isAfterTimelineCursor,
  normalizeBondLevel,
  parseIdentityCursor,
  parseIdentityFilterLevel,
  parseIdentityId,
  parseTimelineCursor,
  personIdentityId,
  sliceIdentityPage,
  timelineCursor,
  whatsAppDisplayName,
  TIMELINE_PAGE_DEFAULT_LIMIT,
  TIMELINE_PAGE_MAX_LIMIT,
  type IdentityChannel,
  type IdentityDynamic,
  type IdentityRow,
  type TimelineEntry,
  type TimelinePage,
} from "@rome/api-types/identities";
import { linkedInMemberId } from "../../channels/linkedin-sync.js";
import { STRANGER_PERSON_ID } from "../../constants.js";
import type { ApiDeps } from "../deps.js";

// The People page's two reads. `/identities` is a union of curated persons,
// unmapped senders from the sentinel log, and the mirrored address books
// nobody has placed yet — WhatsApp contacts and LinkedIn participants — every
// row in the shared `IdentityRow` shape and carrying its newest dynamic.
// `/identities/:id/timeline` merges one identity's dynamics across its
// channels. Both are reads — no person row is materialized here, ever; writes
// stay on the `/persons/*` mutation routes.

interface SentinelActivity {
  channel: string;
  channelUserId: string;
  displayName: string | null;
  lastMessage: string | null;
  lastMessageAt: number | null;
  messageCount: number;
}

/**
 * One identity a channel mirror already holds, in the one shape the union
 * reads mirrors through.
 *
 * WhatsApp's address book and LinkedIn's participant table answer the same
 * question — who this account can reach, and what was last said — in their own
 * columns. Projecting both onto this makes every rule below channel-agnostic:
 * adding a third mirror is a branch in {@link readMirror}, not another special
 * case in the union.
 */
interface MirrorIdentity {
  channel: string;
  /** The identifier a mapping or a placement should name — the form the
   *  channel's own `channel_mappings` rows are keyed by. */
  channelUserId: string;
  /** Every identifier this identity answers to, `channelUserId` included. */
  aliases: string[];
  displayName: string;
  /** The person this identity was already promoted into, or null. */
  linkedPersonId: string | null;
  latest: IdentityDynamic | null;
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
    // level, the silent contacts, the cursor, and `?id=` all scope which rows
    // come back while the counts stay whole-union. Pruning the silent ones here
    // instead would answer `neverMessagedTotal: 0` in the very view whose
    // toggle that number is for.
    //
    // A search does reach them: the toggle holds the address books out of the
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

  // One identity's dynamics, merged across its channels, newest first. Entries
  // are generic: a producer fills `{source, timestamp, body, direction, ref}`,
  // so a Rome App that starts contributing history needs no shape change here.
  app.get("/identities/:id/timeline", async (c) => {
    const parsed = parseIdentityId(c.req.param("id"));
    if (!parsed) return c.json({ error: "id must be a person: or channel: identity id" }, 400);

    const channels =
      parsed.kind === "channel"
        ? [{ channel: parsed.channel, channelUserId: parsed.channelUserId }]
        : ((await deps.personMappingRepo.findById(parsed.personId))?.channelMappings ?? null);
    if (channels === null) return c.json({ error: "Unknown person" }, 404);

    const limit = Math.min(
      Math.max(parsePositiveInt(c.req.query("limit")) ?? TIMELINE_PAGE_DEFAULT_LIMIT, 1),
      TIMELINE_PAGE_MAX_LIMIT,
    );
    const rawCursor = c.req.query("cursor");
    const cursor = parseTimelineCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return c.json({ error: "cursor is not a timeline cursor" }, 400);
    }

    // WhatsApp addresses one person by two jids (a phone one and a `@lid`
    // one), and history can sit under either. Resolving the mapping to every
    // alias is what keeps a person mapped to the phone jid from showing an
    // empty timeline while their thread hangs off the lid. LinkedIn's two
    // forms need no such read: a profile URL resolves to its member id by
    // derivation, inside `readChannelWindow`.
    const aliases = channels.some((mapping) => mapping.channel === "whatsapp")
      ? await whatsAppAliases(deps)
      : new Map<string, string[]>();

    // Deduplicated, because one person can hold two aliases of one contact as
    // two mappings — the unique index is per identifier, not per identity —
    // and reading a thread twice would put every one of its entries on the
    // timeline twice.
    const targets = new Map<string, { channel: string; channelUserId: string }>();
    for (const mapping of channels) {
      const ids =
        mapping.channel === "whatsapp"
          ? (aliases.get(mapping.channelUserId) ?? [mapping.channelUserId])
          : [mapping.channelUserId];
      for (const channelUserId of ids) {
        targets.set(activityKey(mapping.channel, channelUserId), {
          channel: mapping.channel,
          channelUserId,
        });
      }
    }

    const reads = await Promise.all(
      [...targets.values()].map((target) => readChannelTimeline(deps, target, { limit, cursor })),
    );

    // Every producer answers with its own newest `limit + 1`, so the merged
    // page is the newest of the union and one producer alone can prove more
    // exists. `saturated` is that proof: without it, a single-channel identity
    // — the common case — could never report a next page, because its own
    // answer is capped at the page size and nothing would ever exceed it.
    const entries = reads.flatMap((read) => read.entries).sort(compareTimelineEntries);
    const saturated = reads.some((read) => read.saturated);
    const page = entries.slice(0, limit);
    const oldest = page.at(-1);
    const body: TimelinePage = {
      entries: page,
      nextCursor:
        (entries.length > page.length || saturated) && oldest ? timelineCursor(oldest) : null,
    };
    return c.json(body);
  });

  return app;
}

/**
 * Every dynamic one channel identity has, newest first, from whichever store
 * holds that channel's history.
 *
 * The WhatsApp and LinkedIn mirrors hold full threads; the sentinel log holds
 * one row per exchange another channel saw — what arrived, and Rome's reply
 * when it made one. A mirrored channel reads its mirror and not the sentinel
 * log, because the sentinel row and the mirrored message are the same message
 * seen twice. Adding a producer is adding a branch here: the entries it
 * returns are already in the generic shape.
 *
 * Reads one row past the page so the caller can tell "this is everything" from
 * "this is a page", and answers `saturated` when it hit that cap.
 *
 * Reads in whole seconds, never part of one. The merged order settles a second
 * on `(direction, source, ref)`, which is not an order any producer can page by
 * in SQL, so a second the cap cuts through leaves entries that no later page
 * can reach: the next read returns the same rows the cap reached, the cursor
 * filter drops every one as already sent, and the timeline ends early. So the
 * cursor's own second is re-read whole and filtered to what follows the cursor,
 * and the oldest second a capped read touched is completed before it is used.
 */
async function readChannelTimeline(
  deps: ApiDeps,
  mapping: { channel: string; channelUserId: string },
  opts: { limit: number; cursor: TimelineEntry | null },
): Promise<{ entries: TimelineEntry[]; saturated: boolean }> {
  const fetchLimit = opts.limit + 1;
  const cursor = opts.cursor;
  const read = (window: { limit: number | null; before?: number; at?: number }) =>
    readChannelWindow(deps, mapping, window);

  const [boundary, capped] = await Promise.all([
    cursor ? read({ limit: null, at: cursor.timestamp }) : null,
    read({ limit: fetchLimit, before: cursor?.timestamp }),
  ]);

  const saturated = capped.rows >= fetchLimit;
  let older = capped.entries;
  if (saturated && older.length > 0) {
    const oldestSecond = Math.min(...older.map((entry) => entry.timestamp));
    const whole = await read({ limit: null, at: oldestSecond });
    older = [...older.filter((entry) => entry.timestamp !== oldestSecond), ...whole.entries];
  }

  const resumed =
    boundary && cursor
      ? boundary.entries.filter((entry) => isAfterTimelineCursor(entry, cursor))
      : [];
  return { entries: [...resumed, ...older], saturated };
}

/** One producer's rows for a timestamp window, projected onto timeline entries.
 *  `rows` counts what the store returned, which is what a cap is measured
 *  against — a sentinel row can carry two entries. */
async function readChannelWindow(
  deps: ApiDeps,
  mapping: { channel: string; channelUserId: string },
  window: { limit: number | null; before?: number; at?: number },
): Promise<{ entries: TimelineEntry[]; rows: number }> {
  if (mapping.channel === "whatsapp") {
    const messages = await deps.whatsAppStoreRepo.getMessages(mapping.channelUserId, window);
    return {
      entries: messages.map((message) => ({
        source: "whatsapp",
        timestamp: message.timestamp,
        body: message.text,
        direction: message.fromMe ? ("outbound" as const) : ("inbound" as const),
        ref: message.id,
      })),
      rows: messages.length,
    };
  }

  // A LinkedIn mapping is written in whichever form the write that created it
  // had, and only the member-id forms can name a mirrored participant. The
  // vanity-URL form — how the guardian's own mapping is conferred at connect
  // time — names none, so it falls through to the sentinel log below, which is
  // where its history actually is.
  const memberId = mapping.channel === "linkedin" ? linkedInMemberId(mapping.channelUserId) : null;
  if (memberId != null) {
    const messages = await deps.linkedInStoreRepo.getParticipantMessages(memberId, window);
    return {
      entries: messages.map((message) => ({
        source: "linkedin",
        timestamp: message.timestamp,
        // An InMail carries its subject apart from its body, and some carry
        // only a subject — the same fold the channel applies on the way in.
        body: message.subject
          ? `${message.subject}\n${message.text ?? ""}`.trim()
          : (message.text ?? null),
        direction: message.senderIsSelf ? ("outbound" as const) : ("inbound" as const),
        // LinkedIn message ids are unique within a thread, not within an
        // account, and this list merges a person's threads — an unqualified id
        // would collide with another thread's and lose one of the pair to the
        // cursor.
        ref: `${message.threadId}:${message.messageId}`,
      })),
      rows: messages.length,
    };
  }

  const beforeClause = window.before != null ? sql`AND created_at < ${window.before}` : sql``;
  const atClause = window.at != null ? sql`AND created_at = ${window.at}` : sql``;
  const limitClause = window.limit == null ? sql`` : sql`LIMIT ${window.limit}`;
  const rows = (await deps.db.all(sql`
    SELECT id, text, response, action, created_at AS createdAt
    FROM sentinel_log
    WHERE channel = ${mapping.channel} AND channel_user_id = ${mapping.channelUserId}
      ${beforeClause} ${atClause}
    ORDER BY created_at DESC
    ${limitClause}
  `)) as Array<{
    id: number | string;
    text: string | null;
    response: string | null;
    action: string | null;
    createdAt: number | null;
  }>;

  const entries: TimelineEntry[] = [];
  for (const row of rows) {
    const timestamp = Number(row.createdAt ?? 0);
    entries.push({
      source: mapping.channel,
      timestamp,
      body: row.text,
      direction: "inbound",
      ref: `sentinel:${row.id}`,
    });
    // A replied row carries what Rome said back. Without it the dossier reads
    // as one side of a conversation Rome was half of.
    if (row.action === "replied" && row.response) {
      entries.push({
        source: mapping.channel,
        timestamp,
        body: row.response,
        direction: "outbound",
        ref: `sentinel:${row.id}:reply`,
      });
    }
  }

  return { entries, rows: rows.length };
}

/**
 * Every jid one WhatsApp identity answers to, keyed by each of them.
 *
 * The address book consolidates a person's phone jid and `@lid` jid into one
 * contact, but a mapping may name either. Reading history for all of them is
 * what keeps the choice of alias out of what the guardian sees.
 */
async function whatsAppAliases(deps: ApiDeps): Promise<Map<string, string[]>> {
  const contacts = await deps.whatsAppStoreRepo.listContacts({ limit: null });
  const byJid = new Map<string, string[]>();
  for (const contact of contacts) {
    const aliases = contact.aliases.length > 0 ? contact.aliases : [contact.jid];
    for (const alias of aliases) byJid.set(alias, aliases);
  }
  return byJid;
}

/**
 * Every identity the channel mirrors already hold, projected onto one shape.
 *
 * Read whole, not through the address-book endpoints' bounds: this answer is
 * paged, and an identity past a cutoff is one the guardian cannot find, that no
 * count includes, and whose alias group the cutoff may have split.
 */
async function readMirror(deps: ApiDeps): Promise<MirrorIdentity[]> {
  const [contacts, participants] = await Promise.all([
    deps.whatsAppStoreRepo.listContacts({ limit: null }),
    deps.linkedInStoreRepo.listParticipants({ limit: null }),
  ]);

  const identities: MirrorIdentity[] = [];
  for (const contact of contacts) {
    // Group chats are conversations, not identities — they cannot hold a bond.
    if (contact.isGroup) continue;
    identities.push({
      channel: "whatsapp",
      channelUserId: contact.jid,
      aliases: contact.aliases.length > 0 ? contact.aliases : [contact.jid],
      displayName: whatsAppDisplayName(contact) ?? contact.jid,
      linkedPersonId: contact.linkedPersonId,
      latest:
        contact.lastMessageAt == null
          ? null
          : {
              source: "whatsapp",
              timestamp: contact.lastMessageAt,
              preview: contact.lastMessagePreview,
            },
      messageCount: contact.messageCount,
    });
  }
  for (const participant of participants) {
    // The account owner is not an identity to place. Their own row sits in
    // every thread they are in, and offering it would put the guardian on the
    // page as a stranger to themselves.
    if (participant.isSelf) continue;
    identities.push({
      channel: "linkedin",
      channelUserId: participant.participantId,
      // One member id, one form. A profile URL naming the same member folds
      // onto it by derivation rather than by a stored alias — see
      // `canonicalId` in the union.
      aliases: [participant.participantId],
      displayName: participant.name ?? participant.participantId,
      linkedPersonId: participant.linkedPersonId,
      latest:
        participant.lastMessageAt == null
          ? null
          : {
              source: "linkedin",
              timestamp: participant.lastMessageAt,
              preview: participant.lastMessagePreview,
            },
      messageCount: participant.messageCount,
    });
  }
  return identities;
}

/** The full union, unordered and unfiltered. */
async function buildIdentityUnion(deps: ApiDeps): Promise<IdentityRow[]> {
  const mirror = await readMirror(deps);
  const mirrorByAlias = new Map<string, MirrorIdentity>();
  for (const identity of mirror) {
    for (const alias of identity.aliases) {
      mirrorByAlias.set(activityKey(identity.channel, alias), identity);
    }
  }

  // One mirrored identity is one identity however many identifiers address it,
  // so every one of them answers to the representative form. Without this the
  // same person is both a curated person (mapped to one form) and an unknown
  // sender (a sentinel row under another) — two rows the page cannot merge and
  // the guardian cannot tell apart.
  //
  // Two channels reach that form two ways. WhatsApp consolidates a phone jid
  // and a `@lid` jid in the store, so the fold is a lookup. LinkedIn's forms —
  // a bare member id and a profile URL carrying one — fold by derivation, so
  // an identifier the mirror has never seen still lands on the right key.
  const canonicalId = (channel: string, channelUserId: string): string => {
    const derived =
      channel === "linkedin" ? (linkedInMemberId(channelUserId) ?? channelUserId) : channelUserId;
    return mirrorByAlias.get(activityKey(channel, derived))?.channelUserId ?? derived;
  };
  const identityKey = (channel: string, channelUserId: string) =>
    activityKey(channel, canonicalId(channel, channelUserId));
  const mirrorFor = (channel: string, channelUserId: string) =>
    mirrorByAlias.get(identityKey(channel, channelUserId));

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

  const sentinel = new Map<string, SentinelActivity[]>();
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
    const key = identityKey(activity.channel, activity.channelUserId);
    const group = sentinel.get(key);
    if (group) group.push(activity);
    else sentinel.set(key, [activity]);
  }

  // The newest word wins across both histories: a channel mirror holds the full
  // thread, the sentinel log holds what every channel saw. Both are read across
  // every alias of the identity, so which identifier a mapping happens to name
  // never decides what the row shows.
  const activityFor = (channel: string, channelUserId: string): ChannelActivity => {
    const key = identityKey(channel, channelUserId);
    const mirrored = mirrorByAlias.get(key);
    const sentinelEntries = sentinel.get(key) ?? [];
    const sentinelDynamic = sentinelEntries.reduce<IdentityDynamic | null>(
      (best, entry) =>
        newer(
          best,
          entry.lastMessageAt == null
            ? null
            : { source: channel, timestamp: entry.lastMessageAt, preview: entry.lastMessage },
        ),
      null,
    );
    const sentinelCount = sentinelEntries.reduce((sum, entry) => sum + entry.messageCount, 0);
    return {
      latest: newer(sentinelDynamic, mirrored?.latest ?? null),
      // The mirror's count when there is one: a mirrored message and the
      // sentinel row that saw it are one message, and adding them would count
      // every exchange twice.
      messageCount: mirrored != null ? mirrored.messageCount : sentinelCount,
    };
  };

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
      const key = activityKey(channel, channelUserId);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ channel, channelUserId });
    };
    for (const channel of channels) {
      add(channel.channel, channel.channelUserId);
      for (const alias of mirrorFor(channel.channel, channel.channelUserId)?.aliases ?? []) {
        add(channel.channel, alias);
      }
    }
    return out;
  };

  /** Best name on record for an identity with no person row: the mirror's name,
   *  then what the sender called themselves, then the raw identifier. */
  const displayNameFor = (channel: string, channelUserId: string): string => {
    const key = identityKey(channel, channelUserId);
    const fromSentinel = (sentinel.get(key) ?? []).reduce<SentinelActivity | null>(
      (best, entry) =>
        best == null || (entry.lastMessageAt ?? 0) > (best.lastMessageAt ?? 0) ? entry : best,
      null,
    );
    return (
      mirrorByAlias.get(key)?.displayName ??
      fromSentinel?.displayName ??
      canonicalId(channel, channelUserId)
    );
  };

  // One statement, so an identity moving between two people mid-read cannot
  // land under both of them.
  const persons = (await deps.personMappingRepo.findAllWithMappings()).sort((a, b) =>
    compareCodePoints(a.id, b.id),
  );
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
  for (const identity of mirror) {
    if (identity.linkedPersonId != null) continue;
    const key = identityKey(identity.channel, identity.channelUserId);
    if (mapped.has(key)) continue;
    mapped.add(key);
    const activity = activityFor(identity.channel, identity.channelUserId);
    rows.push({
      id: channelIdentityId(identity.channel, identity.channelUserId),
      displayName: identity.displayName,
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
