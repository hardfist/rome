import { userMessageText } from "@/components/chat/chat-view";
import type { ChatMessage } from "@/lib/chat-types";

// The pure model behind the question timeline rail. It never touches the DOM:
// the rail hands it measured pixels and gets back fractions. jsdom reports zero
// for every rect, so this split is what makes the layout rules testable at all.

/** Below this many questions the rail is not worth its pixels. */
export const MIN_TIMELINE_QUESTIONS = 4;

/** Minimum on-track distance between two dots, in px. */
export const MIN_NODE_GAP_PX = 8;

const SUMMARY_MAX_CHARS = 60;

/** Sub-pixel drift that must not trigger a re-render. */
const FRACTION_EPSILON = 0.002;

export interface TimelineQuestion {
  messageId: string;
  /** The question's plain text, exactly as the bubble renders it. */
  text: string;
}

/** A question's measured offset from the top of the scrollable content. */
export interface MeasuredAnchor {
  messageId: string;
  top: number;
}

export interface TimelineNode {
  messageId: string;
  /** 0..1 position down the TRACK — used directly as a CSS percentage. */
  fraction: number;
}

/**
 * Every question the rail can point at: user turns that actually render a
 * bubble, in transcript order.
 *
 * Deliberately not filtered to the main session. While a handoff is open the
 * composer posts to the child session, so a filter would drop every question
 * asked during that handoff — a whole stretch of the conversation missing from
 * the rail with nothing to explain the gap. Those rows are spliced into
 * `displayMessages` and carry their own anchors, so they are addressable like
 * any other. Share selection does filter by session, but that decides which
 * turns can be frozen into a link, not what can be scrolled to.
 *
 * Text-less user turns are excluded because `UserMessage` returns null for
 * them, so there would be no anchor. The suppressed handoff seed is already
 * absent from `displayMessages`.
 */
export function buildTimelineQuestions(messages: ChatMessage[]): TimelineQuestion[] {
  const questions: TimelineQuestion[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = userMessageText(message.content).trim();
    if (!text) continue;
    questions.push({ messageId: message.id, text });
  }
  return questions;
}

/**
 * A one-line label. You need enough to recognise a question you wrote, not to
 * re-read it — 60 chars keeps the tooltip to one line at typical lengths, and
 * keeps the Chinese build from rendering an essay in a 320px box.
 */
export function summarizeQuestion(text: string, maxChars = SUMMARY_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/** The rail is for chats you cannot scan by scrolling. */
export function shouldShowTimeline(
  questionCount: number,
  metrics: { scrollHeight: number; clientHeight: number },
): boolean {
  if (questionCount < MIN_TIMELINE_QUESTIONS) return false;
  if (metrics.clientHeight <= 0) return false;
  return metrics.scrollHeight >= metrics.clientHeight * 2;
}

/**
 * Project anchors onto the track, pushing any dot that would crowd its
 * predecessor further down.
 *
 * Spreading, not merging. Merging crowded dots into one node makes the
 * swallowed questions unreachable by click while looking identical to a
 * lossless dot — the rail would lie, in exactly the long conversations it
 * exists for. Spreading trades local positional fidelity for the guarantee that
 * every question stays individually clickable.
 *
 * Two passes, because one is not enough. The forward pass pushes each crowded
 * dot below its predecessor. On its own that collapses at the bottom edge: a
 * run of questions near the end of the transcript is pushed past the track and
 * clamped, so several dots land on the same pixel and all but one become
 * unclickable — the exact failure spreading exists to avoid. The backward pass
 * pulls such a run back up, which the track has room for whenever the dots fit
 * at all.
 *
 * When they do not fit — more questions than `trackHeight / minGapPx`, which a
 * long chat in a short window reaches — the gap tightens so the whole set still
 * spans the track. Every dot keeps a distinct centre and a sliver of itself to
 * click. Holding the gap fixed instead would push the surplus off the top and
 * clamp it there, stacking those questions on one pixel and making all but the
 * last unreachable.
 */
export function layoutTimelineNodes(
  anchors: MeasuredAnchor[],
  opts: { contentHeight: number; trackHeight: number; minGapPx: number },
): TimelineNode[] {
  const { contentHeight, trackHeight, minGapPx } = opts;
  if (contentHeight <= 0 || trackHeight <= 0) return [];

  const gap =
    anchors.length > 1 ? Math.min(minGapPx, trackHeight / (anchors.length - 1)) : minGapPx;

  const ys: number[] = [];
  let floor = 0;
  for (const anchor of anchors) {
    const natural = Math.min(Math.max(anchor.top / contentHeight, 0), 1) * trackHeight;
    const y = Math.max(natural, floor);
    ys.push(y);
    floor = y + gap;
  }

  let ceiling = trackHeight;
  for (let i = ys.length - 1; i >= 0; i--) {
    if (ys[i] > ceiling) ys[i] = ceiling;
    ceiling = ys[i] - gap;
  }

  return ys.map((y, i) => ({
    messageId: anchors[i].messageId,
    fraction: Math.max(y, 0) / trackHeight,
  }));
}

/**
 * Whether a fresh measurement is worth committing. The rail re-measures on
 * every content resize, which during a streamed reply means many times a
 * second; without this the rail would re-render (and re-render every Radix
 * tooltip root) on drift too small to see.
 */
export function sameNodes(a: TimelineNode[], b: TimelineNode[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (node, i) =>
      node.messageId === b[i].messageId &&
      Math.abs(node.fraction - b[i].fraction) < FRACTION_EPSILON,
  );
}
