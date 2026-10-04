/**
 * stream — play a LIVE stream (Twitch, Chaturbate, anything yt-dlp understands, or a
 * direct .m3u8/.mpd/.mp4 URL) in the terminal, in ASCII/half-block colour.
 *
 *   bun run src/stream.ts chaturbate/<model>
 *   bun run src/stream.ts twitch.tv/<channel>
 *   bun run src/stream.ts https://example.com/live.m3u8
 *
 * WHY THIS ISN'T video.ts: that file uses Media Foundation's MFCreateSourceReaderFromURL,
 * which needs a seekable, COMPLETE local file. Live streams are HLS, which MF cannot
 * demux without a hand-written IMFMediaSource/IMFByteStream COM resolver — and even a
 * "growing file" trick fails because video.ts treats EOF as "loop the clip", which on a
 * live stream is a hot spin-loop over a zero-length file.
 *
 * So here ffmpeg is the transport, demuxer, decoder and scaler, feeding raw BGRA frames
 * over a pipe that a Worker reassembles (see lib/reassemble.ts). The terminal renderer
 * in lib/render.ts is reused UNCHANGED because ffmpeg's `bgra` pixel format is
 * byte-identical to MF's MFVideoFormat_RGB32.
 *
 * A/V SYNC, DELIBERATELY NOT IMPLEMENTED: on a live stream the video inherently trails
 * the audio by the CDN's buffering delay (measured ~9 s to first frame on Twitch), so
 * there is no target to chase — copying video.ts's audio-master-clock catch-up loop here
 * would spin forever against a clock it can never catch. Both are paced independently
 * and the overlay reports the measured latency rather than hiding it.
 *
 * Keys: SPACE pause · m half-block/ASCII · r reconnect · a mute · +/- volume
 *       [ ] capture size · s save PNG · ESC/q quit
 */
import {
  type CharTerm,
  CharTerm as CharGrid,
  type RGB,
  detectConsoleSize,
  runText,
} from "@bun-win32/terminal";
import {
  BLACK,
  ensureLut,
  releaseLut,
  renderFrame,
  type RenderMode,
} from "./lib/render";
import { closeWaveOutLib, createWaveOut, type WaveOut } from "./lib/waveout";
import { looksLive, MediaClient } from "./lib/media";
import {
  isResolveAbortedError,
  isResolveError,
  listFormats,
  normalizeTarget,
  type ResolveOptions,
  resolveStreamSources,
  type StreamSources,
  waitForOnline,
} from "./lib/resolve";

const USAGE = `
stream — live video in your terminal

Usage:
  stream <url|chaturbate/<model>|twitch.tv/<channel>>
  stream <direct.m3u8|.mpd|.mp4>            (skips yt-dlp)

Options:
  -s, --size WxH     capture/decode size (default 480x270)
      --fit          size to exactly the current terminal grid
      --fps N        render frame rate (default 30)
      --no-audio     video only
      --cookies P    Netscape cookie jar for yt-dlp (age-gated/private rooms)
      --cookies-from-browser SPEC  load persistent login from a browser
                         (e.g. chrome, chrome:Default, edge, firefox)
      --list         list yt-dlp formats and exit
      --no-yt-dlp    treat the target as a direct media URL
      --selftest P   headless: wait for a real frame, render it to PNG P, exit
      --wait S       seconds to wait for the first frame in --selftest (default 30)
      --retries N    stop after N offline reconnect attempts (default unlimited)
  -q, --quiet        suppress ffmpeg noise
  -h, --help         this text

Keys:
  SPACE  pause/resume   m  half-block / ASCII   r  reconnect
  a      mute/unmute    +  volume up            -  volume down
  [ ]    capture size   s  save a PNG screenshot
  ESC/q  quit

Notes:
  Twitch playlist URLs are single-use, so the target is re-resolved on every reconnect.
  First-frame latency is dominated by the CDN (measured ~9 s on Twitch), not by us.
  --cookies / --cookies-from-browser go to yt-dlp only; ffmpeg fetches the CDN URLs
  it returns without them. Example: --cookies-from-browser chrome
`;

