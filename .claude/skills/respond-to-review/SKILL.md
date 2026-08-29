---
name: respond-to-review
description: Triage and answer automated code-review findings on a PR without growing its scope. Use when the user asks to "handle / address / respond to review feedback", "go through the bot comments", or after the RomeOS review bots (zoolsher, Jessie-QingYu) post findings on a PR. Classify every finding before writing any code — most findings deserve a reply, not a diff. NOT for requesting a review (that is /code-review) and NOT for reviewing someone else's PR.
---

# Respond to review feedback

Goal end-state: every finding on the PR has exactly one of four answers — a minimal fix with a test, a corrected claim in the PR description, a follow-up issue, or a written decline. The PR's diff grows as little as possible.

Classification precedes code. Never start implementing a finding before classifying it.

## Phase 1 — Gather and dedupe

1. Pull every review body and inline comment on the PR. Drop reviews marked "This review has been superseded."
2. Merge duplicate findings — same file, same defect — into one item. Post the answer once and cross-link it from the other thread.
3. Discard the bots' severity labels and verdicts. Phase 2 re-derives priority.

## Phase 2 — Classify every finding

Run each finding through these tests in order. The first test that matches decides the bucket.

### Test 1 — the bot hedged

If the finding contains "no action required", "flagging for the record", "consider", "worth noting", "latent today", "optional", "acceptable", or "retained deliberately": **decline**, with a one-line acknowledgment.

### Test 2 — the PR already disclosed it

If the finding restates a "Not in this PR" item, a stated tradeoff, or a documented transitional state: **decline**, pointing at the section that covers it.

### Test 3 — no caller can reach it

Ask what concrete caller, with what concrete input, hits the defect on `main` plus this diff. If the answer needs a future adapter, a third-party implementation, an input no caller produces, or a scale nothing is wired to reach: **decline**, stating what would have to exist first. If the concern matters later, record it as one sentence in the interface contract or as a follow-up issue.

### Test 4 — the defect predates the diff

If the defect exists on `main` without this diff: **follow-up issue**, linked from the reply.

Exception: if the PR's own claims depend on the old code being correct — for example, a claim of parity with it — fix the defect in this PR.

### Test 5 — code or claim

The finding is real, reachable, and introduced here. If it does not contradict a claim in the PR description, **fix the code**. If it does, trace the claim to the issue the PR closes:

- The issue demands the claim: **fix the code**.
- The claim is author-added, or there is no linked issue: fix the code or shrink the claim, whichever leaves the smaller diff.
- The issue demands the claim and the requirement looks wrong: stop and ask the user. Never edit the issue.

Shrinking a claim means editing the PR description and stating the change in the reply.

## Phase 3 — Fix what earned a fix

For each finding in the **fix** bucket:

1. Reproduce the finding as a failing test against real callers. If no such test can be written, return the finding to Phase 2 as a decline.
2. Make the smallest change that passes. Prefer deleting or narrowing over adding. A defensive branch requires both a test that fails without it and a caller that can reach it.
3. Check that reverting the fix fails exactly the new test.
4. When the accumulated response diff nears a third of the PR's own diff, stop. Shrink a claim or move the rest to a follow-up issue.

## Phase 4 — Answer every thread

No finding is skipped silently.

Accepting:

- Confirm it plainly: "Confirmed and fixed in `<commit>` — this was real."
- State the reproduction: what the failing test asserts and how it failed before the fix.
- Add what the bot's analysis missed, if anything.

Declining:

- Disclosed tradeoff: one sentence pointing at the PR section that covers it.
- Unreachable scenario: name the caller or input that would have to exist first.
- Intended behavior: "This is intended" plus the reason.

Routing: link the follow-up issue in the reply, with one line on why it is separate work.

## Signals

| Signal in the finding | Verdict |
|---|---|
| Contradicts a claim the PR description makes | Real — run Test 5 |
| Names an existing consumer of changed code (shared component, pooled worker) | Real — fix |
| Comes with a concrete failure sequence you can script | Real — fix |
| "No action required" / "for the record" / "consider" / "latent" | Decline |
| Restates a "Not in this PR" item or documented tradeoff | Decline |
| Needs a caller, input, or implementation that does not exist | Decline |
| Defect also present on `main` without this diff | Follow-up issue |
| "Also fix these other places" | Follow-up issue |

A "Not in this PR" line or a stated tradeoff in the PR description turns a finding into a one-sentence decline. Write those sections before requesting review.
