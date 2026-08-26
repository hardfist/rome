// Rome-owned command (no upstream equivalent in @yunfanye/opencli). It reuses
// the thread-snapshot read path so both commands open, verify, and fetch a
// thread identically.
import { AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";
import {
  LINKEDIN_DOMAIN,
  fetchFirstConversationPayload,
  fetchThreadPayload,
  openThread,
  readThreadCsrf,
  requireCurrentThread,
  requireThreadUrl,
  waitForThreadProbe,
} from "./thread-read.mjs";
import { linkedInThreadId, parseThreadParticipantPayloads } from "./thread-snapshot-helpers.mjs";

const COMMAND = "thread-participants";

cli({
  site: "linkedin",
  name: COMMAND,
  access: "read",
  description: "Return every participant of one LinkedIn thread with their member identifier",
  example:
    "opencli linkedin thread-participants --thread-url https://www.linkedin.com/messaging/thread/<id>/ -f json",
  domain: LINKEDIN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "thread-url",
      type: "string",
      required: true,
      help: "Exact LinkedIn messaging thread URL to read",
    },
  ],
  columns: [
    "thread_url",
    "thread_id",
    "participant_index",
    "participant_count",
    "participant_id",
    "name",
    "headline",
    "type",
    "is_self",
    "profile_url",
  ],
  func: async (page, kwargs) => {
    if (!page) {
      throw new CommandExecutionError("Browser session required for linkedin thread-participants");
    }

    const threadUrl = requireThreadUrl(kwargs["thread-url"]);
    const threadId = linkedInThreadId(threadUrl);

    await openThread(page, threadUrl);

    const probe = await waitForThreadProbe(page, threadId);
    requireCurrentThread(probe, threadUrl, COMMAND);

    const csrf = await readThreadCsrf(page);
    const payloads = [];

    // The conversation response is the authoritative source: its participant
    // reference list names everyone on the thread, including members who have
    // never sent a message.
    const conversationPayload = await fetchFirstConversationPayload(
      page,
      probe,
      csrf,
      threadId,
      COMMAND,
    );
    if (conversationPayload) payloads.push(conversationPayload);

    // The message response covers senders, so a thread whose conversation
    // metadata is unavailable still reports the participants it can prove.
    if (probe?.initial_url) {
      try {
        payloads.push(await fetchThreadPayload(page, probe.initial_url, csrf, threadId, COMMAND));
      } catch (error) {
        if (error instanceof AuthRequiredError) throw error;
        if (!(error instanceof CommandExecutionError) || payloads.length === 0) throw error;
      }
    }

    if (payloads.length === 0) {
      throw new CommandExecutionError(
        "LinkedIn returned no participant data for the requested thread.",
      );
    }

    let rows;
    try {
      rows = parseThreadParticipantPayloads(payloads, { threadId, threadUrl });
    } catch (error) {
      throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }
    if (rows.length === 0) {
      throw new CommandExecutionError(
        "LinkedIn returned no participants for the requested thread.",
      );
    }
    return rows;
  },
});
