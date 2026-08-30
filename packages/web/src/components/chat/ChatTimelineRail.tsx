import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  layoutTimelineNodes,
  MIN_NODE_GAP_PX,
  sameNodes,
  shouldShowTimeline,
  summarizeQuestion,
  type MeasuredAnchor,
  type TimelineNode,
  type TimelineQuestion,
} from "@/components/chat/chat-timeline";

// Re-measuring is trailing-debounced: a streamed reply grows the content on
// every token, and measuring N anchors forces a layout flush each time.
const MEASURE_DEBOUNCE_MS = 150;

const EMPTY: TimelineNode[] = [];

// Matches how the sidebar remembers its own collapse (RomeShellLayout).
const HIDDEN_KEY = "rome-timeline-hidden";

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export interface ChatTimelineRailProps {
  /** The chat's single scrolling node. */
  scroller: HTMLElement | null;
  /**
   * The growing content wrapper inside the scroller. Observed separately
   * because content height changes do not resize the scroller itself, so a
   * ResizeObserver on the scroller alone would never fire and the dots would go
   * stale mid-conversation.
   */
  content: HTMLElement | null;
  questions: TimelineQuestion[];
  onJump: (messageId: string) => void;
}

/**
 * A faint column of dots down the right gutter of the transcript — one per past
 * user question. Hovering names the question, clicking jumps to it.
 *
 * Deliberately the quietest thing on screen: 4px dots at 40% opacity and no
 * connecting line. Nothing here moves or resizes on its own — the only motion
 * is a dot growing under the cursor, which the reader asked for by pointing at
 * it. That is why there is no scroll-following "current position" dot: motion
 * nobody invited is what pulls the eye off the text.
 */
