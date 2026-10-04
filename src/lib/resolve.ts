/**
 * resolve — turn whatever a user typed into a DIRECT media URL that ffmpeg can open,
 * and say something honest when a live performer simply is not live right now.
 *
 * `video.ts` plays seekable local files through `MFCreateSourceReaderFromURL`, which can
 * only do local seekable files. A live stream is neither: it is an endlessly growing
 * HLS playlist whose segments expire. So ffmpeg is the transport/demuxer here, and this
 * module is the layer IN FRONT of it — the bit that decides what to hand over.
 *
 * Three jobs, in order:
 *
 *  1. SHORTCUTS. `isDirectMediaUrl` recognises something ffmpeg can already open
 *     (`.m3u8`/`.mpd`/`.mp4`/`.webm`/`.mkv`, or a known manifest path) and returns it
 *     UNCHANGED, so yt-dlp is never spawned for it. Twitch playlist URLs are the reason
 *     the suffix check is done on the PATH rather than with a naive `endswith`: the URL
 *     ends in a ~600-char opaque token before `.m3u8`, and query strings come after the
 *     extension. `normalizeTarget` expands exactly two shorthands —
 *     `chaturbate/<model>` and `twitch.tv/<channel>` — and touches nothing else. No
 *     model or channel is ever hardcoded.
 *
 *  2. RESOLUTION. `resolveStreamSources` shells out to
 *     `yt-dlp -g --no-playlist -f "best[height<=720]/bestvideo[height<=720]+bestaudio/best"
 *     <target>` and returns the URLs it printed. It is a PLURAL result because the
 *     selector's middle arm matches two formats on Chaturbate (which lists video and
 *     audio separately), and `-g` prints one line per format — so that site needs two
 *     ffmpeg inputs, while Twitch needs one. Exit code, stdout and stderr are all
 *     captured. A cookie jar may be supplied via `opts.cookiesFile` for rooms whose
 *     extractor calls an authenticated API; without one, Chaturbate reports the live
 *     model as "Requested format is not available".
 *
 *  3. CLASSIFICATION — the part that matters for a live-stream player. A model being
 *     offline is NOT an error, it is a normal state that resolves with time. Chaturbate's
 *     extractor maps its API's `room_status` onto five distinct messages (see yt-dlp
 *     `extractor/chaturbate.py::_ERROR_MAP`); four of them mean "wait and try again" and
 *     one means "you will never get in without a password". Those land as `offline`,
 *     `auth`, `geo` or `unknown`, and ONLY `offline` is retryable — so a `waitForOnline`
 *     loop retries a room that comes back online but gives up instantly on something
 *     that would never succeed. `retryable` is a plain field, so a caller that disagrees
 *     (e.g. wants to retry transient network blips too) can branch on `kind` itself.
 *
 * Every failure leaves here as a `ResolveError` whose `message` is a clean sentence. A
 * raw stack trace never reaches a terminal full of half-blocks. Cancellation is NOT a
 * classification: it is its own `ResolveAbortedError`, so callers can tell "the user hit
 * Ctrl-C" apart from "the performer is offline".
 *
 * The `--list-formats` table is parsed COLUMN-AGNOSTICALLY. yt-dlp's `--list-formats`
 * implies `--verbose`, hides every column that is empty for all rows
 * (`render_table(..., hide_empty=True)`), and moves FILESIZE/ABR/VBR in and out between
 * yt-dlp releases. So rows are split on the `|`/`│` delimiters and fields are identified
 * by SHAPE (`WxH`, bare digits, `1428k`, `1.20MiB`) rather than by position — and a
 * field yt-dlp did not print stays `null` instead of becoming a made-up zero.
 *
 * Used by the ffmpeg-backed CLI; see `video.ts` for the decoder side.
 */

import { tryStripchatFallback } from "./stripchat";

// ── Direct-media detection ─────────────────────────────────────────────────────────

/** Extensions that identify something ffmpeg can open as-is. */
export const DIRECT_MEDIA_EXTENSIONS: readonly string[] = [
  ".m3u8",
  ".mpd",
  ".mp4",
  ".webm",
  ".mkv",
];

/**
 * Extension-less manifests. Matched as SUBSTRINGS of the lowercased path, because the
 * useful part of these URLs is a fixed segment, not a file suffix.
 */
