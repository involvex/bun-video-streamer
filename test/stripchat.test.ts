/**
 * Tests for src/lib/stripchat.ts — the stale-`show` fallback.
 *
 * Regression origin: yt-dlp reported "Model is in a private show" (and, logged in,
 * "Unable to extract data") for a Stripchat room that was public and live, because
 * the ended p2p `show` object ({ mode: p2p, endedAt: <hours ago>, endBy: user })
 * stays in `window.__PRELOADED_STATE__` while `model.status` is already `public`
 * with `isLive: true` (verified 2026-10-04 against ErisVesper).
 *
 * All fixtures here are synthetic and minimal — no network, no real page dumps.
 */
import { describe, expect, test } from "bun:test";
import {
  buildStripchatHlsUrls,
  extractPreloadedState,
  isStripchatModelUrl,
  parseHlsVariants,
  selectCappedVariant,
  stripchatLiveFromState,
} from "../src/lib/stripchat";

const NOW = Date.parse("2026-10-04T12:00:00Z");

function state(over: Record<string, any> = {}): Record<string, any> {
  return {
    viewCam: {
      model: { id: 1234567, status: "public", isLive: true },
      streamName: "abcdefghi",
      show: {
        mode: "p2p",
        endedAt: "2026-10-04T10:54:28Z",
        endBy: "user",
        isDeleted: false,
      },
      ...over,
    },
    configV3: {
      initialCommon: {
        hlsStreamUrlTemplate:
          "https://edge-hls.{cdnHost}/hls/{streamName}/master/{streamName}{suffix}.m3u8",
        hlsStreamHost: "doppiocdn.media",
        hlsStreamHosts: { A: "doppiocdn.com", B: "doppiocdn1.com" },
      },
    },
  };
}

const htmlOf = (data: unknown): string =>
  `<html><head><script>window.__PRELOADED_STATE__ = ${JSON.stringify(data)};</script></head></html>`;

describe("isStripchatModelUrl", () => {
  test("matches model URLs incl. locale subdomains", () => {
    expect(isStripchatModelUrl("https://stripchat.com/ErisVesper")).toBe(true);
    expect(isStripchatModelUrl("https://www.stripchat.com/ErisVesper/")).toBe(
      true,
    );
    expect(isStripchatModelUrl("https://de.stripchat.com/ErisVesper")).toBe(
      true,
    );
  });

  test("rejects other sites and bare paths", () => {
    expect(isStripchatModelUrl("https://chaturbate.com/x")).toBe(false);
    expect(isStripchatModelUrl("https://stripchat.com/")).toBe(false);
    expect(isStripchatModelUrl("not a url")).toBe(false);
  });
});

describe("extractPreloadedState", () => {
  test("parses the embedded JSON", () => {
    const data = state();
    expect(extractPreloadedState(htmlOf(data))).toEqual(data);
  });

  test("returns null when absent or broken", () => {
    expect(
      extractPreloadedState("<html><body>shell, no state</body></html>"),
    ).toBeNull();
    expect(
      extractPreloadedState("window.__PRELOADED_STATE__ = {oops"),
    ).toBeNull();
    expect(
      extractPreloadedState("window.__PRELOADED_STATE__ = null;"),
    ).toBeNull();
  });
});

