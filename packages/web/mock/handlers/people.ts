import { http, HttpResponse } from "msw";
import { talkConnections } from "./connections-store";
import {
  generatePersonSlug,
  nextAvailablePersonId,
  STRANGER_PERSON_DISPLAY_NAME,
  STRANGER_PERSON_ID,
  protectedPersonReason,
} from "@rome/api-types/persons";
import {
  channelIdentityId,
  compareIdentityRows,
  compareTimelineEntries,
  identityMatchesQuery,
  isAfterTimelineCursor,
  isAssignableBondLevel,
  latestDynamic,
  compareCodePoints,
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
  type IdentityRow,
  type TimelineEntry,
  type TimelinePage,
} from "@rome/api-types/identities";
import {
  countPeople,
  comparePeople,
  parsePersonFilterLevel,
  personMatchesLevel,
  personMatchesQuery,
  type PeopleList,
  type PersonResource,
} from "@rome/api-types/people";
import type {
  LinkedInMessage,
  LinkedInThread,
  Person as PeoplePerson,
  UnknownSender,
  WhatsAppContact,
  WhatsAppMessage,
} from "@/pages/people/legacy-api-shapes";

/**
 * The People tab: `/api/identities` — the union the page reads — plus the
 * writes that move an identity along the bond ladder, over the same in-memory
 * store the legacy `/api/persons*` and `/api/whatsapp/contacts` endpoints are
 * served from. One store, so a move made through the new page is visible to
 * every other surface reading the old endpoints.
 *
 * `/api/people` is served from the same store, projected into the people
 * contract by `buildPeople`. The composer's mention list reads it; only the
 * People page's own reads and writes still speak `/api/persons`, which is what
 * that route is left alive for.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Fixture clock, in epoch **seconds** — the unit both `sentinel_log.created_at`
 * (a drizzle `mode: "timestamp"` column) and `wa_messages.timestamp` are stored
 * in, and the unit every reader on this page multiplies back up by 1000.
 *
 * Relative, because the page computes each "8m ago", day separator and clock
 * time against the browser's real clock. Literal dates would decay into a
 * thread whose every message reads as months old and whose separators all
 * collapse onto one day.
 */
const secondsAgo = (offset: number): number => Math.floor(Date.now() / 1000) - offset;

/** Local midnight this morning, in epoch seconds. */
const startOfToday = (): number => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return Math.floor(midnight.getTime() / 1000);
};

/**
 * A time on yesterday's local calendar day.
 *
 * The Today/Yesterday separator is a calendar comparison, not an elapsed-time
 * one, so a relative offset cannot express "yesterday": `secondsAgo(DAY + 5h)`
 * is 29 hours back, which lands two calendar days ago whenever the page is
 * opened before 05:00. Anchoring to midnight makes the branch hold at every
 * hour rather than most of them.
 */
const yesterdayAt = (hour: number, minute = 0): number =>
  startOfToday() - DAY + hour * HOUR + minute * MINUTE;

/**
 * `offset` seconds ago, but never earlier than this morning.
 *
 * The clamp is what keeps the other side of the separator honest just after
 * midnight, when "40 minutes ago" would otherwise still be yesterday and the
 * thread would render one group and no separator at all.
 */
const todayAt = (offset: number): number => Math.max(secondsAgo(offset), startOfToday() + MINUTE);

const RAY_JID = "14155550142@s.whatsapp.net";
const MIRA_JID = "14155550188@s.whatsapp.net";
const DEV_JID = "447700900812@s.whatsapp.net";
const PHONE_ONLY_JID = "14085551190@s.whatsapp.net";
const CLINIC_JID = "12065550117@s.whatsapp.net";
const QUIET_JID = "6598023311@s.whatsapp.net";
const QUIET_CJK_JID = "8613800138000@s.whatsapp.net";
const HIKES_JID = "120363041948572901@g.us";

/** Devika is the one person three surfaces describe at once — the unmapped
 *  queue, the contact card and the thread — because she is an unmapped sender on
 *  a synced channel. Production feeds all three from one message and one push
 *  name, so they read them from here. Her contact row needs no entry of its own:
 *  it projects off the thread. */
const DEVIKA_NAME = "Devika";
const DEVIKA_LATEST = { text: "Are you going on Saturday?", at: 3 * HOUR };

/** The curated graph's row, typed against the People page's `/api/persons`
 *  decode. `buildPeople` projects the same row into `PersonResource`, so a
 *  fixture that drops a field breaks whichever surface reads it. */
type PersonFixture = PeoplePerson;

/**
 * What a contact row actually stores: address-book facts, and nothing derived.
 *
 * The five omitted fields are all projections on the real API — the identity
 * pair is a join onto `channel_mappings`, and the summary trio is a subquery
 * over `wa_messages`. Storing any of them here would let a link or a send leave
 * the card disagreeing with the thread behind it, which is the one thing these
 * fixtures exist to keep honest.
 */
type WhatsAppContactRow = Omit<
  WhatsAppContact,
  "linkedPersonId" | "linkedPersonName" | "lastMessageAt" | "lastMessagePreview" | "messageCount"
>;

// The curated graph. Bond levels are chosen to cover each branch the page
// takes on them rather than to look like a plausible address book.
const persons: PersonFixture[] = [
  {
    // The guardian. `/api/bootstrap` reports `phase: "ready"`, and the only
    // route to that phase inserts this row, so a persons payload without it is
    // a state the instance cannot be in. It is also the only fixture that
    // reaches the guardian bond styling and the mention list's guardian
    // exclusion. Id and name track the `/api/auth/me` fixture, since onboarding
    // slugs the id from the name it was given.
    id: "mock-guardian",
    displayName: "Mock Guardian",
    bondLevel: "guardian",
    channelMappings: [],
  },
  {
    id: "ray-oster",
    displayName: "Ray Oster",
    bondLevel: "inner-circle",
    // Two channels, one of them WhatsApp: the card's WhatsApp pill is a button
    // that opens the thread, so this is the only person row that reaches the
    // messages dialog from the known-people section.
    channelMappings: [
      { channel: "telegram", channelUserId: "418820113" },
      { channel: "whatsapp", channelUserId: RAY_JID },
    ],
  },
  {
    id: "mira-chen",
    displayName: "Mira Chen",
    bondLevel: "acquaintance",
    channelMappings: [{ channel: "whatsapp", channelUserId: MIRA_JID }],
  },
  {
    id: "hollis-park",
    displayName: "Hollis Park",
    bondLevel: "other",
    channelMappings: [{ channel: "discord", channelUserId: "284417003118395393" }],
  },
  {
    // A bond level outside the three the create form offers. The column is free
    // text and older rows carry values like this one, so the page has to bucket
    // it under "other" and fall back to that styling rather than render a blank
    // pill and drop the row from every filter.
    id: "sam-okafor",
    displayName: "Sam Okafor",
    bondLevel: "colleague",
    channelMappings: [{ channel: "webchat", channelUserId: "wc-8842" }],
  },
  {
    // Created by hand and never linked to a channel — the card's "no channels"
    // line, which is otherwise unreachable once every person arrives through a
    // sender promotion.
    id: "nadia-petrova",
    displayName: "Nadia Petrova",
    bondLevel: "inner-circle",
    channelMappings: [],
  },
  {
    // The sentinel row core seeds at boot, carrying one already-dismissed
    // sender. `/api/persons` returns it and the page filters it back out, while
    // `/api/people` withholds it — it is here to keep both honest, not to be
    // looked at.
    id: STRANGER_PERSON_ID,
    displayName: STRANGER_PERSON_DISPLAY_NAME,
    bondLevel: "other",
    channelMappings: [{ channel: "telegram", channelUserId: "770144238" }],
  },
];

