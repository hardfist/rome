import { memo, type ReactNode } from "react";
import { Check } from "lucide-react";
import type { TraceSnapshot } from "@rome/api-types/trace-segments";
import { CollapsedTraceButton } from "@/components/agent-trace/AgentTrace";
import type { TraceDrawerTarget } from "@/components/agent-trace/TraceDrawer";
import { renderFlatBlocks } from "@/components/chat/blocks";
import { parseMessageBlocks } from "@/components/chat/blocks/parse-blocks";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { CopyMessageButton } from "@/components/chat/CopyMessageButton";
import {
  DelegatedSubagentGroup,
  type DelegatedSubagentNode,
} from "@/components/chat/DelegatedSubagentGroup";
import { MessageRow } from "@/components/chat/MessageRow";
import { TurnSummaryGroup } from "@/components/chat/TurnSummaryGroup";
import { TurnBranchButton } from "@/components/chat/TurnBranchButton";
import { TurnFeedbackButtons } from "@/components/chat/TurnFeedbackButtons";
import { TraceTrigger } from "@/components/chat/TraceTrigger";
import { UserMessage } from "@/components/chat/UserMessage";
import type { AgentIdentity, ChatRow } from "@/components/chat/chat-view";
import type { ChatMessage } from "@/lib/chat-types";

// The block-level callbacks + resolved-interaction map threaded into
// renderFlatBlocks — a single bag instead of six loose props.
export interface BlockActions {
  onApprovalResolved: () => void;
  onSubmitAppComponent: (
    sessionId: string,
    toolUseId: string,
    output: Record<string, unknown>,
    summary?: string,
  ) => void | Promise<void>;
  onDismissAppComponent: (sessionId: string, toolUseId: string) => void | Promise<void>;
  interactionResults: Map<string, Record<string, unknown>>;
}

// The transient live preview of the floor session's in-flight turn — only the
// block being typed right now. Completed blocks (commentary) and cards are
// persisted live and render in the transcript above this tail.
export interface LivePreview {
  isStreaming: boolean;
  runningTurnId: string | null;
  snapshot: TraceSnapshot | null;
  text: string;
  identity: AgentIdentity;
}

// When inline share selection is active, every selectable turn
// in the transcript gets a checkbox + click target so the guardian picks the
// turns to freeze directly on the messages instead of in a separate list. Only
// rows belonging to `selectableSessionId` (the main session) are checkable —
// handoff child turns ride along with their parent automatically.
export interface ShareSelection {
  active: boolean;
  selectedTurns: Set<string>;
  selectableSessionId: string;
  onToggleTurn: (turnId: string) => void;
}

export interface MessageListProps {
  // Pre-grouped speaker rows (built in chat-view, memoized in Chat).
  rows: ChatRow[];
  live: LivePreview;
  selection?: ShareSelection;
  // Stick-to-bottom observes this content-sized wrapper. It must NOT be the
  // flex/min-h-dvh column (whose height is floored to the viewport): content
  // growing inside that floor wouldn't resize it, so the ResizeObserver would
  // never fire for a late-expanding component.
  contentRef: (node: HTMLElement | null) => void;
  onOpenLiveTrace: () => void;
  onOpenStoredTrace: (target: TraceDrawerTarget) => void;
  onOpenSubagentTrace?: (node: DelegatedSubagentNode) => void;
  activeTraceTarget?: TraceDrawerTarget | null;
  subagentIconByName?: ReadonlyMap<string, string | null>;
  actions: BlockActions;
  // Render inline turn actions (feedback + side-chat branch) next to the copy
  // button under settled agent turns. Guardian-only, so the live chat opts in
  // while read-only surfaces (public share, sessions viewer) omit them.
  feedback?: boolean;
}

// Submission helpers — read a handoff child's messages to drive the composer's
// Approve affordance. Exported for Chat; pure over a message list.

// A user turn that carries actual typed text — a reply to the agent. The
// approval-resolution turn (interaction_result only, no text) does NOT count,
// so it can't supersede the card it's resolving.
function isHumanReply(msg: ChatMessage): boolean {
  return parseMessageBlocks(msg).some(
    (b) => b.type === "text" && typeof b.content === "string" && b.content.trim().length > 0,
  );
}

