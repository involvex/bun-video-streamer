/**
 * media — spawn ffmpeg for a live/VOD stream and deliver BGRA frames + PCM to the
 * main thread via a Worker.
 *
 * WHY FFMPEG: Media Foundation (see video.ts) can only open a seekable, complete
 * local file. Twitch and Chaturbate both serve HLS, which MF cannot demux without a
 * hand-written IMFMediaSource/IMFByteStream COM source resolver. So for streams ffmpeg
 * becomes the transport, demuxer, decoder and scaler, and we consume its raw pixel
 * output over a pipe. The existing terminal renderer then works UNCHANGED because
 * ffmpeg's `bgra` pixel format is byte-identical to MF's MFVideoFormat_RGB32.
 *
 * Threading: the pipes are read on a Worker (src/workers/media.ts). Reading them on
 * the main thread would block the render loop and freeze key handling.
 */

export interface VideoArgsOptions {
  /** Direct media URL (already resolved by lib/resolve.ts). */
  url: string;
  width: number;
  height: number;
  /** Target frame rate. ffmpeg DROPS excess rather than buffering, to bound latency. */
  fps: number;
  /**
   * Enable HLS/low-latency input tuning. MUST be false for progressive inputs:
   * `-live_start_index` is an HLS-demuxer private option and ffmpeg hard-fails with
   * "Option live_start_index not found" on a plain MP4.
   */
  live: boolean;
  quiet: boolean;
}

/**
 * Build the ffmpeg argv for the video pipe. Pure so it can be unit-tested — see
 * test/media.test.ts.
 *
 * FLAG PLACEMENT IS LOAD-BEARING: everything before `-i` is an INPUT option, and
 * `-live_start_index*` / `-reconnect*` are only understood by the HLS/http demuxers,
 * so they must precede `-i` AND only be passed for live/HLS sources.
 */
export function buildVideoArgs(o: VideoArgsOptions): string[] {
  const args = ["-hide_banner", "-loglevel", o.quiet ? "error" : "warning"];

  // ── input options (must precede -i) ──
  // Skip container probing and buffering: for a live edge we would rather start
  // early with a partial stream than wait on a full probe.
  args.push("-fflags", "nobuffer", "-flags", "low_delay");
  args.push("-analyzeduration", "2000000", "-probesize", "2000000");
  if (o.live) {
    // Start near the live edge instead of the head of a potentially huge playlist.
    // NOTE: `-live_start_index_max` does NOT exist in current ffmpeg builds (verified:
    // "Unrecognized option 'live_start_index_max'"), so only `-live_start_index` is
    // set. Its own default is already -3.
    args.push("-live_start_index", "-3");
    // Survive transient HTTP failures / playlist churn mid-stream.
    args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
  }
  args.push("-i", o.url);

  // ── output options ──
  args.push("-map", "0:v:0", "-an");
  args.push("-vf", `scale=${o.width}:${o.height}`);
  // BGRA is REQUIRED: it is the same byte order as MFVideoFormat_RGB32, which is what
  // lib/render.ts reads. rgb24 would swap red and blue.
  args.push("-pix_fmt", "bgra");
  // RATE CONTROL DELIBERATELY LIVES IN THE WORKER, not here.
  // `-fps_mode drop` is an *encoder* option and the rawvideo muxer has no encoder, so
  // ffmpeg rejects it outright ("Invalid value drop specified for fps_mode"). A bare
  // `-r` on a muxer only sets timing metadata without discarding frames, so trusting it
  // would silently double pipe traffic for nothing. The worker posts at most `fps`
  // frames per second and discards the surplus — which is the right trade for a live
  // edge anyway: dropping bounds latency, buffering would grow without bound.
  args.push("-f", "rawvideo", "-");
  return args;
}

export interface AudioArgsOptions {
  url: string;
  rate: number;
  channels: number;
  live: boolean;
  quiet: boolean;
}

/** ffmpeg argv for the audio pipe: headerless signed 16-bit little-endian PCM. */
export function buildAudioArgs(o: AudioArgsOptions): string[] {
  const args = ["-hide_banner", "-loglevel", o.quiet ? "error" : "warning"];
  args.push("-fflags", "nobuffer", "-flags", "low_delay");
  args.push("-analyzeduration", "2000000", "-probesize", "2000000");
  if (o.live) {
    args.push("-live_start_index", "-3"); // see buildVideoArgs — no _max variant exists
    args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
  }
  args.push("-i", o.url);
  args.push("-map", "0:a:0", "-vn");
  args.push("-f", "s16le", "-acodec", "pcm_s16le");
  args.push("-ar", String(o.rate), "-ac", String(o.channels), "-");
  return args;
}

/** Heuristic: does this URL need HLS/live input tuning? */
export function looksLive(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url) || /\.mpd(\?|$)/i.test(url);
}

// ── Worker protocol ───────────────────────────────────────────────────────────────
export type MediaStartMessage = {
  type: "start";
  url: string;
  /**
   * Separate audio input, for sites that publish video and audio as two manifests
   * (Chaturbate). `undefined` means `url` carries both tracks.
   */
  audioUrl: string | undefined;
  width: number;
  height: number;
  fps: number;
  withAudio: boolean;
  live: boolean;
  quiet: boolean;
  audioRate: number;
  audioChannels: number;
};

export type MediaToWorker = MediaStartMessage | { type: "stop" };