// Senders seen in `sentinel_log`. The endpoint is the half of these with no
// row in `channel_mappings`, so this list is the raw log and the join runs in
// the handler — that is what makes create, link and mark-stranger take a card
// off the queue instead of leaving it there until a reload.
/** The log row, plus what Rome said back when it replied — `sentinel_log`
 *  records both halves of an exchange, and the timeline renders both. */
type SentinelRow = UnknownSender & {
  reply?: string;
  /** This log row's own id. A timeline `ref` has to be unique across
   *  everything one source contributes to a person, and one channel
   *  identity can hold several log rows, so the refs key on this rather
   *  than on the channel identity those rows share. */
  logId: string;
};

const sentinelSenders: SentinelRow[] = (
  [
    {
      channel: "telegram",
      channelUserId: "883104221",
      displayName: "Jules Marchetti",
      lastMessage: "hey — is this the right number for the Thursday thing?",
      lastMessageAt: secondsAgo(8 * MINUTE),
      // The one row Rome answered: the dossier shows an exchange rather than
      // half of one, which is the only place an outbound sentinel entry renders.
      reply: "It is — Thursday at 6 still works.",
    },
    {
      // The WhatsApp half of the queue, and the one row another surface can
      // contradict: this is the same message the mirror holds, recorded by the
      // sentinel as it arrived. An unmapped sender on a synced channel shows up
      // in both sections, so both read it from one place.
      channel: "whatsapp",
      channelUserId: DEV_JID,
      displayName: DEVIKA_NAME,
      lastMessage: DEVIKA_LATEST.text,
      lastMessageAt: secondsAgo(DEVIKA_LATEST.at),
    },
    {
      // Neither a name nor text: the sentinel logged an inbound the channel gave
      // nothing else for. The card falls back to "Unknown sender" and drops its
      // quote entirely. On a channel with no mirror behind it on purpose — this
      // is the one row nothing else can be asked to agree with.
      channel: "telegram",
      channelUserId: "5514420983",
      displayName: null,
      lastMessage: null,
      lastMessageAt: secondsAgo(6 * HOUR),
    },
    {
      channel: "discord",
      channelUserId: "612884320117522433",
      displayName: "kev_4410",
      lastMessage: "saw your post about the rome setup, mind if I ask a couple questions?",
      lastMessageAt: secondsAgo(2 * DAY),
    },
    {
      // A channel the page has no pill styling for. It renders the raw channel
      // name in the fallback pill, which is the branch every channel added after
      // the page was written lands in.
      channel: "feishu",
      channelUserId: "ou_9f21c04ab7",
      displayName: "林晓",
      lastMessage: "会议纪要已经发到群里了",
      lastMessageAt: secondsAgo(5 * DAY),
    },
    {
      // A second log row for 林晓, newer than the one above. The log keys on the
      // exchange rather than the sender, so one identity can hold several — and
      // a reader that takes the first would preview an older line than the one
      // sitting at the top of this identity's own timeline.
      channel: "feishu",
      channelUserId: "ou_9f21c04ab7",
      displayName: "林晓",
      lastMessage: "另外周五的场地换到 3 楼了",
      lastMessageAt: secondsAgo(2 * DAY),
    },
    {
      // A WhatsApp arrival the sentinel logged before the mirror synced the
      // chat: no contact row, no thread. The only fixture where the sentinel is
      // the sole record of a WhatsApp exchange, which is what keeps the
      // mirror-first branch from dropping it.
      channel: "whatsapp",
      channelUserId: "5511987654321@s.whatsapp.net",
      displayName: null,
      lastMessage: "oi, tudo bem? vi seu contato no grupo",
      lastMessageAt: secondsAgo(21 * MINUTE),
    },
    {
      // Already marked a stranger. Present in the log, absent from the queue —
      // the join is what hides it, and a mark-stranger write is what put it here.
      channel: "telegram",
      channelUserId: "770144238",
      displayName: null,
      lastMessage: "CLAIM YOUR PRIZE >>",
      lastMessageAt: secondsAgo(9 * DAY),
    },
  ] as Omit<SentinelRow, "logId">[]
).map((row, index) => ({ ...row, logId: `log-${index}` }));

