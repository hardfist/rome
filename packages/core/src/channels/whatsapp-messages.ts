import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import type { Messages } from "./messages.js";
import { inList, scopeColumn, scopeValues, sqlMessages } from "./messages-sql.js";

/**
 * `Messages` over the WhatsApp message mirror (`wa_messages`) — the thread as
 * the channel has it, which is the fullest record of a WhatsApp conversation
 * Rome holds.
 *
 * Scoped by chat either way it is asked. A WhatsApp message hangs off the chat
 * it was said in, and the chat JID is both what names a conversation and what
 * addresses a direct one — so the same `IN` answers both questions, and only
 * what it is allowed to select differs.
 *
 * For an account read, the account's own addresses are the whole scope. A
 * contact reachable both as a phone JID and as a `@lid` JID has a chat under
 * each, and `WhatsAppAccounts` folds both onto one account — so a caller that
 * passes the account's addresses reads one history rather than whichever half
 * its person mapping happened to name.
 *
 * Two things the mirror holds are treated apart from the rest:
 *
 * - Group chats (`@g.us`), which an account read leaves out. A group is
 *   addressed by the group rather than by anyone on it, so no address of an
 *   account names one and the `NOT LIKE` is belt and braces against a group
 *   JID arriving as an address. A conversation read is how a caller asks for
 *   one, and it carries no such condition: the chat named is the chat answered.
 * - Reactions, which neither read carries. A reaction answers a line rather
 *   than being one, and the address book's own activity already leaves it out
 *   of what an account last did. Carrying it would let a directory row preview
 *   a thumbs-up and open on the message it was aimed at, and it is no more a
 *   line of a group's conversation than of a contact's.
 */
export function whatsAppMessages(db: DrizzleDb): Messages {
  return sqlMessages({
    channel: "whatsapp",
    db,
    view(scope) {
      const chats = inList(sql`m.chat_jid`, scopeValues(scope));
      if (chats === null) return null;
      const direct = scope.by === "address" ? sql` AND m.chat_jid NOT LIKE '%@g.us'` : sql``;
      return sql`
        SELECT
          'whatsapp' AS source,
          m.chat_jid AS ${scopeColumn(scope)},
          m.timestamp AS at,
          CASE WHEN m.from_me THEN 1 ELSE 0 END AS outbound,
          m.chat_jid || ':' || m.id AS ref,
          m.text AS body
        FROM wa_messages m
        WHERE ${chats}${direct}
          AND coalesce(m.type, '') <> 'reaction'`;
    },
  });
}