// The newest still-actionable submission: the specialist's latest submit_output
// payload, unless the guardian has since replied (which supersedes it until a
// re-submit). Drives the composer's Approve button.
export function findActiveSubmission(
  messages: ChatMessage[],
): { messageId: string; payload: Record<string, unknown> } | null {
  let active: { messageId: string; payload: Record<string, unknown> } | null = null;
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const card = parseMessageBlocks(msg).find((b) => b.type === "submission_card");
      if (card?.payload && typeof card.payload === "object") {
        active = { messageId: msg.id, payload: card.payload as Record<string, unknown> };
      }
    } else if (msg.role === "user" && active && isHumanReply(msg)) {
      active = null;
    }
  }
  return active;
}

// The most recent submission payload, ignoring the supersede rule — verbal
// approval authorizes the standing submission even though the guardian's "yes"
// just superseded it for the button.
export function findLastSubmission(messages: ChatMessage[]): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const card = parseMessageBlocks(msg).find((b) => b.type === "submission_card");
    if (card?.payload && typeof card.payload === "object") {
      return card.payload as Record<string, unknown>;
    }
  }
  return null;
}

// True once the specialist has relayed the guardian's verbal approval (a
// `handback_approved` block with no later submission superseding it).
export function hasPendingApprovalConfirmation(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = parseMessageBlocks(messages[i]);
    if (blocks.some((b) => b.type === "handback_approved")) return true;
    if (blocks.some((b) => b.type === "submission_card")) return false;
  }
  return false;
}

function renderTrace(trace: ChatMessage, onOpen: (target: TraceDrawerTarget) => void) {
  return trace.traceSummary ? (
    <TraceTrigger
      messageId={trace.id}
      sessionId={trace.sessionId}
      turnId={trace.turnId ?? null}
      summary={trace.traceSummary}
      onOpen={onOpen}
      compact
    />
  ) : null;
}

function renderSubagents(
  subagents: TraceSnapshot["summary"]["subagents"],
  onOpenSubagentTrace: ((node: DelegatedSubagentNode) => void) | undefined,
  activeTraceTarget: TraceDrawerTarget | null | undefined,
  subagentIconByName: ReadonlyMap<string, string | null> | undefined,
) {
  if (!onOpenSubagentTrace || !subagents?.length) return undefined;
  return (
    <DelegatedSubagentGroup
      subagents={subagents}
      selected={activeTraceTarget}
      agentIconByName={subagentIconByName}
      onOpenSubagentTrace={onOpenSubagentTrace}
    />
  );
}

// True if the live tail's text already exists as a persisted commentary block in
// this turn — the persisted copy landed just ahead of the tail, so the tail copy
// is a duplicate to hide. Only commentary counts: the final answer is persisted
// into the row too (via send_message) and, if textually identical to an earlier
// commentary block, must NOT suppress the live tail before stream close.
function hasPersistedCommentary(messages: ChatMessage[], liveText: string): boolean {
  for (const m of messages) {
    for (const part of parseMessageBlocks(m)) {
      if (part.type === "text" && part.turnPhase === "commentary" && part.content === liveText)
        return true;
    }
  }
  return false;
}

// The raw text a copy button puts on the clipboard for an agent turn: every
// text block (commentary + final answer) across the turn's messages, joined as
// the markdown source — not the rendered HTML.
function turnCopyText(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    for (const b of parseMessageBlocks(m)) {
      if (b.type === "text" && typeof b.content === "string" && b.content.trim()) {
        parts.push(b.content);
      }
    }
  }
  return parts.join("\n\n");
}

// The streaming-activity indicator shown when the running turn has no text tail
// to ride on — between text blocks, during a tool call, or before the first
// token. Mirrors the live caret's breathing dot (globals.css) as a standalone
// element so the turn never reads as idle while Stop is still showing.
function LiveActivityDot() {
  return (
    <div className="py-1" role="status" aria-label="Working">
      <span className="rome-live-activity-dot" />
    </div>
  );
}