export const DIRECT_MEDIA_PATH_MARKERS: readonly string[] = [
  "/playlist", // Twitch: https://euc13.playlist.ttvnw.net/v1/playlist/<token>.m3u8
  "/hls/", // Chaturbate / highwebmedia HLS manifests
  "live-hls-web",
  "/dash/",
  "/manifest.mpd", // DASH manifests served without an .mpd suffix
  "/master.m3u8",
  ".ism/manifest", // Smooth Streaming
];

/** The URL's path with query and fragment removed — the only part suffix checks may use. */
function pathOf(url: string): string {
  const withoutFragment = url.split("#")[0] ?? "";
  const withoutQuery = withoutFragment.split("?")[0] ?? "";
  const schemeEnd = withoutQuery.indexOf("://");
  const afterScheme =
    schemeEnd === -1 ? withoutQuery : withoutQuery.slice(schemeEnd + 3);
  const slash = afterScheme.indexOf("/");
  return slash === -1 ? afterScheme : afterScheme.slice(slash);
}

/**
 * True when `target` is already a direct media URL ffmpeg can consume, so yt-dlp must
 * be bypassed entirely. Requires an http(s) scheme: `movie.mp4` is a local FILE, not a
 * URL, and is not this function's business.
 */
export function isDirectMediaUrl(target: string): boolean {
  const trimmed = target.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  const path = pathOf(trimmed).toLowerCase();
  if (DIRECT_MEDIA_EXTENSIONS.some((ext) => path.endsWith(ext))) return true;
  return DIRECT_MEDIA_PATH_MARKERS.some((marker) => path.includes(marker));
}

// ── Shorthand expansion ────────────────────────────────────────────────────────────

export const CHATURBATE_BASE_URL = "https://de.chaturbate.com/";
export const TWITCH_BASE_URL = "https://www.twitch.tv/";

/**
 * Expand the two supported shorthands and return everything else unchanged:
 *   `chaturbate/<model>`   → `https://de.chaturbate.com/<model>/`
 *   `twitch.tv/<channel>`  → `https://www.twitch.tv/<channel>`
 * An optional `www.` on the Twitch shorthand is accepted (same site, not broader
 * handling). Already-absolute URLs are never rewritten, so this is idempotent.
 */
