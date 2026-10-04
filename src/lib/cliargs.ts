/**
 * cliargs — argv splitting for `src/index.ts`, the top-level dispatcher.
 *
 * WHY THIS IS A SEPARATE MODULE: `src/index.ts` runs top-level `await` and spawns child
 * processes, so importing it from a test would execute the dispatcher. The argv rules
 * are pure, so they live here and `test/cliargs.test.ts` guards them.
 *
 * THE BUG THIS EXISTS TO PREVENT: `src/stream.ts` is a SCRIPT, not a library — its tail
 * runs `main().catch(...)` AND `export default main()`, and `main()` reads
 * `process.argv.slice(2)` itself. So `await import("./stream")` from a dispatcher ran the
 * whole pipeline twice, against the UNMODIFIED process.argv, which is how `--stream`
 * reached yt-dlp as `unknown option --stream` and how the bare word `stream` got
 * consumed as the media target (`stream: resolving stream ...`). The dispatcher therefore
 * never imports the entry points; it forwards argv to a child `bun` process instead.
 */

/** Entry points this dispatcher can forward to, mapped to the file that implements them. */
export const COMMAND_ENTRIES = {
  stream: "stream.ts",
  video: "video.ts",
} as const;

export type Command = keyof typeof COMMAND_ENTRIES;

/**
 * Tokens that read like a command but have no entry point. Kept so the dispatcher can
 * say "there is no `pipes` command" instead of silently forwarding the token and letting
 * stream.ts report `unknown option --pipes`.
 */
export const UNIMPLEMENTED_COMMANDS = new Set(["pipes", "pipe"]);

/** Strip leading dashes: `--stream`, `-stream` and `stream` all normalize to `stream`. */
export function normalizeToken(arg: string): string {
  return arg.replace(/^--?/, "");
}

export function isCommand(name: string): name is Command {
  return Object.hasOwn(COMMAND_ENTRIES, name);
}

/** Thrown for a malformed command line; the caller prints the message and exits 1. */
export class CliError extends Error {}

export interface ParsedCommand {
  /** The command to run, or null when the user named none. */
  command: Command | null;
  /**
   * Every token EXCEPT the command, verbatim and in order — the target plus all of its
   * options and their values (`--cookies file`, `--size 640x360`, `--selftest out.png`).
   * Nothing is filtered, reordered, or rewritten: the child entry point owns its own
   * argument grammar, and this dispatcher must not second-guess it.
   */
  rest: string[];
}

/**
 * Split a dispatcher command line into `{command, rest}`.
 *
 * Rules:
 *  - the command may be given as a bare word (`stream`) or a flag (`--stream`/`-stream`);
 *  - only the FIRST command token is consumed, so a target that happens to contain the
 *    word is never eaten;
 *  - if no command token appears, `command` stays null and the caller decides (the
 *    dispatcher defaults to `stream` when a target is present).
 */
export function parseCommand(argv: string[]): ParsedCommand {
  let command: Command | null = null;
  const rest: string[] = [];
  for (const arg of argv) {
    if (command === null) {
      const name = normalizeToken(arg);
      if (isCommand(name)) {
        command = name;
        continue;
      }
      if (UNIMPLEMENTED_COMMANDS.has(name)) {
        throw new CliError(
          `unknown command "${arg}" - there is no "pipes" entry point; use --stream or --video`,
        );
      }
    }
    rest.push(arg);
  }
  return { command, rest };
}

/** True if the argv carries a help flag in any accepted form. */
export function wantsHelp(argv: string[]): boolean {
  return argv.some((arg) => {
    const name = normalizeToken(arg);
    return name === "h" || name === "help";
  });
}

/**
 * The first positional target: a token that is not a flag and not the value of a preceding
 * flag. Option values are recognized by position, so `--cookies out/cookies.txt` yields
 * `out/cookies.txt` as a value rather than the target.
 */
export function firstTarget(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("-")) continue;
    // A non-flag token is a flag VALUE when the previous token is a value-taking flag.
    if (i > 0 && isValueFlag(normalizeToken(argv[i - 1] ?? ""))) continue;
    return arg;
  }
  return undefined;
}

/** Flags that consume the next token, so that token is never mistaken for the target. */
const VALUE_FLAGS = new Set([
  "cookies",
  "cookies-from-browser",
  "cookie",
  "header",
  "headers",
  "size",
  "s",
  "fps",
  "wait",
  "selftest",
  "retries",
]);

export function isValueFlag(name: string): boolean {
  return VALUE_FLAGS.has(name);
}