export function ChatTimelineRail({ scroller, content, questions, onJump }: ChatTimelineRailProps) {
  const { t } = useTranslation("chat");
  const [nodes, setNodes] = useState<TimelineNode[]>(EMPTY);
  const [hidden, setHidden] = useState(readHidden);
  // The dots are positioned as a percentage of THIS element, so the layout math
  // is given this element's height rather than the scroller's. Measuring the
  // track directly is what keeps the computed and painted positions in one
  // coordinate space.
  const trackRef = useRef<HTMLDivElement | null>(null);
  // The column is one composite control, not forty. Only the roving dot is in
  // the tab order; arrows move between dots from there. Tabbing every dot would
  // bury the rest of the page behind dozens of stops in exactly the long chats
  // this exists for, and dropping them from the tab order altogether would
  // leave the transcript with no keyboard route back to an earlier question.
  const [rovingIndex, setRovingIndex] = useState(0);
  const dotRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!scroller) {
      setNodes((prev) => (prev.length === 0 ? prev : EMPTY));
      return;
    }
    let timer = 0;

    /** Lays the dots out, and reports whether there are any. */
    const measure = (): boolean => {
      const track = trackRef.current;
      // A zero-height track means the rail is CSS-hidden below its breakpoint,
      // where the sweep below can only ever produce nothing. Checking it first
      // keeps a narrow viewport from paying for a forced layout on every
      // debounce tick of a streaming reply.
      if (
        !track ||
        track.clientHeight === 0 ||
        !shouldShowTimeline(questions.length, {
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
        })
      ) {
        setNodes((prev) => (prev.length === 0 ? prev : EMPTY));
        return false;
      }
      // Rects rather than offsetTop: SelectableRow makes rows `relative` in
      // share mode, which would silently re-parent offsetTop onto the row.
      const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
      // One sweep into a map, rather than a selector query per question: it is
      // a single DOM traversal instead of N, and it keeps message ids out of a
      // selector string entirely.
      const elements = new Map<string, HTMLElement>();
      for (const el of scroller.querySelectorAll<HTMLElement>("[data-timeline-anchor]")) {
        const id = el.getAttribute("data-timeline-anchor");
        if (id) elements.set(id, el);
      }
      const anchors: MeasuredAnchor[] = [];
      for (const question of questions) {
        const el = elements.get(question.messageId);
        if (!el) continue;
        anchors.push({ messageId: question.messageId, top: el.getBoundingClientRect().top - base });
      }
      const next = layoutTimelineNodes(anchors, {
        contentHeight: scroller.scrollHeight,
        trackHeight: track.clientHeight,
        minGapPx: MIN_NODE_GAP_PX,
      });
      setNodes((prev) => (sameNodes(prev, next) ? prev : next));
      return next.length > 0;
    };

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, MEASURE_DEBOUNCE_MS);
    };

    // Always measure once, even while hidden: the node count is what decides
    // whether the show control renders at all, and skipping this would strand a
    // reader who hid the rail and then reloaded with no way to bring it back.
    const anyDots = measure();
    // With dots to keep, a hidden column has nothing left to stay in sync with,
    // and a streaming reply would otherwise drive a layout flush plus a
    // re-render every debounce tick for something not on screen. Unhiding
    // re-runs this effect, so the dots are measured fresh when they return.
    //
    // With NO dots the observer has to stay: the rail may still become eligible
    // — a wider viewport, a transcript that grows past two screens — and the
    // show control has to appear when it does rather than waiting for the next
    // message or a reload.
    if (hidden && anyDots) return () => window.clearTimeout(timer);

    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    if (content && content !== scroller) observer.observe(content);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [scroller, content, questions, hidden]);

  // Clamped rather than reset: questions arrive while the chat runs, and the
  // caret should not jump back to the top each time one does.
  const activeDot = Math.min(rovingIndex, Math.max(nodes.length - 1, 0));

  const onDotKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const last = nodes.length - 1;
      let next: number;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") next = Math.min(index + 1, last);
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = Math.max(index - 1, 0);
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = last;
      else return;
      event.preventDefault();
      setRovingIndex(next);
      dotRefs.current[next]?.focus();
    },
    [nodes.length],
  );

  const toggleHidden = useCallback(() => {
    setHidden((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(HIDDEN_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  // The track stays mounted even with nothing to show. `measure` reads its
  // height, so an early return here would leave `trackRef` null, which would
  // make the measurement bail, which would keep `nodes` empty — the rail would
  // never appear at all. Only the contents are conditional.
  const empty = nodes.length === 0;

  return (
    // A dot's centre sits 24px in from the container's right edge — far enough
    // that its 14px hit target clears a 15px classic scrollbar entirely, so the
    // scrollbar stays grabbable on Windows and Linux where it is a real control.
    //
    // The other side used to be the binding constraint: the transcript is
    // `mx-auto max-w-5xl`, so once the container drops under 1024px the body
    // fills it and a bubble's edge runs straight into the dots. Chat now gives
    // the scroller a matching right inset under the SAME query, which opens a
    // permanent lane for the rail — so this gate is only about whether the
    // surface is big enough to be worth navigating, not about whether the dots
    // fit. Keep the two queries in sync: Chat.tsx's `pr-8` is what makes any
    // width below 1024 safe.
    //
    // The container is `transcript`, declared on Chat's scroller wrapper — NOT
    // `chat`, which is declared on an outer element that never narrows when the
    // trace drawer takes its 480px.
    //
    // Pointer events stay off the whole strip and are re-enabled only on the
    // dots, so the native scrollbar and the composer's right edge remain
    // grabbable underneath.
    <div
      // No landmark until there is a timeline inside it. Short chats are the
      // common case, and an empty named region is something a screen-reader
      // user lands in and finds nothing.
      role={empty ? undefined : "navigation"}
      aria-label={empty ? undefined : t("timeline.label")}
      className="group pointer-events-none absolute inset-y-0 right-0 z-10 hidden w-8 @min-[48rem]/transcript:block"
    >
      {/* One tab stop, unlike the dots — this is a real control, so it takes
          focus and draws the design system's focus ring. It sits in the band the
          track leaves free at the top, so it never shares a row with a dot. */}
      {empty ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleHidden}
              aria-label={hidden ? t("timeline.show") : t("timeline.hide")}
              aria-expanded={!hidden}
              className="pointer-events-auto absolute top-6 right-6 flex size-6 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full text-muted-foreground opacity-30 transition-opacity duration-200 ease-out group-hover:opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring motion-reduce:transition-none"
            >
              {hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={8}>
            {hidden ? t("timeline.show") : t("timeline.hide")}
          </TooltipContent>
        </Tooltip>
      )}
      {/* Starts below the control's band and stops well above the sticky
          composer, so no dot ever paints on either.

          Hiding slides the column out to the right and fades it, rather than
          unmounting it, so the effect runs in both directions. `visibility`
          carries the safety: it flips discretely at the END of the transition,
          so the dots stay painted while they slide away and stop taking pointer
          events the instant they are gone. `aria-hidden` takes them out of the
          accessibility tree at the same time. */}
      <div
        ref={trackRef}
        data-timeline-track
        aria-hidden={hidden}
        className={`absolute top-16 right-0 bottom-32 w-8 transition-[opacity,translate,visibility] duration-200 ease-out motion-reduce:transition-none ${
          hidden ? "invisible translate-x-6 opacity-0" : "visible translate-x-0 opacity-100"
        }`}
      >
        {empty
          ? null
          : nodes.map((node, index) => {
              const question = questions.find((q) => q.messageId === node.messageId);
              if (!question) return null;
              const label = summarizeQuestion(question.text);
              return (
                <Tooltip key={node.messageId}>
                  <TooltipTrigger asChild>
                    {/* A bare <button>, never the ui-kit Button: the /chat layout
                    invariant sweep measures every [data-slot="button"] for
                    vertical centring and sibling-uniform heights, which a
                    free-positioned dot fails by construction. The label is the
                    question alone — Radix already wires the tooltip as
                    aria-describedby, so a "jump to" prefix would make a screen
                    reader add a prefix to a question it announces twice
                    regardless: Radix wires the tooltip as the description while
                    this is the name, so both carry the question. Naming the
                    action instead would not remove the repetition, only pad it.

                    Focus is styled like hover, so the dot under the caret
                    reads like the one under the cursor. Only the roving dot is
                    tabbable; hidden dots leave the tab order entirely, so
                    nothing focusable ever sits inside `aria-hidden`. */}
                    <button
                      type="button"
                      ref={(el) => {
                        dotRefs.current[index] = el;
                      }}
                      tabIndex={hidden || index !== activeDot ? -1 : 0}
                      aria-label={label}
                      onKeyDown={(event) => onDotKeyDown(event, index)}
                      onFocus={() => setRovingIndex(index)}
                      onClick={() => onJump(node.messageId)}
                      style={{ top: `${node.fraction * 100}%` }}
                      className="pointer-events-auto absolute right-6 size-3.5 -translate-y-1/2 translate-x-1/2 rounded-full before:absolute before:inset-[5px] before:rounded-full before:scale-100 before:bg-muted-foreground before:opacity-40 before:transition-[opacity,scale] before:duration-200 before:ease-out motion-reduce:before:transition-none group-hover:before:opacity-70 hover:before:scale-150 hover:before:opacity-100 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring focus-visible:before:scale-150 focus-visible:before:opacity-100"
                    />
                  </TooltipTrigger>
                  {/* The offset clears the dot: TooltipContent's arrow is 10px
                  rotated 45°, which at the default offset of 0 would land on
                  top of a 4px dot. */}
                  <TooltipContent side="left" sideOffset={8}>
                    {label}
                  </TooltipContent>
                </Tooltip>
              );
            })}
      </div>
    </div>
  );
}