// The WhatsApp address book. Unordered: the handler sorts, because the order
// the repository returns depends on the summary fields it projects.
const whatsappContacts: WhatsAppContactRow[] = [
  {
    jid: RAY_JID,
    phoneNumber: "14155550142",
    name: "Ray Oster",
    notify: "Ray",
    verifiedName: null,
    imgUrl: null,
    chatName: null,
    isGroup: false,
  },
  {
    // Named only by `notify` — the push name WhatsApp attaches to a message
    // from someone who isn't in the address book. Same person as the unmapped
    // WhatsApp sender above, which is how the two sections agree: an unknown
    // sender on a synced channel shows up in both.
    jid: DEV_JID,
    phoneNumber: "447700900812",
    name: null,
    notify: DEVIKA_NAME,
    verifiedName: null,
    imgUrl: null,
    chatName: null,
    isGroup: false,
  },
  {
    // A group: no contact row behind it, so the name comes off the chat and the
    // subtitle says so rather than showing a phone number the jid doesn't have.
    jid: HIKES_JID,
    phoneNumber: null,
    name: null,
    notify: null,
    verifiedName: null,
    imgUrl: null,
    chatName: "Sunday hikes",
    isGroup: true,
  },
  {
    jid: MIRA_JID,
    phoneNumber: "14155550188",
    name: "Mira Chen",
    notify: null,
    verifiedName: null,
    imgUrl: null,
    chatName: null,
    isGroup: false,
  },
  {
    // Nothing but a number. Every name field is empty, so the card falls all
    // the way through to the formatted phone — and so does its thread's one
    // bubble, which is the only sender here the address book cannot name.
    jid: PHONE_ONLY_JID,
    phoneNumber: "14085551190",
    name: null,
    notify: null,
    verifiedName: null,
    imgUrl: null,
    chatName: null,
    isGroup: false,
  },
  {
    // Two contacts nobody has ever said anything to, and nobody has ever heard
    // from: the address book's quiet thousands, in miniature. They stay out of
    // the stream, which carries only the accounts something has happened on,
    // and the contacts list holds them like any other account.
    jid: QUIET_JID,
    phoneNumber: "6598023311",
    name: "Jonas Tan",
    notify: null,
    verifiedName: null,
    imgUrl: null,
    chatName: null,
    isGroup: false,
  },
  {
    jid: QUIET_CJK_JID,
    phoneNumber: "8613800138000",
    name: "李阿姨 Li Ayi",
    notify: null,
    verifiedName: null,
    imgUrl: null,
    chatName: null,
    isGroup: false,
  },
  {
    // A business, synced from the address book but never messaged: no time
    // label, no preview, and an empty thread behind the messages button.
    jid: CLINIC_JID,
    phoneNumber: "12065550117",
    name: null,
    notify: null,
    verifiedName: "Foothill Dental",
    imgUrl: null,
    chatName: null,
    isGroup: false,
  },
];

const guardianText = (id: string, text: string, timestamp: number): WhatsAppMessage => ({
  id,
  senderJid: null,
  senderName: null,
  senderPhoneNumber: null,
  fromMe: true,
  timestamp,
  type: "text",
  text,
  hasMedia: false,
  pushName: null,
  reactsToId: null,
});

/** `text` is null for a media message: WhatsApp sends the caption there, and an
 *  uncaptioned photo has none. */
const theirText = (
  id: string,
  contact: { jid: string; name: string | null; phone: string | null },
  text: string | null,
  timestamp: number,
  extra: Partial<WhatsAppMessage> = {},
): WhatsAppMessage => ({
  id,
  senderJid: contact.jid,
  senderName: contact.name,
  senderPhoneNumber: contact.phone,
  fromMe: false,
  timestamp,
  type: "text",
  text,
  hasMedia: false,
  pushName: contact.name,
  reactsToId: null,
  ...extra,
});

const RAY = { jid: RAY_JID, name: "Ray Oster", phone: "14155550142" };
const MIRA = { jid: MIRA_JID, name: "Mira Chen", phone: "14155550188" };
const DEVIKA = { jid: DEV_JID, name: DEVIKA_NAME, phone: "447700900812" };
/** The unsaved number. `senderName` is a coalesce over the sender's `wa_contacts`
 *  row, and this jid's row has every name field empty, so the real query returns
 *  null here — a labelled sender would be a row the API cannot produce. The
 *  thread's bubbles fall back to the formatted phone, same as its card. */
const UNSAVED = { jid: PHONE_ONLY_JID, name: null, phone: "14085551190" };

// Threads, oldest first — the order the route hands back after its own reverse.
// Ray's runs across two days and carries a reaction and an attachment, so the
// dialog's date separators, reaction badges and media placeholder all render
// off real data instead of only in a screenshot somewhere.
const threads: Record<string, WhatsAppMessage[]> = {
  [RAY_JID]: [
    theirText("wa-ray-1", RAY, "did the sensor box ever turn up?", yesterdayAt(11, 20)),
    guardianText(
      "wa-ray-2",
      "yesterday, yeah. one of the cables was missing though",
      yesterdayAt(12, 20),
    ),
    theirText("wa-ray-3", RAY, "ugh. I have a spare, I'll bring it", yesterdayAt(12, 32)),
    theirText("wa-ray-4", RAY, null, yesterdayAt(13, 20), {
      type: "image",
      hasMedia: true,
    }),
    guardianText("wa-ray-5", "that's the one 🙏", yesterdayAt(13, 24)),
    theirText("wa-ray-6", RAY, "👍", yesterdayAt(13, 25), {
      type: "reaction",
      reactsToId: "wa-ray-5",
    }),
    guardianText("wa-ray-7", "still ok for thursday at 6?", todayAt(40 * MINUTE)),
    theirText("wa-ray-8", RAY, "yep, I'll come straight from the shop", todayAt(25 * MINUTE)),
    guardianText("wa-ray-9", "perfect, see you then", todayAt(22 * MINUTE)),
  ],
  [DEV_JID]: [
    theirText(
      "wa-dev-1",
      DEVIKA,
      "Hi! Got your number from the climbing group 👋",
      secondsAgo(DEVIKA_LATEST.at + 40),
    ),
    theirText("wa-dev-2", DEVIKA, DEVIKA_LATEST.text, secondsAgo(DEVIKA_LATEST.at)),
  ],
  // A group thread: consecutive messages from different people, which is the
  // only case where the dialog labels a bubble with its sender.
  [HIKES_JID]: [
    theirText("wa-hike-1", MIRA, "weather looks fine for sunday", secondsAgo(6 * HOUR)),
    theirText("wa-hike-2", RAY, "I can drive, 3 spare seats", secondsAgo(6 * HOUR - 8 * MINUTE)),
    guardianText("wa-hike-3", "put me down for one", secondsAgo(6 * HOUR - 20 * MINUTE)),
    theirText("wa-hike-4", MIRA, "same!", secondsAgo(6 * HOUR - 24 * MINUTE)),
  ],
  [MIRA_JID]: [
    guardianText("wa-mira-1", "sent you the notes from friday", secondsAgo(2 * DAY + HOUR)),
    theirText("wa-mira-2", MIRA, "thanks for sending that over", secondsAgo(2 * DAY)),
  ],
  [PHONE_ONLY_JID]: [
    theirText(
      "wa-unsaved-1",
      UNSAVED,
      "Your appointment is confirmed for Tuesday at 10:15.",
      secondsAgo(11 * DAY),
    ),
  ],
  // CLINIC_JID has no entry on purpose: a contact synced from the address book
  // with nothing ever said. The dialog's empty thread, not a load failure.
};

/** The repository's tiebreaker for two contacts with the same last-message
 *  time: the first name field that has anything in it, lower-cased. Distinct
 *  from the page's own display choice, which is a rendering decision made
 *  against the same fields. */
