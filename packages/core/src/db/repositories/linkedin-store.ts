import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  linkedinMessages,
  linkedinParticipants,
  linkedinThreadParticipants,
  linkedinThreads,
} from "../schema.js";
import type { DrizzleDb } from "../index.js";
import { linkedInMemberIdFromProfileUrl } from "../../channels/linkedin-sync.js";
import type {
  LinkedInHistoryMessage,
  LinkedInMessageInput,
  LinkedInParticipantInput,
  LinkedInParticipantRow,
  LinkedInSyncSink,
  LinkedInThreadCursor,
  LinkedInThreadInput,
} from "../../channels/linkedin-sync.js";

// The member-id form lives with the poller/store contract, not here: it is the
// identity both sides of the mirror agree on. Re-exported so callers reading
// participant rows reach it from the same module those rows come from.
export { linkedInMemberIdFromProfileUrl };

const UPSERT_CHUNK = 200;
const HISTORY_READ_LIMIT = 1000;
const THREADS_READ_LIMIT = 10000;
const PARTICIPANTS_READ_LIMIT = 10000;

/** One thread row for the People tab's LinkedIn section. */
export interface LinkedInThreadRow {
  threadId: string;
  threadUrl: string;
  personName: string | null;
  /** Raw group title only — never a joined-names fallback. */
  conversationName: string | null;
  lastMessagePreview: string | null;
  /** Unix seconds, or null when the listing carried no timestamp yet. */
  lastMessageAt: number | null;
  unread: boolean;
  /** LinkedIn's group flag; null until the first snapshot reports it. */
  isGroup: boolean | null;
  /**
   * How many people are on the thread, counted from the stored membership —
   * null until that membership has been read authoritatively. Null therefore
   * means "not known yet", never "nobody": a thread only seeded from stored
   * messages has rows but no count, because senders prove who has posted and
   * say nothing about who else is listening.
   */
  participantCount: number | null;
  counterpartyType: string | null;
  category: string | null;
  messageCount: number;
}

/** One message row of `/api/linkedin/threads/:threadId/messages`. */
export interface LinkedInMessageRow {
  messageId: string;
  senderName: string | null;
  senderHeadline: string | null;
  senderProfileUrl: string | null;
  senderIsSelf: boolean;
  /** Unix seconds — sent_at when LinkedIn reported one, else first-seen. */
  timestamp: number;
  text: string | null;
  subject: string | null;
  reactionCount: number | null;
}

/**
 * One mirrored LinkedIn identity, annotated with whether it has been promoted
 * to a curated `persons` entry. `isSelf` rides along rather than being filtered
 * out here: which identities a caller offers for promotion is its own policy,
 * and the guardian's own row is still a real member of the threads it appears
 * in.
 */
export interface LinkedInParticipantContactRow {
  /** Bare LinkedIn member id — the `channelUserId` promotion writes. */
  participantId: string;
  name: string | null;
  headline: string | null;
  type: string | null;
  isSelf: boolean;
  /** How many mirrored threads this identity belongs to. */
  threadCount: number;
  /** The person this identity was promoted into, or null when unpromoted. */
  linkedPersonId: string | null;
  linkedPersonName: string | null;
}

/** One thread's membership paired with the age of the read that produced it. */
export interface LinkedInThreadParticipantSet {
  participants: LinkedInParticipantRow[];
  /** When the membership was last read from LinkedIn; null when never. */
  lastReadAt: Date | null;
}

/** What one backfill pass touched. */
export interface LinkedInParticipantBackfillResult {
  /** Threads seeded — threads already read authoritatively are skipped. */
  threads: number;
  /** Distinct identities the seed proved. */
  participants: number;
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Durable store for the LinkedIn inbox mirror (threads + recent message
 * history). Writes are fed by the inbox poller as a {@link LinkedInSyncSink};
 * reads serve the poller's watermarks and the history talk feature.
 */
export class LinkedInStoreRepository implements LinkedInSyncSink {
  constructor(private db: DrizzleDb) {}

