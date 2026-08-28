import type {
  AppInstallResponse,
  AppListResponse,
  AppPublishResponse,
  AppReadmeResponse,
  InstalledAppCard,
  SpecSource,
} from "@rome/api-types/apps";
import { APP_MANAGER_ERROR_STATUS } from "@rome/api-types/app-manager-errors";
import { deriveAppRuntimeStatus } from "@rome/api-types/apps-runtime";
import { http, HttpResponse } from "msw";
import type { UpgradeCandidate } from "@/hooks/use-apps";
import { publicAccess } from "./settings";
import type { ListingDetailPayload } from "@/components/AppInstallConfirm";

// The installed-app catalog. Each card is a distinct card state the grid and the
// details page have to render — active/disabled/failed, first-party/appstore/
// local, frontend/backend-only, upgradable/current — so the whole surface is
// reachable without a daemon. `morning-brief` is deliberately the same app the
// chat fixtures pin a session to, so its agent, its icon, and its card all
// describe one app.
//
// What mock mode still can't do is *open* an embedded app: `/app-assets` is
// module federation off the real backend, so a card's href navigates to the
// app shell's load error. The cards, their lifecycle controls, and the details
// page are in scope; the app's own UI needs `dev:all`.

/** Rendered by the icon route below, so the tile's image branch is exercised. */
const ICON_TINTS: Record<string, string> = {
  "morning-brief": "#d86f4c",
  notes: "#4c7fd8",
};