function displayNameOf(contact: WhatsAppContactRow): string {
  return (
    contact.name ??
    contact.notify ??
    contact.verifiedName ??
    contact.chatName ??
    contact.phoneNumber ??
    contact.jid
  ).toLowerCase();
}

/**
 * A contact's summary trio, projected from its thread the way the repository's
 * subqueries do.
 *
 * Reactions are emoji pinned to another message rather than a line of their
 * own, so they are excluded from the preview and its timestamp — but not from
 * `messageCount`, which the repository takes as a plain `COUNT(*)` over the
 * chat.
 */
function summarize(
  jid: string,
): Pick<WhatsAppContact, "lastMessageAt" | "lastMessagePreview" | "messageCount"> {
  const thread = threads[jid] ?? [];
  // `>`, not `>=`: the repository orders by `timestamp DESC, rowid DESC`, so
  // the last row inserted wins a tie. Threads here are append-ordered, which
  // makes the later element the higher rowid. Reachable rather than
  // theoretical — sends stamp whole seconds, so two in the same second tie.
  const newest = thread
    .filter((message) => message.type !== "reaction")
    .reduce<WhatsAppMessage | null>(
      (latest, message) => (latest && latest.timestamp > message.timestamp ? latest : message),
      null,
    );
  return {
    lastMessageAt: newest?.timestamp ?? null,
    lastMessagePreview: newest?.text ?? null,
    messageCount: thread.length,
  };
}

/** The person a channel identity currently maps to, or `undefined` while it is
 *  still unmapped. The `channel_mappings` lookup both the unknown-sender query
 *  and the contacts join run. */
function ownerOf(channel: string, channelUserId: string): PersonFixture | undefined {
  return persons.find((person) =>
    person.channelMappings.some(
      (mapping) => mapping.channel === channel && mapping.channelUserId === channelUserId,
    ),
  );
}

/**
 * The id `POST /persons/create` mints, over the in-memory store. Both the slug
 * and the collision rule come from the shared derivation; all this adds is the
 * set of ids to resolve against, which is the one thing the two sides cannot
 * share — the repository resolves against the rows it queries, this against the
 * rows it holds.
 *
 * A name that slugs to nothing gets a uuid on the real route.
 * `crypto.randomUUID` is the browser's equivalent of core's `uuid()`.
 */
function nextPersonId(displayName: string): string {
  const base = generatePersonSlug(displayName);
  if (!base) return crypto.randomUUID();
  return nextAvailablePersonId(
    base,
    persons.map((person) => person.id),
  );
}

/**
 * The route's rejection for a request missing a required field, wording
 * included: the page puts a 4xx `error` body straight on the card, so the copy
 * is the contract here, not the status alone. Core writes these as an Oxford
 * list — "a and b", "a, b, and c".
 */
const missingFields = (fields: string[]) => {
  const list =
    fields.length < 3
      ? fields.join(" and ")
      : `${fields.slice(0, -1).join(", ")}, and ${fields.at(-1)}`;
  return HttpResponse.json({ error: `${list} are required` }, { status: 400 });
};

/** What the account's own platform calls it, then the name its sender put on a
 *  message, then the address itself — the order `DirectoryAccount.displayName`
 *  and `LinkedAccount.displayName` both name. Never the linked person's name. */
function nameForAccount(channel: string, channelUserId: string): string {
  const contact =
    channel === "whatsapp"
      ? whatsappContacts.find((candidate) => candidate.jid === channelUserId)
      : undefined;
  const sender = sentinelSenders.find(
    (s) => s.channel === channel && s.channelUserId === channelUserId,
  );
  return (contact ? whatsAppDisplayName(contact) : null) ?? sender?.displayName ?? channelUserId;
}

export function buildIdentities(): IdentityRow[] {
  const rows: IdentityRow[] = [];
  const mapped = new Set<string>();
  const contactByJid = new Map(whatsappContacts.map((contact) => [contact.jid, contact]));
  const key = (channel: string, channelUserId: string) => `${channel}\n${channelUserId}`;

  /**
   * How many records the producers hold for one channel identity — reactions
   * and replies included, because the field counts history rather than rendered
   * entries.
   */
  const messageCountFor = (channel: string, channelUserId: string): number => {
    const contact = channel === "whatsapp" ? contactByJid.get(channelUserId) : undefined;
    if (contact) return summarize(contact.jid).messageCount;
    return sentinelSenders
      .filter((s) => s.channel === channel && s.channelUserId === channelUserId)
      .reduce((total, s) => total + (s.reply ? 2 : 1), 0);
  };

  /**
   * A row's activity.
   *
   * `latest` is the head of the row's own timeline rather than a separately
   * computed maximum. The two orderings settle a same-second tie differently —
   * the timeline on direction and `ref`, a dynamic on `source` and `preview` —
   * so computing them apart lets a row preview one event while its timeline
   * opens on another. Deriving one from the other makes that unrepresentable.
   */
  const activityForChannels = (channels: IdentityChannel[]) => {
    return {
      messageCount: channels.reduce(
        (total, mapping) => total + messageCountFor(mapping.channel, mapping.channelUserId),
        0,
      ),
      latest: latestDynamic(timelineForChannels(channels)),
    };
  };

  for (const person of persons) {
    for (const mapping of person.channelMappings) {
      mapped.add(key(mapping.channel, mapping.channelUserId));
    }

    if (person.id === STRANGER_PERSON_ID) {
      for (const head of person.channelMappings) {
        const group = [head];
        rows.push({
          id: channelIdentityId(head.channel, head.channelUserId),
          displayName: nameForAccount(head.channel, head.channelUserId),
          level: "stranger",
          channels: group,
          ...activityForChannels(group),
          neverMessaged: false,
        });
      }
      continue;
    }

    const channels = person.channelMappings;
    rows.push({
      id: personIdentityId(person.id),
      displayName: person.displayName,
      level: person.bondLevel === "guardian" ? "guardian" : normalizeBondLevel(person.bondLevel),
      channels,
      ...activityForChannels(channels),
      neverMessaged: false,
    });
  }

  for (const sender of sentinelSenders) {
    const k = key(sender.channel, sender.channelUserId);
    if (mapped.has(k)) continue;
    mapped.add(k);
    const senderGroup = [{ channel: sender.channel, channelUserId: sender.channelUserId }];
    rows.push({
      id: channelIdentityId(sender.channel, sender.channelUserId),
      displayName: nameForAccount(sender.channel, sender.channelUserId),
      level: "unknown",
      channels: senderGroup,
      ...activityForChannels(senderGroup),
      neverMessaged: false,
    });
  }

  for (const contact of whatsappContacts) {
    // Groups are conversations, not identities — they cannot hold a bond.
    if (contact.isGroup) continue;
    const k = key("whatsapp", contact.jid);
    if (mapped.has(k)) continue;
    mapped.add(k);
    const group = [{ channel: "whatsapp", channelUserId: contact.jid }];
    const activity = activityForChannels(group);
    rows.push({
      id: channelIdentityId("whatsapp", contact.jid),
      displayName: whatsAppDisplayName(contact) ?? contact.jid,
      level: "unknown",
      channels: group,
      ...activity,
      neverMessaged: activity.latest === null,
    });
  }

  return rows;
}

