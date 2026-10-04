import { describe, expect, test } from "bun:test";
import { buildAudioArgs, buildVideoArgs, looksLive } from "../src/lib/media";

const BASE = { width: 480, height: 270, fps: 30, quiet: true };

/** Index of a flag in argv (the value token, not the option). */
function idx(args: string[], flag: string): number {
  const i = args.indexOf(flag);
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
}

describe("buildVideoArgs", () => {
  const live = buildVideoArgs({ ...BASE, url: "https://x/y.m3u8", live: true });
  const vod = buildVideoArgs({ ...BASE, url: "https://x/y.mp4", live: false });

  test("input options precede -i and output options follow it", () => {
    const inputFlag = idx(live, "-live_start_index");
    const urlAt = idx(live, "https://x/y.m3u8");
    const outputFlag = idx(live, "-pix_fmt");
    expect(inputFlag).toBeLessThan(urlAt);
    expect(urlAt).toBeLessThan(outputFlag);
  });

  test("all four probe/buffer flags stay before -i", () => {
    const urlAt = idx(live, "https://x/y.m3u8");
    for (const f of [
      "-fflags",
      "-flags",
      "-analyzeduration",
      "-probesize",
      "-live_start_index",
      "-reconnect",
    ]) {
      expect(idx(live, f)).toBeLessThan(urlAt);
    }
  });

  test("live sources get the low-latency HLS tuning", () => {
    expect(live).toContain("-live_start_index");
    expect(live).toContain("-reconnect");
    expect(live).toContain("-reconnect_streamed");
    expect(live).toContain("-reconnect_delay_max");
    expect(live[live.indexOf("-live_start_index") + 1]).toBe("-3");
  });

  test("no option that current ffmpeg does not recognise", () => {
    // Regression guards for options verified against ffmpeg N-125782:
    //  - `-live_start_index_max` → "Unrecognized option"
    //  - `-fps_mode drop`        → "Invalid value drop specified for fps_mode"
    //                                (it is an ENCODER option; rawvideo has no encoder)
    for (const args of [live, vod]) {
      expect(args).not.toContain("-live_start_index_max");
      expect(args).not.toContain("-fps_mode");
    }
  });

  test("progressive sources must NOT get HLS-only options", () => {
    // Regression guard: ffmpeg hard-fails with "Option live_start_index not found"
    // on a plain MP4, which is an unrecoverable start error.
    for (const f of ["-live_start_index", "-reconnect", "-reconnect_streamed"]) {
      expect(vod).not.toContain(f);
    }
  });

  test("BGRA is mandatory — the renderer indexes it as MFVideoFormat_RGB32", () => {
    expect(live).toContain("-pix_fmt");
    expect(live[live.indexOf("-pix_fmt") + 1]).toBe("bgra");
    expect(live).not.toContain("rgb24");
  });

  test("scales to the requested size", () => {
    expect(live[live.indexOf("-vf") + 1]).toBe("scale=480:270");
  });

  test("rate control is left to the worker, not ffmpeg", () => {
    // The worker discards surplus frames; ffmpeg emits at the source rate. See the
    // long comment in buildVideoArgs for why -fps_mode/-r are unusable here.
    expect(live).not.toContain("-r");
  });

  test("writes raw video to stdout and takes no audio", () => {
    expect(live[live.indexOf("-f") + 1]).toBe("rawvideo");
    expect(live[live.length - 1]).toBe("-");
    expect(live).toContain("-an");
  });

  test("does not clamp fps into argv (the worker owns it)", () => {
    const odd = buildVideoArgs({
      ...BASE,
      url: "u",
      fps: 0,
      live: false,
      quiet: true,
    });
    expect(odd).not.toContain("-r");
  });
});

describe("buildAudioArgs", () => {
  const a = buildAudioArgs({
    url: "https://x/y.m3u8",
    rate: 48000,
    channels: 2,
    live: true,
    quiet: true,
  });

  test("input options precede -i", () => {
    expect(idx(a, "-live_start_index")).toBeLessThan(idx(a, "https://x/y.m3u8"));
  });

  test("requests headerless s16le PCM at the negotiated rate/channels", () => {
    expect(a[a.indexOf("-f") + 1]).toBe("s16le");
    expect(a[a.indexOf("-acodec") + 1]).toBe("pcm_s16le");
    expect(a[a.indexOf("-ar") + 1]).toBe("48000");
    expect(a[a.indexOf("-ac") + 1]).toBe("2");
    expect(a[a.length - 1]).toBe("-");
  });

  test("selects the audio stream and drops video", () => {
    expect(a).toContain("0:a:0");
    expect(a).toContain("-vn");
  });
});

describe("looksLive", () => {
  test("detects manifests, ignoring query strings", () => {
    expect(looksLive("https://a/b.m3u8")).toBe(true);
    expect(looksLive("https://a/b.m3u8?token=abc")).toBe(true);
    expect(looksLive("https://a/b.mpd")).toBe(true);
  });

  test("progressive files are not live", () => {
    expect(looksLive("https://a/b.mp4")).toBe(false);
    expect(looksLive("https://a/b.webm")).toBe(false);
  });

  test("a path merely containing 'm3u8' is not a manifest", () => {
    expect(looksLive("https://a/m3u8.mp4")).toBe(false);
  });
});
