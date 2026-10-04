/**
 * index — the top-level dispatcher.
 *
 *   bun src/index.ts --stream https://www.twitch.tv/<channel>
 *   bun src/index.ts stream  https://www.twitch.tv/<channel> --cookies out/cookies.txt
 *   bun src/index.ts --video clip.mp4
 *
 * It only picks an entry point and forwards the REST of the command line to it as a child
 * `bun` process. It deliberately does NOT `import("./stream")`:
 *
 *  - `src/stream.ts` and `src/video.ts` are scripts, not libraries. Both read
 *    `process.argv` themselves and run their whole pipeline at module scope, so importing
 *    them re-parses the UNMODIFIED `process.argv` — which is exactly how `--stream` used to
 *    leak into yt-dlp (`unknown option --stream`) and how the bare word `stream` was
 *    consumed as the media target (`stream: resolving stream ...`).
 *  - a child process also isolates the FFI/winmm state, so `video`'s Media Foundation
 *    teardown can never race `stream`'s waveOut ring inside one interpreter.
 *
 * The command token itself is stripped and nothing else: the target and every option with
 * its value (`--cookies file`, `--size 640x360`, …) are passed through verbatim, because
 * each entry point owns its own argument grammar.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMAND_ENTRIES,
  type Command,
  firstTarget,
  type ParsedCommand,
  parseCommand,
  wantsHelp,
} from "./lib/cliargs";

const USAGE = `
index — play video in your terminal

Usage:
  index --stream <url|chaturbate/<model>|twitch.tv/<channel>> [options]
  index stream  <target> [options]     (same thing)
  index --video <file.mp4>

"stream" is the default command when a target is given without one.

Options are the entry point's own; run with --help to list them:
  index --stream --help
  index --video --help
`;

/** Directory holding the entry points, resolved so the cwd never matters. */
const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

async function run(command: Command, args: string[]): Promise<number> {
  const entry = join(SRC_DIR, COMMAND_ENTRIES[command]);
  // `process.execPath` is the bun binary, so this works even when bun is not on PATH.
  const proc = Bun.spawn([process.execPath, "run", entry, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

async function main(): Promise<void> {
  let parsed: ParsedCommand;
  try {
    parsed = parseCommand(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`index: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const { command, rest } = parsed;

  if (command === null) {
    // No command given: a target implies the default (stream), otherwise show usage.
    if (wantsHelp(rest)) {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (firstTarget(rest) === undefined) {
      process.stdout.write(USAGE);
      process.exit(1);
    }
    process.exit(await run("stream", rest));
  }

  process.exit(await run(command, rest));
}

await main();
