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
 * The questions the rail can point at: main-session user turns that actually
 * render a bubble. Handoff child turns are excluded for the same reason
 * `mainTurnIds` in Chat.tsx excludes them — they ride along with their parent
 * and are not independently addressable. Text-less user turns are excluded
 * because `UserMessage` returns null for them, so there would be no anchor.
 */
export function buildTimelineQuestions(
  messages: ChatMessage[],
  mainSessionId: string,
): TimelineQuestion[] {
  const questions: TimelineQuestion[] = [];
  for (const message of messages) {
    if (message.role !== "user" || message.sessionId !== mainSessionId) continue;
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
 * at all. Only a genuine overflow (more dots than `trackHeight / minGapPx`)
 * still overlaps, now at the top, where the alternative is dropping questions.
 */
export function layoutTimelineNodes(
  anchors: MeasuredAnchor[],
  opts: { contentHeight: number; trackHeight: number; minGapPx: number },
): TimelineNode[] {
  const { contentHeight, trackHeight, minGapPx } = opts;
  if (contentHeight <= 0 || trackHeight <= 0) return [];

  const ys: number[] = [];
  let floor = 0;
  for (const anchor of anchors) {
    const natural = Math.min(Math.max(anchor.top / contentHeight, 0), 1) * trackHeight;
    const y = Math.max(natural, floor);
    ys.push(y);
    floor = y + minGapPx;
  }

  let ceiling = trackHeight;
  for (let i = ys.length - 1; i >= 0; i--) {
    if (ys[i] > ceiling) ys[i] = ceiling;
    ceiling = ys[i] - minGapPx;
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
