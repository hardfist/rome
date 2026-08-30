// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatTimelineRail } from "./ChatTimelineRail";
import type { TimelineQuestion } from "./chat-timeline";

afterEach(() => cleanup());

const QUESTIONS: TimelineQuestion[] = [
  { messageId: "q1", text: "how do I ship this?" },
  { messageId: "q2", text: "what broke the build?" },
  { messageId: "q3", text: "why is it slow?" },
  { messageId: "q4", text: "can we cache it?" },
];

function rect(top: number, height = 0): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

// jsdom has no layout: every rect is zero and scrollHeight/clientHeight are 0,
// which would trip the rail's gates before any of its wiring ran. Stub the
// metrics so what is under test is the component's own behaviour; the geometry
// itself is covered with plain numbers in chat-timeline.test.ts.
function stubScroller(anchors: Array<{ id: string; top: number }>): HTMLElement {
  const scroller = document.createElement("div");
  for (const anchor of anchors) {
    const el = document.createElement("div");
    el.setAttribute("data-timeline-anchor", anchor.id);
    el.getBoundingClientRect = () => rect(anchor.top);
    scroller.appendChild(el);
  }
  scroller.getBoundingClientRect = () => rect(0, 600);
  Object.defineProperty(scroller, "scrollHeight", { value: 3000, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
  Object.defineProperty(scroller, "scrollTop", { value: 0, writable: true, configurable: true });
  document.body.appendChild(scroller);
  return scroller;
}

const SPREAD_ANCHORS = [
  { id: "q1", top: 0 },
  { id: "q2", top: 600 },
  { id: "q3", top: 1200 },
  { id: "q4", top: 1800 },
];

/**
 * Render, then give the track a height and re-run the measurement.
 *
 * The track's own `clientHeight` drives the layout (that is what keeps the
 * computed and painted positions in one coordinate space), and jsdom reports 0
 * for it until it is stubbed — which cannot happen before the first render. The
 * second pass hands the effect a fresh `questions` identity so it re-measures
 * against the stubbed height, which is the path that ships.
 */
function renderRail(
  scroller: HTMLElement | null,
  questions: TimelineQuestion[],
  onJump: (messageId: string) => void = () => {},
) {
  // The rail lives inside Chat's single TooltipProvider (Chat.tsx), which owns
  // the shared hover delay — it deliberately does not nest one of its own.
  const view = render(
    <TooltipProvider>
      <ChatTimelineRail
        scroller={scroller}
        content={scroller}
        questions={questions}
        onJump={onJump}
      />
    </TooltipProvider>,
  );
  const track = view.container.querySelector<HTMLElement>("[data-timeline-track]");
  if (track) Object.defineProperty(track, "clientHeight", { value: 500, configurable: true });
  view.rerender(
    <TooltipProvider>
      <ChatTimelineRail
        scroller={scroller}
        content={scroller}
        questions={[...questions]}
        onJump={onJump}
      />
    </TooltipProvider>,
  );
  return view;
}

describe("ChatTimelineRail", () => {
  it("renders one dot per question, labelled with its text", () => {
    renderRail(stubScroller(SPREAD_ANCHORS), QUESTIONS);
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "how do I ship this?" })).toBeTruthy();
  });

  it("jumps to the question a dot points at", () => {
    const onJump = vi.fn();
    renderRail(stubScroller(SPREAD_ANCHORS), QUESTIONS, onJump);
    fireEvent.click(screen.getByRole("button", { name: "what broke the build?" }));
    expect(onJump).toHaveBeenCalledWith("q2");
  });

  it("keeps every question clickable when they crowd together", () => {
    // All four within 12px of content. They spread down the track instead of
    // merging, so none becomes unreachable — the whole point of spreading.
    const onJump = vi.fn();
    renderRail(
      stubScroller([
        { id: "q1", top: 0 },
        { id: "q2", top: 4 },
        { id: "q3", top: 8 },
        { id: "q4", top: 12 },
      ]),
      QUESTIONS,
      onJump,
    );
    expect(screen.getAllByRole("button")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "can we cache it?" }));
    expect(onJump).toHaveBeenCalledWith("q4");
  });

  it("stays out of the tab order", () => {
    // ~40 dots would otherwise add ~40 tab stops to the chat. ⌘K search is the
    // keyboard path to a message.
    renderRail(stubScroller(SPREAD_ANCHORS), QUESTIONS);
    for (const dot of screen.getAllByRole("button")) {
      expect(dot.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("renders no dots below the question floor", () => {
    const { container } = renderRail(
      stubScroller(SPREAD_ANCHORS.slice(0, 2)),
      QUESTIONS.slice(0, 2),
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("renders no dots when the transcript fits on one screen", () => {
    const scroller = stubScroller(SPREAD_ANCHORS);
    Object.defineProperty(scroller, "scrollHeight", { value: 700, configurable: true });
    const { container } = renderRail(scroller, QUESTIONS);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("renders no dots without a scroller", () => {
    const { container } = renderRail(null, QUESTIONS);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