  async upsertThreads(threads: LinkedInThreadInput[]): Promise<void> {
    if (threads.length === 0) return;
    const now = new Date();
    for (const chunk of chunked(threads, UPSERT_CHUNK)) {
      await this.db
        .insert(linkedinThreads)
        .values(
          chunk.map((t) => ({
            threadId: t.threadId,
            threadUrl: t.threadUrl,
            personName: t.personName ?? null,
            lastMessagePreview: t.lastMessagePreview ?? null,
            lastMessageAt: t.lastMessageAt ?? null,
            unread: t.unread,
            counterpartyType: t.counterpartyType ?? null,
            category: t.category ?? null,
            firstSyncedAt: now,
            updatedAt: now,
          })),
        )
        // coalesce(excluded, existing) so a listing row that dropped a field
        // (LinkedIn omits previews for some thread types) never wipes one we
        // already learned. `unread` is a point-in-time flag and always wins.
        .onConflictDoUpdate({
          target: linkedinThreads.threadId,
          set: {
            threadUrl: sql`excluded.thread_url`,
            personName: sql`coalesce(excluded.person_name, person_name)`,
            lastMessagePreview: sql`coalesce(excluded.last_message_preview, last_message_preview)`,
            lastMessageAt: sql`coalesce(excluded.last_message_at, last_message_at)`,
            unread: sql`excluded.unread`,
            counterpartyType: sql`coalesce(excluded.counterparty_type, counterparty_type)`,
            category: sql`coalesce(excluded.category, category)`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
  }

  async upsertMessages(messages: LinkedInMessageInput[]): Promise<void> {
    if (messages.length === 0) return;
    const now = new Date();
    for (const chunk of chunked(messages, UPSERT_CHUNK)) {
      // Unlike WhatsApp's immutable frames, LinkedIn messages can be edited
      // and reactions accrue after delivery, so a re-snapshot refreshes the
      // mutable fields in place. Identity fields keep their first-seen value.
      await this.db
        .insert(linkedinMessages)
        .values(
          chunk.map((m) => ({
            messageId: m.messageId,
            threadId: m.threadId,
            sentAt: m.sentAt ?? null,
            senderName: m.senderName ?? null,
            senderProfileUrl: m.senderProfileUrl ?? null,
            senderHeadline: m.senderHeadline ?? null,
            senderType: m.senderType ?? null,
            senderIsSelf: m.senderIsSelf,
            text: m.text ?? null,
            subject: m.subject ?? null,
            reactionCount: m.reactionCount ?? null,
            createdAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [linkedinMessages.threadId, linkedinMessages.messageId],
          set: {
            text: sql`coalesce(excluded.text, text)`,
            reactionCount: sql`coalesce(excluded.reaction_count, reaction_count)`,
            sentAt: sql`coalesce(excluded.sent_at, sent_at)`,
          },
        });
    }
  }

  async getThreadCursors(threadIds: string[]): Promise<Map<string, LinkedInThreadCursor>> {
    if (threadIds.length === 0) return new Map();
    const cursors = new Map<string, LinkedInThreadCursor>();
    for (const chunk of chunked(threadIds, UPSERT_CHUNK)) {
      const rows = await this.db
        .select({
          threadId: linkedinThreads.threadId,
          lastMessageAt: linkedinThreads.lastMessageAt,
          lastMessagePreview: linkedinThreads.lastMessagePreview,
          lastSyncedAt: linkedinThreads.lastSyncedAt,
        })
        .from(linkedinThreads)
        .where(inArray(linkedinThreads.threadId, chunk));
      for (const row of rows) cursors.set(row.threadId, row);
    }
    return cursors;
  }

  async markThreadSynced(
    threadId: string,
    opts: {
      conversationTitle?: string | null;
      isGroup?: boolean | null;
    },
  ): Promise<void> {
    const now = new Date();
    // Null metadata means "the snapshot did not say" (an older plugin, an
    // untitled thread), so it never clears what an earlier snapshot learned.
    //
    // A snapshot's participant count is deliberately not stored: the count a
    // reader sees is derived from `linkedin_thread_participants`, and taking a
    // second, unverifiable copy from here is exactly what let the two disagree.
    await this.db
      .update(linkedinThreads)
      .set({
        lastSyncedAt: now,
        updatedAt: now,
        ...(opts.conversationTitle ? { conversationName: opts.conversationTitle } : {}),
        ...(opts.isGroup != null ? { isGroup: opts.isGroup } : {}),
      })
      .where(sql`${linkedinThreads.threadId} = ${threadId}`);
  }

  /**
   * The mirrored inbox, newest-conversation-first then by name — the People
   * tab's LinkedIn section. Far simpler than the WhatsApp analog: threads are
   * already one row each, so there is no identity folding to do.
   */
  async listThreads(): Promise<LinkedInThreadRow[]> {
    const rows = (await this.db.all(sql`
      SELECT
        t.thread_id AS threadId,
        t.thread_url AS threadUrl,
        t.person_name AS personName,
        t.conversation_name AS conversationName,
        t.last_message_preview AS lastMessagePreview,
        t.last_message_at AS lastMessageAt,
        t.unread AS unread,
        t.is_group AS isGroup,
        CASE WHEN t.participants_last_read_at IS NULL THEN NULL ELSE (
          SELECT COUNT(*) FROM linkedin_thread_participants tp
          WHERE tp.thread_id = t.thread_id
        ) END AS participantCount,
        t.counterparty_type AS counterpartyType,
        t.category AS category,
        (SELECT COUNT(*) FROM linkedin_messages m WHERE m.thread_id = t.thread_id)
          AS messageCount
      FROM linkedin_threads t
      ORDER BY (t.last_message_at IS NULL) ASC, t.last_message_at DESC,
        lower(coalesce(t.person_name, t.conversation_name, t.thread_id)) ASC
      LIMIT ${THREADS_READ_LIMIT}
    `)) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      threadId: String(r.threadId),
      threadUrl: String(r.threadUrl),
      personName: (r.personName as string | null) ?? null,
      conversationName: (r.conversationName as string | null) ?? null,
      lastMessagePreview: (r.lastMessagePreview as string | null) ?? null,
      lastMessageAt: r.lastMessageAt == null ? null : Number(r.lastMessageAt),
      unread: Boolean(r.unread),
      isGroup: r.isGroup == null ? null : Boolean(r.isGroup),
      participantCount: r.participantCount == null ? null : Number(r.participantCount),
      counterpartyType: (r.counterpartyType as string | null) ?? null,
      category: (r.category as string | null) ?? null,
      messageCount: Number(r.messageCount ?? 0),
    }));
  }

  /** Recent messages for one thread, oldest→newest (newest at the bottom). */
  async getMessages(
    threadId: string,
    opts: { limit?: number; before?: number } = {},
  ): Promise<LinkedInMessageRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const beforeClause =
      opts.before != null ? sql`AND coalesce(m.sent_at, m.created_at) < ${opts.before}` : sql``;
    const rows = (await this.db.all(sql`
      SELECT
        m.message_id AS messageId,
        m.sender_name AS senderName,
        m.sender_headline AS senderHeadline,
        m.sender_profile_url AS senderProfileUrl,
        m.sender_is_self AS senderIsSelf,
        coalesce(m.sent_at, m.created_at) AS timestamp,
        m.text AS text,
        m.subject AS subject,
        m.reaction_count AS reactionCount
      FROM linkedin_messages m
      WHERE m.thread_id = ${threadId} ${beforeClause}
      ORDER BY coalesce(m.sent_at, m.created_at) DESC, m.rowid DESC
      LIMIT ${limit}
    `)) as Array<Record<string, unknown>>;

    return rows
      .map((r) => ({
        messageId: String(r.messageId),
        senderName: (r.senderName as string | null) ?? null,
        senderHeadline: (r.senderHeadline as string | null) ?? null,
        senderProfileUrl: (r.senderProfileUrl as string | null) ?? null,
        senderIsSelf: Boolean(r.senderIsSelf),
        timestamp: Number(r.timestamp),
        text: (r.text as string | null) ?? null,
        subject: (r.subject as string | null) ?? null,
        reactionCount: r.reactionCount == null ? null : Number(r.reactionCount),
      }))
      .reverse();
  }

  /**
   * Replace a thread's participant set with exactly `participants`: identities
   * are upserted into `linkedin_participants`, membership rows are added for
   * everyone in the set, and members no longer in it are dropped. An empty
   * array therefore empties the thread — callers must not pass one for a
   * snapshot that merely failed to report a participant list.
   *
   * The whole replace runs in one transaction, so the set flips as a unit. A
   * failure part-way through would otherwise leave the thread over-inclusive:
   * the new members added, the departed ones never deleted.
   *
   * Identity rows outlive membership: a person dropped from one thread keeps
   * their row for the other threads they are in.
   *
   * The same transaction stamps the thread's `participants_last_read_at`. Every
   * call here IS an authoritative read of the membership, and recording it
   * atomically with the set makes it impossible to claim a read that did not
   * land — or to land a set that then looks like it was never read.
   */
  async upsertThreadParticipants(
    threadId: string,
    participants: LinkedInParticipantInput[],
  ): Promise<void> {
    const now = new Date();
    // Snapshots have been seen to repeat an id; keep the last entry per id so
    // the insert never conflicts with itself inside one statement.
    const unique = new Map(participants.map((p) => [p.participantId, p]));
    const ids = [...unique.keys()];

    await this.db.transaction((tx) => {
      for (const chunk of chunked([...unique.values()], UPSERT_CHUNK)) {
        tx.insert(linkedinParticipants)
          .values(
            chunk.map((p) => ({
              participantId: p.participantId,
              name: p.name ?? null,
              headline: p.headline ?? null,
              type: p.type ?? null,
              isSelf: p.isSelf,
              firstSyncedAt: now,
              updatedAt: now,
            })),
          )
          // coalesce(excluded, existing) for the same reason as threads: a
          // snapshot that omits a field never wipes one an earlier snapshot
          // learned. `is_self` takes the new value verbatim because it
          // describes the viewer rather than the snapshot, which is why the
          // input type makes it required.
          .onConflictDoUpdate({
            target: linkedinParticipants.participantId,
            set: {
              name: sql`coalesce(excluded.name, name)`,
              headline: sql`coalesce(excluded.headline, headline)`,
              type: sql`coalesce(excluded.type, type)`,
              isSelf: sql`excluded.is_self`,
              updatedAt: sql`excluded.updated_at`,
            },
          })
          .run();

        tx.insert(linkedinThreadParticipants)
          .values(
            chunk.map((p) => ({
              threadId,
              participantId: p.participantId,
              firstSyncedAt: now,
            })),
          )
          // Membership carries no mutable facts, so a re-snapshot is a no-op
          // that preserves the original first-seen time.
          .onConflictDoNothing()
          .run();
      }

      // Drop whoever left the thread. Deleting by "not in the new set" rather
      // than clearing first keeps `first_synced_at` intact for those who stayed.
      tx.delete(linkedinThreadParticipants)
        .where(
          ids.length === 0
            ? eq(linkedinThreadParticipants.threadId, threadId)
            : and(
                eq(linkedinThreadParticipants.threadId, threadId),
                notInArray(linkedinThreadParticipants.participantId, ids),
              ),
        )
        .run();

      // The membership is only as good as the read it came from, so the age of
      // that read is stored with it. A no-op when the listing has not created
      // the thread row yet — the next listing will.
      tx.update(linkedinThreads)
        .set({ participantsLastReadAt: now, updatedAt: now })
        .where(eq(linkedinThreads.threadId, threadId))
        .run();
    });
  }

  /**
   * One thread's membership together with when it was read. Prefer this over
   * {@link getThreadParticipants} wherever the answer's authority matters: a
   * null `lastReadAt` means nothing has ever read this thread's membership, so
   * the rows are at best a seed inferred from stored messages.
   */
  async getThreadParticipantSet(threadId: string): Promise<LinkedInThreadParticipantSet> {
    const [participants, rows] = await Promise.all([
      this.getThreadParticipants(threadId),
      this.db
        .select({ participantsLastReadAt: linkedinThreads.participantsLastReadAt })
        .from(linkedinThreads)
        .where(eq(linkedinThreads.threadId, threadId))
        .limit(1),
    ]);
    return { participants, lastReadAt: rows[0]?.participantsLastReadAt ?? null };
  }

  /**
   * Seed the participant tables from messages already mirrored. Every sender
   * the mirror recorded carries their member id inside
   * `linkedin_messages.sender_profile_url`, so an inbox that has been polled
   * for a while already knows most of its participants without a new crawl.
   *
   * Two properties keep the seed honest:
   *   - it is additive (insert-or-ignore, never a delete), because senders
   *     prove presence but their absence proves nothing; and
   *   - it never stamps `participants_last_read_at`, and skips any thread that
   *     already carries one. A real read is authoritative and must not be
   *     re-polluted by a member who has since left but whose messages remain.
   */
  async backfillParticipantsFromMessages(): Promise<LinkedInParticipantBackfillResult> {
    const now = new Date();
    // Newest message last, so a later message's facts win for a given sender.
    const rows = (await this.db.all(sql`
      SELECT
        m.thread_id AS threadId,
        m.sender_profile_url AS senderProfileUrl,
        m.sender_name AS senderName,
        m.sender_headline AS senderHeadline,
        m.sender_type AS senderType,
        m.sender_is_self AS senderIsSelf
      FROM linkedin_messages m
      JOIN linkedin_threads t ON t.thread_id = m.thread_id
      WHERE t.participants_last_read_at IS NULL
        AND m.sender_profile_url IS NOT NULL
      ORDER BY coalesce(m.sent_at, m.created_at) ASC, m.rowid ASC
    `)) as Array<Record<string, unknown>>;

    const identities = new Map<string, LinkedInParticipantInput>();
    const memberships = new Map<string, { threadId: string; participantId: string }>();
    for (const row of rows) {
      const participantId = linkedInMemberIdFromProfileUrl(row.senderProfileUrl as string | null);
      if (!participantId) continue;
      const threadId = String(row.threadId);
      identities.set(participantId, {
        participantId,
        name: (row.senderName as string | null) ?? null,
        headline: (row.senderHeadline as string | null) ?? null,
        type: (row.senderType as string | null) ?? null,
        isSelf: Boolean(row.senderIsSelf),
      });
      memberships.set(`${threadId}\u0000${participantId}`, { threadId, participantId });
    }
    if (memberships.size === 0) return { threads: 0, participants: 0 };

    await this.db.transaction((tx) => {
      for (const chunk of chunked([...identities.values()], UPSERT_CHUNK)) {
        tx.insert(linkedinParticipants)
          .values(
            chunk.map((p) => ({
              participantId: p.participantId,
              name: p.name ?? null,
              headline: p.headline ?? null,
              type: p.type ?? null,
              isSelf: p.isSelf,
              firstSyncedAt: now,
              updatedAt: now,
            })),
          )
          // A sender row is weaker evidence than a participant read, so it only
          // fills gaps: an existing fact — including `is_self`, which a real
          // read answers for the viewer — is left exactly as it was.
          .onConflictDoNothing()
          .run();
      }

      for (const chunk of chunked([...memberships.values()], UPSERT_CHUNK)) {
        tx.insert(linkedinThreadParticipants)
          .values(chunk.map((m) => ({ ...m, firstSyncedAt: now })))
          .onConflictDoNothing()
          .run();
      }
    });

    return {
      threads: new Set([...memberships.values()].map((m) => m.threadId)).size,
      participants: identities.size,
    };
  }

  /**
   * Every stored LinkedIn identity, each row saying whether it has already been
   * promoted to a person. The join is on the member id itself — no translation
   * step — because `linkedin_participants.participant_id` and a `linkedin`
   * `channel_mappings.channel_user_id` are the same identifier by construction.
   *
   * Promotion is a guardian action against these rows, not something this
   * repository performs: a LinkedIn inbox holds many identities that should
   * never enter the curated person graph, so nothing here writes `persons`.
   */
  async listParticipants(): Promise<LinkedInParticipantContactRow[]> {
    const rows = (await this.db.all(sql`
      SELECT
        p.participant_id AS participantId,
        p.name AS name,
        p.headline AS headline,
        p.type AS type,
        p.is_self AS isSelf,
        (SELECT COUNT(*) FROM linkedin_thread_participants tp
           WHERE tp.participant_id = p.participant_id) AS threadCount,
        cm.person_id AS linkedPersonId,
        person.display_name AS linkedPersonName
      FROM linkedin_participants p
      LEFT JOIN channel_mappings cm
        ON cm.channel = 'linkedin' AND cm.channel_user_id = p.participant_id
      LEFT JOIN persons person ON person.id = cm.person_id
      ORDER BY lower(coalesce(p.name, p.participant_id)) ASC, p.participant_id ASC
      LIMIT ${PARTICIPANTS_READ_LIMIT}
    `)) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      participantId: String(r.participantId),
      name: (r.name as string | null) ?? null,
      headline: (r.headline as string | null) ?? null,
      type: (r.type as string | null) ?? null,
      isSelf: Boolean(r.isSelf),
      threadCount: Number(r.threadCount ?? 0),
      linkedPersonId: (r.linkedPersonId as string | null) ?? null,
      linkedPersonName: (r.linkedPersonName as string | null) ?? null,
    }));
  }

