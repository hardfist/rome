// The shapes of the endpoints that predate the /people contract: the unmapped
// queue, the curated persons list, and the two conversation mirrors. The People
// page is off all but the LinkedIn mirror, whose threads are conversations
// rather than accounts and reach no /accounts row. Core still serves the rest —
// the WhatsApp mirror backs the chat drawer — so the dashboard's mock backend
// stands in for them and types its fixtures against these.
//
// One definition, read by both the fetch site and the mock that answers it — a
// second copy would let the two drift while both still typecheck.

export interface UnknownSender {
  channel: string;
  channelUserId: string;
  displayName: string | null;
  lastMessage: string | null;
  lastMessageAt: number | null;
}

export interface Person {
  id: string;
  displayName: string;
  bondLevel: string;
  channelMappings: { channel: string; channelUserId: string }[];
}

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