interface Options {
  target: string;
  width: number;
  height: number;
  fps: number;
  withAudio: boolean;
  quiet: boolean;
  fit: boolean;
  noYtDlp: boolean;
  /** Netscape cookie jar for yt-dlp; "" for none. */
  cookies: string;
  /** Browser spec for yt-dlp --cookies-from-browser; "" for none. */
  cookiesFromBrowser: string;
  list: boolean;
  help: boolean;
  /** Self-test: PNG output path, or "" for off. */
  selftest: string;
  /** Seconds to wait for the first frame in self-test mode. */
  wait: number;
}

function parseArgs(argv: string[]): Options | null {
  const o: Options = {
    target: "",
    width: 480,
    height: 270,
    fps: 30,
    withAudio: true,
    quiet: false,
    fit: false,
    noYtDlp: false,
    cookies: "",
    cookiesFromBrowser: "",
    list: false,
    help: false,
    selftest: "",
    wait: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--no-audio") o.withAudio = false;
    else if (a === "-q" || a === "--quiet") o.quiet = true;
    else if (a === "--fit") o.fit = true;
    else if (a === "--list") o.list = true;
    else if (a === "--no-yt-dlp") o.noYtDlp = true;
    else if (a === "--cookies") {
      const path = argv[++i];
      if (path === undefined || path.startsWith("-")) {
        process.stderr.write(
          "stream: --cookies needs a Netscape cookies.txt path\n",
        );
        return null;
      }
      o.cookies = path;
    } else if (a === "--cookies-from-browser") {
      const spec = argv[++i];
      if (spec === undefined || spec.startsWith("-")) {
        process.stderr.write(
          "stream: --cookies-from-browser needs a browser spec (e.g. chrome, edge, firefox)\n",
        );
        return null;
      }
      o.cookiesFromBrowser = spec;
    } else if (a === "--selftest")
      o.selftest = argv[++i] ?? "stream-selftest.png";
    else if (a === "--wait") o.wait = Number(argv[++i]);
    else if (a === "--fps") o.fps = Number(argv[++i]);
    else if (a === "--retries") {
      const n = Number(argv[++i]);
      o.help = false; // consumed; kept for forward-compat
      void n;
    } else if (a === "-s" || a === "--size") {
      const m = /^(\d+)x(\d+)$/i.exec(argv[++i] ?? "");
      if (m === null) {
        process.stderr.write(
          "stream: bad --size (expected WxH, e.g. 640x360)\n",
        );
        return null;
      }
      o.width = Number(m[1]);
      o.height = Number(m[2]);
    } else if (a.startsWith("-")) {
      process.stderr.write(`stream: unknown option ${a}\n`);
      return null;
    } else if (o.target === "") o.target = a;
  }
  if (!Number.isFinite(o.fps) || o.fps <= 0) o.fps = 30;
  if (!Number.isInteger(o.width) || o.width < 16) o.width = 480;
  if (!Number.isInteger(o.height) || o.height < 16) o.height = 270;
  return o;
}

const EMPTY = new Uint8Array(0);
const BAR_BG: RGB = [18, 18, 24];
const DIM: RGB = [130, 130, 150];
const LABEL: RGB = [180, 200, 255];

/**
 * How long --selftest keeps waiting for PCM after the first video frame. Split-track
 * sites open two independent ffmpeg/HTTP connections, so the audio pipe can lag the
 * video pipe by a second or two on a cold start.
 */
const AUDIO_GRACE_S = 10;

const say = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

