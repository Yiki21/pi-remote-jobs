// Usage: node selftest.mjs /absolute/path/to/pi-coding-agent
// Uses the installed Pi loader; no model requests or remote SSH connections.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const pkg = dirname(fileURLToPath(import.meta.url));
const sdk = process.argv[2];
if (!sdk) throw new Error("Pass the installed pi-coding-agent package root.");
const { loadExtensions } = await import(
  pathToFileURL(resolve(sdk, "dist/core/extensions/loader.js"))
);
const loaded = await loadExtensions([resolve(pkg, "index.ts")], pkg);
assert.deepEqual(loaded.errors, []);
const tool = loaded.extensions[0].tools.get("remote").definition;
mkdirSync(resolve(pkg, ".tmp"), { recursive: true });
const base = mkdtempSync(resolve(pkg, ".tmp/selftest-"));
const context = (p) => ({
  cwd: resolve(base, p),
  isProjectTrusted: () => true,
  sessionManager: { getSessionId: () => "same-session", getBranch: () => [] },
});
const call = (p, args) =>
  tool.execute("test", args, undefined, undefined, context(p));
try {
  for (const p of ["a", "b", "a/nested", "empty"])
    mkdirSync(resolve(base, p, ".pi"), { recursive: true });
  for (const p of ["a", "b"])
    writeFileSync(
      resolve(base, p, ".pi/remote.json"),
      JSON.stringify({ hosts: [{ name: p, local: true }] }),
    );
  await assert.rejects(
    call("empty", { cmd: "touch should-not-exist" }),
    /not configured/,
  );
  await assert.rejects(call("a/nested", { cmd: "true" }), /not configured/);
  await assert.rejects(
    tool.execute("t", { action: "hosts" }, undefined, undefined, {
      ...context("a"),
      isProjectTrusted: () => false,
    }),
    /Trust/,
  );
  const rs = await Promise.all(
    ["a", "b"].map((p) => call(p, { action: "hosts" })),
  );
  assert.match(rs[0].content[0].text, /a: up/);
  assert.match(rs[1].content[0].text, /b: up/);
  assert.notEqual(rs[0].details.project, rs[1].details.project);
  for (const p of ["../outside", "-option"])
    await assert.rejects(call("a", { cmd: "true", sync: [p] }), /unsafe path/);
  symlinkSync("/etc", resolve(base, "a/escape"));
  await assert.rejects(
    call("a", { cmd: "true", sync: ["escape/passwd"] }),
    /symlink/,
  );
  await assert.rejects(
    call("b", { action: "wait", job: "a.0123456789" }),
    /no longer in/,
  );
  // Re-reading config lets a host be removed without reloading the extension.
  writeFileSync(
    resolve(base, "a/.pi/remote.json"),
    JSON.stringify({ hosts: [{ name: "replacement", local: true }] }),
  );
  assert.match(
    (await call("a", { action: "hosts" })).content[0].text,
    /replacement: up/,
  );
  console.log(
    "PASS: Pi loader, missing config, nested boundary, trust, concurrent project isolation, unsafe paths, symlink escape, cross-project jobs, live config updates",
  );
} finally {
  rmSync(base, { recursive: true, force: true });
}
