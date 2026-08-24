/**
 * Contract between the LinkedIn inbox poller (the producer of opencli sync
 * rows) and whatever persists them. The poller translates `opencli linkedin
 * inbox` / `thread-snapshot` JSON into these plain DTOs and hands them to a
 * `LinkedInSyncSink`; `LinkedInStoreRepository` is the production sink, and
 * tests pass a fake. Keeping the contract here (not in the db layer) lets the
 * poller stay free of any database dependency and makes its unit tests trivial.
 */

export interface LinkedInThreadInput {
  /** LinkedIn thread id — the opaque id inside the messaging thread URL. */
  threadId: string;
  threadUrl: string;
  /** Counterparty display name as the inbox listing reports it. */
  personName?: string | null;
  lastMessagePreview?: string | null;
  /** Timestamp of the thread's latest message per the inbox listing. */
  lastMessageAt?: Date | null;
  unread: boolean;
  /** `member` | `organization` | … as the inbox listing reports it. */
  counterpartyType?: string | null;
  /** LinkedIn inbox categories, e.g. `INBOX,PRIMARY_INBOX`. */
  category?: string | null;
}

export interface LinkedInMessageInput {
  /** LinkedIn message id. Unique within a thread. */
  messageId: string;
  threadId: string;
  sentAt?: Date | null;
  senderName?: string | null;
  senderProfileUrl?: string | null;
  senderHeadline?: string | null;
  /** `member` | `organization` | `agent` | `custom`. */
  senderType?: string | null;
  senderIsSelf: boolean;
  text?: string | null;
  subject?: string | null;
  reactionCount?: number | null;
}

/** One identity in a thread's participant list, per the thread snapshot. */
export interface LinkedInParticipantInput {
  /**
   * LinkedIn member id, bare (`ACoAA…`) — not a urn or a profile URL — so it
   * lines up with `channel_mappings.channel_user_id` for `channel: "linkedin"`.
   */
  participantId: string;
  name?: string | null;
  headline?: string | null;
  /** `member` | `organization` | `agent` | `custom`. */
  type?: string | null;
  /** True for the account owner's own entry in the participant list. */
  isSelf?: boolean;
}

/** One participant of a thread, person-level facts folded in. */
export interface LinkedInParticipantRow {
  participantId: string;
  name: string | null;
  headline: string | null;
  type: string | null;
  isSelf: boolean;
}

/** The per-thread sync watermark the poller compares inbox listings against. */
export interface LinkedInThreadCursor {
  threadId: string;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  lastSyncedAt: Date | null;
}

/** One mirrored message joined with its thread, for the history talk feature. */
export interface LinkedInHistoryMessage {
  messageId: string;
  threadId: string;
  threadName: string | null;
  /** sent_at when LinkedIn reported one, else the mirror's first-seen time. */
  sentAt: Date;
  senderName: string | null;
  senderProfileUrl: string | null;
  senderIsSelf: boolean;
  text: string | null;
  subject: string | null;
}

export interface LinkedInSyncSink {
  upsertThreads(threads: LinkedInThreadInput[]): Promise<void>;
  upsertMessages(messages: LinkedInMessageInput[]): Promise<void>;
  /** Watermarks for the given threads (absent threads are omitted). */
  getThreadCursors(threadIds: string[]): Promise<Map<string, LinkedInThreadCursor>>;
  /** Record a completed thread snapshot (advances `lastSyncedAt`). Metadata
   *  fields update only when known — null means "the snapshot did not say",
   *  never "unset what an earlier snapshot learned". */
  markThreadSynced(
    threadId: string,
    opts: {
      /** The raw conversation title (groups); null for 1:1/untitled/unknown. */
      conversationTitle?: string | null;
      /** LinkedIn's authoritative group flag; null when the snapshot predates it. */
      isGroup?: boolean | null;
      participantCount?: number | null;
    },
  ): Promise<void>;
  /** Mirrored history, newest last; `threadId: null` spans every thread. */
  fetchHistory?(threadId: string | null, since: Date): Promise<LinkedInHistoryMessage[]>;
  /**
   * Replace a thread's membership with exactly `participants` (an empty array
   * empties the thread). Optional: no poller writes participants yet.
   */
  upsertThreadParticipants?(
    threadId: string,
    participants: LinkedInParticipantInput[],
  ): Promise<void>;
}