const apps: InstalledAppCard[] = [
  {
    id: "morning-brief",
    version: "1.4.0",
    displayName: "Morning Brief",
    description: "Assembles the daily digest and reads it back on request.",
    status: "active",
    phase: "installed",
    hasFrontend: true,
    href: "/apps/morning-brief",
    fullHref: "/full/apps/morning-brief",
    capabilities: ["agents", "actions", "skills"],
    capabilityDetails: {
      agents: [{ name: "briefer", description: "Drafts and schedules the morning brief" }],
      actions: [
        { name: "daily_summary", description: "Generate the guardian's daily activity summary" },
        { name: "brief_preview", description: "Render tomorrow's brief without sending it" },
      ],
      skills: [{ name: "digest-writing", description: "House style for the daily digest" }],
      hooks: [],
    },
    isEnabled: true,
    canToggle: true,
    // First-party apps ship with Rome and are immutable to users: enable/disable
    // is the only control, so the uninstall affordance must be absent here.
    canUninstall: false,
    canPublish: false,
    accessMode: "private",
    isPublic: false,
    cloudAllowedEmails: [],
    canManagePublicAccess: true,
    source: { mode: "bundle", path: "dist/first-party-artifacts/morning-brief" },
    projectPath: null,
    origin: "builtin",
    iconUrl: "/api/apps/morning-brief/icon",
    suggestedChannelBindings: [
      { channel: "telegram", agent: "briefer", reason: "Delivers the brief where you read it" },
    ],
  },
  {
    id: "notes",
    version: "0.8.1",
    displayName: "Notes",
    description: "A shared notebook the agent can read from and write to.",
    status: "active",
    phase: "installed",
    hasFrontend: true,
    href: "/apps/notes",
    fullHref: "/full/apps/notes",
    capabilities: ["actions", "skills"],
    capabilityDetails: {
      agents: [],
      actions: [
        { name: "note_create", description: "Add a note to the shared notebook" },
        { name: "note_search", description: "Full-text search across saved notes" },
      ],
      skills: [{ name: "note-taking", description: "When and how to file a note" }],
      hooks: [],
    },
    isEnabled: true,
    canToggle: true,
    canUninstall: true,
    includeSource: true,
    canPublish: false,
    accessMode: "private",
    isPublic: false,
    cloudAllowedEmails: [],
    canManagePublicAccess: true,
    source: { mode: "appstore", listingId: "notes", version: "0.8.1" },
    projectPath: null,
    origin: "appstore",
    iconUrl: "/api/apps/notes/icon",
  },
  {
    id: "recipe-box",
    version: "0.2.0",
    displayName: "Recipe Box",
    description: "Work-in-progress recipe manager, installed from its workspace.",
    status: "active",
    phase: "installed",
    hasFrontend: true,
    href: "/apps/recipe-box",
    fullHref: "/full/apps/recipe-box",
    capabilities: ["actions"],
    capabilityDetails: {
      agents: [],
      actions: [{ name: "recipe_add", description: "File a recipe with its ingredients" }],
      skills: [],
      hooks: [],
    },
    isEnabled: true,
    canToggle: true,
    canUninstall: true,
    // A locally-sourced app is the only kind the guardian can publish, so this
    // is the one card whose publish control is live.
    canPublish: true,
    accessMode: "private",
    isPublic: false,
    cloudAllowedEmails: [],
    canManagePublicAccess: true,
    source: { mode: "source", path: "projects/apps/recipe-box" },
    projectPath: "apps/recipe-box",
    origin: "local",
    iconUrl: null,
  },
  {
    id: "weather",
    version: "1.1.2",
    displayName: "Weather",
    description: "Forecast lookups for the household's locations.",
    status: "active",
    phase: "installed",
    // Backend-only: no tile in the sidebar, and the card must not offer to open it.
    hasFrontend: false,
    href: null,
    fullHref: null,
    capabilities: ["actions"],
    capabilityDetails: {
      agents: [],
      actions: [{ name: "weather_forecast", description: "Look up a multi-day forecast" }],
      skills: [],
      hooks: [],
    },
    isEnabled: true,
    canToggle: true,
    canUninstall: true,
    canPublish: false,
    accessMode: "private",
    isPublic: false,
    cloudAllowedEmails: [],
    canManagePublicAccess: false,
    source: { mode: "appstore", listingId: "weather", version: "1.1.2" },
    projectPath: null,
    origin: "appstore",
    iconUrl: null,
  },
  {
    id: "expense-tracker",
    version: "0.5.0",
    displayName: "Expense Tracker",
    description: "Receipts in, categorised spend out.",
    // Disabled is a runtime status, not a phase: the app is still installed and
    // its card keeps every control except the ones that need a live runtime.
    status: "disabled",
    phase: "installed",
    hasFrontend: true,
    href: null,
    fullHref: null,
    capabilities: ["actions", "hooks"],
    capabilityDetails: {
      agents: [],
      actions: [{ name: "expense_log", description: "Record a receipt against a category" }],
      skills: [],
      hooks: [{ name: "on-receipt-image", description: "Parses receipts dropped into chat" }],
    },
    isEnabled: false,
    canToggle: true,
    canUninstall: true,
    canPublish: false,
    accessMode: "private",
    isPublic: false,
    cloudAllowedEmails: [],
    canManagePublicAccess: true,
    source: { mode: "appstore", listingId: "expense-tracker", version: "0.5.0" },
    projectPath: null,
    origin: "appstore",
    iconUrl: null,
  },
  {
    id: "ledger-sync",
    version: "0.3.4",
    displayName: "Ledger Sync",
    description: "Mirrors the household ledger to a spreadsheet.",
    status: "failed",
    phase: "failed",
    error: "Action registration failed: `ledger_push` declared an unknown input schema.",
    hasFrontend: false,
    href: null,
    fullHref: null,
    capabilities: ["actions"],
    capabilityDetails: {
      agents: [],
      // A per-artifact loadError is a separate diagnostic from the app-level
      // `error` above, and consumers must surface it — seeded so they can be
      // seen disagreeing in scope (the app failed; one artifact says why).
      actions: [
        {
          name: "ledger_push",
          description: "Append rows to the linked spreadsheet",
          loadError: "inputSchema: expected a zod schema, received undefined",
        },
      ],
      skills: [],
      hooks: [],
    },
    isEnabled: true,
    canToggle: true,
    canUninstall: true,
    canPublish: false,
    accessMode: "private",
    isPublic: false,
    cloudAllowedEmails: [],
    canManagePublicAccess: false,
    source: { mode: "source", path: "projects/apps/ledger-sync" },
    projectPath: "apps/ledger-sync",
    origin: "local",
    iconUrl: null,
  },
];

// Advisory upgrade probe. Only `notes` is behind, so the grid shows one update
// badge and the header's "update all" affordance has exactly one target.
const upgradable: UpgradeCandidate[] = [
  {
    appId: "notes",
    currentVersion: "0.8.1",
    availableVersion: "0.9.0",
    targetSource: { mode: "appstore", listingId: "notes", version: "0.9.0" },
  },
];