export function normalizeTarget(target: string): string {
  const trimmed = target.trim();
  if (trimmed === "") return trimmed;

  const chaturbate = /^chaturbate\/([^/?#\s]+)\/?$/i.exec(trimmed);
  if (chaturbate !== null) return `${CHATURBATE_BASE_URL}${chaturbate[1]!}/`;

  const twitch = /^(?:www\.)?twitch\.tv\/([^/?#\s]+)\/?$/i.exec(trimmed);
  if (twitch !== null) return `${TWITCH_BASE_URL}${twitch[1]!}`;

  return trimmed;
}

// ── Failure classification ─────────────────────────────────────────────────────────

export type ResolveErrorKind = "offline" | "auth" | "geo" | "unknown";

/**
 * Retryable. Four of Chaturbate's five `_ERROR_MAP` messages land here — every one of
 * them is a state a private show or an idle performer walks out of:
 *   offline → `Room is currently offline`      (verified locally, yt-dlp 2026.09.27)
 *   hidden  → `Hidden session in progress`
 *   private → `Room is currently in a private show`
 *   away    → `Performer is currently away`
 * plus the generic not-live wording Twitch and other extractors use. `offline` alone is
 * deliberately broad — yt-dlp also emits it as a bare word ("offline_tipping", "is
 * offline") — because a false `offline` only costs one more poll, whereas a false
 * `unknown` kills a stream the user is watching come online.
 */
export const OFFLINE_PATTERNS: readonly RegExp[] = [
  /\boffline\b/, // Room is currently offline / offline_tipping / bare "offline"
  /hidden session in progress/, // Chaturbate _ERROR_MAP['hidden']
  /currently in a private show/, // Chaturbate _ERROR_MAP['private']
  /private show/,
  /performer is currently away/, // Chaturbate _ERROR_MAP['away']
  /currently away/,
  /\bnot (currently )?live\b/, // UserNotLive / "the channel is not currently live"
  /has not started/, // "Live event has not started"
  /no video formats found/, // how Twitch reports an offline channel
];

/**
 * Not retryable — no amount of waiting produces a URL. `Room is password protected`
 * (Chaturbate `_ERROR_MAP`) is the live-site member of this family; the rest is the
 * standard yt-dlp login/age/region wall.
 */
export const AUTH_PATTERNS: readonly RegExp[] = [
  /password protected/, // Chaturbate _ERROR_MAP['password protected']
  /sign in/, // "Sign in to confirm you're not a bot" / "...your age"
  /login required/,
  /requires authentication/,
  /only available for registered users/, // InfoExtractor.raise_login_required default
  /private video/,
  /members[- ]only/,
  /available to this channel'?s (members|subscribers)/,
  /confirm your age/,
  /age[- ]restricted/,
  /inappropriate for some users/,
  /use --cookies/,
  /cookies from/,
  /\bunauthorized\b/,
  /\bforbidden\b/,
  /http error 40[13]/,
];

/**
 * Not retryable — the stream exists, this machine cannot see it. Chaturbate raises this
 * from its API path (`raise_geo_restricted()`, whose default message is quoted below) when
 * `room_status` is `public` but no playlist URL comes back.
 */
export const GEO_PATTERNS: readonly RegExp[] = [
  /not available from your location/, // raise_geo_restricted default message
  /geo[- ]restric/, // "geo restriction", "geo-restricted"
  /not available in your (country|region)/,
  /not made this video available in your country/,
  /blocked it in your country/,
  /geo verification/,
];

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Pull the one human sentence out of yt-dlp's stderr. Prefers the `ERROR:` line and
 * strips yt-dlp's own `ERROR: [Extractor] <id>: ` prefix, so
 * `ERROR: [Chaturbate] pinkypuppa: Room is currently offline` becomes
 * `Room is currently offline`. Falls back to the last line that is neither a bracketed
 * verbose log nor a WARNING. Returns '' when there is nothing usable.
 */
export function cleanYtdlpMessage(stderr: string): string {
  const lines = stripAnsi(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  for (const line of lines) {
    const match = /^ERROR:\s*(?:\[[^\]]*\]\s*)?(?:[^:\s]+:\s*)?(.*)$/i.exec(
      line,
    );
    const detail = (match?.[1] ?? "").trim();
    if (detail !== "") return detail;
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (line.startsWith("[") || /^WARNING:/i.test(line)) continue;
    return line;
  }
  return "";
}

/**
 * Classify raw yt-dlp stderr. geo → auth → offline, in that order, so the narrowest and
 * most terminal conditions win; anything unrecognised is `unknown`.
 */
export function classifyFailure(stderr: string): ResolveErrorKind {
  const haystack = stripAnsi(stderr).toLowerCase();
  if (GEO_PATTERNS.some((pattern) => pattern.test(haystack))) return "geo";
  if (AUTH_PATTERNS.some((pattern) => pattern.test(haystack))) return "auth";
  if (OFFLINE_PATTERNS.some((pattern) => pattern.test(haystack)))
    return "offline";
  return "unknown";
}

// ── Errors ──────────────────────────────────────────────────────────────────────────

export interface ResolveErrorInit {
  kind: ResolveErrorKind;
  target: string;
  /** The clean one-line reason taken from yt-dlp. */
  detail: string;
  /** Raw stderr, ANSI-stripped — kept for the UI's "why did that fail" panel. */
  stderr?: string;
  exitCode?: number | null;
}

/** `de.chaturbate.com/pinkypuppa`, `www.twitch.tv/aidamoodi` — short enough for a status line. */
function targetLabel(target: string): string {
  const bare = target
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "");
  const segments = bare.split("/").filter((segment) => segment !== "");
  const host = segments[0] ?? bare;
  const tail = segments.length > 1 ? segments[segments.length - 1]! : undefined;
  return tail === undefined ? host : `${host}/${tail}`;
}

function humanSentence(init: ResolveErrorInit): string {
  const label = targetLabel(init.target);
  const because = init.detail === "" ? "" : ` (yt-dlp: ${init.detail})`;
  switch (init.kind) {
    case "offline":
      return `${label} is offline${because}`;
    case "auth":
      return `${label} requires authentication, a password or age verification${because}`;
    case "geo":
      return `${label} is geo-blocked in this region${because}`;
    default: {
      const code =
        init.exitCode === null ? "" : ` (yt-dlp exit ${init.exitCode})`;
      return `could not resolve ${label}${code}${because}`;
    }
  }
}

/**
 * A yt-dlp failure, already classified and already humanised. `message` is one clean
 * sentence — no stack trace, no `Error:` prefix soup. `retryable` is true ONLY for
 * `offline`; `detail`, `stderr` and `exitCode` are there so a UI can explain itself
 * without re-running the command.
 */
export class ResolveError extends Error {
  readonly kind: ResolveErrorKind;
  readonly retryable: boolean;
  readonly target: string;
  readonly detail: string;
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(init: ResolveErrorInit) {
    super(humanSentence(init));
    this.name = "ResolveError";
    this.kind = init.kind;
    this.retryable = init.kind === "offline";
    this.target = init.target;
    this.detail = init.detail;
    this.stderr = init.stderr ?? "";
    this.exitCode = init.exitCode ?? null;
  }
}

/**
 * Cancellation. Deliberately NOT a ResolveError: this is the user leaving, not the site
 * failing, and the two must never be conflated by a retry loop.
 */
export class ResolveAbortedError extends Error {
  constructor(message = "aborted", options?: ErrorOptions) {
    super(message, options);
    this.name = "ResolveAbortedError";
  }
}

export function isResolveError(error: unknown): error is ResolveError {
  return error instanceof ResolveError;
}

export function isResolveAbortedError(
  error: unknown,
): error is ResolveAbortedError {
  return error instanceof ResolveAbortedError;
}

// ── The spawn ───────────────────────────────────────────────────────────────────────

export const DEFAULT_YTDLP_BINARY = "yt-dlp";

/**
 * Format selector, as three FALLBACKS rather than one best-effort chain.
 *
 * The `best[height<=720]` arm covers the common case: a muxed progressive/HLS variant
 * with both tracks in one URL, so ffmpeg needs exactly one `-i`.
 *
 * The `bestvideo+bestaudio` arm exists for Chaturbate, whose extractor lists video and
 * audio as SEPARATE formats (`2  mp4 640x360 video only`, `audio_aac_128 audio only`).
 * `best` means "best format with BOTH tracks", so it matches nothing there and yt-dlp
 * fails with "Requested format is not available". `bestvideo[...]+bestaudio` matches two
 * formats instead, and `yt-dlp -g` prints ONE LINE PER FORMAT — so the caller gets two
 * URLs and must feed them to two separate ffmpegs.
 *
 * The final bare `best` is the last resort so a site with only low/unlabelled variants
 * still resolves instead of erroring.
 */
export const DEFAULT_FORMAT_SELECTOR =
  "best[height<=720]/bestvideo[height<=720]+bestaudio/best";

export interface ResolveOptions {
  /** Cancels the in-flight invocation; the child is killed, never orphaned. */
  signal?: AbortSignal;
  /** Executable to shell out to (default 'yt-dlp', resolved from PATH). */
  binary?: string;
  /**
   * Netscape-format cookie jar passed to yt-dlp as `--cookies <path>`.
   *
   * Needed for age-gated/private rooms: Chaturbate's extractor calls an authenticated
   * API, and without a session cookie it answers "Requested format is not available"
   * even while the model is live. The jar is ONLY handed to yt-dlp — the CDN URLs it
   * hands back carry their own `?session=` token and ffmpeg fetches them fine without
   * cookies. (ffmpeg's own `-cookies` takes newline-delimited `Set-Cookie` header
   * VALUES, not a Netscape file, so passing the path there would silently do nothing.)
   */
  cookiesFile?: string;
  /**
   * Browser to load cookies from, passed to yt-dlp as
   * `--cookies-from-browser <spec>` (e.g. `"chrome"`, `"chrome:Default"`,
   * `"edge"`, `"firefox"`).
   *
   * This reads the persistent login directly from the installed browser's
   * cookie store (DPAPI on Windows, same user) — no manual jar export needed.
   * When both this and `cookiesFile` are set, both flags are forwarded and
   * yt-dlp merges the sources (and dumps the jar back to `cookiesFile`).
   * See https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp
   */
  cookiesFromBrowser?: string;
}

/**
 * `--cookies-from-browser <spec>` and/or `--cookies <path>`, or nothing.
 *
 * A missing/blank jar path is dropped rather than forwarded: `--cookies ""` makes yt-dlp
 * try to parse an empty file and fail with a confusing error, which is worse than
 * resolving anonymously and getting an honest "offline" from the site.
 * Same for a blank browser spec.
 */
function cookieArgs(opts: ResolveOptions): string[] {
  const out: string[] = [];
  const browser = opts.cookiesFromBrowser?.trim();
  if (browser !== undefined && browser !== "")
    out.push("--cookies-from-browser", browser);
  const jar = opts.cookiesFile?.trim();
  if (jar !== undefined && jar !== "") out.push("--cookies", jar);
  return out;
}

/**
 * The `yt-dlp -g` argv, up to but excluding the target URL. Pure, so the cookie and
 * format-selector wiring is unit-testable without spawning anything.
 *
 * `--cookies` / `--cookies-from-browser` are yt-dlp GLOBAL options, so their position
 * among the other globals is irrelevant — but they must land before the URL, otherwise
 * yt-dlp treats the jar path/spec as a second URL and reports
 * "ERROR: unable to download webpage".
 */
export function buildResolveArgs(opts: ResolveOptions = {}): string[] {
  return [
    "-g",
    "--no-playlist",
    ...cookieArgs(opts),
    "-f",
    DEFAULT_FORMAT_SELECTOR,
  ];
}

interface YtdlpRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `signal.reason` when it carries one, so the caller's own message survives. */
function abortError(signal: AbortSignal): ResolveAbortedError {
  const reason: unknown = signal.reason;
  const message =
    reason instanceof Error && reason.message !== ""
      ? reason.message
      : "aborted";
  return reason instanceof Error
    ? new ResolveAbortedError(message, { cause: reason })
    : new ResolveAbortedError(message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined || !signal.aborted) return;
  throw abortError(signal);
}

/**
 * Spawn yt-dlp and read BOTH pipes plus the exit code together.
 *
 * `stdin: 'ignore'` is not cosmetic: this runs inside a CharTerm TUI, and an inherited
 * stdin would let yt-dlp eat the user's keystrokes mid-playback.
 *
 * On abort the child is killed and the rejection is immediate — `proc.exited` is observed
 * (so the handle is reaped and cannot outlive the call) but not awaited, so cancelling
 * never blocks on a process that may be wedged in a socket read.
 */
async function runYtdlp(
  args: string[],
  opts: ResolveOptions,
): Promise<YtdlpRun> {
  const signal = opts.signal;
  throwIfAborted(signal);

  const proc = Bun.spawn({
    cmd: [opts.binary ?? DEFAULT_YTDLP_BINARY, ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const drained: Promise<YtdlpRun> = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));

  if (signal === undefined) return await drained;

  const cancelled = new Promise<YtdlpRun>((_resolve, reject) => {
    const onAbort = (): void => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
      void proc.exited.catch(() => {});
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void drained.then(
      () => signal.removeEventListener("abort", onAbort),
      () => signal.removeEventListener("abort", onAbort),
    );
  });

  return await Promise.race([drained, cancelled]);
}

/**
 * Split `yt-dlp -g` stdout into video/audio sources.
 *
 * `-g` prints one URL per selected format, in selector order: a muxed source yields a
 * single line, a `bestvideo+bestaudio` source yields video first then audio. Anything
 * that is not an http(s) URL is discarded — a stray progress or warning line on stdout
 * must not be handed to ffmpeg as `-i`. Returns null when nothing usable survived, so
 * the caller falls through to `classifyRun` and reports the real stderr instead of a
 * generic "no URL".
 */
export function parseSourceUrls(stdout: string): StreamSources | null {
  const urls = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
  const video = urls[0];
  if (video === undefined) return null;
  // A second URL is only trustworthy as the AUDIO track if it differs from the first;
  // a duplicate line means the extractor echoed the same muxed URL twice.
  const second = urls[1];
  return second === undefined || second === video
    ? { video }
    : { video, audio: second };
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : String(error);
}

/** yt-dlp missing from PATH, ENOENT, EPERM… anything that went wrong before it could talk. */
function spawnFailure(target: string, error: unknown): ResolveError {
  return new ResolveError({
    kind: "unknown",
    target,
    detail: `${DEFAULT_YTDLP_BINARY} could not be started: ${errorText(error)}`,
  });
}

/** A completed run that did not produce a usable URL → classified ResolveError. */
function classifyRun(target: string, run: YtdlpRun): ResolveError {
  const stderr = stripAnsi(run.stderr).trim();
  const detail = cleanYtdlpMessage(run.stderr);
  return new ResolveError({
    kind: detail === "" ? "unknown" : classifyFailure(run.stderr),
    target,
    detail:
      detail === "" && run.stdout.trim() === ""
        ? `no output (exit ${run.exitCode})`
        : detail === ""
          ? "yt-dlp produced no URL"
          : detail,
    stderr,
    exitCode: run.exitCode,
  });
}

// ── Public resolution ───────────────────────────────────────────────────────────────

/**
 * What ffmpeg has to open, as resolved from a user-typed target.
 *
 * `audio` is present only when the site ships SEPARATE video and audio URLs — Chaturbate
 * does (`bestvideo+bestaudio` matched two formats, so `-g` printed two lines). When it is
 * `undefined` the single muxed `video` URL carries both tracks, which is Twitch's case
 * and the direct-`.m3u8` case. `audioUrl` is threaded separately rather than merged
 * because there is no way to merge them for free: two HLS manifests are two inputs, and
 * ffmpeg would need `-i v.m3u8 -i a.m3u8 -map 0:v -map 1:a` in ONE process, replacing
 * the two-independent-pipes design that keeps each track paced on its own clock.
 */
export interface StreamSources {
  video: string;
  audio?: string;
}

/**
 * Resolve a user-supplied target to the direct media URL(s) ffmpeg can open.
 *
 * A target that is ALREADY a direct media URL (`isDirectMediaUrl`) is returned unchanged
 * without spawning yt-dlp at all. Everything else is normalised (`normalizeTarget`) and
 * handed to `yt-dlp -g --no-playlist -f <DEFAULT_FORMAT_SELECTOR>`, whose stdout lines
 * are the URLs — one line for a muxed source, two for a split video/audio source.
 *
 * @throws {ResolveError} any yt-dlp failure, classified `offline` / `auth` / `geo` / `unknown`.
 * @throws {ResolveAbortedError} if `opts.signal` fired.
 */
export async function resolveStreamSources(
  target: string,
  opts: ResolveOptions = {},
): Promise<StreamSources> {
  const normalized = normalizeTarget(target);
  if (normalized === "") {
    throw new ResolveError({ kind: "unknown", target, detail: "empty target" });
  }
  if (isDirectMediaUrl(normalized)) {
    return { video: normalized }; // bypass yt-dlp entirely
  }
  throwIfAborted(opts.signal);

  let run: YtdlpRun;
  try {
    run = await runYtdlp([...buildResolveArgs(opts), normalized], opts);
  } catch (error) {
    if (error instanceof ResolveAbortedError) throw error;
    throw spawnFailure(normalized, error);
  }

  if (run.exitCode === 0) {
    const sources = parseSourceUrls(run.stdout);
    if (sources !== null) return sources;
  }
  const failure = classifyRun(normalized, run);
  // Stripchat serves a stale `show` object after a private/p2p show ends while the
  // model is already public again — yt-dlp then reports "private show" (or, logged
  // in, the locale-subdomain JS shell has no preloaded state at all: "Unable to
  // extract data"). The fallback re-checks the page state itself; when inconclusive
  // it returns null and the ORIGINAL error below is what the caller sees.
  const stripchat = await tryStripchatFallback(normalized, {
    signal: opts.signal,
  });
  if (stripchat !== null) return stripchat;
  throw failure;
}

// ── Polling until the performer shows up ─────────────────────────────────────────────

export const DEFAULT_WAIT_INTERVAL_MS = 10_000;

export interface WaitOptions extends ResolveOptions {
  /** Delay between attempts (default 10_000). */
  intervalMs?: number;
  /** Attempts AFTER the first one (default Infinity — wait forever). */
  retries?: number;
  /** Fired before each sleep with the 1-based attempt number and the classified failure. */
  onWait?: (attempt: number, reason: ResolveError) => void;
}

/**
 * Abort-aware sleep. The listener is always removed on either exit path, so a long
 * `waitForOnline` cannot accumulate listeners, and an abort during the sleep rejects
 * immediately rather than waiting out the remaining interval.
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  const sig = signal;
  return new Promise<void>((resolve, reject) => {
    if (sig === undefined) {
      setTimeout(resolve, ms);
      return;
    }
    if (sig.aborted) {
      reject(abortError(sig));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      sig.removeEventListener("abort", onAbort);
      reject(abortError(sig));
    };
    timer = setTimeout(() => {
      sig.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    sig.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll `resolveStreamSources` until it succeeds.
 *
 * Retries ONLY classified `offline` failures (`retryable`), which is the whole point: a
 * model who is offline right now may be live in two minutes, but a password wall or a
 * geo-block will never clear, so those are rethrown on the first attempt and the caller
 * is expected to report and stop. `retries` counts attempts after the first, so
 * `retries: 3` means at most four yt-dlp calls. `onWait(attempt, reason)` fires before
 * each sleep so the UI can say "still offline, retry 2/∞".
 *
 * Returns the resolved sources. Throws the last `ResolveError` when retries are exhausted,
 * a non-retryable `ResolveError` immediately, and `ResolveAbortedError` on cancellation —
 * a cancellation can never be mistaken for a failed stream, and never hangs.
 */
export async function waitForOnline(
  target: string,
  opts: WaitOptions = {},
): Promise<StreamSources> {
  const intervalMs = opts.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const retries = opts.retries ?? Infinity;
  const signal = opts.signal;
  let attempt = 0;

  for (;;) {
    throwIfAborted(signal);
    try {
      return await resolveStreamSources(target, opts);
    } catch (error) {
      if (error instanceof ResolveAbortedError) throw error;
      if (!(error instanceof ResolveError)) throw error;
      if (!error.retryable || attempt >= retries) throw error;
      attempt += 1;
      opts.onWait?.(attempt, error);
      await sleep(intervalMs, signal);
    }
  }
}

// ── Format table ─────────────────────────────────────────────────────────────────────

/** One `--list-formats` row. Every field is `null` when yt-dlp did not print it. */
export interface FormatRow {
  formatId: string;
  ext: string | null;
  resolution: string | null;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  filesize: number | null;
}

const FORMAT_HEADER = /^ID\s+EXT\b/;
const TABLE_RULE = /^[-─]{5,}$/;
const COLUMN_DELIM = /[|│]/;
const SHAPE_RESOLUTION = /^\d+x\d+$/i;
const SHAPE_FPS = /^\d+(?:\.\d+)?$/;
const SHAPE_BITRATE = /^\d+(?:\.\d+)?k$/i;
/**
 * A single cell of the codec group. `simplified_codec()` returns either a real codec
 * string or one of the stylistic labels — and two of those labels contain a SPACE
 * ("audio only", "video only"). A plain whitespace split would tear `audio only` into
 * `audio` + `only` and shift ACODEC out of the row entirely, so the label is matched as
 * a unit before the generic any-non-space-run fallback is tried.
 */
const CODEC_CELL = /audio only|video only|[^\s]+/g;

/** `1,024.00KiB`, `≈1.20MiB`, `~512B`, `12.50GiB` → bytes. null for `unknown` / TBR tokens. */
function parseByteSize(token: string): number | null {
  const match = /^(?:[≈~]\s*)?([\d.,]+)\s*(B|[KMGT]i?B)$/.exec(token);
  if (match === null) return null;
  const value = Number((match[1] ?? "").replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const unit = match[2]!;
  // Rounded: a byte count is an integer, and `1.20MiB` is a rounded human figure anyway.
  return unit === "B"
    ? Math.round(value)
    : Math.round(value * 2 ** (("KMGT".indexOf(unit[0]!) + 1) * 10));
}

/**
 * Parse one table row: `[ID EXT RES FPS] | [FILESIZE TBR PROTO] | [VCODEC VBR ACODEC ABR …]`.
 * Fields are recognised by shape, never by index, because yt-dlp's column set shifts
 * between releases and `hide_empty` drops any column that is empty for every row.
 */
function parseFormatRow(line: string): FormatRow | null {
  const groups = line.split(COLUMN_DELIM).map((group) => group.trim());
  const left = (groups[0] ?? "").split(/\s+/).filter((token) => token !== "");
  const formatId = left[0];
  if (formatId === undefined || formatId === "") return null;
  const ext = left[1] ?? null;

  // RESOLUTION is "WxH", a spaced label ("audio only", "images"), or absent entirely.
  let resolution: string | null = null;
  let fps: number | null = null;
  const rest = left.slice(2);
  const head = rest[0];
  if (head !== undefined) {
    if (SHAPE_RESOLUTION.test(head)) {
      resolution = head;
      const maybeFps = rest[1];
      if (maybeFps !== undefined && SHAPE_FPS.test(maybeFps))
        fps = Number(maybeFps);
    } else if (SHAPE_FPS.test(head)) {
      fps = Number(head); // RESOLUTION column hidden by hide_empty
    } else {
      resolution = rest.join(" ");
    }
  }

  // PROTO is always last in its group; anything before it is FILESIZE and/or TBR.
  const middle = (groups[1] ?? "").split(/\s+/).filter((token) => token !== "");
  let filesize: number | null = null;
  for (const token of middle.slice(0, -1)) {
    const bytes = parseByteSize(token);
    if (bytes !== null) {
      filesize = bytes;
      break;
    }
  }

  // Codec columns come first; VBR / ABR / ASR are all `<number>k` and are not returned.
  // Tokenised with CODEC_CELL so the spaced labels survive as one cell.
  const codecs = [...(groups[2] ?? "").matchAll(CODEC_CELL)]
    .map((match) => match[0]!)
    .filter((cell) => cell !== "" && !SHAPE_BITRATE.test(cell));

  return {
    formatId,
    ext,
    resolution,
    fps,
    vcodec: codecs[0] ?? null,
    acodec: codecs[1] ?? null,
    filesize,
  };
}

/**
 * Parse `yt-dlp --list-formats` stdout. The table is emitted on STDOUT (with
 * `--list-formats` implying `--verbose`, so `[extractor] Extracting URL: …` lines share
 * it); those are skipped, along with blank lines and any trailing prose after the table.
 * Returns [] rather than throwing when no table is present.
 */
export function parseFormatRows(output: string): FormatRow[] {
  const rows: FormatRow[] = [];
  let sawHeader = false;
  let sawRule = false;
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!sawRule) {
      if (!sawHeader && FORMAT_HEADER.test(trimmed)) sawHeader = true;
      else if (sawHeader && TABLE_RULE.test(trimmed)) sawRule = true;
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("[")) continue; // blank / verbose / warning
    if (!COLUMN_DELIM.test(trimmed)) continue; // prose after the table
    const row = parseFormatRow(trimmed);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/**
 * Run `yt-dlp --list-formats --no-playlist <target>` and return the printed rows.
 *
 * Note that this deliberately does NOT short-circuit on `isDirectMediaUrl`: a direct
 * `.m3u8` still has real HLS variants worth listing, and bypassing yt-dlp here would
 * report "no formats" for exactly the URLs that have the most.
 *
 * @throws {ResolveError} classified the same way as `resolveStreamSources`.
 */
export async function listFormats(
  target: string,
  opts: ResolveOptions = {},
): Promise<FormatRow[]> {
  const normalized = normalizeTarget(target);
  if (normalized === "") {
    throw new ResolveError({ kind: "unknown", target, detail: "empty target" });
  }
  throwIfAborted(opts.signal);

  let run: YtdlpRun;
  try {
    run = await runYtdlp(
      ["--list-formats", "--no-playlist", ...cookieArgs(opts), normalized],
      opts,
    );
  } catch (error) {
    if (error instanceof ResolveAbortedError) throw error;
    throw spawnFailure(normalized, error);
  }

  if (run.exitCode !== 0) throw classifyRun(normalized, run);
  return parseFormatRows(run.stdout);
}