  /** One thread's participants with their person-level facts, by member id. */
  async getThreadParticipants(threadId: string): Promise<LinkedInParticipantRow[]> {
    const rows = (await this.db.all(sql`
      SELECT
        tp.participant_id AS participantId,
        p.name AS name,
        p.headline AS headline,
        p.type AS type,
        p.is_self AS isSelf
      FROM linkedin_thread_participants tp
      LEFT JOIN linkedin_participants p ON p.participant_id = tp.participant_id
      WHERE tp.thread_id = ${threadId}
      ORDER BY tp.participant_id ASC
    `)) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      participantId: String(r.participantId),
      name: (r.name as string | null) ?? null,
      headline: (r.headline as string | null) ?? null,
      type: (r.type as string | null) ?? null,
      isSelf: Boolean(r.isSelf),
    }));
  }

  /** The reverse lookup: every thread a participant belongs to. */
  async getParticipantThreadIds(participantId: string): Promise<string[]> {
    const rows = await this.db
      .select({ threadId: linkedinThreadParticipants.threadId })
      .from(linkedinThreadParticipants)
      .where(eq(linkedinThreadParticipants.participantId, participantId))
      .orderBy(linkedinThreadParticipants.threadId);
    return rows.map((r) => r.threadId);
  }

  /**
   * Recent mirrored messages for the history talk feature: a bounded
   * chronological slice (newest `HISTORY_READ_LIMIT` kept, returned oldest
   * first). `threadId: null` spans every thread. Rows without a LinkedIn
   * delivery time order (and filter) by the mirror's first-seen time.
   */
  async fetchHistory(threadId: string | null, since: Date): Promise<LinkedInHistoryMessage[]> {
    const sinceSeconds = Math.floor(since.getTime() / 1000);
    const threadClause = threadId != null ? sql`AND m.thread_id = ${threadId}` : sql``;
    const rows = (await this.db.all(sql`
      SELECT
        m.message_id AS messageId,
        m.thread_id AS threadId,
        coalesce(t.conversation_name, t.person_name) AS threadName,
        coalesce(m.sent_at, m.created_at) AS sentAt,
        m.sender_name AS senderName,
        m.sender_profile_url AS senderProfileUrl,
        m.sender_is_self AS senderIsSelf,
        m.text AS text,
        m.subject AS subject
      FROM linkedin_messages m
      LEFT JOIN linkedin_threads t ON t.thread_id = m.thread_id
      WHERE coalesce(m.sent_at, m.created_at) >= ${sinceSeconds} ${threadClause}
      ORDER BY coalesce(m.sent_at, m.created_at) DESC, m.rowid DESC
      LIMIT ${HISTORY_READ_LIMIT}
    `)) as Array<Record<string, unknown>>;

    return rows
      .map((r) => ({
        messageId: String(r.messageId),
        threadId: String(r.threadId),
        threadName: (r.threadName as string | null) ?? null,
        sentAt: new Date(Number(r.sentAt) * 1000),
        senderName: (r.senderName as string | null) ?? null,
        senderProfileUrl: (r.senderProfileUrl as string | null) ?? null,
        senderIsSelf: Boolean(r.senderIsSelf),
        text: (r.text as string | null) ?? null,
        subject: (r.subject as string | null) ?? null,
      }))
      .reverse();
  }
}