const readmes: Record<string, string> = {
  "morning-brief": [
    "# Morning Brief",
    "",
    "Assembles a short digest every morning and delivers it over your preferred",
    "channel.",
    "",
    "## Sections",
    "",
    "- **Inbox** — anything that arrived overnight and looks like it needs you.",
    "- **Weather** — today's forecast for the household's primary location.",
    "- **Calendar** — the day's meetings, omitted entirely on a clear day.",
    "",
    "## Configuration",
    "",
    "Ask the agent to change the delivery time or drop a section; it writes",
    "through to the app's own settings.",
    "",
    "```yaml",
    "morning_brief:",
    "  time: '07:00'",
    "  sections: [inbox, weather]",
    "```",
  ].join("\n"),
  notes: "# Notes\n\nA shared notebook. Nothing to configure.\n",
};

/** The app id a `POST /apps` source resolves to — the daemon derives it from
 *  the artifact; here the fixtures encode the same mapping. */
function appIdForSource(source: SpecSource): string | null {
  if (source.mode === "appstore") return source.listingId;
  const leaf = source.path.split("/").filter(Boolean).pop();
  return leaf ?? null;
}

function cardFor(appId: string): InstalledAppCard | undefined {
  return apps.find((app) => app.id === appId);
}

/**
 * The card's derived half. Nothing here is stored on the row, because every
 * field below can be computed from something that is — and a stored copy is a
 * copy that can disagree.
 *
 * `status` comes from `deriveAppRuntimeStatus`, the same function the real
 * route calls: a failed app stays failed however its `enabled` flag moves, so
 * "active" can never pair with a `failed` phase. `href`/`fullHref` follow from
 * that status, so a card only offers to open an app that could actually serve
 * one. Access mode comes from the `/api/public-access` store the access dialog
 * writes to, so a just-changed dialog and the card's badge agree on the next read.
 */
function toCard(app: InstalledAppCard): InstalledAppCard {
  const emails = publicAccess.config.cloudEmailAccess[app.id] ?? [];
  const isPublic = publicAccess.config.allowedApps.includes(app.id);
  const status = deriveAppRuntimeStatus(app.phase, app.isEnabled);
  const openable = status === "active" && app.hasFrontend;
  return {
    ...app,
    status,
    href: openable ? `/apps/${app.id}` : null,
    fullHref: openable ? `/full/apps/${app.id}` : null,
    isPublic,
    cloudAllowedEmails: emails,
    accessMode: isPublic ? "public" : emails.length > 0 ? "cloud-email" : "private",
  };
}

/** A flat mark in the app's tint — enough for the tile's image branch to be
 *  the thing under test, rather than the generated-fallback branch. */
function iconSvg(tint: string, letter: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img">`,
    `<rect width="64" height="64" rx="14" fill="${tint}"/>`,
    `<text x="32" y="43" text-anchor="middle" font-family="system-ui, sans-serif"`,
    ` font-size="32" font-weight="600" fill="#fff">${letter}</text>`,
    `</svg>`,
  ].join("");
}

