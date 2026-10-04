/**
 * stripchat — fallback resolver for Stripchat's stale-`show` state.
 *
 * WHY THIS EXISTS: yt-dlp's StripchatIE decides "private show" from a single check —
 * `viewCam.show` being a dict (`stripchat.py::_real_extract`). But Stripchat leaves the
 * LAST show object in `window.__PRELOADED_STATE__` after it ends, `endedAt` and all:
 * a model who is `status: public`, `isLive: true`, `playerStatus: playing` still carries
 * `show: { mode: p2p, endedAt: <hours ago>, endBy: user }`, so a live public room
 * resolves as "Model is in a private show" (verified 2026-10-04, yt-dlp nightly
 * 2026.09.27). And with login cookies the site serves a locale-subdomain JS shell
 * (`de.stripchat.com`) with NO preloaded state at all, which lands as the generic
 * "Unable to extract data". Both are wrong for a public stream.
 *
 * WHAT THIS DOES: when yt-dlp fails on a Stripchat model URL, fetch the model page
 * ourselves (anonymous, browser UA — the anonymous page is the one that carries the
 * server-rendered state), parse `window.__PRELOADED_STATE__`, and believe the MODEL
 * flags over the stale SHOW object: public + isLive + (no show, or show.endedAt in
 * the past) means live. The HLS master URL is built from the page's own
 * `configV3.initialCommon` template (`https://edge-hls.{cdnHost}/hls/{streamName}/
 * master/{streamName}_auto.m3u8`) and each candidate is probed (HTTP 200 + `#EXTM3U`)
 * before it is handed out — an unverified guess never reaches ffmpeg.
 *
 * Anything inconclusive returns null and the caller rethrows yt-dlp's ORIGINAL error,
 * so this fallback can never turn a real offline/private room into a bogus URL.
 */

