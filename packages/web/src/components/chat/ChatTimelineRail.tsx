import { useEffect, useRef, useState } from "react";
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
 * Deliberately the quietest thing on screen: 4px dots at 40% opacity, no
 * connecting line, and opacity as the only transition. Nothing here moves or
 * changes size while the user reads.
 */
export function ChatTimelineRail({ scroller, content, questions, onJump }: ChatTimelineRailProps) {
  const { t } = useTranslation("chat");
  const [nodes, setNodes] = useState<TimelineNode[]>(EMPTY);
  // The dots are positioned as a percentage of THIS element, so the layout math
  // is given this element's height rather than the scroller's. Measuring the
  // track directly is what keeps the computed and painted positions in one
  // coordinate space.
  const trackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!scroller) {
      setNodes((prev) => (prev.length === 0 ? prev : EMPTY));
      return;
    }
    let timer = 0;

    const measure = () => {
      const track = trackRef.current;
      if (
        !track ||
        !shouldShowTimeline(questions.length, {
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
        })
      ) {
        setNodes((prev) => (prev.length === 0 ? prev : EMPTY));
        return;
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
    };

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, MEASURE_DEBOUNCE_MS);
    };

    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    if (content && content !== scroller) observer.observe(content);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [scroller, content, questions]);

  return (
    // Hidden below @6xl (1152px): under that the transcript's max-w-5xl body
    // reaches the container edge and the dots would sit ~8px off the user's own
    // bubbles. The container is `transcript`, declared on Chat's scroller
    // wrapper — NOT `chat`, which is declared on an outer element that never
    // narrows when the trace drawer takes its 480px.
    //
    // Pointer events stay off the whole strip and are re-enabled only on the
    // dots, so the native scrollbar and the composer's right edge remain
    // grabbable underneath.
    <div
      aria-label={t("timeline.label")}
      className="pointer-events-none absolute inset-y-0 right-0 z-10 hidden w-8 @6xl/transcript:block"
    >
      {/* Stops well above the sticky composer so no dot ever paints on it. */}
      <div
        ref={trackRef}
        data-timeline-track
        className="group absolute right-0 top-8 bottom-32 w-8"
      >
        {nodes.map((node) => {
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
                    reader announce the question twice. */}
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={label}
                  onClick={() => onJump(node.messageId)}
                  style={{ top: `${node.fraction * 100}%` }}
                  className="pointer-events-auto absolute right-4 size-3.5 -translate-y-1/2 translate-x-1/2 rounded-full before:absolute before:inset-[5px] before:rounded-full before:bg-muted-foreground before:opacity-40 before:transition-opacity group-hover:before:opacity-70 hover:before:opacity-100"
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