describe("stripchatLiveFromState", () => {
  test("a stale ended show with a public live model is live", () => {
    const live = stripchatLiveFromState(state(), NOW);
    expect(live).not.toBeNull();
    expect(live!.streamName).toBe("abcdefghi");
    expect(live!.hosts[0]).toBe("doppiocdn.media");
    expect(live!.hosts).toContain("doppiocdn.com");
  });

  test("no show object at all is live", () => {
    const { show: _dropped, ...rest } = state().viewCam;
    expect(
      stripchatLiveFromState({ ...state(), viewCam: rest }, NOW),
    ).not.toBeNull();
  });

  test("a running show without endedAt stays private", () => {
    const s = state({ show: { mode: "private", isDeleted: false } });
    expect(stripchatLiveFromState(s, NOW)).toBeNull();
  });

  test("a show ending in the future stays private", () => {
    const s = state({
      show: { mode: "group", endedAt: "2026-10-04T13:00:00Z" },
    });
    expect(stripchatLiveFromState(s, NOW)).toBeNull();
  });

  test("offline or non-public models are not live", () => {
    expect(
      stripchatLiveFromState(
        state({ model: { status: "public", isLive: false } }),
        NOW,
      ),
    ).toBeNull();
    expect(
      stripchatLiveFromState(
        state({ model: { status: "away", isLive: true } }),
        NOW,
      ),
    ).toBeNull();
  });

  test("missing streamName or hosts is inconclusive", () => {
    expect(stripchatLiveFromState(state({ streamName: "" }), NOW)).toBeNull();
    const s = state();
    delete (s.configV3.initialCommon as Record<string, unknown>).hlsStreamHost;
    delete (s.configV3.initialCommon as Record<string, unknown>).hlsStreamHosts;
    expect(stripchatLiveFromState(s, NOW)).toBeNull();
  });

  test("falls back to the default template when the page has none", () => {
    const s = state();
    delete (s.configV3.initialCommon as Record<string, unknown>)
      .hlsStreamUrlTemplate;
    const live = stripchatLiveFromState(s, NOW);
    expect(live!.template).toContain("{cdnHost}");
    expect(live!.template).toContain("{streamName}");
  });
});

describe("buildStripchatHlsUrls", () => {
  test("current streamName shape first, legacy model-id shape after", () => {
    const urls = buildStripchatHlsUrls({
      streamName: "abcdefghi",
      modelId: 1234567,
      template:
        "https://edge-hls.{cdnHost}/hls/{streamName}/master/{streamName}{suffix}.m3u8",
      hosts: ["doppiocdn.media", "doppiocdn.com"],
    });
    expect(urls[0]).toBe(
      "https://edge-hls.doppiocdn.media/hls/abcdefghi/master/abcdefghi_auto.m3u8",
    );
    expect(urls).toContain(
      "https://edge-hls.doppiocdn.media/hls/1234567/master/1234567_auto.m3u8",
    );
    expect(
      urls.indexOf(
        "https://edge-hls.doppiocdn.com/hls/abcdefghi/master/abcdefghi_auto.m3u8",
      ),
    ).toBeLessThan(
      urls.indexOf(
        "https://edge-hls.doppiocdn.media/hls/1234567/master/1234567_auto.m3u8",
      ),
    );
  });
});

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=30
1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,FRAME-RATE=30
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,FRAME-RATE=30
360p.m3u8
`;

describe("parseHlsVariants", () => {
  test("reads bandwidth/resolution and resolves relative URIs", () => {
    const vs = parseHlsVariants(
      MASTER,
      "https://edge-hls.doppiocdn.media/hls/s/master/s_auto.m3u8",
    );
    expect(vs).toHaveLength(3);
    expect(vs[0]).toMatchObject({
      bandwidth: 6000000,
      width: 1920,
      height: 1080,
    });
    expect(vs[1]!.uri).toBe(
      "https://edge-hls.doppiocdn.media/hls/s/master/720p.m3u8",
    );
  });

  test("media playlists yield no variants", () => {
    expect(
      parseHlsVariants("#EXTM3U\n#EXTINF:6.0,\nseg.ts\n", "https://x/y.m3u8"),
    ).toEqual([]);
  });
});

describe("selectCappedVariant", () => {
  const vs = parseHlsVariants(
    MASTER,
    "https://edge-hls.doppiocdn.media/hls/s/master/s_auto.m3u8",
  );

  test("picks the best rendition at or below 720p, not the 1080p top", () => {
    const v = selectCappedVariant(vs, 720)!;
    expect(v.height).toBe(720);
    expect(v.uri.endsWith("720p.m3u8")).toBe(true);
  });

  test("when everything is taller, takes the cheapest instead of stalling", () => {
    const tall = vs.filter((v) => (v.height ?? 0) > 720);
    const v = selectCappedVariant(tall, 720)!;
    expect(v.height).toBe(1080);
  });

  test("null when nothing parsed", () => {
    expect(selectCappedVariant([], 720)).toBeNull();
  });
});