/**
 * Every curated person, as `GET /api/people` serves them.
 *
 * Projected off {@link buildIdentities} rather than off the fixture store a
 * second time: the two surfaces list the same people with the same accounts
 * and the same activity, so a second derivation would let the mention list and
 * the identity union disagree about a person the fixtures describe once.
 *
 * The stranger sentinel never appears. It contributes one `channel:` row per
 * dismissed sender rather than a `person:` row, so it falls out here by
 * construction — the same reason the route withholds it.
 */
export function buildPeople(): PersonResource[] {
  const byId = new Map(persons.map((person) => [person.id, person]));
  return buildIdentities().flatMap((row) => {
    const parsed = parseIdentityId(row.id);
    if (parsed?.kind !== "person") return [];
    const person = byId.get(parsed.personId);
    if (!person) return [];
    return [
      {
        id: person.id,
        displayName: person.displayName,
        // The stored value, free text included — the page buckets it, the
        // contract does not launder it.
        bondLevel: person.bondLevel,
        accounts: row.channels.map((mapping) => ({
          channel: mapping.channel,
          channelUserId: mapping.channelUserId,
          displayName: nameForAccount(mapping.channel, mapping.channelUserId),
        })),
        messageCount: row.messageCount,
        latest: row.latest,
      },
    ];
  });
}

/**
 * One identity's dynamics, newest first, the way the route merges them: the
 * WhatsApp mirror holds full threads, and every other channel contributes the
 * single line the sentinel recorded. Entries are generic — source, time, body,
 * direction, ref — so nothing here knows it is looking at WhatsApp.
 */
export function buildTimeline(id: string): TimelineEntry[] | null {
  const parsed = parseIdentityId(id);
  if (!parsed) return null;
  const channels =
    parsed.kind === "channel"
      ? [{ channel: parsed.channel, channelUserId: parsed.channelUserId }]
      : (persons.find((person) => person.id === parsed.personId)?.channelMappings ?? null);
  if (channels === null) return null;
  return timelineForChannels(channels);
}

/** One channel set's dynamics, newest first. The row's `latest` is this
 *  sequence's head, so the two cannot disagree about what happened last. */
function timelineForChannels(channels: IdentityChannel[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const mapping of channels) {
    if (mapping.channel === "whatsapp") {
      const jid = mapping.channelUserId;
      const mirrored = threads[jid] ?? [];
      // The sentinel recorded the same arrival the mirror holds, so the two are
      // alternatives rather than additions. With no mirrored thread the
      // sentinel is all there is, and skipping it leaves an identity that has
      // plainly messaged with an empty timeline, a null `latest`, and no place
      // in the Unknown count.
      if (mirrored.length === 0) {
        entries.push(...sentinelEntriesFor(mapping));
        continue;
      }
      for (const message of mirrored) {
        // A reaction is not its own dynamic — `summarize` skips them when it
        // picks `latest`, so carrying them here would let one identity report
        // two different newest things. Whether the page renders them against
        // the line they answer is the page rebuild's call.
        if (message.type === "reaction") continue;
        entries.push({
          source: "whatsapp",
          timestamp: message.timestamp,
          body: message.text,
          direction: message.fromMe ? "outbound" : "inbound",
          // A WhatsApp message id is unique within its chat, and a person can
          // hold several WhatsApp identities, so the chat qualifies it into
          // the source-global ref the contract asks for.
          ref: `${jid}:${message.id}`,
        });
      }
      continue;
    }
    entries.push(...sentinelEntriesFor(mapping));
  }
  return entries.sort(compareTimelineEntries);
}

/** Every sentinel log row for one channel identity, as timeline entries. */
function sentinelEntriesFor(mapping: IdentityChannel): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const sender of sentinelSenders) {
    if (sender.channel !== mapping.channel || sender.channelUserId !== mapping.channelUserId) {
      continue;
    }
    entries.push({
      source: sender.channel,
      timestamp: sender.lastMessageAt ?? 0,
      body: sender.lastMessage,
      direction: "inbound",
      ref: `sentinel:${sender.logId}`,
    });
    if (sender.reply) {
      entries.push({
        source: sender.channel,
        timestamp: sender.lastMessageAt ?? 0,
        body: sender.reply,
        direction: "outbound",
        ref: `sentinel:${sender.logId}:reply`,
      });
    }
  }
  return entries;
}

/**
 * The legacy `/api/persons/unknown` queue: one card per unmapped sender, newest
 * first, the way core's endpoint groups it.
 *
 * The log holds a record per exchange, so one sender can own several. The queue
 * is a list of people waiting rather than a list of things they said, so the
 * records collapse to their newest — returning them raw renders one person as
 * two cards sharing a React key, the older of them stale.
 */

export function listUnknownSenders(): SentinelRow[] {
  const newest = new Map<string, SentinelRow>();
  for (const sender of sentinelSenders) {
    if (ownerOf(sender.channel, sender.channelUserId)) continue;
    const k = `${sender.channel}\n${sender.channelUserId}`;
    const held = newest.get(k);
    if (!held || (sender.lastMessageAt ?? 0) > (held.lastMessageAt ?? 0)) newest.set(k, sender);
  }
  return [...newest.values()].sort(
    (a, b) =>
      (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) ||
      compareCodePoints(a.channelUserId, b.channelUserId),
  );
}

// ── LinkedIn inbox mirror fixtures ──────────────────────────────────────────
// Two threads exercise both dialog shapes: a 1:1 with a subject-carrying
// InMail and reactions, and a group conversation (personName + conversationName)
// so the sender labels render.

const LI_ARVIND_THREAD = "2-mock-arvind==";
const LI_FOUNDERS_THREAD = "2-mock-founders==";

const liSelf = (id: string, text: string, timestamp: number): LinkedInMessage => ({
  messageId: id,
  senderName: "Rome Guardian",
  senderHeadline: null,
  senderProfileUrl: "https://www.linkedin.com/in/rome-guardian/",
  senderIsSelf: true,
  timestamp,
  text,
  subject: null,
  reactionCount: null,
});