export const STRIPCHAT_MODEL_RE =
  /^https?:\/\/(?:www\.|[a-z]{2}\.)?stripchat\.com\/([^/?#\s]+)\/?$/i;

/** True for `https://stripchat.com/<model>` incl. locale subdomains (`de.`, `www.`). */
export function isStripchatModelUrl(target: string): boolean {
  return STRIPCHAT_MODEL_RE.test(target.trim());
}

const PRELOADED_RE = /window\.__PRELOADED_STATE__\s*=\s*\{/;
/**
 * Plain `fetch` with only a UA gets HTTP 406 (empty body) from stripchat.com — the
 * WAF wants a browser-like `Accept` set (verified 2026-10-04). Used for BOTH the
 * model page and the CDN playlist probes.
 */
const STRIPCHAT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

const DEFAULT_HLS_TEMPLATE =
  "https://edge-hls.{cdnHost}/hls/{streamName}/master/{streamName}{suffix}.m3u8";

/** Balanced-brace slice from `start` (which must point at `{`), quote-aware. */
function extractBalanced(source: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse `window.__PRELOADED_STATE__ = {...}` out of model-page HTML.
 * Returns the state object, or null when absent/unparseable — never throws.
 */
export function extractPreloadedState(html: string): Record<string, any> | null {
  const m = PRELOADED_RE.exec(html);
  if (m === null || m.index === undefined) return null;
  const brace = html.indexOf("{", m.index);
  if (brace === -1) return null;
  const raw = extractBalanced(html, brace);
  if (raw === null) return null;
  try {
    const data: unknown = JSON.parse(raw);
    return typeof data === "object" && data !== null ? (data as Record<string, any>) : null;
  } catch {
    return null;
  }
}

export interface StripchatLive {
  /** Value for `{streamName}` in the HLS template. */
  streamName: string;
  /** Numeric model id, for the legacy `{id}_auto.m3u8` candidate shape. */
  modelId?: number;
  /** Template with `{cdnHost}` / `{streamName}` / `{suffix}` placeholders. */
  template: string;
  /** CDN hosts to try, primary first. */
  hosts: string[];
}

/**
 * Believe the MODEL flags, not a stale SHOW object. Live means: `model.status` is
 * `public`, `model.isLive` is true, and `viewCam.show` is either absent/not-a-dict
 * or carries an `endedAt` timestamp in the past (an ended p2p/group/ticket show the
 * site left in the state). A show dict WITHOUT `endedAt` is a genuinely running
 * show → null (the room really is private).
 */
export function stripchatLiveFromState(
  data: Record<string, any>,
  nowMs = Date.now(),
): StripchatLive | null {
  const viewCam: unknown = data.viewCam;
  if (typeof viewCam !== "object" || viewCam === null) return null;
  const vc = viewCam as Record<string, any>;
  const model: unknown = vc.model;
  if (typeof model !== "object" || model === null) return null;
  const status = (model as Record<string, any>).status;
  const isLive = (model as Record<string, any>).isLive;
  if (status !== "public" || isLive !== true) return null;

  const show: unknown = vc.show;
  if (typeof show === "object" && show !== null && !Array.isArray(show)) {
    const endedAt: unknown = (show as Record<string, any>).endedAt;
    const endedMs = typeof endedAt === "string" && endedAt !== "" ? Date.parse(endedAt) : NaN;
    // No (parseable) end timestamp → the show is running → really private.
    if (!Number.isFinite(endedMs) || endedMs > nowMs) return null;
  }

  const streamName: unknown = vc.streamName;
  if (typeof streamName !== "string" || streamName === "") return null;

  const initialCommon: unknown = data?.configV3?.initialCommon;
  const ic =
    typeof initialCommon === "object" && initialCommon !== null
      ? (initialCommon as Record<string, any>)
      : {};
  const template =
    typeof ic.hlsStreamUrlTemplate === "string" && ic.hlsStreamUrlTemplate !== ""
      ? ic.hlsStreamUrlTemplate
      : DEFAULT_HLS_TEMPLATE;
  const hosts: string[] = [];
  if (typeof ic.hlsStreamHost === "string" && ic.hlsStreamHost !== "") hosts.push(ic.hlsStreamHost);
  const map: unknown = ic.hlsStreamHosts;
  if (typeof map === "object" && map !== null) {
    for (const h of Object.values(map as Record<string, unknown>)) {
      if (typeof h === "string" && h !== "" && !hosts.includes(h)) hosts.push(h);
    }
  }
  if (hosts.length === 0) return null;

  const rawId: unknown = (model as Record<string, any>).id;
  const modelId = typeof rawId === "number" && Number.isFinite(rawId) ? rawId : undefined;
  return { streamName, modelId, template, hosts };
}

/**
 * Master-playlist candidates: current `{streamName}_auto` shape per host, then the
 * legacy `{modelId}_auto` shape yt-dlp's extractor still builds. Suffix `_auto` is
 * what the live site serves (verified 2026-10-04: 200 + `#EXTM3U`).
 */
export function buildStripchatHlsUrls(live: StripchatLive): string[] {
  const urls: string[] = [];
  const push = (u: string): void => {
    if (!urls.includes(u)) urls.push(u);
  };
  for (const host of live.hosts) {
    push(
      live.template
        .replace("{cdnHost}", host)
        .replaceAll("{streamName}", live.streamName)
        .replace("{suffix}", "_auto"),
    );
  }
  if (live.modelId !== undefined) {
    for (const host of live.hosts) {
      push(`https://edge-hls.${host}/hls/${live.modelId}/master/${live.modelId}_auto.m3u8`);
    }
  }
  return urls;
}

export interface StripchatFallbackOptions {
  signal?: AbortSignal;
  /** Per-request timeout ms (default 15_000). */
  timeoutMs?: number;
  /**
   * Cap variant renditions at this height (default 720) — mirrors yt-dlp's
   * `best[height<=720]` selector. Without it ffmpeg plays the ABR master's top
   * rendition (1080p+), which stalls on connections that cannot sustain it while
   * Chaturbate (capped by the selector) stays smooth.
   */
  maxHeight?: number;
}

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  width: number | null;
  height: number | null;
}

/**
 * Parse `#EXT-X-STREAM-INF` variants out of a master playlist, resolving relative
 * URIs against the master URL. Pure. Returns [] for media playlists (no variants).
 */
export function parseHlsVariants(masterText: string, baseUrl: string): HlsVariant[] {
  const lines = masterText.split("\n");
  const out: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const bw = Number(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? NaN);
    const res = /RESOLUTION=(\d+)x(\d+)/.exec(line);
    const rawUri = (lines[i + 1] ?? "").trim();
    if (rawUri === "" || rawUri.startsWith("#")) continue;
    let uri: string;
    try {
      uri = new URL(rawUri, baseUrl).href;
    } catch {
      continue;
    }
    out.push({
      uri,
      bandwidth: Number.isFinite(bw) ? bw : 0,
      width: res !== null ? Number(res[1]) : null,
      height: res !== null ? Number(res[2]) : null,
    });
  }
  return out;
}

/**
 * Best variant at or below `maxHeight` (highest bandwidth wins); when every
 * variant is taller, the cheapest one — a small smooth picture beats a stalled
 * big one. Variants WITHOUT resolution info are only used when nothing parsed
 * better: unknown size must not outrank a known-good capped pick.
 */
export function selectCappedVariant(variants: HlsVariant[], maxHeight = 720): HlsVariant | null {
  const known = variants.filter((v) => v.height !== null);
  const capped = known.filter((v) => (v.height as number) <= maxHeight);
  const pool = capped.length > 0 ? capped : known;
  if (pool.length === 0) return null;
  return pool.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
}

/**
 * Try to resolve a Stripchat model URL without yt-dlp. Returns `{ video }` with a
 * PROBED master playlist, or null when anything is inconclusive (not a model URL,
 * fetch failed, no state, model not public/live, no candidate answered 200+#EXTM3U).
 * Never throws for site reasons — only an aborted signal rejects.
 */
export async function tryStripchatFallback(
  target: string,
  opts: StripchatFallbackOptions = {},
): Promise<{ video: string } | null> {
  if (!isStripchatModelUrl(target)) return null;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxHeight = opts.maxHeight ?? 720;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (opts.signal?.aborted) return null;
    let html: string;
    try {
      const res = await fetch(target.trim(), {
        headers: STRIPCHAT_HEADERS,
        signal: controller.signal,
      });
      if (!res.ok) return null;
      html = await res.text();
    } catch {
      return null;
    }
    const live = stripchatLiveFromState(extractPreloadedState(html) ?? {});
    if (live === null) return null;
    for (const url of buildStripchatHlsUrls(live)) {
      try {
        const res = await fetch(url, {
          headers: STRIPCHAT_HEADERS,
          signal: controller.signal,
        });
        if (!res.ok) continue;
        const master = (await res.text()).slice(0, 65536);
        if (!master.includes("#EXTM3U")) continue;
        // Master with renditions: descend to the capped variant so ffmpeg never
        // chews the top 1080p+ rendition on a thin connection. The variant is
        // probed the same way; a media playlist (no variants) is used as-is.
        const variant = selectCappedVariant(parseHlsVariants(master, url), maxHeight);
        if (variant === null) return { video: url };
        try {
          const vres = await fetch(variant.uri, {
            headers: STRIPCHAT_HEADERS,
            signal: controller.signal,
          });
          if (!vres.ok) continue;
          const head = (await vres.text()).slice(0, 512);
          if (head.includes("#EXTM3U")) return { video: variant.uri };
        } catch {
          if (controller.signal.aborted) return null;
          continue;
        }
      } catch {
        if (controller.signal.aborted) return null;
        continue;
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