/** STREAM_DEBUG=1 traces the render loop / worker handshake on stderr. */
const DEBUG = process.env.STREAM_DEBUG === "1";
let debugFrames = 0;

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts === null) process.exit(1);
  if (opts.help || opts.target === "") {
    process.stdout.write(USAGE);
    process.exit(opts.help ? 0 : 1);
  }

  const target = opts.noYtDlp ? opts.target : normalizeTarget(opts.target);
  /** yt-dlp options shared by the initial resolve, --list and every reconnect. */
  const resolveOpts: ResolveOptions = {
    ...(opts.cookies === "" ? {} : { cookiesFile: opts.cookies }),
    ...(opts.cookiesFromBrowser === ""
      ? {}
      : { cookiesFromBrowser: opts.cookiesFromBrowser }),
  };

  if (opts.list) {
    const rows = await listFormats(target, resolveOpts);
    if (rows.length === 0) {
      say(`stream: no formats for ${target}`);
      process.exit(1);
    }
    process.stdout.write(
      `${"ID".padEnd(24)}${"EXT".padEnd(6)}${"RES".padEnd(12)}${"FPS".padEnd(6)}${"VCODEC".padEnd(14)}${"ACODEC".padEnd(12)}SIZE\n`,
    );
    for (const r of rows) {
      // Guarantee at least one space between columns instead of hoping every value is
      // shorter than its width: Chaturbate's `audio_aac_128-Audio_200_5` is 25 chars and
      // `video only` is 10, both longer than the old widths, so the row ran together.
      const pad = (v: unknown, n: number): string => {
        const s = String(v ?? "-");
        return s.length >= n ? `${s} ` : s.padEnd(n);
      };
      process.stdout.write(
        `${pad(r.formatId, 24)}${pad(r.ext, 6)}${pad(r.resolution, 12)}${pad(r.fps, 6)}${pad(r.vcodec, 14)}${pad(r.acodec, 12)}${r.filesize ?? "-"}\n`,
      );
    }
    return;
  }

  if (opts.fit) {
    const { columns, rows } = detectConsoleSize();
    opts.width = Math.max(16, columns);
    opts.height = Math.max(16, rows * 2);
    say(`stream: --fit → ${opts.width}x${opts.height}`);
  }

  // ── Resolve. An offline Chaturbate model is a WAIT state, not an error, so we poll
  //    until it comes online (Ctrl-C stops). Anything terminal-classified exits.
  // --no-yt-dlp means the caller vouched this IS a direct media URL (or a local file),
  // so skip yt-dlp entirely -- including resolution, not just normalization.
  // `sources` can hold TWO urls: sites like Chaturbate publish video and audio as
  // separate manifests, which yt-dlp's `-f bestvideo+bestaudio` reports as two lines.
  let sources: StreamSources;
  if (opts.noYtDlp) {
    sources = { video: target };
    say("stream: using the target directly (--no-yt-dlp)");
  } else {
    say(`stream: resolving ${target} ...`);
    for (;;) {
      try {
        sources = await waitForOnline(target, {
          ...resolveOpts,
          onWait: (attempt, err) => {
            say(
              `stream: ${err.kind} - ${err.detail} (retry in 10s, attempt ${attempt})`,
            );
          },
        });
        break;
      } catch (err) {
        if (isResolveAbortedError(err)) process.exit(130);
        if (!isResolveError(err)) throw err;
        say(`stream: ${err.message}`);
        say("stream: waiting for the model to come online - Ctrl-C to stop");
        // waitForOnline already polls; loop only if it gave up for a retryable reason.
        if (!err.retryable) process.exit(1);
      }
    }
  }
  say(
    sources.audio === undefined
      ? `stream: ${looksLive(sources.video) ? "live/HLS" : "progressive"} source resolved`
      : "stream: live/HLS source resolved (separate video + audio manifests)",
  );

  // ── runtime state ──
  let mode: RenderMode = process.env.VIDEO_MODE === "ascii" ? "ascii" : "half";
  let paused = false;
  let muted = false;
  let volume = 0.8;
  let status = "connecting";
  let connectStart = Date.now();
  let latencyMs = 0;
  let fpsEma = 0;
  let framesDrawn = 0;
  let pcmBytes = 0;

  let client: MediaClient | null = null;
  /**
   * TypeScript cannot see the assignment to `client` that happens inside the async
   * connect(), so it narrows the variable to `null`/`never` and rejects every property
   * access. Routing reads through this function keeps the declared type.
   */
  const activeClient = (): MediaClient | null => client;
  let waveOut: WaveOut | null = null;
  if (opts.withAudio) {
    const w = createWaveOut({ rate: 48000, channels: 2, bits: 16 });
    if (w.ok) waveOut = w;
  }
  // "Audio confirmed" means PCM has actually arrived, not merely that we asked for it —
  // a stream with no audio track must not claim sound.
  let audioConfirmed = false;

  let reconnectAt = 0;
  let reconnectDelayS = 0;
  let reconnectAttempt = 0;
  let wantReconnect = false;
  let quitting = false;

  const HIDE_AFTER_S = 2;
  let lastMoveT = -1000;
  let lastMouseSeq = -1;

  /** Drop the current connection (worker + its ffmpeg children) but stay alive. */
  const dropConnection = (): void => {
    client?.stop();
    client = null;
    latencyMs = 0;
    fpsEma = 0;
    connectStart = Date.now();
    reconnectAt = 0;
    reconnectDelayS = 0;
  };

  const scheduleReconnect = (why: string): void => {
    if (quitting || reconnectAt > 0) return;
    // Capped exponential backoff: 1, 2, 4, 8, 16, 30, 30 … seconds.
    const step =
      reconnectAttempt === 0 ? 1 : Math.min(30, 2 ** reconnectAttempt);
    reconnectAttempt++;
    reconnectDelayS = step;
    reconnectAt = Date.now() + step * 1000;
    status = `${why} — retry ${reconnectAttempt} in ${step}s`;
  };

  const connect = async (): Promise<void> => {
    status = "connecting";
    connectStart = Date.now();
    try {
      // Re-resolving is what recovers a dropped stream: the playlist URL we hold has
      // expired or started 404ing. Twitch issues single-use URLs. Skip it when the
      // target was vouched as directly openable, and skip it entirely for a local file.
      if (!opts.noYtDlp)
        sources = await resolveStreamSources(target, resolveOpts);
    } catch {
      // Keep the previous sources and let ffmpeg try; on failure we back off and retry.
    }
    client = new MediaClient(
      {
        url: sources.video,
        audioUrl: sources.audio,
        width: opts.width,
        height: opts.height,
        fps: opts.fps,
        withAudio: opts.withAudio,
        live: looksLive(sources.video) || looksLive(sources.audio ?? ""),
        quiet: opts.quiet,
      },
      {
        onPcm: (bytes) => {
          // PCM is handled on the MAIN THREAD only — the worker must never touch winmm
          // (its WAVEHDR buffers are not worker-safe).
          if (paused || waveOut === null) return;
          pcmBytes += bytes.length;
          if (!audioConfirmed) {
            audioConfirmed = true;
            waveOut.setVolume(muted ? 0 : volume, muted ? 0 : volume);
          }
          waveOut.writePcm(bytes);
        },
        onEnded: (reason) => {
          if (quitting) return;
          scheduleReconnect(
            reason.startsWith("error") ? "error" : "stream ended",
          );
        },
        onError: (message) => {
          if (quitting) return;
          scheduleReconnect(`error: ${message.slice(0, 40)}`);
        },
      },
    );
    client.start();
  };

  await connect();

  const startedAt = Date.now();

  // ── self-test: headless, no render loop ──
  //
  // The engine's CAPTURE_PNG mode captures the FIRST frame and exits immediately
  // (verified: elapsed ~0 ms). That is fine for video.ts, where Media Foundation has
  // already decoded by then, but a live stream needs ~9 s of CDN buffering before its
  // first frame exists — so CAPTURE_PNG always yields a black grid. This mode instead
  // WAITS for real video, renders it into an off-screen CharTerm and writes a PNG,
  // which makes the whole pipeline verifiable without a TTY.
  if (opts.selftest) {
    const columns = Number(process.env.TERM_COLS ?? 160);
    const rows = Number(process.env.TERM_ROWS ?? 40);
    const grid = new CharGrid(columns, rows);
    const deadline = Date.now() + opts.wait * 1000;
    let got: { bytes: Uint8Array; seq: number } | null = null;
    // Audio gets its own grace period AFTER the first video frame: the two manifests
    // are fetched by separate ffmpegs over separate connections, so a split-track site
    // can easily hand over video a second or two before PCM shows up. Reporting PCM is
    // what makes the split-manifest path verifiable at all — a silent ffmpeg that died
    // on a missing `0:a:0` would otherwise look exactly like a successful run.
    const audioDeadline = () => Date.now() + AUDIO_GRACE_S * 1000;
    while (Date.now() < deadline && got === null) {
      got = activeClient()?.takeFrame() ?? null;
      if (got === null) await new Promise((r) => setTimeout(r, 25));
    }
    const elapsed = Date.now() - startedAt;
    if (got === null) {
      say(
        `stream_selftest FAIL no frame within ${opts.wait}s ` +
          `(worker received ${activeClient()?.framesReceived ?? 0})`,
      );
      activeClient()?.stop();
      waveOut?.shutdown();
      closeWaveOutLib();
      process.exit(1);
    }
    if (opts.withAudio) {
      const until = audioDeadline();
      while (pcmBytes === 0 && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const L = ensureLut(
      columns,
      rows,
      opts.width,
      opts.height,
      opts.width * 4,
      false,
    );
    renderFrame(grid, got.bytes, mode, L);
    const outPath = opts.selftest;
    await Bun.write(outPath, grid.toPNG());
    // Sanity-check the picture is not an all-black grid (which would mean the decode
    // path produced nothing usable even though bytes arrived).
    const lum = grid.foreground.reduce((a, v) => a + (v & 0xff), 0);
    say(
      `stream_selftest OK png=${outPath} ${columns}x${rows} ` +
        `bytes=${got.bytes.length} expected=${opts.width * opts.height * 4} ` +
        `frameAt=${elapsed}ms nonBlack=${lum > 0}`,
    );
    // Audio is reported, not enforced: `--no-audio` has nothing to report, and a stream
    // that genuinely has no audio track should not fail a video smoke test. Exit stays
    // keyed on the picture, but the numbers are here so a CI log can spot a dead track.
    if (opts.withAudio) {
      say(
        `stream_selftest audio ${pcmBytes > 0 ? "OK" : "NONE"} ` +
          `pcmBytes=${pcmBytes} split=${sources.audio === undefined ? "no" : "yes"}`,
      );
    }
    activeClient()?.stop();
    waveOut?.shutdown();
    releaseLut();
    closeWaveOutLib();
    process.exit(lum > 0 ? 0 : 1);
  }

  const drawOverlay = (t: CharTerm, fps: number): void => {
    const y = t.rows - 1;
    const audio = audioConfirmed
      ? muted
        ? "♪mute"
        : `♪${Math.round(volume * 100)}%`
      : "♪off";
    const left = ` ${target} ${opts.width}x${opts.height} · ${
      mode === "half" ? "HALF" : "ASCII"
    } · ${audio} · ${latencyMs > 0 ? `${(latencyMs / 1000).toFixed(1)}s` : "…"} · ${paused ? "[PAUSED] " : ""}${status}`;
    const right =
      status === "live" ? "SPACE m r a +/- [ ] s ESC " : "SPACE r ESC ";
    t.fillRect(0, y, t.columns, 1, BAR_BG);
    t.text(
      0,
      y,
      left.slice(0, Math.max(0, t.columns - right.length - 1)),
      LABEL,
      BAR_BG,
      true,
    );
    const rx = Math.max(0, t.columns - right.length);
    if (rx > left.length) t.text(rx, y, right, DIM, BAR_BG);

    const fc: RGB =
      fps >= 50
        ? [120, 255, 140]
        : fps >= 25
          ? [255, 200, 90]
          : [255, 110, 110];
    const fl = ` ${fps.toFixed(0).padStart(3)} FPS `;
    const fx = Math.max(0, t.columns - fl.length);
    t.fillRect(fx, 0, fl.length, 1, [22, 22, 30]);
    t.text(fx, 0, fl, fc, [22, 22, 30], true);
  };

  await runText({
    title: `stream: ${target}`,
    hud: "",
    targetFps: opts.fps,
    drawFps: false,
    mouse: true,
    frame: (t: CharTerm, time: number, dt: number) => {
      if (quitting) return;
      if (wantReconnect) {
        wantReconnect = false;
        dropConnection();
        reconnectAttempt = 0;
        void connect();
      } else if (reconnectAt > 0 && Date.now() >= reconnectAt) {
        dropConnection();
        void connect();
      }

      if (t.mouse.active && t.mouse.sequence !== lastMouseSeq) {
        lastMouseSeq = t.mouse.sequence;
        lastMoveT = time;
      }

      // While paused, push an empty chunk so the ring accounts for the silence instead
      // of silently underrunning.
      if (paused && waveOut !== null) waveOut.writePcm(EMPTY);

      const c = client;
      if (DEBUG) {
        debugFrames++;
        if (debugFrames === 1 || debugFrames % 30 === 0) {
          say(
            `stream[dbg] frame=${debugFrames} client=${c === null ? "null" : "set"} ` +
              `recv=${c?.framesReceived ?? -1} pending=${c?.hasPendingFrame ?? false} ` +
              `reconnectAt=${reconnectAt} paused=${paused}`,
          );
        }
      }
      if (!paused && c !== null) {
        const f = c.takeFrame();
        if (f !== null) {
          framesDrawn++;
          if (latencyMs === 0) {
            latencyMs = Date.now() - connectStart;
            status = "live";
          }
          // rawvideo/bgra is tightly packed and top-down: stride = width*4, no flip.
          const L = ensureLut(
            t.columns,
            t.rows,
            opts.width,
            opts.height,
            opts.width * 4,
            false,
          );
          renderFrame(t, f.bytes, mode, L);
          const inst = dt > 0 ? 1 / dt : opts.fps;
          fpsEma = fpsEma === 0 ? inst : fpsEma * 0.9 + inst * 0.1;
        } else if (framesDrawn === 0) {
          t.fillRect(0, 0, t.columns, t.rows, BLACK);
        }
      }

      if (
        process.env.BENCH !== "1" &&
        (process.env.VIDEO_OVERLAY === "1" || time - lastMoveT < HIDE_AFTER_S)
      ) {
        drawOverlay(t, fpsEma);
      }
    },
    onKey: (key: string, t: CharTerm) => {
      switch (key) {
        case "space":
          paused = !paused;
          if (paused) waveOut?.pause();
          else waveOut?.resume();
          if (paused) status = "paused";
          else status = latencyMs > 0 ? "live" : status;
          break;
        case "m":
        case "M":
          mode = mode === "half" ? "ascii" : "half";
          break;
        case "r":
        case "R":
          wantReconnect = true;
          break;
        case "a":
        case "A":
          muted = !muted;
          waveOut?.setVolume(muted ? 0 : volume, muted ? 0 : volume);
          break;
        case "+":
        case "=":
          volume = Math.min(1, volume + 0.1);
          if (!muted) waveOut?.setVolume(volume, volume);
          break;
        case "-":
        case "_":
          volume = Math.max(0, volume - 0.1);
          if (!muted) waveOut?.setVolume(volume, volume);
          break;
        case "[":
          opts.width = Math.max(64, Math.round(opts.width / 1.25));
          opts.height = Math.max(36, Math.round(opts.height / 1.25));
          wantReconnect = true;
          break;
        case "]":
          opts.width = Math.min(1920, Math.round(opts.width * 1.25));
          opts.height = Math.min(1080, Math.round(opts.height * 1.25));
          wantReconnect = true;
          break;
        case "s":
        case "S": {
          const path = `stream-${Date.now()}.png`;
          Bun.write(path, t.toPNG());
          say(`stream: saved ${path}`);
          break;
        }
        case "escape":
        case "q":
        case "Q":
          quitting = true;
          dropConnection();
          waveOut?.shutdown();
          waveOut = null;
          releaseLut();
          closeWaveOutLib();
          process.exit(0);
        default:
          break;
      }
    },
  });

  // runText returned (Ctrl-C / ESC path above already tore down).
  quitting = true;
  dropConnection();
  waveOut?.shutdown();
  releaseLut();
  closeWaveOutLib();

  say(
    `stream_stats elapsed=${Math.round((Date.now() - startedAt) / 1000)}s ` +
      `drawn=${framesDrawn} fps=${fpsEma.toFixed(1)} ` +
      `size=${opts.width}x${opts.height} latency=${latencyMs}ms ` +
      `audio=${audioConfirmed ? "on" : "off"} pcm=${pcmBytes}B ` +
      `underruns=${waveOut?.underruns ?? 0} drops=${waveOut?.drops ?? 0} ` +
      `reconnects=${reconnectAttempt}`,
  );
  void reconnectDelayS;
}

process.on("SIGINT", () => process.exit(0));

/**
 * Exported as the FUNCTION, never as `main()`.
 *
 * `export default main()` is an invocation, not an alias: the old tail was
 *
 *     main().catch(...);
 *     export default main();   // <- second invocation
 *
 * so the whole resolve → connect → render pipeline ran TWICE in one process. That is what
 * printed `stream: resolving <url> ...` twice and opened two MediaClient/ffmpeg pairs.
 * Exporting the reference keeps the module usable programmatically while `import.meta.main`
 * runs it exactly once when the file is executed directly.
 */
export default main;

if (import.meta.main) {
  main().catch((err: unknown) => {
    say(`stream: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
