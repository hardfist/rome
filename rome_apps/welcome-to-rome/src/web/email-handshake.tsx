import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowRight, Check, Loader2, Mail } from "lucide-react";
import { defineComponent, type AppComponentContext } from "@rome-os/app-web-sdk";
import { Button } from "@rome-os/ui/button";
import { getWelcomeCopy } from "@/lib/copy";

// The first onboarding step: a mutual-email handshake. The card reads the two
// addresses from the registry-native surfaces — the agent's provisioned address
// from the email connection's `inbox` grant display (GET /api/connections) and
// the guardian's from the pure-config settings row (GET /api/settings) — and,
// if the instance hasn't provisioned a mailbox yet, runs the email conferral
// setup on the spot (#1605: POST the generic setup route, poll to a
// terminal state; idempotent — a live setup re-attaches, a provisioned inbox
// re-provisions to the same address). Both addresses are shown read-only; on
// "agree" it submits `{ agreed, guardianEmail }` and the script sends the
// hello. If a mailbox can't be provisioned (e.g. no Rome Cloud in dev) it
// offers a plain "continue" that submits `{ skip }`.

interface EmailStatus {
  address?: string | null;
  guardianEmail?: string | null;
}

async function getEmailStatus(): Promise<EmailStatus | null> {
  try {
    const [connectionsRes, settingsRes] = await Promise.all([
      fetch("/api/connections", { credentials: "include" }),
      fetch("/api/settings", { credentials: "include" }),
    ]);
    if (!connectionsRes.ok) return null;
    const { connections } = (await connectionsRes.json()) as {
      connections?: Array<{
        service?: string;
        display?: Record<string, { email?: string | null } | null>;
      }>;
    };
    const email = connections?.find((c) => c.service === "email");
    // guardianEmail is operator config on the settings row (it is not grant
    // identity), self-healed by the adapter once the channel starts.
    const settings = settingsRes.ok
      ? ((await settingsRes.json()) as { email?: { guardianEmail?: string | null } })
      : {};
    return {
      address: email?.display?.inbox?.email ?? null,
      guardianEmail: settings.email?.guardianEmail ?? null,
    };
  } catch {
    return null;
  }
}

async function connectEmail(): Promise<void> {
  try {
    const started = await fetch("/api/connections/email/grants/inbox/setup", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!started.ok) return;
    const { cid } = (await started.json()) as { cid?: string };
    if (!cid) return;
    // Email's setup takes no input; poll (bounded) until it reaches a
    // terminal state.
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`/api/setups/${cid}`, { credentials: "include" });
      if (!res.ok) return;
      const { state } = (await res.json()) as { state?: { status?: string } };
      const status = state?.status;
      if (status === "done" || status === "failed" || status === "cancelled") return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch {
    /* best-effort; the status re-read below decides availability */
  }
}

type Phase =
  | { kind: "checking" }
  | { kind: "ready"; agentEmail: string; guardianEmail: string }
  | { kind: "unavailable" };

function Address({ label, email }: { label: string; email: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-8 border border-border bg-surface/60 px-3 py-2">
      <Mail className="size-4 shrink-0 text-primary" />
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <span className="block truncate text-sm font-medium text-foreground">{email}</span>
      </span>
    </div>
  );
}

function EmailHandshake({ ctx }: { ctx: AppComponentContext }) {
  const copy = getWelcomeCopy(ctx.bootstrap.shell.locale);
  const resolved = ctx.host.resolved;
  const [phase, setPhase] = useState<Phase>(() =>
    resolved ? { kind: "ready", agentEmail: "", guardianEmail: "" } : { kind: "checking" },
  );

  useEffect(() => {
    if (resolved) return; // a re-mounted, already-answered card needs no lookup
    let cancelled = false;
    (async () => {
      let status = await getEmailStatus();
      if (!status?.address) {
        await connectEmail(); // provision on the spot
        status = await getEmailStatus();
      }
      if (cancelled) return;
      const agentEmail = status?.address ?? "";
      const guardianEmail = status?.guardianEmail ?? "";
      // Need both addresses for a real mutual handshake; otherwise let them pass.
      setPhase(
        agentEmail && guardianEmail
          ? { kind: "ready", agentEmail, guardianEmail }
          : { kind: "unavailable" },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [resolved]);

  if (resolved) {
    return (
      <div className="flex w-full max-w-md items-center gap-2 rounded-12 border border-primary/40 bg-primary/5 p-3 text-sm text-foreground">
        <Check className="size-4 text-primary" /> {copy.emailHandshake.confirmed}
      </div>
    );
  }

  if (phase.kind === "checking") {
    return (
      <div className="flex w-full max-w-md items-center gap-2 rounded-12 border border-border bg-card p-3 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> {copy.emailHandshake.settingUp}
      </div>
    );
  }

  if (phase.kind === "unavailable") {
    return (
      <div className="w-full max-w-md space-y-3 rounded-12 border border-border bg-card p-3">
        <p className="text-sm text-foreground">{copy.emailHandshake.unavailable}</p>
        <Button
          className="w-full"
          onClick={() => ctx.host.submit({ skip: true }, copy.emailHandshake.continue)}
        >
          {copy.emailHandshake.continue} <ArrowRight />
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md space-y-3 rounded-12 border border-border bg-card p-4">
      <div className="space-y-2">
        <Address label={copy.emailHandshake.agentAddress} email={phase.agentEmail} />
        <Address label={copy.emailHandshake.guardianAddress} email={phase.guardianEmail} />
      </div>
      <Button
        className="w-full"
        onClick={() =>
          ctx.host.submit(
            { agreed: true, guardianEmail: phase.guardianEmail },
            copy.emailHandshake.agree,
          )
        }
      >
        {copy.emailHandshake.agree} <ArrowRight />
      </Button>
    </div>
  );
}

defineComponent("email-handshake", (container, ctx) => {
  const root = createRoot(container);
  root.render(<EmailHandshake ctx={ctx} />);
  return () => root.unmount();
});
