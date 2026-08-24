import assert from "node:assert/strict";
import test from "node:test";
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { getRegistry } from "@jackwener/opencli/registry";
import { parseThreadParticipantPayloads, threadParticipantId } from "./thread-snapshot-helpers.mjs";
import "./thread-participants.js";

const THREAD_ID = "2-target==";
const THREAD_URL = `https://www.linkedin.com/messaging/thread/${THREAD_ID}/`;
const SELF_ID = "ACoAAASelfMemberId";
const EVAN_ID = "ACoAAAEvanMemberId";
const MIRA_ID = "ACoAAAMiraMemberId";
const SELF = `urn:li:msg_messagingParticipant:urn:li:fsd_profile:${SELF_ID}`;
const EVAN = `urn:li:msg_messagingParticipant:urn:li:fsd_profile:${EVAN_ID}`;
const MIRA = `urn:li:msg_messagingParticipant:urn:li:fsd_profile:${MIRA_ID}`;

function apiUrl(threadId) {
  const variables = `(conversationUrn:urn%3Ali%3Amsg_conversation%3A%28urn%3Ali%3Afsd_profile%3Aself%2C${encodeURIComponent(threadId)}%29)`;
  return `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.abcdef0123456789&variables=${variables}`;
}

function conversationApiUrl(suffix = "") {
  return `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.abcdef0123456789&variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3Aself${suffix})`;
}

function participant(entityUrn, firstName, lastName, distance, headline = "") {
  return {
    $type: "com.linkedin.messenger.MessagingParticipant",
    entityUrn,
    participantType: {
      member: {
        firstName: { text: firstName },
        lastName: { text: lastName },
        distance,
        headline: { text: headline },
        profileUrl: `https://www.linkedin.com/in/${firstName.toLowerCase()}/`,
      },
    },
  };
}

function message(id, sender, deliveredAt, text) {
  return {
    $type: "com.linkedin.messenger.Message",
    entityUrn: `urn:li:msg_message:${id}`,
    backendUrn: `urn:li:messagingMessage:${id}`,
    backendConversationUrn: `urn:li:messagingThread:${THREAD_ID}`,
    "*conversation": `urn:li:msg_conversation:(urn:li:fsd_profile:self,${THREAD_ID})`,
    "*sender": sender,
    deliveredAt,
    body: { text },
    reactionSummaries: [],
  };
}

const SELF_PARTICIPANT = participant(SELF, "Yunfan", "Ye", "SELF", "Builder");
const EVAN_PARTICIPANT = participant(EVAN, "Evan", "Ye", "DISTANCE_1", "Founder");
const MIRA_PARTICIPANT = participant(MIRA, "Mira", "Chen", "DISTANCE_1", "Designer");

function payload({ participants, messages = [], complete = true, conversation = {} }) {
  return {
    __opencli: { conversation_participant_refs_complete: complete },
    included: [
      {
        $type: "com.linkedin.messenger.Conversation",
        entityUrn: `urn:li:msg_conversation:(urn:li:fsd_profile:self,${THREAD_ID})`,
        backendUrn: `urn:li:messagingThread:${THREAD_ID}`,
        "*conversationParticipants": participants.map((entity) => entity.entityUrn),
        ...conversation,
      },
      ...participants,
      ...messages,
    ],
  };
}

function rowsFor(payloads) {
  return parseThreadParticipantPayloads(payloads, {
    threadId: THREAD_ID,
    threadUrl: THREAD_URL,
  });
}

test("participant ids are the bare member id carried by the participant urn", () => {
  assert.equal(threadParticipantId(SELF), SELF_ID);
  assert.equal(threadParticipantId(EVAN), EVAN_ID);
  assert.equal(
    threadParticipantId("urn:li:msg_messagingParticipant:urn:li:fsd_company:1234567"),
    "1234567",
  );
  // The bare id is what a caller stores as a channel_user_id, so a value that is
  // already bare must survive untouched.
  assert.equal(threadParticipantId(EVAN_ID), EVAN_ID);
  assert.equal(threadParticipantId(""), "");
  assert.equal(threadParticipantId(undefined), "");
  assert.equal(threadParticipantId("urn:li:msg_messagingParticipant:"), "");
});