export type MediaFromWorker =
  | {
      type: "ready";
      width: number;
      height: number;
      fps: number;
      hasAudio: boolean;
      live: boolean;
    }
  /** A complete BGRA frame: `width * height * 4` bytes, tightly packed. */
  | { type: "frame"; buf: ArrayBuffer; seq: number }
  /** A chunk of s16le PCM (arbitrary length, NOT frame-aligned). */
  | { type: "pcm"; buf: ArrayBuffer }
  | { type: "ended"; reason: string }
  | { type: "error"; message: string };

export interface MediaClientOptions {
  url: string;
  /**
   * Audio track from a SEPARATE URL, or `undefined` to take audio from `url`.
   *
   * Declared as a required-but-nullable property rather than `audioUrl?: string` so that
   * `Required<MediaClientOptions>` (used for the normalised `opts` field) still admits
   * `undefined` instead of lying about it being a guaranteed `string`.
   */
  audioUrl: string | undefined;
  width: number;
  height: number;
  fps: number;
  withAudio: boolean;
  live?: boolean;
  quiet?: boolean;
  audioRate?: number;
  audioChannels?: number;
}

export interface MediaClientHandlers {
  onReady?(e: { width: number; height: number; fps: number; hasAudio: boolean }): void;
  /**
   * PCM is delivered by CALLBACK because the consumer (lib/waveout.ts) wants every
   * chunk as soon as it lands — audio must not wait for a render tick.
   *
   * Video frames are NOT delivered by callback: they are pulled with takeFrame() from
   * the render loop, so a frame we never got to draw is discarded rather than queued.
   */
  onPcm?(bytes: Uint8Array): void;
  onEnded?(reason: string): void;
  onError?(message: string): void;
}

/**
 * Owns one Worker + its ffmpeg children for one connection. Reconnection policy lives
 * in the caller (stream.ts) so backoff can be surfaced in the UI.
 */
export class MediaClient {
  private worker: Worker | null = null;
  private stopped = false;
  private seq = 0;
  /** Most recent frame not yet consumed by the render loop. */
  private pendingFrame: Uint8Array | null = null;
  private pendingSeq = 0;
  /** Total frames handed over by the worker, for stats. */
  private recvFrames = 0;
  /** Total PCM bytes handed over by the worker, for stats. */
  private recvPcm = 0;
  /** PCM is consumed immediately by the caller; no queueing here. */
  readonly opts: Required<MediaClientOptions>;
  private readonly h: MediaClientHandlers;

  constructor(opts: MediaClientOptions, handlers: MediaClientHandlers) {
    this.opts = {
      live: looksLive(opts.url) || looksLive(opts.audioUrl ?? ""),
      quiet: false,
      audioRate: 48000,
      audioChannels: 2,
      ...opts,
    };
    this.h = handlers;
  }

  get width(): number {
    return this.opts.width;
  }

  get height(): number {
    return this.opts.height;
  }

  /** Take the newest buffered frame, discarding any older unconsumed one. */
  takeFrame(): { bytes: Uint8Array; seq: number } | null {
    const bytes = this.pendingFrame;
    if (bytes === null) return null;
    this.pendingFrame = null;
    return { bytes, seq: this.pendingSeq };
  }

  get hasPendingFrame(): boolean {
    return this.pendingFrame !== null;
  }

  /** Frames delivered by the worker since start(). */
  get framesReceived(): number {
    return this.recvFrames;
  }

  /** PCM bytes delivered by the worker since start(). */
  get pcmReceived(): number {
    return this.recvPcm;
  }

  start(): void {
    if (this.worker !== null) return;
    this.stopped = false;
    // Bun's Worker() wants a real filesystem path (or a bun: URL). Handing it a
    // `file://` URL fails SILENTLY: the worker never loads, no error is raised, and
    // frames simply never arrive. Under a normal relative import `import.meta.url` IS
    // a file:// URL, so convert it explicitly.
    const url = new URL("../workers/media.ts", import.meta.url);
    const path = url.protocol === "file:" ? Bun.fileURLToPath(url) : url.pathname;
    const worker = new Worker(path);
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent<MediaFromWorker>) => {
      if (this.stopped) return;
      const msg = ev.data;
      switch (msg.type) {
        case "ready":
          this.h.onReady?.(msg);
          break;
        case "frame": {
          // Latest-wins: a frame we never got to draw is replaced, never queued.
          this.pendingFrame = new Uint8Array(msg.buf);
          this.pendingSeq = msg.seq;
          this.seq = msg.seq + 1;
          this.recvFrames++;
          break;
        }
        case "pcm":
          this.recvPcm += msg.buf.byteLength;
          this.h.onPcm?.(new Uint8Array(msg.buf));
          break;
        case "ended":
          this.h.onEnded?.(msg.reason);
          break;
        case "error":
          this.h.onError?.(msg.message);
          break;
      }
    };
    worker.onerror = (ev: ErrorEvent) => {
      if (this.stopped) return;
      this.h.onError?.(ev.message || "worker crashed");
    };
    const msg: MediaStartMessage = {
      type: "start",
      url: this.opts.url,
      audioUrl: this.opts.audioUrl,
      width: this.opts.width,
      height: this.opts.height,
      fps: this.opts.fps,
      withAudio: this.opts.withAudio,
      live: this.opts.live,
      quiet: this.opts.quiet,
      audioRate: this.opts.audioRate,
      audioChannels: this.opts.audioChannels,
    };
    worker.postMessage(msg);
  }

  stop(): void {
    this.stopped = true;
    const worker = this.worker;
    this.worker = null;
    this.pendingFrame = null;
    if (worker === null) return;
    // Ask first so the worker can kill its children, then make sure it is gone.
    try {
      worker.postMessage({ type: "stop" } satisfies MediaToWorker);
    } catch {
      // worker already dead — nothing to stop.
    }
    worker.terminate();
  }
}
