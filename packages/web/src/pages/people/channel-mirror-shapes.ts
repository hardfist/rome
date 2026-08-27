// The two conversation mirrors, which are on neither noun of the /people
// contract: a thread is a conversation rather than an account, so nothing here
// reaches a /accounts row.
//
// The LinkedIn mirror has a reader — `./linkedin.tsx`, the one section of the
// People page still on its own endpoints, because a LinkedIn account cannot yet
// be linked to a person. The WhatsApp mirror has none: the People page rebuild
// replaced its section with the channel-blind timeline, and core still serves
// `/api/whatsapp/contacts*` for callers outside this dashboard. Its shapes stay
// so the mock backend keeps standing in for routes that exist.
//
// One definition, read by both the fetch site and the mock that answers it — a
// second copy would let the two drift while both still typecheck.

/** One row of `/api/whatsapp/contacts/:jid/messages`, the WhatsApp mirror's own
 *  message shape. The People page reads the channel-blind timeline instead;
 *  this stays for the mock backend and any surface still on the mirror. */
export interface WhatsAppMessage {
  id: string;
  senderJid: string | null;
  senderName: string | null;
  senderPhoneNumber: string | null;
  fromMe: boolean;
  /** Unix seconds. */
  timestamp: number;
  type: string | null;
  text: string | null;
  hasMedia: boolean;
  pushName: string | null;
  reactsToId: string | null;
}

export interface WhatsAppContact {
  jid: string;
  phoneNumber: string | null;
  name: string | null;
  notify: string | null;
  verifiedName: string | null;
  imgUrl: string | null;
  chatName: string | null;
  isGroup: boolean;
  linkedPersonId: string | null;
  linkedPersonName: string | null;
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  messageCount: number;
}

/** One row of `/api/linkedin/threads`, the LinkedIn inbox mirror. */
export interface LinkedInThread {
  threadId: string;
  threadUrl: string;
  personName: string | null;
  /** Raw group title only — 1:1 threads carry null, never a person's name. */
  conversationName: string | null;
  lastMessagePreview: string | null;
  /** Unix seconds. */
  lastMessageAt: number | null;
  unread: boolean;
  /** LinkedIn's group flag; null until the first snapshot reports it. */
  isGroup: boolean | null;
  participantCount: number | null;
  counterpartyType: string | null;
  category: string | null;
  messageCount: number;
}

/** One row of `/api/linkedin/threads/:threadId/messages`. */
export interface LinkedInMessage {
  messageId: string;
  senderName: string | null;
  senderHeadline: string | null;
  senderProfileUrl: string | null;
  senderIsSelf: boolean;
  /** Unix seconds. */
  timestamp: number;
  text: string | null;
  subject: string | null;
  reactionCount: number | null;
}