test("participant parsing returns one row per participant with the acceptance fields", () => {
  const rows = rowsFor([
    payload({
      participants: [SELF_PARTICIPANT, EVAN_PARTICIPANT, MIRA_PARTICIPANT],
      messages: [message("m1", EVAN, 1000, "hello both")],
      conversation: { title: "Pitch review", groupChat: true },
    }),
  ]);

  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.thread_id === THREAD_ID));
  assert.ok(rows.every((row) => typeof row.participant_id === "string" && row.participant_id));
  assert.deepEqual(
    rows.map((row) => row.participant_id),
    [SELF_ID, EVAN_ID, MIRA_ID],
  );
  assert.deepEqual(
    rows.map((row) => row.name),
    ["Yunfan Ye", "Evan Ye", "Mira Chen"],
  );
  assert.deepEqual(
    rows.map((row) => row.headline),
    ["Builder", "Founder", "Designer"],
  );
  assert.ok(rows.every((row) => row.type === "member"));
  assert.deepEqual(
    rows.map((row) => row.is_self),
    [true, false, false],
  );
});

test("a participant who has sent no message still appears in the output", () => {
  // Mira is on the conversation's participant list but authored nothing.
  const rows = rowsFor([
    payload({
      participants: [SELF_PARTICIPANT, EVAN_PARTICIPANT, MIRA_PARTICIPANT],
      messages: [message("m1", SELF, 1000, "kicking this off"), message("m2", EVAN, 2000, "on it")],
      conversation: { groupChat: true },
    }),
  ]);

  const mira = rows.find((row) => row.participant_id === MIRA_ID);
  assert.ok(mira, "the silent participant must be returned");
  assert.equal(mira.name, "Mira Chen");
  assert.equal(mira.headline, "Designer");
  assert.equal(mira.is_self, false);
});

test("a 1:1 thread returns both the account owner and the counterparty", () => {
  const rows = rowsFor([
    payload({
      participants: [SELF_PARTICIPANT, EVAN_PARTICIPANT],
      messages: [message("m1", EVAN, 1000, "hi")],
      conversation: { groupChat: false },
    }),
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.participant_id).sort(), [SELF_ID, EVAN_ID].sort());
  assert.equal(rows.filter((row) => row.is_self).length, 1);
  assert.equal(rows.find((row) => row.is_self).participant_id, SELF_ID);
  assert.equal(rows.find((row) => !row.is_self).participant_id, EVAN_ID);
});

test("participants are deduplicated across payloads and counted once", () => {
  const rows = rowsFor([
    payload({ participants: [SELF_PARTICIPANT, EVAN_PARTICIPANT] }),
    payload({
      participants: [SELF_PARTICIPANT, EVAN_PARTICIPANT],
      messages: [message("m1", EVAN, 1000, "hi")],
    }),
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.participant_count),
    [2, 2],
  );
  assert.deepEqual(
    rows.map((row) => row.participant_index),
    [1, 2],
  );
});

test("participants still resolve when only sparse message data is available", () => {
  const rows = rowsFor([
    {
      included: [
        {
          $type: "com.linkedin.messenger.Conversation",
          entityUrn: `urn:li:msg_conversation:(urn:li:fsd_profile:self,${THREAD_ID})`,
        },
        SELF_PARTICIPANT,
        message("m1", SELF, 1000, "hello"),
      ],
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].participant_id, SELF_ID);
  assert.equal(rows[0].is_self, true);
});

function fakePage({ probe, responses }) {
  const calls = { goto: [], evaluate: [] };
  return {
    calls,
    goto: async (url) => calls.goto.push(url),
    wait: async () => {},
    getCookies: async () => [{ name: "JSESSIONID", value: '"csrf"' }],
    evaluate: async (fn, ...args) => {
      calls.evaluate.push({ fn: fn.name, args });
      if (fn.name === "inspectLinkedInThreadPage") return probe;
      if (fn.name === "fetchLinkedInThreadApi" || fn.name === "fetchLinkedInConversationApi") {
        return responses.get(args[0]) || { error: "missing fixture" };
      }
      if (fn.name === "discoverOlderThreadApi") {
        return { api_url: "", message_list_found: true };
      }
      throw new Error(`Unexpected page function ${fn.name}`);
    },
  };
}

test("the command is registered as a read-only cookie command with participant columns", () => {
  const command = getRegistry().get("linkedin/thread-participants");
  assert.ok(command);
  assert.equal(command.strategy, "cookie");
  assert.equal(command.access, "read");
  for (const column of ["thread_id", "participant_id", "name", "headline", "type", "is_self"]) {
    assert.ok(command.columns.includes(column), `missing column ${column}`);
  }
});

test("the command returns every participant of the requested thread", async () => {
  const command = getRegistry().get("linkedin/thread-participants");
  const initial = apiUrl(THREAD_ID);
  const conversations = conversationApiUrl();
  const page = fakePage({
    probe: {
      current_url: THREAD_URL,
      auth_wall: false,
      initial_url: initial,
      page_urls: [],
      conversation_urls: [conversations],
    },
    responses: new Map([
      [
        conversations,
        {
          json: payload({
            participants: [SELF_PARTICIPANT, EVAN_PARTICIPANT, MIRA_PARTICIPANT],
            conversation: { groupChat: true },
          }),
        },
      ],
      [
        initial,
        {
          json: {
            included: [
              {
                $type: "com.linkedin.messenger.Conversation",
                entityUrn: `urn:li:msg_conversation:(urn:li:fsd_profile:self,${THREAD_ID})`,
              },
              EVAN_PARTICIPANT,
              message("m1", EVAN, 1000, "hello both"),
            ],
          },
        },
      ],
    ]),
  });

  const rows = await command.func(page, { "thread-url": THREAD_URL });

  assert.deepEqual(page.calls.goto, ["https://www.linkedin.com/messaging/", THREAD_URL]);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.participant_id).sort(),
    [SELF_ID, EVAN_ID, MIRA_ID].sort(),
  );
  // Mira sent nothing; only the conversation participant list proves she is here.
  assert.ok(rows.some((row) => row.participant_id === MIRA_ID && row.name === "Mira Chen"));
  assert.ok(rows.every((row) => row.thread_id === THREAD_ID));
  assert.ok(rows.every((row) => row.thread_url === THREAD_URL));
});

