import { createLogger } from "../logger.js";

const log = createLogger("app-scaffold");

/**
 * The published Rome packages an app template declares as dependencies.
 * `@rome-os/ui` is web-only, so the workflow template does not carry it —
 * a placeholder that never appears in a template is simply never substituted.
 */
export const TEMPLATED_PACKAGES = [
  "@rome-os/app-runtime",
  "@rome-os/app-web-sdk",
  "@rome-os/ui",
] as const;

export type TemplatedPackage = (typeof TEMPLATED_PACKAGES)[number];

export type TemplateVersions = Record<TemplatedPackage, string>;

/**
 * Placeholder each template's `package.json` carries in place of a version
 * range. The scaffold resolves them at create time so a new app starts on the
 * current release instead of whatever was current when the template was last
 * hand-edited — the emitted `package.json` still holds a concrete `^x.y.z`,
 * because the app is installed from npm on user machines where a floating
 * `"latest"` would re-resolve on every install.
 */
export const VERSION_PLACEHOLDERS: TemplateVersions = {
  "@rome-os/app-runtime": "__ROME_APP_RUNTIME_VERSION__",
  "@rome-os/app-web-sdk": "__ROME_APP_WEB_SDK_VERSION__",
  "@rome-os/ui": "__ROME_UI_VERSION__",
};

/**
 * Ranges used when the registry cannot be reached (offline host, npm outage).
 * Scaffolding an app must not require the network, so a lookup failure degrades
 * to the newest release known when this file was last touched rather than
 * failing the create. These only need to be new enough to install and build;
 * `pnpm up` from the app root takes it the rest of the way.
 */
const FALLBACK_VERSIONS: TemplateVersions = {
  "@rome-os/app-runtime": "^0.6.0",
  "@rome-os/app-web-sdk": "^0.2.21",
  "@rome-os/ui": "^0.2.2",
};

const REGISTRY_URL = "https://registry.npmjs.org";
const LOOKUP_TIMEOUT_MS = 3_000;

async function fetchLatest(pkg: TemplatedPackage, timeoutMs: number): Promise<string | undefined> {
  // The `/<pkg>/latest` document is a single version's metadata — a few hundred
  // bytes — where the packument root is megabytes for a package with history.
  const url = `${REGISTRY_URL}/${pkg.replace("/", "%2f")}/latest`;
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn("registry lookup failed", { pkg, status: res.status });
      return undefined;
    }
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string" || body.version.length === 0) {
      log.warn("registry returned no version", { pkg });
      return undefined;
    }
    return `^${body.version}`;
  } catch (err) {
    log.warn("registry lookup errored", { pkg, error: (err as Error).message });
    return undefined;
  }
}

/**
 * Resolve the version range the scaffold writes for each templated package,
 * newest-published first. Lookups run concurrently and each falls back
 * independently, so one unreachable package does not pin the others back.
 */
export async function resolveTemplateVersions(
  timeoutMs: number = LOOKUP_TIMEOUT_MS,
): Promise<TemplateVersions> {
  const entries = await Promise.all(
    TEMPLATED_PACKAGES.map(async (pkg) => {
      const resolved = (await fetchLatest(pkg, timeoutMs)) ?? FALLBACK_VERSIONS[pkg];
      return [pkg, resolved] as const;
    }),
  );
  const versions = Object.fromEntries(entries) as TemplateVersions;
  log.info("resolved template dependency versions", versions);
  return versions;
}
