// Browser-side flow shared by the LinkedIn thread reads (`thread-snapshot`,
// `thread-participants`). Every read opens the same thread the same way, proves
// the browser really landed on the requested thread, and fetches from the same
// two normalized messaging endpoints — so a fix to any of those applies to all
// of them. Command names are passed in only to keep error text specific.
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import {
  LINKEDIN_MESSAGING_URL,
  canonicalizeLinkedInThreadUrl,
  fetchLinkedInConversationApi,
  fetchLinkedInThreadApi,
  inspectLinkedInThreadPage,
  isThreadConversationApiUrl,
  isThreadMessageApiUrl,
  unwrapThreadBrowserResult,
  validateThreadConversationPayload,
} from "./thread-snapshot-helpers.mjs";

export const LINKEDIN_DOMAIN = "www.linkedin.com";

export function requireThreadUrl(value) {
  const threadUrl = canonicalizeLinkedInThreadUrl(value);
  if (!threadUrl) {
    throw new ArgumentError(
      "--thread-url must be an exact https://www.linkedin.com/messaging/thread/<id>/ URL",
    );
  }
  return threadUrl;
}

async function readThreadProbe(page, threadId) {
  return unwrapThreadBrowserResult(await page.evaluate(inspectLinkedInThreadPage, threadId));
}

export async function openThread(page, threadUrl) {
  await page.goto(LINKEDIN_MESSAGING_URL);
  await page.wait(4);
  await page.goto(threadUrl);
  await page.wait(4);
}

export async function waitForThreadProbe(page, threadId) {
  let probe = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    probe = await readThreadProbe(page, threadId);
    if (probe?.auth_wall || probe?.initial_url) return probe;
    await page.wait(1);
  }
  return probe;
}

// Fails closed: an auth wall and a thread the browser did not actually open are
// both refusals, never a partial or a neighbouring thread's data.
export function requireCurrentThread(probe, expectedUrl, command) {
  if (probe?.auth_wall) {
    throw new AuthRequiredError(
      LINKEDIN_DOMAIN,
      `LinkedIn ${command} requires an active signed-in LinkedIn browser session.`,
    );
  }
  const actualUrl = canonicalizeLinkedInThreadUrl(probe?.current_url || "");
  if (!actualUrl || actualUrl !== expectedUrl) {
    throw new CommandExecutionError(
      `LinkedIn ${command} blocked: thread_url_mismatch`,
      `Expected ${expectedUrl}; actual ${actualUrl || probe?.current_url || "not_available"}`,
    );
  }
  return actualUrl;
}

export async function readThreadCsrf(page) {
  const cookies = await page.getCookies({ url: "https://www.linkedin.com" });
  const jsession = cookies.find((cookie) => cookie.name === "JSESSIONID")?.value;
  if (!jsession) {
    throw new AuthRequiredError(
      LINKEDIN_DOMAIN,
      "LinkedIn JSESSIONID cookie not found. Please sign in to LinkedIn.",
    );
  }
  return jsession.replace(/^"|"$/g, "");
}

export async function fetchThreadPayload(page, apiUrl, csrf, threadId, command) {
  if (!isThreadMessageApiUrl(apiUrl, threadId)) {
    throw new CommandExecutionError(
      `LinkedIn ${command} blocked an API response for a different thread`,
    );
  }
  const response = unwrapThreadBrowserResult(
    await page.evaluate(fetchLinkedInThreadApi, apiUrl, csrf),
  );
  if (response?.auth_required) {
    throw new AuthRequiredError(
      LINKEDIN_DOMAIN,
      `LinkedIn messaging API authentication failed: ${response.error || "access denied"}`,
    );
  }
  if (!response?.json || response.error) {
    throw new CommandExecutionError(
      `LinkedIn messaging API returned an unexpected response: ${response?.error || "no data"}`,
    );
  }
  if (!Array.isArray(response.json.included)) {
    throw new CommandExecutionError(
      "LinkedIn messaging API returned a malformed normalized payload",
    );
  }
  return response.json;
}

export async function fetchConversationPayload(page, apiUrl, csrf, threadId, command) {
  if (!isThreadConversationApiUrl(apiUrl)) {
    throw new CommandExecutionError(`LinkedIn ${command} blocked an unsafe conversation URL`);
  }
  const response = unwrapThreadBrowserResult(
    await page.evaluate(fetchLinkedInConversationApi, apiUrl, csrf, threadId),
  );
  if (response?.auth_required) {
    throw new AuthRequiredError(
      LINKEDIN_DOMAIN,
      `LinkedIn messaging API authentication failed: ${response.error || "access denied"}`,
    );
  }
  if (!response?.json || response.error) {
    throw new CommandExecutionError(
      `LinkedIn conversation API returned an unexpected response: ${response?.error || "no data"}`,
    );
  }
  try {
    return validateThreadConversationPayload(response.json, threadId);
  } catch (error) {
    throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
  }
}

// Performance entries can be stale, so a conversation URL that fails is retried
// against the next candidate. An auth failure still stops the read.
export async function fetchFirstConversationPayload(page, probe, csrf, threadId, command) {
  for (const apiUrl of Array.isArray(probe?.conversation_urls) ? probe.conversation_urls : []) {
    try {
      const payload = await fetchConversationPayload(page, apiUrl, csrf, threadId, command);
      if (payload) return payload;
    } catch (error) {
      if (error instanceof AuthRequiredError) throw error;
      if (!(error instanceof CommandExecutionError)) throw error;
    }
  }
  return null;
}
