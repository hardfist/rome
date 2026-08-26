import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowRight, Check, Copy, RotateCcw } from "lucide-react";
import {
  defineComponent,
  HOST_NAVIGATE_EVENT,
  navigateRome,
  type AppComponentContext,
} from "@rome-os/app-web-sdk";
import { getWelcomeCopy } from "@/lib/copy";

// The full-mode welcome screen — the first screen of Rome (src/web/App.tsx),
// shown standalone via the /full/apps route. "Run the welcome again" sends the
// guardian back here; its "Start chat" then resets the progress and replays the
// flow from scratch.
const WELCOME_SCREEN_PATH = "/full/apps/welcome-to-rome";
const SHOWCASES_APP_ID = "showcases";

// The closing card. props: `{ heading, body?, kickoffPrompt? }`. The "Run the
// welcome again" button still navigates back to the full-mode welcome screen
// (which clears the welcome progress on its next "Start chat"); the primary
// action opens Showcases so the guardian has a natural next place to explore.
function CompletionCard({ ctx }: { ctx: AppComponentContext }) {
  const copy = getWelcomeCopy(ctx.bootstrap.shell.locale);
  const heading =
    typeof ctx.props.heading === "string" ? ctx.props.heading : copy.completion.fallbackHeading;
  const body = typeof ctx.props.body === "string" ? ctx.props.body : "";
  const kickoff = typeof ctx.props.kickoffPrompt === "string" ? ctx.props.kickoffPrompt : "";
  const [copied, setCopied] = useState(false);
  const [openingShowcases, setOpeningShowcases] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const openShowcases = () => {
    if (openingShowcases) return;
    setOpeningShowcases(true);
    navigateRome({ path: "apps", appId: SHOWCASES_APP_ID });
  };

  // Soft-navigate the host back to the welcome screen. We dispatch the host's
  // navigate event directly (the typed navigateRome() has no full-mode variant);
  // the shell's react-router listener swaps the route, unmounting the chat.
  const runAgain = () => {
    if (restarting) return;
    setRestarting(true);
    window.dispatchEvent(
      new CustomEvent(HOST_NAVIGATE_EVENT, { detail: { path: WELCOME_SCREEN_PATH } }),
    );
  };

  const copyKickoff = async () => {
    try {
      await navigator.clipboard.writeText(kickoff);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="w-full max-w-md rounded-12 border border-border bg-card p-4">
      <p className="text-sm font-medium text-foreground">🏛️ {heading}</p>
      {body ? <p className="mt-1.5 text-xs text-muted-foreground">{body}</p> : null}

      {kickoff ? (
        <div className="mt-3 rounded-12 border border-border bg-surface/60 p-2.5">
          <p className="whitespace-pre-wrap text-xs text-foreground">{kickoff}</p>
          <button
            type="button"
            onClick={copyKickoff}
            className="mt-2 inline-flex items-center gap-1.5 rounded-8 border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
            {copied ? copy.completion.copied : copy.completion.copyPrompt}
          </button>
        </div>
      ) : null}

      <p className="mt-3 text-xs text-muted-foreground">{copy.completion.explore}</p>
      <button
        type="button"
        disabled={openingShowcases}
        onClick={openShowcases}
        className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-8 bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {openingShowcases ? copy.completion.opening : copy.completion.openShowcases}
        <ArrowRight className="size-4" />
      </button>

      <button
        type="button"
        disabled={restarting}
        onClick={runAgain}
        className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
      >
        <RotateCcw className="size-3.5" />
        {restarting ? copy.completion.opening : copy.completion.runAgain}
      </button>
    </div>
  );
}

defineComponent("completion-card", (container, ctx) => {
  const root = createRoot(container);
  root.render(<CompletionCard ctx={ctx} />);
  return () => root.unmount();
});