export const appHandlers = [
  http.get("/api/app-store/listings/*", ({ params }) => {
    if (decodeURIComponent(String(params[0])) !== "@alice/calendar") {
      return HttpResponse.json({ error: "Listing not found" }, { status: 404 });
    }
    return HttpResponse.json({
      available: true,
      listing: {
        id: "@alice/calendar",
        handle: "alice",
        slug: "calendar",
        name: "Calendar",
        description: "A calendar to make your own.",
        longDescription: null,
        iconUrl: null,
        categories: [],
        state: "published",
        highestVersion: "2.0.0",
        verified: true,
      },
      versions: [
        {
          version: "2.0.0",
          contentHash: "b".repeat(64),
          sourceAvailable: false,
          state: "live",
          sizeBytes: 1024,
          publishedAt: "2026-08-27T00:00:00Z",
        },
        {
          version: "1.2.3",
          contentHash: "a".repeat(64),
          sourceAvailable: true,
          state: "live",
          sizeBytes: 1024,
          publishedAt: "2026-08-26T00:00:00Z",
        },
      ],
    } satisfies ListingDetailPayload);
  }),
  http.get("/api/apps", () =>
    HttpResponse.json({ apps: apps.map(toCard) } satisfies AppListResponse),
  ),
  // Both literal routes must precede any "/api/apps/:appId" pattern — MSW serves
  // the first handler whose path matches, and ":appId" would swallow them.
  http.get("/api/apps/updates", () => HttpResponse.json({ upgradable })),
  // Hold the catalog's SSE channel open without emitting: the fixture list only
  // changes through this file's own mutations, which invalidate the query
  // directly, and a stream that closes reads as a dropped connection.
  http.get("/api/apps/events", () => {
    const stream = new ReadableStream({ start() {} });
    return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
  }),
  http.get("/api/apps/:appId/icon", ({ params }) => {
    const appId = String(params.appId);
    const tint = ICON_TINTS[appId];
    if (!tint) return new HttpResponse(null, { status: 404 });
    return new HttpResponse(iconSvg(tint, appId.charAt(0).toUpperCase()), {
      headers: { "Content-Type": "image/svg+xml" },
    });
  }),
  // `readme` is null when the packed artifact has none; an unknown app is a 404.
  // Both branches are seeded, so the details page can be seen rendering each.
  http.get("/api/app-readmes/:appId", ({ params }) => {
    const appId = String(params.appId);
    if (!cardFor(appId)) return HttpResponse.json({ error: "Unknown app" }, { status: 404 });
    return HttpResponse.json({
      appId,
      readme: readmes[appId] ?? null,
    } satisfies AppReadmeResponse);
  }),
  // Install or upgrade. The upgrade path is the one reachable from the grid:
  // it re-installs an already-installed app from a newer source, so the version
  // moves and the candidate that advertised it is retired.
  http.post("/api/apps", async ({ request }) => {
    const body = (await request.json()) as { source: SpecSource };
    const appId = appIdForSource(body.source);
    const app = appId ? cardFor(appId) : undefined;
    if (!app) {
      return HttpResponse.json({ error: "Unknown app source" }, { status: 400 });
    }
    if (body.source.mode === "appstore") app.version = body.source.version;
    // `source` is the card's authoritative reinstall source, so the accepted
    // source has to replace it — otherwise the next read advertises the version
    // that was just upgraded away from. The real route echoes the submitted
    // source back for the same reason.
    app.source = body.source;
    const candidateIndex = upgradable.findIndex((candidate) => candidate.appId === app.id);
    if (candidateIndex >= 0) upgradable.splice(candidateIndex, 1);
    return HttpResponse.json({
      appId: app.id,
      spec: { source: body.source, enabled: app.isEnabled },
      phase: app.phase,
    } satisfies AppInstallResponse);
  }),
  http.patch("/api/apps/:appId", async ({ params, request }) => {
    const app = cardFor(String(params.appId));
    if (!app) return HttpResponse.json({ error: "Unknown app" }, { status: 404 });
    const body = (await request.json()) as { enabled: boolean };
    // Only the flag is stored. Status and the open links are derived per read,
    // so enabling an app whose phase is `failed` cannot promote it to active.
    app.isEnabled = body.enabled;
    return HttpResponse.json({
      appId: app.id,
      spec: { source: app.source, enabled: app.isEnabled },
      phase: app.phase,
    } satisfies AppInstallResponse);
  }),
  http.delete("/api/apps/:appId", ({ params }) => {
    const appId = String(params.appId);
    const index = apps.findIndex((app) => app.id === appId);
    if (index < 0) return HttpResponse.json({ error: "Unknown app" }, { status: 404 });
    // The daemon rejects uninstalling a first-party app; a fixture that allowed
    // it would model a card state the real backend can't produce. The status
    // comes from the shared table rather than a number chosen here, so the mock
    // cannot answer a different class than the route does.
    if (!apps[index].canUninstall) {
      return HttpResponse.json(
        {
          error: `FIRST_PARTY_PROTECTED: App "${appId}" ships with Rome and cannot be uninstalled`,
        },
        { status: APP_MANAGER_ERROR_STATUS.FIRST_PARTY_PROTECTED },
      );
    }
    apps.splice(index, 1);
    const candidateIndex = upgradable.findIndex((candidate) => candidate.appId === appId);
    if (candidateIndex >= 0) upgradable.splice(candidateIndex, 1);
    return HttpResponse.json({ ok: true });
  }),
  http.post("/api/apps/:appId/publish", ({ params }) => {
    const app = cardFor(String(params.appId));
    if (!app) return HttpResponse.json({ error: "Unknown app" }, { status: 404 });
    if (!app.canPublish) {
      return HttpResponse.json({ error: "This app cannot be published" }, { status: 403 });
    }
    return HttpResponse.json({
      appId: app.id,
      listing: { id: `listing-${app.id}`, handle: `mock-guardian/${app.id}`, slug: app.id },
      version: {
        version: app.version,
        contentHash: "a".repeat(64),
        sizeBytes: 128_400,
        sourceAvailable: true,
      },
      claimed: true,
    } satisfies AppPublishResponse);
  }),
];