const liTheir = (
  id: string,
  sender: { name: string; headline: string | null; profileUrl: string | null },
  text: string,
  timestamp: number,
  extra: Partial<LinkedInMessage> = {},
): LinkedInMessage => ({
  messageId: id,
  senderName: sender.name,
  senderHeadline: sender.headline,
  senderProfileUrl: sender.profileUrl,
  senderIsSelf: false,
  timestamp,
  text,
  subject: null,
  reactionCount: null,
  ...extra,
});

const LI_ARVIND = {
  name: "Arvind Srivastav",
  headline: "Founder at Signalwing",
  profileUrl: "https://www.linkedin.com/in/arvind-mock/",
};
const LI_CALEB = {
  name: "Caleb Cater",
  headline: "Developer Relations",
  profileUrl: "https://www.linkedin.com/in/caleb-mock/",
};

const linkedinMessagesByThread: Record<string, LinkedInMessage[]> = {
  [LI_ARVIND_THREAD]: [
    liTheir(
      "li-arvind-1",
      LI_ARVIND,
      "Great meeting you at the robotics meetup — would love to compare notes.",
      yesterdayAt(9, 40),
      { subject: "Following up from Tuesday" },
    ),
    liSelf("li-arvind-2", "Likewise! Free Thursday afternoon?", yesterdayAt(10, 5)),
    liTheir("li-arvind-3", LI_ARVIND, "Thursday works. Calendar invite sent.", secondsAgo(3_600), {
      reactionCount: 1,
    }),
  ],
  [LI_FOUNDERS_THREAD]: [
    liTheir(
      "li-founders-1",
      LI_ARVIND,
      "Sharing the pitch review notes here.",
      yesterdayAt(15, 12),
    ),
    liTheir(
      "li-founders-2",
      LI_CALEB,
      "Added comments on the deck — see section 3.",
      secondsAgo(7_200),
    ),
    liSelf("li-founders-3", "Thanks both, reading now.", secondsAgo(5_400)),
  ],
};

const linkedinThreads: LinkedInThread[] = [
  {
    // The producer's real 1:1 shape: conversationName is the raw title only,
    // so it is null here even though the thread has a counterparty name —
    // group-ness is the isGroup flag, never a name heuristic.
    threadId: LI_ARVIND_THREAD,
    threadUrl: `https://www.linkedin.com/messaging/thread/${LI_ARVIND_THREAD}/`,
    personName: "Arvind Srivastav",
    conversationName: null,
    lastMessagePreview: "Thursday works. Calendar invite sent.",
    lastMessageAt: secondsAgo(3_600),
    unread: true,
    isGroup: false,
    participantCount: 2,
    counterpartyType: "member",
    category: "INBOX,PRIMARY_INBOX",
    messageCount: 3,
  },
  {
    // A real group with no single personName: the card's title falls back to
    // the conversation title, and the badge comes from isGroup alone.
    threadId: LI_FOUNDERS_THREAD,
    threadUrl: `https://www.linkedin.com/messaging/thread/${LI_FOUNDERS_THREAD}/`,
    personName: null,
    conversationName: "Founder pitch review",
    lastMessagePreview: "Thanks both, reading now.",
    lastMessageAt: secondsAgo(5_400),
    unread: false,
    isGroup: true,
    participantCount: 3,
    counterpartyType: "member",
    category: "INBOX,PRIMARY_INBOX",
    messageCount: 3,
  },
];

// Shared-store escape hatch for ./people-proposed.ts, so a write made through
// the proposed /people routes is visible to every legacy endpoint in this file
// and vice versa. Retires with the legacy endpoints once the People surface
// reads the /people contract.
export const proposedApiStore = {
  persons,
  sentinelSenders,
  whatsappContacts,
  ownerOf,
  nextPersonId,
  summarize,
};

