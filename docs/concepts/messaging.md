# Messaging: Channels, Policies, Sentinel, Approvals

## Channels

Channels are messaging platform integrations — external platforms like Telegram, WhatsApp, and Discord, plus the webchat built into the dashboard. Each channel has an adapter that normalizes platform-specific messages into a common shape carrying the channel, the sender's [account](identity.md#account), thread addressing, content, and the raw platform event.

**Contracts:**

- Every inbound message is normalized to the common shape before it reaches routing. The channel's adapter absorbs platform-specific wire formats, so adding a channel changes nothing downstream.
- Channel connection setup is uniform: enabling any channel drives the same server-owned setup protocol — there is no bespoke per-service connect flow ([channel invariants](../architecture/channels.md#invariants)).
- Per-channel credentials are kept separate and are revoked independently.

**Not to be confused with:**

- **[Person](identity.md#persons)** — a channel is where a message arrives. The person is who sent it, resolved across channels.
- **[Hook](apps.md#hooks)** — the `channel-message` hook is how an inbound message enters app code. The channel is the integration that produced it.

## Policies

The policy engine decides how to handle each incoming message based on who sent it and where.

Evaluation order (first match wins):
1. **Sender-specific** — exact [person](identity.md#persons) match
2. **Thread-specific** — thread name + type match
3. **Sender tier** — [bond level](identity.md#bond-levels) match
4. **Channel-specific** — [channel](#channels) match
5. **Global** — catch-all

Policy actions:
- **Allow** — route to the [main agent](agents.md#agent-hierarchy)
- **Block** — drop the message
- **Sentinel review** — triage through the [sentinel](#sentinel)

**Contracts:**

- Evaluation is strictly ordered from most to least specific, and the first matching policy wins. A more specific policy always overrides a broader one.
- Default behavior: guardian messages are allowed, and everyone else goes through sentinel review. Which bond levels are trusted is configurable.

**Not to be confused with:**

- **[Bond level](identity.md#bond-levels)** — a bond level is an attribute of a person. A policy is a routing rule that may key on it.
- **[Approvals](#approvals)** — a policy routes inbound messages. An approval gates a sensitive action before it executes.

## Sentinel

The sentinel is a lightweight [agent](agents.md) that triages messages from untrusted senders. When the [policy engine](#policies) routes a message to sentinel review, the sentinel decides:

- **Reply** — respond directly (logged for [guardian](identity.md#guardian) review)
- **Escalate** — forward to the [main agent](agents.md#agent-hierarchy)
- **Ignore** — drop the message (logged)

**Contracts:**

- All sentinel decisions are recorded. The main agent periodically reviews the log (cadence configurable) to catch anything that needs follow-up.
- The sentinel only sees messages the [policy engine](#policies) routes to it. It is not in the path of trusted senders' messages.

**Not to be confused with:**

- **[Policies](#policies)** — the policy engine decides *whether* the sentinel sees a message. The sentinel decides *what to do* with it.
- **Envoy** — the envoy validates *outgoing* messages. The sentinel triages *incoming* messages (see [agent hierarchy](agents.md#agent-hierarchy)).

## Approvals

The approval system gates sensitive [actions](actions.md) behind [guardian](identity.md#guardian) sign-off. When a gated action is triggered, execution pauses and Rome records an approval. The guardian approves or rejects it from the web dashboard.

**Contracts:**

- An approval-gated action does not execute before the guardian's decision: execution pauses at the gate, and a rejection means the action never runs.
- Only the guardian can decide an approval.

**Not to be confused with:**

- **[Sentinel](#sentinel)** — sentinel review triages inbound *messages*. An approval gates a sensitive *action*.
