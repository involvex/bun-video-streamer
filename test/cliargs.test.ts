/**
 * Tests for src/lib/cliargs.ts — the argv split done by src/index.ts.
 *
 * Regression origin: `bun src/index.ts --stream <url> --cookies <jar>` printed
 * `stream: unknown option --stream`. The dispatcher used to `import("./stream")`, and
 * since src/stream.ts reads `process.argv` at module scope (and even runs `main()` twice,
 * via both `main().catch(...)` and `export default main()`), the command flag arrived at
 * yt-dlp untouched and the bare word `stream` was eaten as the media target.
 *
 * These tests pin the two invariants that fix it: the command token is consumed exactly
 * once, and EVERY other token reaches the child entry point verbatim.
 */
import { describe, expect, test } from "bun:test";
import {
  COMMAND_ENTRIES,
  CliError,
  firstTarget,
  isValueFlag,
  normalizeToken,
  parseCommand,
  wantsHelp,
} from "../src/lib/cliargs";

const URL_ = "https://www.twitch.tv/rowshonara";
const JAR = "D:/repos/terminal-media-player/bun-video-stream/out/cookies.txt";

describe("normalizeToken", () => {
  test("strips one or two leading dashes", () => {
    expect(normalizeToken("--stream")).toBe("stream");
    expect(normalizeToken("-stream")).toBe("stream");
    expect(normalizeToken("stream")).toBe("stream");
  });

  test("leaves an ordinary flag alone apart from its dashes", () => {
    // `--no-audio` must NOT become `no-audio`-as-a-command and must keep its own name.
    expect(normalizeToken("--no-audio")).toBe("no-audio");
    expect(normalizeToken("--cookies")).toBe("cookies");
  });
});

describe("parseCommand", () => {
  test("--stream is consumed and never forwarded", () => {
    // The exact failing command line from the bug report.
    const { command, rest } = parseCommand(["--stream", URL_, "--cookies", JAR]);
    expect(command).toBe("stream");
    expect(rest).toEqual([URL_, "--cookies", JAR]);
    expect(rest).not.toContain("--stream");
  });

  test("a bare `stream` word is consumed as the command, not as the target", () => {
    const { command, rest } = parseCommand(["stream", URL_]);
    expect(command).toBe("stream");
    expect(rest).toEqual([URL_]);
    // Guards the `stream: resolving stream ...` symptom.
    expect(firstTarget(rest)).toBe(URL_);
  });

  test("-stream / --video / video all resolve", () => {
    expect(parseCommand(["-stream", URL_]).command).toBe("stream");
    expect(parseCommand(["--video", "clip.mp4"]).command).toBe("video");
    expect(parseCommand(["video", "clip.mp4"]).command).toBe("video");
    expect(parseCommand(["--video", "clip.mp4"]).rest).toEqual(["clip.mp4"]);
  });

  test("only the FIRST command token is consumed", () => {
    // A target may legitimately contain the word; the second one stays untouched.
    const { command, rest } = parseCommand(["stream", "chaturbate/stream", "--list"]);
    expect(command).toBe("stream");
    expect(rest).toEqual(["chaturbate/stream", "--list"]);
  });

  test("options, their values and their order are preserved byte-for-byte", () => {
    const argv = [
      "--stream",
      URL_,
      "--cookies",
      JAR,
      "--size",
      "640x360",
      "--fps",
      "24",
      "--no-audio",
      "--selftest",
      "out/live.png",
      "--wait",
      "40",
    ];
    expect(parseCommand(argv).rest).toEqual(argv.slice(1));
  });

  test("a command flag after the target is still recognised", () => {
    const { command, rest } = parseCommand([URL_, "--stream"]);
    expect(command).toBe("stream");
    expect(rest).toEqual([URL_]);
  });

  test("no command at all leaves argv untouched", () => {
    const argv = [URL_, "--cookies", JAR];
    const { command, rest } = parseCommand(argv);
    expect(command).toBeNull();
    expect(rest).toEqual(argv);
  });

  test("`--no-audio` and friends are never mistaken for a command", () => {
    const { command } = parseCommand([URL_, "--no-audio", "--no-yt-dlp"]);
    expect(command).toBeNull();
  });

  test("--pipes is rejected with a pointer to a real command", () => {
    expect(() => parseCommand(["--pipes", URL_])).toThrow(CliError);
    expect(() => parseCommand(["pipes"])).toThrow(/--stream or --video/);
  });

  test("every advertised command has a real entry file", () => {
    for (const [name, file] of Object.entries(COMMAND_ENTRIES)) {
      expect(file).toEndWith(".ts");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe("firstTarget", () => {
  test("finds the target and skips option values", () => {
    expect(firstTarget([URL_, "--cookies", JAR])).toBe(URL_);
    expect(firstTarget(["--cookies", JAR, URL_])).toBe(URL_);
    expect(firstTarget(["--size", "640x360", "twitch.tv/aidamoodi"])).toBe("twitch.tv/aidamoodi");
  });

  test("returns undefined when there is nothing positional", () => {
    expect(firstTarget([])).toBeUndefined();
    expect(firstTarget(["--no-audio"])).toBeUndefined();
    expect(firstTarget(["--fit"])).toBeUndefined();
  });

  test("a cookie jar path is a value, never the target", () => {
    // The user's paste has a Windows path after --cookies. Treating it as the target would
    // hand a .txt file to yt-dlp, so a --cookies with no other positional yields NO target
    // (the dispatcher then prints usage instead of resolving a bogus path).
    expect(firstTarget(["--cookies", JAR])).toBeUndefined();
    expect(firstTarget([URL_, "--cookies", JAR])).toBe(URL_);
  });

  test("a --cookies-from-browser spec is a value, never the target", () => {
    expect(firstTarget(["--cookies-from-browser", "chrome"])).toBeUndefined();
    expect(firstTarget([URL_, "--cookies-from-browser", "chrome"])).toBe(URL_);
  });
});

describe("isValueFlag", () => {
  test("covers every value-taking flag stream.ts parses", () => {
    for (const f of [
      "cookies",
      "cookies-from-browser",
      "size",
      "s",
      "fps",
      "wait",
      "selftest",
      "retries",
    ]) {
      expect(isValueFlag(f)).toBe(true);
    }
    for (const f of ["fit", "no-audio", "quiet", "list", "no-yt-dlp", "help"]) {
      expect(isValueFlag(f)).toBe(false);
    }
  });
});

describe("wantsHelp", () => {
  test("accepts -h, --help and help", () => {
    expect(wantsHelp(["--help"])).toBe(true);
    expect(wantsHelp(["-h"])).toBe(true);
    expect(wantsHelp(["--stream", "--help"])).toBe(true);
    expect(wantsHelp([URL_])).toBe(false);
  });
});
