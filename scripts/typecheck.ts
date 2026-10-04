#!/usr/bin/env bun
/**
 * Filtered typecheck.
 *
 * `@bun-win32/*` ships raw `.ts` sources, so `tsc` type-checks vendored
 * files under `node_modules/` and reports ~191 `noUncheckedIndexedAccess`
 * / strict errors there. `skipLibCheck` only skips `.d.ts`, and `exclude`
 * does not apply to files pulled in via imports, so neither flag can
 * suppress this. Project policy (AGENTS.md): only `src/` and `test/`
 * must be clean.
 *
 * This wrapper runs `tsc --noEmit --pretty false`, partitions diagnostics
 * into project errors vs vendored `node_modules` noise, prints both, and
 * exits non-zero only when project files have errors.
 */
import { spawnSync } from "node:child_process";

const result = spawnSync("bunx", ["tsc", "--noEmit", "--pretty", "false"], {
  encoding: "utf8",
  shell: true,
});

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const lines = output.split(/\r?\n/).filter((line) => line.length > 0);

// tsc --pretty false emits one header line per diagnostic
// (`file(line,col): error TS...`) optionally followed by indented
// continuation lines. Group continuations with their header so
// multi-line vendored diagnostics are suppressed as a unit.
const diagnostics: string[][] = [];
for (const line of lines) {
  if (/error TS\d+/.test(line)) {
    diagnostics.push([line]);
  } else if (diagnostics.length > 0) {
    diagnostics[diagnostics.length - 1]?.push(line);
  }
}

const isVendored = (diagnostic: string[]): boolean =>
  /(^|[\\/])node_modules[\\/]/.test(diagnostic[0] ?? "");

const projectDiagnostics = diagnostics.filter((d) => !isVendored(d));
const vendoredDiagnostics = diagnostics.filter(isVendored);

for (const diagnostic of projectDiagnostics) {
  console.error(diagnostic.join("\n"));
}

// Keep the vendored summary on stdout so it does not look like a failure.
const vendoredFiles = new Set(
  vendoredDiagnostics.map((d) => (d[0] ?? "").slice(0, (d[0] ?? "").indexOf("("))),
);

console.log(
  `typecheck: src/test errors: ${projectDiagnostics.length}, ` +
    `node_modules errors ignored: ${vendoredDiagnostics.length} ` +
    `in ${vendoredFiles.size} files`,
);

process.exit(projectDiagnostics.length > 0 ? 1 : 0);