// One transcript row. Memoized so a streaming turn re-renders ONLY its running
// row — every settled row bails on its stable props, so renderFlatBlocks never
// re-runs for the history. `live` is non-null for exactly the running turn's row
// and carries the live trace + streaming-text tail INTO that row. Crucially the
// running row stays at its final transcript position the whole turn: when the
// turn finalizes, `live` flips to null and the row re-renders in place (NOT a
// remount), so an inline card's local input state — typed mid-stream — survives.
const RowView = memo(function RowView({
  row,
  live,
  actions,
  onOpenLiveTrace,
  onOpenStoredTrace,
  onOpenSubagentTrace,
  activeTraceTarget,
  subagentIconByName,
  feedback = false,
}: {
  row: ChatRow;
  live: LivePreview | null;
  actions: BlockActions;
  onOpenLiveTrace: () => void;
  onOpenStoredTrace: (target: TraceDrawerTarget) => void;
  onOpenSubagentTrace?: (node: DelegatedSubagentNode) => void;
  activeTraceTarget?: TraceDrawerTarget | null;
  subagentIconByName?: ReadonlyMap<string, string | null>;
  feedback?: boolean;
}) {
  if (row.kind === "user") return <UserMessage msg={row.message} />;
  const avatar = <AgentAvatar iconUrl={row.identity.iconUrl} label={row.identity.name} />;
  if (row.kind === "trace") {
    const summary = row.message.traceSummary;
    const subagents = summary?.subagents;
    const plan = summary?.plan;
    return (
      <MessageRow
        name={row.identity.name}
        avatar={avatar}
        subtitle={renderTrace(row.message, onOpenStoredTrace)}
        headerAccessory={renderSubagents(
          subagents,
          onOpenSubagentTrace,
          activeTraceTarget,
          subagentIconByName,
        )}
      >
        {plan?.steps.length ? <TurnSummaryGroup plan={plan} live={false} /> : null}
      </MessageRow>
    );
  }
  // Running turn: its persisted trace isn't written yet, so the live trace button
  // carries it. Settled turn: its stored trace.
  const subtitle = live ? (
    <CollapsedTraceButton
      summary={live.snapshot?.summary}
      segments={live.snapshot?.segments}
      onClick={onOpenLiveTrace}
      live
      compact
    />
  ) : row.trace ? (
    renderTrace(row.trace, onOpenStoredTrace)
  ) : undefined;
  const suppressText = !!live?.text && hasPersistedCommentary(row.messages, live.text);
  // Copy appears once the turn settles (`live` gone) and only when it produced
  // text — a card-only turn has nothing raw to copy.
  const copyText = live ? "" : turnCopyText(row.messages);
  // Feedback rides the same settled action row; it needs the turn identity.
  const feedbackTurn = feedback && !live ? rowTurnRef(row) : null;
  const showFeedback = !!feedbackTurn?.turnId && !!feedbackTurn.sessionId;
  const summary = live?.snapshot?.summary ?? row.trace?.traceSummary;
  const subagents = summary?.subagents;
  const recapMessageId = row.messages.find((message) =>
    parseMessageBlocks(message).some((block) => block.type === "turn_recap"),
  )?.id;
  return (
    <MessageRow
      name={row.identity.name}
      avatar={avatar}
      subtitle={subtitle}
      headerAccessory={renderSubagents(
        subagents,
        onOpenSubagentTrace,
        activeTraceTarget,
        subagentIconByName,
      )}
      className="group"
    >
      {row.messages.map((m) => {
        const blocks = parseMessageBlocks(m);
        if (m.id !== recapMessageId) {
          return (
            <div key={m.id}>{renderFlatBlocks(blocks, { ...actions, sessionId: m.sessionId })}</div>
          );
        }

        const recapIndex = blocks.findIndex((block) => block.type === "turn_recap");
        const recap = blocks[recapIndex];
        return (
          <div key={m.id}>
            {renderFlatBlocks(blocks.slice(0, recapIndex), {
              ...actions,
              sessionId: m.sessionId,
            })}
            <TurnSummaryGroup
              plan={summary?.plan}
              live={!!live}
              recap={
                recap?.type === "turn_recap"
                  ? {
                      content: recap.content ?? "",
                      audioUrl: recap.audioUrl,
                      audioMimeType: recap.audioMimeType,
                      audioDurationMs: recap.audioDurationMs,
                    }
                  : undefined
              }
            />
            {renderFlatBlocks(blocks.slice(recapIndex + 1), {
              ...actions,
              sessionId: m.sessionId,
            })}
          </div>
        );
      })}
      {live?.text && !suppressText ? (
        // rome-live-caret appends the pulsing live dot after the last rendered
        // character (see globals.css).
        <div className="rome-live-caret">
          {renderFlatBlocks([{ type: "text", content: live.text }], actions)}
        </div>
      ) : live ? (
        // Streaming with no text tail (tool call / block gap): keep the
        // breathing dot alive on its own so the turn never reads as idle. A
        // live Plan already carries its own animated state marker.
        summary?.plan?.steps.length ? null : (
          <LiveActivityDot />
        )
      ) : null}
      {recapMessageId ? null : <TurnSummaryGroup plan={summary?.plan} live={!!live} />}
      {copyText || showFeedback ? (
        // Settled-turn action row: copy + feedback + side-chat branch.
        // Hover-revealed on
        // pointer devices, always visible on touch — mirrors the affordance
        // under the guardian's own bubbles. `has-[[aria-pressed=true]]` keeps
        // the row visible while the feedback draft is open (its popover is
        // portaled, so group-focus-within can't see it) and once a rating is
        // recorded.
        <div className="-ml-2 mt-1 flex items-center md:opacity-0 md:transition-opacity md:group-focus-within:opacity-100 md:group-hover:opacity-100 md:has-[[aria-expanded=true]]:opacity-100 md:has-[[aria-pressed=true]]:opacity-100">
          {copyText ? <CopyMessageButton text={copyText} /> : null}
          {showFeedback && feedbackTurn?.turnId ? (
            <TurnFeedbackButtons
              key={`${feedbackTurn.sessionId}:${feedbackTurn.turnId}`}
              sessionId={feedbackTurn.sessionId}
              turnId={feedbackTurn.turnId}
            />
          ) : null}
          {showFeedback && feedbackTurn?.turnId ? (
            <TurnBranchButton
              key={`branch:${feedbackTurn.sessionId}:${feedbackTurn.turnId}`}
              sessionId={feedbackTurn.sessionId}
              turnId={feedbackTurn.turnId}
            />
          ) : null}
        </div>
      ) : null}
    </MessageRow>
  );
});