export const peopleHandlers = [
  http.get("/api/identities", ({ request }) => {
    const params = new URL(request.url).searchParams;
    const wanted = params.get("id");
    const query = params.get("q") ?? "";
    const includeNeverMessaged = params.get("includeNeverMessaged") === "true";
    const limit = Number(params.get("limit"));
    const rawLevel = params.get("level");
    const level = parseIdentityFilterLevel(rawLevel);
    if (rawLevel != null && rawLevel !== "" && level === null) {
      return HttpResponse.json({ error: `level must name a bond level or "all"` }, { status: 400 });
    }

    const rawCursor = params.get("cursor");
    const cursor = parseIdentityCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return HttpResponse.json({ error: "cursor is not an identity cursor" }, { status: 400 });
    }

    const all = buildIdentities();
    // The whole matching union, `?id=` included — narrowing to one row is the
    // shared rule's job, so a by-id refresh still reads union-wide counts.
    const rows = all.filter((row) => identityMatchesQuery(row, query));
    rows.sort(compareIdentityRows);
    return HttpResponse.json(
      // Counts, the silent-contact toggle, the level filter and paging are all
      // the shared rule's job — the whole matching union goes in, so the
      // fixtures cannot drift from the route on any of them, and the counts
      // still describe rows this page is holding back.
      sliceIdentityPage(rows, {
        cursor,
        limit: Number.isFinite(limit) && limit > 0 ? limit : null,
        level,
        id: wanted,
        // A search reaches the whole address book; the toggle only decides what
        // the browsing views carry. A lookup by id needs no such pairing —
        // `sliceIdentityPage` answers about the row it names either way.
        includeNeverMessaged: includeNeverMessaged || query.trim() !== "",
      }),
    );
  }),

  http.get("/api/identities/:id/timeline", ({ params, request }) => {
    const id = String(params.id);
    // The id has to name a row the union actually exposes. A syntactically
    // valid `channel:` id for an identity that was never seen, or one since
    // folded into a person, would otherwise answer 200 and an empty or partial
    // history — a stale client would render "no messages" for someone who has
    // them rather than learning its id is gone.
    if (!buildIdentities().some((row) => row.id === id)) {
      return HttpResponse.json({ error: "Unknown identity" }, { status: 404 });
    }
    const entries = buildTimeline(id);
    if (entries === null) {
      return HttpResponse.json({ error: "Unknown identity" }, { status: 404 });
    }
    const timelineParams = new URL(request.url).searchParams;
    const rawCursor = timelineParams.get("cursor");
    const cursor = parseTimelineCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return HttpResponse.json({ error: "cursor is not a timeline cursor" }, { status: 400 });
    }
    // Clamped the way the contract defines, so `?limit=` exercises paging here
    // exactly as it will against the route.
    const rawLimit = Number(timelineParams.get("limit"));
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, TIMELINE_PAGE_MAX_LIMIT)
        : TIMELINE_PAGE_DEFAULT_LIMIT;
    // Resumes at the entry the cursor names rather than at its second: a
    // second holds more than one entry, and the route pages the same way.
    const remaining = cursor
      ? entries.filter((entry) => isAfterTimelineCursor(entry, cursor))
      : entries;
    const page = remaining.slice(0, limit);
    const oldest = page.at(-1);
    const body: TimelinePage = {
      entries: page,
      nextCursor: remaining.length > page.length && oldest ? timelineCursor(oldest) : null,
    };
    return HttpResponse.json(body);
  }),

  http.post("/api/persons/set-bond-level", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Partial<{
      personId: string;
      bondLevel: string;
    }>;
    const { personId, bondLevel } = body;
    if (!personId || !bondLevel) return missingFields(["personId", "bondLevel"]);
    if (!isAssignableBondLevel(bondLevel)) {
      return HttpResponse.json(
        { error: "bondLevel must be inner-circle, acquaintance, or other" },
        { status: 400 },
      );
    }
    const person = persons.find((candidate) => candidate.id === personId);
    if (!person) return HttpResponse.json({ error: "Unknown person" }, { status: 404 });
    // Which rows are structure rather than people is the shared rule's call,
    // so the route and this handler cannot disagree on it.
    const protectedReason = protectedPersonReason(person);
    if (protectedReason) {
      return HttpResponse.json(
        {
          error:
            protectedReason === "guardian"
              ? "the guardian's bond level cannot be changed"
              : "the stranger sentinel has no bond level",
        },
        { status: 400 },
      );
    }
    person.bondLevel = bondLevel;
    return HttpResponse.json({ success: true });
  }),

  http.post("/api/persons/move-channel", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Partial<{
      channel: string;
      channelUserId: string;
      bondLevel: string;
      displayName: string;
    }>;
    const { channel, channelUserId, bondLevel, displayName } = body;
    if (!channel || !channelUserId || !bondLevel) {
      return missingFields(["channel", "channelUserId", "bondLevel"]);
    }
    if (!isAssignableBondLevel(bondLevel)) {
      return HttpResponse.json(
        { error: "bondLevel must be inner-circle, acquaintance, or other" },
        { status: 400 },
      );
    }
    const owner = ownerOf(channel, channelUserId);
    if (owner && owner.id !== STRANGER_PERSON_ID) {
      return HttpResponse.json(
        { error: "identity is already mapped to a person" },
        { status: 409 },
      );
    }
    const name = displayName || channelUserId;
    const personId = nextPersonId(name);
    const placed: PersonFixture = {
      id: personId,
      displayName: name,
      bondLevel,
      channelMappings: [],
    };
    persons.push(placed);
    // A dismissed identity's mapping is re-pointed rather than duplicated,
    // which is what makes recovery from the Stranger group a plain move.
    if (owner) {
      owner.channelMappings = owner.channelMappings.filter(
        (mapping) => !(mapping.channel === channel && mapping.channelUserId === channelUserId),
      );
    }
    placed.channelMappings.push({ channel, channelUserId });
    return HttpResponse.json({ success: true, personId });
  }),

  http.post("/api/persons/merge", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Partial<{
      sourcePersonId: string;
      targetPersonId: string;
    }>;
    const { sourcePersonId, targetPersonId } = body;
    if (!sourcePersonId || !targetPersonId) {
      return missingFields(["sourcePersonId", "targetPersonId"]);
    }
    if (sourcePersonId === targetPersonId) {
      return HttpResponse.json(
        { error: "a person cannot be merged into themselves" },
        { status: 400 },
      );
    }
    const sourceIndex = persons.findIndex((person) => person.id === sourcePersonId);
    const target = persons.find((person) => person.id === targetPersonId);
    if (sourceIndex === -1 || !target) {
      return HttpResponse.json({ error: "Unknown person" }, { status: 404 });
    }
    // Dismissing a curated person is a merge into the sentinel: their mappings
    // move across and each renders as its own stranger-level row, so the
    // identity survives the source row going away. That only holds while there
    // is a mapping to carry — a person with none leaves nothing behind, which
    // is the one case this refuses. `canMoveToStranger` is the same rule, so a
    // caller can omit the move rather than discover it here.
    if (target.id === STRANGER_PERSON_ID && persons[sourceIndex].channelMappings.length === 0) {
      return HttpResponse.json(
        { error: "an identity with no channel mappings cannot be dismissed" },
        { status: 400 },
      );
    }
    const protectedSource = protectedPersonReason(persons[sourceIndex]);
    if (protectedSource) {
      return HttpResponse.json(
        {
          error:
            protectedSource === "guardian"
              ? "the guardian cannot be merged away"
              : "the stranger sentinel cannot be merged away",
        },
        { status: 400 },
      );
    }
    target.channelMappings.push(...persons[sourceIndex].channelMappings);
    persons.splice(sourceIndex, 1);
    return HttpResponse.json({ success: true });
  }),

  // Ordered before `/api/persons` only for readability — MSW matches full
  // paths, so neither shadows the other.
  http.get("/api/persons/unknown", () => HttpResponse.json(listUnknownSenders())),

  http.post("/api/persons/create", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Partial<{
      displayName: string;
      bondLevel: string;
      channel: string;
      channelUserId: string;
    }>;
    const { displayName, bondLevel, channel, channelUserId } = body;
    if (!displayName || !bondLevel || !channel || !channelUserId) {
      return missingFields(["displayName", "bondLevel", "channel", "channelUserId"]);
    }
    const personId = nextPersonId(displayName);
    persons.push({
      id: personId,
      displayName,
      bondLevel,
      channelMappings: [{ channel, channelUserId }],
    });
    return HttpResponse.json({ success: true, personId });
  }),

  http.post("/api/persons/link", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Partial<{
      channel: string;
      channelUserId: string;
      existingPersonId: string;
    }>;
    const { channel, channelUserId, existingPersonId } = body;
    if (!channel || !channelUserId || !existingPersonId) {
      return missingFields(["channel", "channelUserId", "existingPersonId"]);
    }
    const person = persons.find((candidate) => candidate.id === existingPersonId);
    // Unreachable from the page, whose link form only lists persons that exist.
    // It stands in for the foreign key on `channel_mappings.person_id`, so a
    // mistyped id cannot leave a mapping pointing at nobody.
    if (!person) return HttpResponse.json({ error: "Unknown person" }, { status: 404 });
    // An identity belongs to one person: an already-mapped one is re-pointed,
    // never mapped a second time, or it would surface in two groups at once.
    const owner = ownerOf(channel, channelUserId);

    if (owner) {
      if (owner.id === existingPersonId) return HttpResponse.json({ success: true });
      owner.channelMappings = owner.channelMappings.filter(
        (mapping) => !(mapping.channel === channel && mapping.channelUserId === channelUserId),
      );
    }
    person.channelMappings.push({ channel, channelUserId });
    return HttpResponse.json({ success: true });
  }),

  http.post("/api/persons/mark-stranger", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Partial<{
      channel: string;
      channelUserId: string;
    }>;
    const { channel, channelUserId } = body;
    if (!channel || !channelUserId) return missingFields(["channel", "channelUserId"]);
    const stranger = persons.find((person) => person.id === STRANGER_PERSON_ID);
    if (!stranger) return HttpResponse.json({ error: "Unknown person" }, { status: 404 });
    stranger.channelMappings.push({ channel, channelUserId });
    return HttpResponse.json({ success: true });
  }),

  http.get("/api/persons", () => HttpResponse.json(persons)),

  // The curated people read. Query parsing and the counts' scope are the
  // route's (`packages/core/src/api/routes/people.ts`); the rules they run on
  // are the contract's, so both ends call the same ones.
  http.get("/api/people", ({ request }) => {
    const params = new URL(request.url).searchParams;
    const rawLevel = params.get("level");
    const level = parsePersonFilterLevel(rawLevel);
    if (rawLevel != null && rawLevel !== "" && level === null) {
      return HttpResponse.json({ error: `level must name a bond level or "all"` }, { status: 400 });
    }

    // The whole `?q=` match, before `?level=` narrows it — every chip's number
    // has to stay true while another chip is the selected one.
    const matching = buildPeople().filter((person) =>
      personMatchesQuery(person, params.get("q") ?? ""),
    );
    return HttpResponse.json({
      people: matching
        .filter((person) => personMatchesLevel(person, level ?? "all"))
        .sort(comparePeople),
      counts: countPeople(matching),
    } satisfies PeopleList);
  }),

  http.get("/api/whatsapp/contacts", () => {
    const rows = whatsappContacts.map((contact) => {
      const owner = ownerOf("whatsapp", contact.jid);
      return {
        ...contact,
        ...summarize(contact.jid),
        linkedPersonId: owner?.id ?? null,
        linkedPersonName: owner?.displayName ?? null,
      } satisfies WhatsAppContact;
    });
    // The repository's ORDER BY: threads that have said something first, newest
    // first, then the silent ones by name. Sorting here rather than in the
    // fixture is what makes a send move its contact to the top.
    rows.sort((a, b) => {
      if ((a.lastMessageAt === null) !== (b.lastMessageAt === null)) {
        return a.lastMessageAt === null ? 1 : -1;
      }
      if (a.lastMessageAt !== b.lastMessageAt) {
        return (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
      }
      return displayNameOf(a).localeCompare(displayNameOf(b));
    });
    return HttpResponse.json(rows);
  }),

  http.get("/api/linkedin/threads", () => {
    // The repository's ORDER BY: threads with a listed timestamp first, newest
    // first, then by display name.
    const rows = [...linkedinThreads].sort((a, b) => {
      if ((a.lastMessageAt === null) !== (b.lastMessageAt === null)) {
        return a.lastMessageAt === null ? 1 : -1;
      }
      if (a.lastMessageAt !== b.lastMessageAt) {
        return (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
      }
      const nameOf = (t: LinkedInThread) => t.personName ?? t.conversationName ?? t.threadId;
      return nameOf(a).localeCompare(nameOf(b));
    });
    return HttpResponse.json(rows);
  }),

  http.get("/api/linkedin/threads/:threadId/messages", ({ params, request }) => {
    const thread = linkedinMessagesByThread[String(params.threadId)] ?? [];
    const raw = Number(new URL(request.url).searchParams.get("limit"));
    // Newest `limit`, handed back oldest-first, same as the real route.
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 500) : 50;
    return HttpResponse.json(thread.slice(-limit));
  }),

  http.get("/api/whatsapp/contacts/:jid/messages", ({ params, request }) => {
    const thread = threads[String(params.jid)] ?? [];
    const raw = Number(new URL(request.url).searchParams.get("limit"));
    // The route reads the newest `limit` and hands them back oldest-first, so a
    // long thread opens on its tail rather than its beginning.
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 500) : 50;
    return HttpResponse.json(thread.slice(-limit));
  }),

  // The real write goes through opencli `linkedin safe-send`; the mock applies
  // the same request contract, then appends the browser-visible send that a
  // later mirror sync would persist.
  http.post("/api/linkedin/threads/:threadId/send", async ({ params, request }) => {
    const threadId = String(params.threadId);
    const body = (await request.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return HttpResponse.json({ error: "text is required" }, { status: 400 });

    const thread = linkedinThreads.find((candidate) => candidate.threadId === threadId);
    if (!thread) return HttpResponse.json({ error: "LinkedIn thread not found" }, { status: 404 });

    const messages = (linkedinMessagesByThread[threadId] ??= []);
    const now = secondsAgo(0);
    messages.push(liSelf(`li-sent-${threadId}-${messages.length}`, text, now));
    thread.lastMessagePreview = text;
    thread.lastMessageAt = now;
    thread.messageCount = messages.length;
    return HttpResponse.json({ ok: true, recipient: thread.personName ?? thread.conversationName });
  }),

  // The real route hands the text to the adapter and persists nothing; Baileys
  // echoes it back as a `fromMe` message, which the mirror picks up and the
  // next poll shows. Appending here is that echo — without it the composer's
  // optimistic bubble would never reconcile and would sit "sending" forever.
  http.post("/api/whatsapp/contacts/:jid/send", async ({ params, request }) => {
    const jid = String(params.jid);
    const body = (await request.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return HttpResponse.json({ error: "text is required" }, { status: 400 });

    // The route sends through a live transport, so it refuses when the channel
    // has none — and the composer has its own copy for that 503. Disconnecting
    // WhatsApp on the Connections page is what makes this reachable; without
    // the check, a visibly disconnected account would keep sending.
    if (talkConnections("whatsapp").length !== 1) {
      return HttpResponse.json({ error: "WhatsApp is not connected" }, { status: 503 });
    }

    const thread = (threads[jid] ??= []);
    thread.push(guardianText(`wa-sent-${jid}-${thread.length}`, text, secondsAgo(0)));

    return HttpResponse.json({ ok: true });
  }),
];
