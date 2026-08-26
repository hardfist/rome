import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { defineComponent, type AppComponentContext } from "@rome-os/app-web-sdk";
import { Button } from "@rome-os/ui/button";
import { CoachPointer, findWidgetCoachTarget } from "@/lib/coach";
import { getWelcomeCopy } from "@/lib/copy";

// The "open the browser, sign in to ChatGPT, then continue" step. Submits
// `{ action: "continue" | "skip" }`. Two phases:
//   • before the Browser widget is open — guide them to it (with the coach line);
//   • once it's open — tell them to sign in there (arrow pointing right at it).
// `props.notSignedIn` re-prompts after a failed sign-in check.

// The Desktop/Browser widget is an iframe titled "Desktop".
const isBrowserOpen = () => !!document.querySelector('iframe[title="Desktop"]');

/** Reactive: re-renders when the Browser widget opens/closes. */
function useBrowserOpen(): boolean {
  const [open, setOpen] = useState(isBrowserOpen);
  useEffect(() => {
    const id = setInterval(() => setOpen(isBrowserOpen()), 400);
    return () => clearInterval(id);
  }, []);
  return open;
}

function Step({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-aux text-primary">
        {label}
      </span>
      <span className="text-xs text-muted-foreground">{children}</span>
    </li>
  );
}

function BrowserStep({ ctx }: { ctx: AppComponentContext }) {
  const copy = getWelcomeCopy(ctx.bootstrap.shell.locale);
  const notSignedIn = ctx.props.notSignedIn === true;
  const browserOpen = useBrowserOpen();
  const resolved = ctx.host.resolved;
  const submitted = resolved && ctx.result?.action === "continue";
  // The login re-check happens server-side, and its outcome arrives as the NEXT
  // turn (a re-prompt if not signed in, or the scrape narration if signed in) —
  // this resolved card can't observe that. So show the "Checking…" spinner only
  // briefly for tactile feedback, then settle to a static confirmation, instead
  // of spinning forever.
  const [spinning, setSpinning] = useState(true);
  useEffect(() => {
    if (!submitted) return;
    const id = setTimeout(() => setSpinning(false), 4000);
    return () => clearTimeout(id);
  }, [submitted]);
  const checking = submitted && spinning;
  // Anchor the coach line on the "Add widget" text itself.
  const anchorRef = useRef<HTMLElement | null>(null);

  return (
    <div className="w-full max-w-md space-y-3">
      {!browserOpen ? (
        <div className="rounded-12 border border-border bg-card p-3">
          <p className="mb-2 text-sm font-medium text-foreground">{copy.browserStep.heading}</p>
          <ol className="space-y-1.5">
            <Step label="1">
              {copy.browserStep.openBefore}{" "}
              <strong
                ref={anchorRef}
                className={
                  resolved
                    ? "text-foreground"
                    : "inline-flex items-center rounded-8 border border-primary/35 bg-primary/5 px-1.5 py-0.5 text-foreground shadow-1 whitespace-nowrap"
                }
              >
                {copy.browserStep.addBrowser}
              </strong>{" "}
              {copy.browserStep.openAfter}
            </Step>
            <Step label="2">{copy.browserStep.signIn}</Step>
            <Step label="3">{copy.browserStep.returnWhenReady}</Step>
          </ol>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-12 border border-border bg-card p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{copy.browserStep.openHeading}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {copy.browserStep.openDescription}
            </p>
          </div>
          <ArrowRight
            className="size-6 shrink-0 text-primary"
            style={{ animation: "wtr-nudge-right 1s ease-in-out infinite" }}
          />
        </div>
      )}

      {notSignedIn ? (
        <p className="rounded-8 bg-warning-bg/60 px-2.5 py-1.5 text-xs text-warning-fg">
          {copy.browserStep.notSignedIn}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Button
          className="w-full"
          disabled={resolved}
          onClick={() => ctx.host.submit({ action: "continue" }, copy.browserStep.signedIn)}
        >
          {checking ? (
            <>
              <Loader2 className="animate-spin" /> {copy.browserStep.checking}
            </>
          ) : submitted ? (
            <>
              <Check /> {copy.browserStep.signedIn}
            </>
          ) : (
            copy.browserStep.signedIn
          )}
        </Button>
        <Button
          className="w-full"
          variant="outline"
          disabled={resolved}
          onClick={() => ctx.host.submit({ action: "skip" }, copy.browserStep.skipSummary)}
        >
          {copy.browserStep.skip}
        </Button>
      </div>

      {/* While the browser isn't open yet, point from the "Add widget" text to the
          real (+) toolbar button — and, once its menu opens, to the "Browser"
          item — until the guardian makes a choice. */}
      {!browserOpen ? (
        <CoachPointer
          fromRef={anchorRef}
          findTarget={findWidgetCoachTarget}
          active={!resolved}
          stop={isBrowserOpen}
        />
      ) : null}
    </div>
  );
}

defineComponent("browser-step", (container, ctx) => {
  const root = createRoot(container);
  root.render(<BrowserStep ctx={ctx} />);
  return () => root.unmount();
});
