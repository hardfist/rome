import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dockerBundleOptions } from "./bundle-docker-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx/package.json"))("esbuild");

test("the relocated Caddy generator runs without Core workspace dependencies", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rome-compiled-caddy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, "caddy.cjs");
  await build({
    ...dockerBundleOptions("cjs"),
    entryPoints: [join(root, "packages/core/src/lib/caddyfile-generator.ts")],
    outfile,
    logLevel: "silent",
  });

  const output = execFileSync(
    process.execPath,
    [
      "-e",
      `const { generateCaddyfile } = require(${JSON.stringify(outfile)});
       console.log(generateCaddyfile({
         enableAccessControl: true,
         allowedApps: ["@alice/calendar"],
         cloudEmailAccess: {},
       }));`,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.ok(output.includes("/apps/%40alice%2Fcalendar"));
});

test("compiled People contracts run in plain Node without TypeScript source resolution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rome-compiled-people-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, "people.mjs");
  await build({
    ...dockerBundleOptions(),
    stdin: {
      contents: 'export { timelinePageLimit } from "@rome/api-types/people";',
      resolveDir: join(root, "packages/core"),
      sourcefile: "people-entry.ts",
      loader: "ts",
    },
    outfile,
    logLevel: "silent",
  });

  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { timelinePageLimit } from "./people.mjs";
       console.log(timelinePageLimit("75"));`,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(Number(output), 75);
});
