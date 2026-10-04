/**
 * Tests for the yt-dlp wiring in lib/resolve.ts.
 *
 * Both behaviours here were found by watching a real Chaturbate room fail:
 *   - `best[height<=720]/best` matches NOTHING there, because the extractor lists video
 *     and audio as separate formats, so `best` (which needs both tracks) never matches.
 *   - without a cookie jar the extractor hits an authenticated API and reports a live
 *     model as "Requested format is not available".
 *
 * Nothing here spawns yt-dlp — the argv builder and the stdout parser are both pure.
 */
import { describe, expect, test } from "bun:test";
import {
  buildResolveArgs,
  DEFAULT_FORMAT_SELECTOR,
  normalizeTarget,
  parseSourceUrls,
} from "../src/lib/resolve";

const V = "https://edge22-fra.live.mmcdn.com/v/clip.m3u8?session=aaa";
const A = "https://edge22-fra.live.mmcdn.com/a/clip.m3u8?session=bbb";

describe("buildResolveArgs", () => {
  test("omits --cookies entirely when no jar was given", () => {
    expect(buildResolveArgs()).not.toContain("--cookies");
    expect(buildResolveArgs({})).not.toContain("--cookies");
  });

  test("a blank cookie path is dropped, not forwarded as --cookies ''", () => {
    // --cookies "" makes yt-dlp try to parse an empty jar and fail confusingly.
    expect(buildResolveArgs({ cookiesFile: "" })).not.toContain("--cookies");
    expect(buildResolveArgs({ cookiesFile: "   " })).not.toContain("--cookies");
  });

  test("emits --cookies <path> before the target is appended", () => {
    const args = buildResolveArgs({ cookiesFile: "out/cookies.txt" });
    const i = args.indexOf("--cookies");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("out/cookies.txt");
  });

  test("keeps -g/--no-playlist/-f and the chaturbate-capable selector", () => {
    const args = buildResolveArgs();
    expect(args.slice(0, 2)).toEqual(["-g", "--no-playlist"]);
    expect(args).toContain("-f");
    expect(args[args.indexOf("-f") + 1]).toBe(DEFAULT_FORMAT_SELECTOR);
  });

  test("the selector can actually match chaturbate's split tracks", () => {
    // The regression this guards: `best[height<=720]/best` matched nothing and yt-dlp
    // said "Requested format is not available" for a model who was live.
    const arms = DEFAULT_FORMAT_SELECTOR.split("/");
    expect(arms).toHaveLength(3);
    expect(arms.some((a) => a.includes("bestvideo") && a.includes("bestaudio"))).toBe(true);
    // `best` alone must remain the LAST resort, never the first choice.
    expect(arms[arms.length - 1]).toBe("best");
  });
});

describe("parseSourceUrls", () => {
  test("one URL is a muxed source: no separate audio", () => {
    expect(parseSourceUrls(`${V}\n`)).toEqual({ video: V });
  });

  test("two URLs are split tracks: video first, audio second", () => {
    expect(parseSourceUrls(`${V}\n${A}\n`)).toEqual({ video: V, audio: A });
  });

  test("tolerates CRLF and blank lines between/after the URLs", () => {
    expect(parseSourceUrls(`\r\n${V}\r\n\r\n${A}\r\n\r\n`)).toEqual({
      video: V,
      audio: A,
    });
  });

  test("a repeated URL is not mistaken for a second track", () => {
    // yt-dlp echoing one muxed URL twice must not spawn a second ffmpeg on the same
    // input — that would just duplicate the audio.
    expect(parseSourceUrls(`${V}\n${V}\n`)).toEqual({ video: V });
  });

  test("drops non-URL stdout noise instead of feeding it to ffmpeg", () => {
    expect(parseSourceUrls(`WARNING: something\n${V}\n`)).toEqual({ video: V });
  });

  test("returns null when nothing usable was printed, so the caller reports stderr", () => {
    expect(parseSourceUrls("")).toBeNull();
    expect(parseSourceUrls("ERROR: Room is currently offline\n")).toBeNull();
    expect(parseSourceUrls("   \n\n")).toBeNull();
  });
});

describe("normalizeTarget", () => {
  test("expands the two shorthands and leaves real URLs alone", () => {
    expect(normalizeTarget("chaturbate/iren_wagner")).toBe(
      "https://de.chaturbate.com/iren_wagner/",
    );
    expect(normalizeTarget("twitch.tv/aidamoodi")).toBe("https://www.twitch.tv/aidamoodi");
    expect(normalizeTarget("https://example.com/live.m3u8")).toBe("https://example.com/live.m3u8");
  });
});
