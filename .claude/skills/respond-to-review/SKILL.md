---
name: respond-to-review
description: Triage and answer automated code-review findings on a PR without growing its scope. Use when the user asks to "handle / address / respond to review feedback", "go through the bot comments", or after the RomeOS review bots (zoolsher, Jessie-QingYu) post findings on a PR. Classify every finding before writing any code — most findings deserve a reply, not a diff. NOT for requesting a review (that is /code-review) and NOT for reviewing someone else's PR.
---

# Respond to review feedback

Goal end-state: every finding on the PR has exactly one of four answers — a minimal fix with a test, a corrected claim in the PR description, a follow-up issue, or a written decline. The PR's diff grows as little as possible.

The bots present real defects and noise in the same authoritative voice. The default response to a finding is to add code — for an input nothing produces, a caller that does not exist, or a scope the PR excluded on purpose. So classification precedes code. Never start implementing a finding before classifying it.

## Phase 1 — Gather and dedupe

Pull every review body and inline comment on the PR:

```bash
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
gh pr view <PR> -R "$REPO" --json reviews --jq '.reviews[] | "[\(.author.login) / \(.state)]\n\(.body)"'
gh api "repos/$REPO/pulls/<PR>/comments" --paginate --jq '.[] | "[\(.user.login) on \(.path):\(.line // .original_line)]\n\(.body)"'
```

1. Drop reviews marked "This review has been superseded."
2. Merge duplicate findings — same file, same defect — into one item. Post the answer once and cross-link it from the other thread.
3. Discard the bots' severity labels and verdicts. Severity does not predict which findings are real. Phase 2 re-derives it from evidence.

## Phase 2 — Classify every finding

Run each finding through these tests in order. The first test that matches decides the bucket.

### Test 1 — the bot hedged

If the finding contains "no action required", "flagging for the record", "consider", "worth noting", "latent today", "optional", "acceptable", or "retained deliberately", the bot found nothing actionable. Bucket: **decline**, with a one-line acknowledgment.

### Test 2 — the PR already disclosed it

If the finding restates a "Not in this PR" item, a stated tradeoff, or a documented transitional state, the decision is already made in the open. Bucket: **decline**, pointing at the section that covers it.

### Test 3 — no caller can reach it

A real finding names a defect reachable today: on `main` plus this diff, with the callers and inputs that exist. Ask what concrete caller, with what concrete input, hits the defect. If the answer needs a future adapter, a third-party implementation, an input no caller produces, or a scale nothing is wired to reach, the defect cannot happen. Bucket: **decline**, stating what would have to exist first. If the concern matters later, one sentence in the interface contract or a follow-up issue records it. Code does not.

### Test 4 — the defect predates the diff

If the defect exists on `main` without this diff — "other entrypoints have the same problem", "the release process must also move" — it is adjacent work, not review response. Bucket: **follow-up issue**, linked from the reply.

One exception: if the PR's own contract makes the old defect load-bearing, fix it in this PR. In #107, the PR claimed parity with old code, so an old bug became a liability on both sides of the migration.

### Test 5 — code or claim

The finding is real, reachable, and introduced here. The bots audit the PR description's own claims well. When a finding attacks a claim, two fixes exist — change the code to honor the claim, or shrink the claim — and the choice is not free.

**Trace the claim to the issue the PR closes.**

- The issue demands the claim, in its acceptance criteria or as its reason to exist: the claim is a requirement. **Fix the code.** A shrunken claim means the PR no longer closes the issue. In #114, "the directory reads no message store" was the point of issue #113, so the only valid answer to a leftover read was code.
- The claim is author-added, a promise on top of what the issue asked for: fix or shrink, **whichever leaves the smaller diff**. Shrinking means editing the PR description and saying so in the reply, never quietly. In #91, instant key propagation to warm workers was a self-imposed promise. Shrinking it to "on next worker recycle" was a legitimate option.
- No linked issue: every claim is author-owned and may shrink, but only to be honest, never to dodge. If the shrunken claim makes the PR pointless, the finding is real and demands code.
- The claim is in the issue, but the issue is yours and the requirement was arbitrary: change the issue first, in the open, then shrink.

## Phase 3 — Fix what earned a fix

For each finding in the **fix** bucket:

1. Reproduce the finding as a failing test against real callers. If no such test can be written, return the finding to Phase 2 as a decline.
2. Make the smallest change that passes. Prefer deleting or narrowing over adding. A defensive branch requires both a test that fails without it and a caller that can reach it.
3. Check that reverting the fix fails exactly the new test.
4. Watch the accumulated response diff. When it nears a third of the PR's own diff, stop — the work is scope growth, and every added line is new surface for the next review round. Shrink a claim or move the rest to a follow-up issue.

## Phase 4 — Answer every thread

No finding is skipped silently. The written decline is what stops the same finding from recurring on the next PR.

Accepting — match the tone of the replies on #86 and #107:

- Confirm it plainly: "Confirmed and fixed in `<commit>` — this was real."
- State the reproduction: what the failing test asserts and how it failed before the fix.
- Add what the bot's analysis missed, if anything — a worse failure mode, a second call site given the same guard.

Declining:

- Disclosed tradeoff: one sentence pointing at the PR section that covers it.
- Unreachable scenario: name the caller or input that would have to exist first, and where the concern is recorded if it is worth recording.
- Intended behavior: "This is intended" plus the reason is a complete reply.

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

A thorough PR description makes this skill cheap to run. Every "Not in this PR" line and stated tradeoff turns a potential debate into a one-sentence decline. Write those sections before requesting review.
