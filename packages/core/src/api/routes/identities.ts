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
  type IdentityChannel,
  type IdentityDynamic,
  type IdentityRow,
} from "@rome/api-types/identities";
import { STRANGER_PERSON_ID } from "../../constants.js";
import type { TalkAccountActivity } from "../../channels/account-activity.js";
import type { TalkAccounts } from "../../channels/accounts.js";
import type { ApiDeps } from "../deps.js";

// The People page's one read: a union of curated persons, unmapped senders from
// the sentinel log, and the WhatsApp contacts nobody has placed yet, every row
// in the shared `IdentityRow` shape and carrying its newest dynamic. A read —
// no person row is materialized here, ever; writes stay on the `/persons/*`
// mutation routes.

interface SentinelActivity {
  channel: string;
  channelUserId: string;
  displayName: string | null;
  lastMessage: string | null;
  lastMessageAt: number | null;
  messageCount: number;
}

/**
 * One identity a channel's account plane already holds, in the shape the union
 * reads every mirror through.
 *
 * The projection is `Account` plus its activity, and nothing channel-specific
 * survives it: which addressings a channel hands out, which of them is
 * canonical, and what counts as an account at all are the channel's answers,
 * given once behind {@link TalkAccounts}. So every rule below is
 * channel-agnostic, and adding a mirror is an entry in {@link mirrorPlanes}
 * rather than another special case in the union.
 */
interface MirrorIdentity {
  channel: string;
  /** The account's own address — what a mapping or a placement should name. */
  channelUserId: string;
  /** Every address the account answers to, `channelUserId` included. */
  aliases: string[];
  /** What the channel calls the account, or null when it holds no name. */
  name: string | null;
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

/** A channel whose account plane the union reads. One entry per mirror. */
interface MirrorPlane {
  channel: string;
  accounts: TalkAccounts & TalkAccountActivity;
}

function mirrorPlanes(deps: ApiDeps): MirrorPlane[] {
  return [{ channel: "whatsapp", accounts: deps.whatsAppAccounts }];
}

/**
 * One page big enough to hold any listing — what `TalkAccounts.listAccounts`
 * says to ask for when a caller needs every account exactly once. Its order is
 * stable but the listing under it is not, so walking cursors across a live
 * mirror would skip or repeat an account as an inbound message reordered it.
 */
const WHOLE_LISTING = Number.MAX_SAFE_INTEGER;

/**
 * Every identity the channel mirrors already hold, projected onto one shape.
 *
 * Read whole rather than paged: this answer is paged here, and an identity past
 * a channel's own cutoff is one the guardian cannot find and no count includes.
 */
async function readMirrors(deps: ApiDeps): Promise<MirrorIdentity[]> {
  const identities: MirrorIdentity[] = [];
  for (const { channel, accounts } of mirrorPlanes(deps)) {
    const [listing, activity, addresses] = await Promise.all([
      accounts.listAccounts({ limit: WHOLE_LISTING }),
      accounts.listActivity(),
      accounts.listAddresses(),
    ]);

    // The addressing set of each account, which is the address map read the
    // other way round. A row carries all of them because a search reads them:
    // an omitted address is a contact the guardian cannot reach by the phone
    // number they know.
    const aliasesOf = new Map<string, string[]>();
    for (const [address, accountId] of addresses) {
      const group = aliasesOf.get(accountId);
      if (group) group.push(address);
      else aliasesOf.set(accountId, [address]);
    }

    for (const account of listing.accounts) {
      const seen = activity.get(account.id);
      identities.push({
        channel,
        channelUserId: account.id,
        aliases: (aliasesOf.get(account.id) ?? [account.id]).sort(compareCodePoints),
        name: account.name,
        latest:
          seen == null
            ? null
            : { source: channel, timestamp: seen.lastMessageAt, preview: seen.lastMessagePreview },
        messageCount: seen?.messageCount ?? 0,
      });
    }
  }
  return identities;
}

/** The full union, unordered and unfiltered. */
async function buildIdentityUnion(deps: ApiDeps): Promise<IdentityRow[]> {
  const mirror = await readMirrors(deps);
  const mirrorByAlias = new Map<string, MirrorIdentity>();
  for (const identity of mirror) {
    for (const alias of identity.aliases) {
      mirrorByAlias.set(activityKey(identity.channel, alias), identity);
    }
  }

  // One mirrored identity is one identity however many addresses reach it, so
  // every one of them answers to the account's own. Without this the same
  // person is both a curated person (mapped to one form) and an unknown sender
  // (a sentinel row under another) — two rows the page cannot merge and the
  // guardian cannot tell apart.
  //
  // Which addresses fold onto which account is the channel's answer, not a
  // rule the union derives: it is the address map read as given.
  const canonicalId = (channel: string, channelUserId: string): string =>
    mirrorByAlias.get(activityKey(channel, channelUserId))?.channelUserId ?? channelUserId;
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

  /** Best name on record for an identity with no person row: the channel's own
   *  name for it, then what the sender called themselves, then the raw
   *  identifier. */
  const displayNameFor = (channel: string, channelUserId: string): string => {
    const key = identityKey(channel, channelUserId);
    const fromSentinel = (sentinel.get(key) ?? []).reduce<SentinelActivity | null>(
      (best, entry) =>
        best == null || (entry.lastMessageAt ?? 0) > (best.lastMessageAt ?? 0) ? entry : best,
      null,
    );
    return (
      mirrorByAlias.get(key)?.name ??
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
