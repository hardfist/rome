import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  linkedinMessages,
  linkedinParticipants,
  linkedinThreadParticipants,
  linkedinThreads,
} from "../schema.js";
import type { DrizzleDb } from "../index.js";
import type {
  LinkedInHistoryMessage,
  LinkedInMessageInput,
  LinkedInParticipantInput,
  LinkedInParticipantRow,
  LinkedInSyncSink,
  LinkedInThreadCursor,
  LinkedInThreadInput,
} from "../../channels/linkedin-sync.js";

const UPSERT_CHUNK = 200;
const HISTORY_READ_LIMIT = 1000;
const THREADS_READ_LIMIT = 10000;

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
      participantCount?: number | null;
    },
  ): Promise<void> {
    const now = new Date();
    // Null metadata means "the snapshot did not say" (an older plugin, an
    // untitled thread), so it never clears what an earlier snapshot learned.
    await this.db
      .update(linkedinThreads)
      .set({
        lastSyncedAt: now,
        updatedAt: now,
        ...(opts.conversationTitle ? { conversationName: opts.conversationTitle } : {}),
        ...(opts.isGroup != null ? { isGroup: opts.isGroup } : {}),
        ...(opts.participantCount != null ? { participantCount: opts.participantCount } : {}),
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
        t.participant_count AS participantCount,
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
    });
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
