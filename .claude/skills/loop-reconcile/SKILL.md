---
name: loop-reconcile
description: Autonomously compute the gap between an ideal-state doc and the codebase, then file the next work issues — or a loop-complete or loop-needs-discussion report.
disable-model-invocation: true
---

# Loop: reconcile

Goal end-state: the next deliverable chunk of the gap between the doc and the codebase exists as issues, awaiting `ready-for-agent`, or one report explains why not.

This is the autonomous half of the reconciliation loop. When launched from a session, run it in a background agent. It runs headless: never ask the user a question mid-run. Every ambiguity resolves to "stop and file a report", never "do something plausible". Every report reads standalone on GitHub and never depends on chat context.

All work state lives in the GitHub repository itself: issues, labels, and milestones. No project board. Every issue this skill files carries two labels: `loop-reconcile`, the mark that the loop owns it, and a scope label `loop:<doc-stem>` naming its source doc — `loop:people` for `docs/northstars/people.md`. Reports also carry `loop-complete` or `loop-needs-discussion`. If a label is missing from the repository, create it.

Args: an ideal-state doc under `docs/northstars/`, and optionally a repository milestone.

- Given a milestone, reconcile against the milestone description. First check that the doc still backs every milestone statement: if one contradicts the doc, or the doc no longer asks for it at all, file a `loop-needs-discussion` report and stop. The doc wins on intent, and a milestone that fell behind it needs a session, not work.
- Given no milestone, reconcile against the doc's Statements section and file issues attached to no milestone.
- Only the Statements list has authority. The rest of the doc is illustration.

## Inputs and precedence

| Source | Role | Authority |
| --- | --- | --- |
| Ideal-state doc | What should be | Wins on intent |
| Codebase | What is | Wins on facts |
| Issue tracker | What is in flight | None — it gates and remembers |

- The tracker never influences what to scope. It only gates whether to scope.
- Do not read PR or git history to guess intent. If a gap looks like a deliberate move away from the doc, scope it anyway. The human withholds `ready-for-agent` and fixes the doc.
- Concurrency belongs to the driver. Assume this run is alone.

## Authority

- Allowed: create issues, comment, and revise or withdraw issues that carry `loop-reconcile` plus this run's scope label and not `ready-for-agent`.
- Never: apply `ready-for-agent`, create or advance milestones, close an issue labeled `ready-for-agent`, touch an issue outside this run's scope label, or edit the ideal-state doc.
- Anything a human approved is frozen. Issues labeled `ready-for-agent` and milestones change only by human hand.

## Procedure

1. Guard. Read the open issues carrying `loop-reconcile` and this run's scope label.
   - If one is labeled `ready-for-agent` or is in progress, file nothing. Print a pointer to it and stop.
   - If none carries `ready-for-agent`, re-check each against the gap computed below. If they hold, stop. If they are stale, revise or withdraw them, then continue.
2. Compute the gap. Walk the Statements list one claim at a time against the code. Record each as holds, with evidence, or fails, with the shortest path to make it hold.
3. Exit by what the walk found.
   - A statement cannot be checked, or two statements cannot both hold: the doc is broken. File a `loop-needs-discussion` report naming the statements, and file nothing else. The doc gets fixed in a `loop-northstar` session, never by this run.
   - Zero gap: file a `loop-complete` report walking each statement with its evidence and naming what it checked — the doc, or the milestone. Never advance to the next milestone.
   - More than about four chunks, or crossing a contract boundary: file a `loop-needs-discussion` report calling for a milestone session and sketching a possible slicing. Never scope and plan in the same run.
   - Otherwise: scope chunks by the rules below and file them as issues.

## Scoping rules

- A chunk fits one reviewable PR.
- Change a shared contract by expand and contract: add the new alongside the old, and move consumers in later chunks. If the contract and all its consumers fit one chunk, change it in place.
- The chunk that removes the last consumer of a replaced thing also deletes it. Dead code is noise to the next gap computation.
- When an issue states a fact about the code, it names the file that shows it. The reader verifies by looking, not by searching. This caps nothing — a chunk touches as many files as one reviewable PR allows.
- File several issues only when the chunks are parallel: disjoint files, no shared contract. Never file a dependency chain — a chained issue is a stored prediction that goes stale.
- Issues follow [the issue format](../../../docs/authoring/github-issues.md), attach to the milestone when one is given, and stand alone without the doc.
- Never apply `ready-for-agent`.

## Exits

Every run ends in exactly one: issues filed, a `loop-complete` report, or a `loop-needs-discussion` report. A report is an issue carrying its label.
