import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import type { Messages } from "./messages.js";
import { addressesIn, inList, sqlMessages } from "./messages-sql.js";

/**
 * `Messages` over the WhatsApp message mirror (`wa_messages`) — the thread as
 * the channel has it, which is the fullest record of a WhatsApp conversation
 * Rome holds.
 *
 * Scoped by chat: a WhatsApp message hangs off the chat it was said in, and a
 * direct chat is addressed by the contact, so the account's own addresses are
 * the whole scope. A contact reachable both as a phone JID and as a `@lid` JID
 * has a chat under each, and `WhatsAppAccounts` folds both onto one account —
 * so a caller that passes the account's addresses reads one history rather
 * than whichever half its person mapping happened to name.
 *
 * Two things the mirror holds are left out:
 *
 * - Group chats (`@g.us`). A group is addressed by the group rather than by
 *   anyone on it, so no address of an account names one — the `NOT LIKE` is
 *   belt and braces against a group JID arriving as an address.
 * - Reactions. A reaction answers a line rather than being one, and the
 *   address book's own activity already leaves it out of what an account last
 *   did. Carrying it here would let a directory row preview a thumbs-up and
 *   open on the message it was aimed at.
 */
export function whatsAppMessages(db: DrizzleDb): Messages {
  return sqlMessages({
    channel: "whatsapp",
    db,
    view(scope) {
      const addresses = addressesIn(scope);
      const chats = inList(sql`m.chat_jid`, addresses);
      if (chats === null) return null;
      return sql`
        SELECT
          'whatsapp' AS source,
          m.chat_jid AS address,
          m.timestamp AS at,
          CASE WHEN m.from_me THEN 1 ELSE 0 END AS outbound,
          m.chat_jid || ':' || m.id AS ref,
          m.text AS body
        FROM wa_messages m
        WHERE ${chats}
          AND m.chat_jid NOT LIKE '%@g.us'
          AND coalesce(m.type, '') <> 'reaction'`;
    },
  });
}