// The live tail for a running turn that has not persisted ANY message yet —
// there's no row to attach to, so it stands alone (avatar + live trace +
// streaming text). The moment its first message persists, a running agent row
// appears in `rows` and owns the tail instead (RowView). No inline card can
// exist before that first persist — cards come from persisted blocks, never the
// raw text tail — so nothing with local state remounts when the tail moves in.
function StandaloneLiveTail({
  live,
  actions,
  onOpenLiveTrace,
  onOpenSubagentTrace,
  activeTraceTarget,
  subagentIconByName,
}: {
  live: LivePreview;
  actions: BlockActions;
  onOpenLiveTrace: () => void;
  onOpenSubagentTrace?: (node: DelegatedSubagentNode) => void;
  activeTraceTarget?: TraceDrawerTarget | null;
  subagentIconByName?: ReadonlyMap<string, string | null>;
}) {
  return (
    <MessageRow
      name={live.identity.name}
      avatar={<AgentAvatar iconUrl={live.identity.iconUrl} label={live.identity.name} />}
      subtitle={
        <CollapsedTraceButton
          summary={live.snapshot?.summary}
          segments={live.snapshot?.segments}
          onClick={onOpenLiveTrace}
          live
          compact
        />
      }
      headerAccessory={renderSubagents(
        live.snapshot?.summary.subagents,
        onOpenSubagentTrace,
        activeTraceTarget,
        subagentIconByName,
      )}
    >
      {live.text ? (
        <div className="rome-live-caret">
          {renderFlatBlocks([{ type: "text", content: live.text }], actions)}
        </div>
      ) : live.snapshot?.summary.plan?.steps.length ? null : (
        // No text persisted yet (turn just opened, or first phase is a tool
        // call): the breathing dot stands in for the missing tail.
        <LiveActivityDot />
      )}
      <TurnSummaryGroup plan={live.snapshot?.summary.plan} live />
    </MessageRow>
  );
}

