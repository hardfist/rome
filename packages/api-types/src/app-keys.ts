// App keys — guardian-entered named values injected into the Rome process
// environment for apps to read. Shared contract between core's routes, the
// dashboard, and mock mode. Name validation lives here rather than in core so
// the mock rejects exactly the names the server rejects.

/** The value-free wire shape. Values never travel: the API returns names and
 * labels only, and `overridden` says a real environment variable is shadowing
 * the stored value (operator env always wins). */
export interface AppKeyDto {
  name: string;
  label: string;
  /** ISO-8601 timestamp of the last write. */
  updatedAt: string;
  overridden: boolean;
}

export interface AppKeysListResponse {
  keys: AppKeyDto[];
}

export const APP_KEY_MAX_NAME_LENGTH = 64;
export const APP_KEY_MAX_LABEL_LENGTH = 120;
export const APP_KEY_MAX_VALUE_LENGTH = 32768;

const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

// An app key lands in `process.env`, so a name that collides with platform
// configuration could reroute the database, the API ports, or an upstream
// credential. Config env names are only expressed as inline `env.X` reads in
// core's `config.ts` (`envToRawConfig`) — there is no enumerable schema to
// check against — so this list carries every prefix family the platform
// consumes plus the ambient OS names a child process relies on.
const RESERVED_PREFIXES = [
  "ROME_",
  "NODE_",
  "NPM_",
  "PNPM_",
  "PANTHEON_",
  "INTERNAL_API_",
  "RELAY_",
  "STATSIG_",
  "FEATURE_GATE_",
  "OTEL_",
  "SQLITE_",
  "POSTGRES_",
  "DATABASE_",
  "WEB_",
  "LINKEDIN_",
  "SENTINEL_",
  "ANTHROPIC_",
  "DOCKERHUB_",
  "CLICKHOUSE_",
  "AWS_",
  "SSH_",
  "NEXT_",
];

const RESERVED_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "HOSTNAME",
  "EDITOR",
  "CI",
  "LOG_LEVEL",
  "UPDATES_DOMAIN",
]);

/** Returns a human-readable rejection reason, or null when the name is usable. */
export function appKeyNameError(name: string): string | null {
  if (name.length === 0) return "Name is required.";
  if (name.length > APP_KEY_MAX_NAME_LENGTH) {
    return `Name must be at most ${APP_KEY_MAX_NAME_LENGTH} characters.`;
  }
  if (!NAME_PATTERN.test(name)) {
    return "Name must use only uppercase letters, digits, and underscores, and start with a letter.";
  }
  if (RESERVED_NAMES.has(name)) {
    return `${name} is reserved by Rome. Pick a different name.`;
  }
  const prefix = RESERVED_PREFIXES.find((p) => name.startsWith(p));
  if (prefix) {
    return `Names starting with ${prefix} are reserved by Rome. Pick a different name.`;
  }
  return null;
}
