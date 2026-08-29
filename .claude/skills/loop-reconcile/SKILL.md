---
name: loop-reconcile
description: Autonomously compute the gap between an ideal-state doc and the codebase, then file the next work issues — or a milestone-complete or needs-discussion report.
disable-model-invocation: true
---

# Loop: reconcile

Goal end-state: the next deliverable chunk of the gap between the doc and the codebase exists as issues on the board, awaiting `ready-for-agent`, or one report explains why not.

This is the autonomous half of the reconciliation loop. When launched from a session, run it in a background agent. It runs headless: never ask the user a question mid-run. Every ambiguity resolves to "stop and file a report", never "do something plausible". Every report reads standalone on the board and never depends on chat context.

Args: an ideal-state doc under `docs/northstars/`, and optionally a milestone. Given a milestone, reconcile against the milestone description instead of the full doc. Only the Statements list — the doc's Statements section, or the milestone description's — has authority. The rest of the doc is illustration.

## Inputs and precedence

| Source | Role | Authority |
| --- | --- | --- |
| Ideal-state doc | What should be | Wins on intent |
| Codebase | What is | Wins on facts |
| Board | What is in flight | None — it gates and remembers |

- The board never influences what to scope. It only gates whether to scope.
- Do not read PR or git history to guess intent. If a gap looks like a deliberate move away from the doc, scope it anyway. The human withholds `ready-for-agent` and fixes the doc.
- Concurrency belongs to the driver. Assume this run is alone.

## Authority

- Allowed: create issues, add them to the board, comment, and revise or withdraw this loop's own issues while they carry no `ready-for-agent` label.
- Never: apply `ready-for-agent`, create or advance milestones, close an issue labeled `ready-for-agent`, or edit the ideal-state doc.
- Anything a human approved is frozen. Issues labeled `ready-for-agent` and milestones change only by human hand.

## Procedure

1. Guard. Read the board for the given scope.
   - If an open issue is labeled `ready-for-agent` or is in progress, file nothing. Print a pointer to it and stop.
   - If the open issues carry no `ready-for-agent` label, re-check each against the gap computed below. If they hold, stop. If they are stale, revise or withdraw them, then continue.
2. Compute the gap. Walk the Statements list one claim at a time against the code. Record each as holds, with evidence, or fails, with the shortest path to make it hold.
3. Exit by what the walk found.
   - A statement cannot be checked, or two statements cannot both hold: the doc is broken. File an issue labeled `needs-discussion` naming the statements, and file nothing else. The doc gets fixed in a `loop-northstar` session, never by this run.
   - Zero gap: file an issue labeled `milestone-complete` walking each statement with its evidence. Never advance to the next milestone.
   - More than about four chunks, or crossing a contract boundary: file an issue labeled `needs-discussion` calling for a milestone session and sketching a possible slicing. Never scope and plan in the same run.
   - Otherwise: scope chunks by the rules below and file them as issues.

## Scoping rules

- A chunk fits one reviewable PR.
- Change a shared contract by expand and contract: add the new alongside the old, and move consumers in later chunks. If the contract and all its consumers fit one chunk, change it in place.
- The chunk that removes the last consumer of a replaced thing also deletes it. Dead code is noise to the next gap computation.
- When an issue states a fact about the code, it names the file that shows it. The reader verifies by looking, not by searching. This caps nothing — a chunk touches as many files as one reviewable PR allows.
- File several issues only when the chunks are parallel: disjoint files, no shared contract. Never file a dependency chain — a chained issue is a stored prediction that goes stale.
- Issues follow [the issue format](../../../docs/authoring/github-issues.md), attach to the given milestone, and stand alone without the doc.
- Never apply `ready-for-agent`.

## Exits

Every run ends in exactly one: issues filed, a `milestone-complete` report, or a `needs-discussion` report.
