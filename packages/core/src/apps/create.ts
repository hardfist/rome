import { isUtf8 } from "node:buffer";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TEMPLATED_PACKAGES,
  VERSION_PLACEHOLDERS,
  type TemplateVersions,
} from "./template-versions.js";

export interface TemplateVars {
  appId: string;
  appName: string;
  /**
   * Version range to substitute for each templated Rome package. Omitted by
   * callers that materialize a tree carrying no version placeholders (tests,
   * and any future template without dependencies).
   */
  versions?: TemplateVersions;
}

export function appIdToDisplayName(appId: string): string {
  return appId
    .split("-")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(" ");
}

export async function isDirectoryNonEmpty(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length > 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/**
 * SQL-identifier-safe slug derived from appId: `appId` allows hyphens
 * (`[a-z][a-z0-9-]*`) but `db.tablePrefix` must match `[a-z][a-z0-9_]*`.
 * Surfaced to templates as `__APP_TABLE_PREFIX__`.
 */
function appIdToTablePrefix(appId: string): string {
  return appId.replace(/-/g, "_");
}

function applyPlaceholders(input: string, vars: TemplateVars): string {
  const tablePrefix = appIdToTablePrefix(vars.appId);
  let out = input
    .replace(/__APP_TABLE_PREFIX__/g, tablePrefix)
    .replace(/__APP_ID__/g, vars.appId)
    .replace(/__APP_NAME__/g, vars.appName);
  const versions = vars.versions;
  if (versions != null) {
    for (const pkg of TEMPLATED_PACKAGES) {
      out = out.split(VERSION_PLACEHOLDERS[pkg]).join(versions[pkg]);
    }
  }
  return out;
}

export async function materializeTemplate(
  srcDir: string,
  destDir: string,
  vars: TemplateVars,
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destName = applyPlaceholders(entry.name, vars);
    const destPath = join(destDir, destName);
    if (entry.isDirectory()) {
      await materializeTemplate(srcPath, destPath, vars);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const buf = await readFile(srcPath);
    if (isUtf8(buf)) {
      await writeFile(destPath, applyPlaceholders(buf.toString("utf-8"), vars), "utf-8");
    } else {
      await writeFile(destPath, buf);
    }
  }
}
