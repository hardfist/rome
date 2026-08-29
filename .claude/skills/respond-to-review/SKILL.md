---
name: respond-to-review
description: Triage and answer automated code-review findings on a PR without growing its scope. Use when the user asks to "handle / address / respond to review feedback", "go through the bot comments", or after the RomeOS review bots (zoolsher, Jessie-QingYu) post findings on a PR. The core discipline — classify every finding BEFORE writing any code; most findings deserve a reply, not a diff. NOT for requesting a review (that is /code-review) and NOT for reviewing someone else's PR.
---

# Respond to review feedback

Goal end-state: every review finding on the PR has exactly one of four answers — a minimal fix with a test, a corrected claim in the PR description, a follow-up issue, or a written decline — and the PR's diff grew as little as possible.

The review bots are worth reading and dangerous to obey. Measured over 18 recent PRs (#84–#115): ~43 findings, of which 8–10 were real and worth code. Every P3 was safe to decline. The bots present the noise in the same authoritative voice as the signal, and an agent's default response to any finding is to add code — for a rare input, a caller that does not exist, or a scope the PR deliberately excluded. This skill exists to replace that default with judgment.

**The prime rule: classification precedes code. Never start implementing a finding you have not classified.**

## Phase 1 — Gather and dedupe

Pull every review body and inline comment on the PR:

```bash
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
gh pr view <PR> -R "$REPO" --json reviews --jq '.reviews[] | "[\(.author.login) / \(.state)]\n\(.body)"'
gh api "repos/$REPO/pulls/<PR>/comments" --paginate --jq '.[] | "[\(.user.login) on \(.path):\(.line // .original_line)]\n\(.body)"'
```

- Drop reviews marked "This review has been superseded."
- The two bots overlap. Merge duplicate findings (same file, same defect) into one item; the answer will be posted once and cross-linked from the other thread.
- **Discard the bot's severity labels and verdicts.** A P1 REQUEST_CHANGES has been scope expansion; a P2 has been the realest bug in the batch (#86, #91). Severity is re-derived in Phase 2, from evidence.

## Phase 2 — Classify every finding

Run each finding through these tests, in order. The first test that matches decides the bucket.

### Test 1 — the bot already declined it for you

If the finding contains its own hedge — "no action required", "flagging for the record", "consider", "worth noting", "latent today", "optional", "acceptable", "retained deliberately" — the bot is saying it found nothing actionable. Bucket: **decline** (a one-line acknowledgment).

### Test 2 — the PR already declined it

If the finding restates something the PR description discloses — a "Not in this PR" item, a stated tradeoff, a documented transitional state — the decision was already made in the open. Bucket: **decline**, pointing at the section that covers it. (#108's finding was titled "retained deliberately"; #90's finding re-raised a duplication the PR body spent a paragraph justifying.)

### Test 3 — can it happen?

A real finding names a defect reachable **today**: on `main` plus this diff, with the callers and inputs that exist. Ask: what concrete caller, with what concrete input, hits this? If the answer requires a future adapter, a third-party implementation, an input no caller produces (`limit: 0`, astral-plane Unicode in a ref), or a scale nothing is wired to reach — the defect cannot happen. Bucket: **decline**, stating what would have to exist first. If the concern is real-but-future, one sentence in the interface contract or a follow-up issue covers it; code does not.

### Test 4 — did this PR introduce it?

If the defect is real but exists on `main` without this diff — "other entrypoints have the same problem" (#93), "the release process must also move" (#102) — it is adjacent work, not review response. Bucket: **follow-up issue**, linked from the reply.

One exception, from #107: fix a pre-existing bug in this PR only when the PR's own contract makes it load-bearing — for example, the PR claims parity with the old code, so the old bug becomes a new liability on both sides of the migration.

### Test 5 — code or claim?

The finding is real, reachable, and introduced here. The bots are genuinely good at auditing the PR description's own claims ("on every save, workers read them" vs. forked env snapshots, #91; "no message-store read" vs. a leftover sentinel scan, #114). When a finding attacks a claim, there are two candidate fixes — change the code to honor the claim, or shrink the claim — and the choice is not free:

**Trace the claim to the issue the PR closes.**

- **The issue demands the claim** (it is in the acceptance criteria, or it is the reason the issue exists): the claim is a requirement. **Fix the code.** Shrinking the claim would mean the PR no longer closes the issue. (#114: "the directory reads no message store" was the point of #113 — the only valid answer to the leftover read was code.)
- **The claim is author-added** — a promise on top of what the issue asked for: fix or shrink, **whichever leaves the smaller diff**. Shrinking means editing the PR description honestly and saying so in the reply, never quietly. (#91: instant key propagation to warm workers was a self-imposed promise; shrinking it to "on next worker recycle" was a legitimate option that would have avoided a module-loader mechanism several times the size of the feature.)
- **No linked issue** (cleanup, self-initiated fix): every claim is author-owned and may be shrunk — but only to be honest, never to dodge. If the shrunken claim makes the PR pointless, the finding is real and demands code.
- **The claim is in the issue, but the issue is yours and the requirement was arbitrary**: change the issue first, in the open, then shrink.

## Phase 3 — Fix what earned a fix

For each finding in the **fix** bucket:

1. **Reproduce it as a failing test first.** This is the house style (#86, #107) and it is also the last filter: a finding that cannot be turned into a failing test against real callers goes back to Phase 2 as a decline. The test must bite — reverting the fix must fail exactly that test.
2. **Make the smallest change that passes.** Prefer deleting or narrowing over adding. A defensive branch requires both a test that fails without it and a caller that can reach it.
3. **Hold a diff budget.** If the accumulated response diff approaches a third of the original PR's diff, stop. The response is no longer review response; it is scope growth, and every added line is new surface for the next review round to find P1s in (#91 grew through four rounds this way). Re-scope: shrink a claim, or move work to a follow-up issue.

## Phase 4 — Answer every thread

No finding is skipped silently. The written record of why a finding was declined is what stops it recurring on the next PR.

**Accepting** (match the tone of the replies on #86 and #107):
- Confirm it plainly: "Confirmed and fixed in `<commit>` — this was real."
- State the reproduction: what the failing test asserts and how it failed before the fix.
- Add what the bot's analysis missed, if anything — a worse failure mode, a second call site given the same guard.

**Declining:**
- Disclosed tradeoff: one sentence pointing at the PR section that covers it.
- Unreachable scenario: name the caller or input that would have to exist first, and where the concern is recorded (contract comment, follow-up issue) if it is worth recording.
- Intended behavior: "This is intended" plus the reason is a complete reply.

**Routing:** link the follow-up issue in the reply, with one line on why it is separate work.

## Calibration table

| Signal in the finding | Likely verdict |
|---|---|
| Contradicts a claim the PR description makes | Real — run Test 5 |
| Names an existing consumer of changed code (shared component, pooled worker) | Real — fix |
| Comes with a concrete failure sequence you can script | Real — fix |
| "No action required" / "for the record" / "consider" / "latent" | Decline |
| Restates a "Not in this PR" or documented tradeoff | Decline |
| Requires a caller, input, or implementation that does not exist | Decline |
| Defect also present on `main` without this diff | Follow-up issue |
| "Also fix these other places" | Follow-up issue |

A thorough PR description is what makes this skill cheap to run: every "Not in this PR" line and stated tradeoff turns a potential debate into a one-sentence decline. Write those sections first; they are the cheapest review response there is.