// The (turnId, sessionId) a row belongs to, for inline share selection. Null
// turnId rows (transient/optimistic) and the standalone live tail aren't
// selectable.
function rowTurnRef(row: ChatRow): { turnId: string | null; sessionId: string } {
  if (row.kind === "user" || row.kind === "trace") {
    return { turnId: row.message.turnId ?? null, sessionId: row.message.sessionId };
  }
  const first = row.messages[0] ?? row.trace;
  return { turnId: first?.turnId ?? null, sessionId: first?.sessionId ?? "" };
}

// Wraps a transcript row with a checkbox + full-row click target during share
// selection. The overlay button sits above the row, so in selection mode a
// click toggles the turn instead of activating links/cards underneath.
function SelectableRow({
  selected,
  onToggle,
  label,
  children,
}: {
  selected: boolean;
  onToggle: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <div
        className={`rounded-8 pl-9 transition-colors ${selected ? "bg-primary/5" : "opacity-60"}`}
      >
        {children}
      </div>
      <span
        className={`pointer-events-none absolute left-2 top-3 flex size-5 items-center justify-center rounded-4 border ${
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-surface"
        }`}
      >
        {selected && <Check className="size-3.5" />}
      </span>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={selected}
        aria-label={label}
        className="absolute inset-0 rounded-8 ring-primary/40 focus-visible:outline-none focus-visible:ring-2"
      />
    </div>
  );
}

export function MessageList({
  rows,
  live,
  selection,
  contentRef,
  onOpenLiveTrace,
  onOpenStoredTrace,
  onOpenSubagentTrace,
  activeTraceTarget,
  subagentIconByName,
  actions,
  feedback,
}: MessageListProps) {
  // The running turn's row is NOT pulled out of the transcript — it renders in
  // its final position and receives `live` so it carries the trace + text tail
  // in place (RowView). This keeps the row (and any inline card in it) mounted
  // across the streaming→settled transition; only it re-renders per token, every
  // settled row bails on memo. A turn with nothing persisted yet has no row, so
  // the tail stands alone until its first message lands.
  const runningTurnId = live.isStreaming ? live.runningTurnId : null;
  const lastRow = rows.at(-1);
  const runningRow =
    runningTurnId &&
    lastRow?.kind === "agent" &&
    lastRow.messages.some((m) => m.turnId === runningTurnId)
      ? lastRow
      : undefined;
  const hasRunningRow = !!runningRow;

  return (
    <div className="flex-1">
      <div ref={contentRef} className="mx-auto max-w-5xl px-4 pt-4 md:px-6">
        {rows.map((row) => {
          const isRunning = row === runningRow;
          const view = (
            <RowView
              key={row.key}
              row={row}
              live={isRunning ? live : null}
              actions={actions}
              onOpenLiveTrace={onOpenLiveTrace}
              onOpenStoredTrace={onOpenStoredTrace}
              onOpenSubagentTrace={onOpenSubagentTrace}
              activeTraceTarget={activeTraceTarget}
              subagentIconByName={subagentIconByName}
              feedback={feedback}
            />
          );
          if (!selection?.active) return view;
          const { turnId, sessionId } = rowTurnRef(row);
          if (!turnId || sessionId !== selection.selectableSessionId) {
            // Not selectable (child-session row, or no turn): still dim it so the
            // selection state reads clearly across the whole transcript.
            return (
              <div key={row.key} className="pl-9 opacity-60">
                {view}
              </div>
            );
          }
          return (
            <SelectableRow
              key={row.key}
              selected={selection.selectedTurns.has(turnId)}
              onToggle={() => selection.onToggleTurn(turnId)}
              label={selection.selectedTurns.has(turnId) ? "Deselect message" : "Select message"}
            >
              {view}
            </SelectableRow>
          );
        })}
        {live.isStreaming && !hasRunningRow ? (
          <StandaloneLiveTail
            live={live}
            actions={actions}
            onOpenLiveTrace={onOpenLiveTrace}
            onOpenSubagentTrace={onOpenSubagentTrace}
            activeTraceTarget={activeTraceTarget}
            subagentIconByName={subagentIconByName}
          />
        ) : null}
      </div>
    </div>
  );
}
