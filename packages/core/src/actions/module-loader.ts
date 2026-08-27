import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ResolverFactory } from "@rspack/resolver";
import type { Action, ActionConfig } from "./types.js";

// Apps written in TypeScript declare `entry: ./index.ts` against their `src/`
// layout; `rome build` emits `.js` into `dist/` and copies the YAML unchanged.
// `extensionAlias` lets the resolver try the compiled `.js` sibling first and
// fall back to `.ts` when running against source (e.g. `tsx` on the host).
// Node's own resolver doesn't know about TypeScript extensions.
const sharedResolver = new ResolverFactory({
  extensions: [".js", ".ts", ".mjs", ".cjs", ".mts", ".cts", ".jsx", ".tsx", ".json"],
  extensionAlias: {
    ".js": [".js", ".ts"],
    ".jsx": [".jsx", ".tsx"],
    ".mjs": [".mjs", ".mts"],
    ".cjs": [".cjs", ".cts"],
    ".ts": [".js", ".ts"],
    ".tsx": [".jsx", ".tsx"],
    ".mts": [".mjs", ".mts"],
    ".cts": [".cjs", ".cts"],
  },
  mainFiles: ["index"],
});

export type GenericActionFactory<TDeps = unknown> = (config: ActionConfig, deps: TDeps) => Action;

function isActionFactory<TDeps>(value: unknown): value is GenericActionFactory<TDeps> {
  return typeof value === "function";
}

function toPascalCase(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

export async function resolveModuleEntryPath(baseDir: string, entry?: string): Promise<string> {
  const absoluteBaseDir = resolve(baseDir);
  const specifier = entry ?? "./index";
  const result = await sharedResolver.async(absoluteBaseDir, specifier);
  if (!result.path) {
    throw new Error(
      `No entry module found for "${baseDir}" (resolving "${specifier}"): ${result.error ?? "no path returned"}`,
    );
  }
  const [realBaseDir, realEntryPath] = await Promise.all([
    realpath(absoluteBaseDir),
    realpath(result.path),
  ]);
  const relativeEntryPath = relative(realBaseDir, realEntryPath);
  if (relativeEntryPath.startsWith("..") || isAbsolute(relativeEntryPath)) {
    throw new Error(`Invalid entry path "${specifier}" for ${baseDir}: escapes base dir`);
  }
  return result.path;
}

// App modules can read process.env at module scope, and the file-identity
// buster below cannot see an environment change. Bumping this epoch salts the
// cache key so every subsequent import re-evaluates module scope against the
// current environment (app keys do this on save/delete). Each bump strands the
// previously imported instances in the ESM cache — the same cost as an app
// upgrade changing mtime — bounded by how often a guardian edits keys.
let envEpoch = 0;

export function bumpModuleEnvEpoch(): void {
  envEpoch++;
}

export async function importModuleWithCacheBuster(path: string): Promise<Record<string, unknown>> {
  const fileStat = await stat(path);
  const cacheBuster = `${Math.trunc(fileStat.mtimeMs)}-${fileStat.size}-e${envEpoch}`;
  const url = `${pathToFileURL(path).href}?v=${cacheBuster}`;
  return await import(url);
}

export function resolveActionFactory<TDeps>(
  module: Record<string, unknown>,
  actionName: string,
): GenericActionFactory<TDeps> {
  const preferredNamed = `create${toPascalCase(actionName)}Action`;

  if (isActionFactory<TDeps>(module.createAction)) {
    return module.createAction;
  }
  if (isActionFactory<TDeps>(module[preferredNamed])) {
    return module[preferredNamed];
  }
  if (isActionFactory<TDeps>(module.default)) {
    return module.default;
  }

  const candidates = Object.entries(module)
    .filter(
      ([name, value]) => /^create[A-Za-z0-9_]*Action$/.test(name) && isActionFactory<TDeps>(value),
    )
    .map(([, value]) => value as GenericActionFactory<TDeps>);

  if (candidates.length === 1) {
    return candidates[0];
  }

  throw new Error(
    `No action factory found for "${actionName}". Export createAction(config, deps) or a single create*Action function.`,
  );
}

export async function instantiateActionFromDirectory<TDeps>(
  config: ActionConfig,
  actionDir: string,
  deps: TDeps,
): Promise<Action> {
  const entryPath = await resolveModuleEntryPath(actionDir, config.entry);
  const module = await importModuleWithCacheBuster(entryPath);
  const factory = resolveActionFactory<TDeps>(module, config.name);
  return factory(config, deps);
}