test("the command returns both sides of a 1:1 thread", async () => {
  const command = getRegistry().get("linkedin/thread-participants");
  const initial = apiUrl(THREAD_ID);
  const conversations = conversationApiUrl();
  const page = fakePage({
    probe: {
      current_url: THREAD_URL,
      auth_wall: false,
      initial_url: initial,
      page_urls: [],
      conversation_urls: [conversations],
    },
    responses: new Map([
      [
        conversations,
        {
          json: payload({
            participants: [SELF_PARTICIPANT, EVAN_PARTICIPANT],
            conversation: { groupChat: false },
          }),
        },
      ],
      [
        initial,
        {
          json: {
            included: [
              {
                $type: "com.linkedin.messenger.Conversation",
                entityUrn: `urn:li:msg_conversation:(urn:li:fsd_profile:self,${THREAD_ID})`,
              },
              EVAN_PARTICIPANT,
              message("m1", EVAN, 1000, "hi"),
            ],
          },
        },
      ],
    ]),
  });

  const rows = await command.func(page, { "thread-url": THREAD_URL });

  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.is_self).length, 1);
  assert.equal(rows.find((row) => row.is_self).participant_id, SELF_ID);
  assert.equal(rows.find((row) => !row.is_self).participant_id, EVAN_ID);
});

test("the command validates the thread URL before navigating", async () => {
  const command = getRegistry().get("linkedin/thread-participants");
  const page = fakePage({ probe: {}, responses: new Map() });
  await assert.rejects(
    command.func(page, { "thread-url": "https://www.linkedin.com/feed/" }),
    ArgumentError,
  );
  assert.deepEqual(page.calls.goto, []);
});

test("the command fails closed on an auth wall", async () => {
  const command = getRegistry().get("linkedin/thread-participants");
  const page = fakePage({
    probe: { current_url: "https://www.linkedin.com/login", auth_wall: true },
    responses: new Map(),
  });
  await assert.rejects(command.func(page, { "thread-url": THREAD_URL }), AuthRequiredError);
});

test("the command fails closed when the browser landed on a different thread", async () => {
  const command = getRegistry().get("linkedin/thread-participants");
  const page = fakePage({
    probe: {
      current_url: "https://www.linkedin.com/messaging/thread/2-other==/",
      auth_wall: false,
      initial_url: apiUrl(THREAD_ID),
      page_urls: [],
      conversation_urls: [],
    },
    responses: new Map(),
  });
  await assert.rejects(
    command.func(page, { "thread-url": THREAD_URL }),
    (error) =>
      error instanceof CommandExecutionError && /thread_url_mismatch/.test(String(error.message)),
  );
});

test("the command fails closed when LinkedIn returns no participant data", async () => {
  const command = getRegistry().get("linkedin/thread-participants");
  const initial = apiUrl(THREAD_ID);
  const page = fakePage({
    probe: {
      current_url: THREAD_URL,
      auth_wall: false,
      initial_url: initial,
      page_urls: [],
      conversation_urls: [],
    },
    responses: new Map([[initial, { error: "HTTP 500" }]]),
  });
  await assert.rejects(command.func(page, { "thread-url": THREAD_URL }), CommandExecutionError);
});
