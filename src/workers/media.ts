/**
 * media worker — owns the ffmpeg child processes for one stream connection.
 *
 * Runs OFF the main thread: the pipes are read with blocking awaits, so reading them on
 * the main thread would freeze the terminal render loop and key handling.
 *
 * Responsibilities:
 *   • spawn ffmpeg for video (rawvideo/bgra) and, optionally, audio (s16le PCM)
 *   • reassemble arbitrary pipe chunks into fixed-size BGRA frames
 *   • throttle frame posts to the target fps (HLS bursts arrive far faster)
 *   • post each frame as a TRANSFERRED ArrayBuffer so there is no copy on the main
 *     thread — the bytes we send are a fresh copy, never the reassembler's accumulator
 *   • surface every child exit as `ended`/`error` with the ffmpeg stderr tail, so the
 *     main thread can reconnect instead of hanging
 */
import { FrameReassembler } from "../lib/reassemble";
import {
  buildAudioArgs,
  buildVideoArgs,
  type MediaFromWorker,
  type MediaToWorker,
} from "../lib/media";

const post = (msg: MediaFromWorker, transfer?: Transferable[]): void => {
  if (transfer !== undefined) (self as unknown as Worker).postMessage(msg, transfer);
  else (self as unknown as Worker).postMessage(msg);
};

interface Child {
  proc: ReturnType<typeof Bun.spawn>;
  stderr: Promise<string>;
}

let videoChild: Child | null = null;
let audioChild: Child | null = null;
let stopping = false;

/** Drain stderr so ffmpeg never blocks on a full pipe, and keep the tail for errors. */
function drainStderr(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  return (async () => {
    const chunks: string[] = [];
    try {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
        // Keep only the last few KB — enough to explain a failure.
        if (chunks.length > 40) chunks.shift();
      }
    } catch {
      // stderr closed underneath us (process killed) — not an error.
    }
    return chunks.join("").slice(-4000);
  })();
}

function spawnFfmpeg(args: string[]): Child {
  const proc = Bun.spawn({
    cmd: ["ffmpeg", ...args],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return { proc, stderr: drainStderr(proc) };
}

function killChild(child: Child | null): void {
  if (child === null) return;
  try {
    child.proc.kill();
  } catch {
    // already exited
  }
}

/**
 * Read the video pipe, reassemble frames, and post them at no more than `fps`.
 *
 * Throttling happens HERE (not just in ffmpeg) because an HLS burst can arrive as
 * ~180 frames in a couple of seconds; posting all of them would flood the message
 * channel and add latency for no benefit. Surplus frames are discarded — on a live
 * stream that is exactly the right trade.
 */
async function pumpVideo(child: Child, width: number, height: number, fps: number): Promise<void> {
  const frameSize = width * height * 4;
  const re = new FrameReassembler(frameSize);
  const minIntervalMs = 1000 / Math.max(1, fps);
  let nextPostAt = 0;
  let seq = 0;
  let posted = 0;

  // `held` is the newest complete frame; the read loop overwrites it and the drain
  // timer below releases it at a STEADY rate. Transferred buffers can never be reused,
  // so the only allocation is one copy per posted frame (≤ fps/sec).
  const held = new Uint8Array(frameSize);
  let haveFrame = false;

  /**
   * Release the held frame at the target rate.
   *
   * Why a timer instead of posting straight from the read loop: an HLS segment lands
   * as one large burst (measured: 200 frames inside a single 487 ms read). Posting from
   * the read loop therefore posts once per burst, which measured at only ~5 fps and
   * looked like a slideshow. Holding the freshest frame and releasing it on a timer
   * converts those bursts into a steady cadence.
   *
   * Re-posting an unchanged frame is essentially free: the terminal diffs identical
   * cells to a few bytes, so a frozen picture between segments costs almost nothing.
   */
  const drain = setInterval(
    () => {
      if (stopping || !haveFrame) return;
      const now = Date.now();
      if (now < nextPostAt) return;
      nextPostAt = now + minIntervalMs;
      const buf = held.slice().buffer as ArrayBuffer;
      post({ type: "frame", buf, seq: seq++ }, [buf]);
      posted++;
    },
    Math.max(1, Math.min(8, Math.round(minIntervalMs / 4))),
  );

  const reader = (child.proc.stdout as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Keep ONLY the freshest complete frame from this read; the rest are surplus.
      if (re.pushLatest(value, held)) haveFrame = true;
    }
    const tail = re.flush();
    if (tail !== null && tail.length > 0 && !stopping) {
      held.set(tail, 0);
      haveFrame = true;
      const buf = held.slice(0, tail.length).buffer as ArrayBuffer;
      post({ type: "frame", buf, seq: seq++ }, [buf]);
      posted++;
    }
  } finally {
    clearInterval(drain);
    reader.releaseLock?.();
  }
  if (!stopping) {
    const [err, code] = await Promise.all([child.stderr.catch(() => ""), child.proc.exited]);
    const tail = err
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .slice(-3)
      .join(" | ");
    post({
      type: "ended",
      reason: code !== 0 ? `ffmpeg video exited ${code}: ${tail}` : "video stream ended",
    });
  }
  void posted;
}

/**
 * Forward PCM as it arrives. Chunk boundaries are meaningless for audio (and the
 * waveOut ring in lib/waveout.ts re-chunks internally), so these are posted verbatim.
 * Every 4th chunk carries a copy (transferred) to keep main-thread writes off the
 * worker's heap; the rest are small enough to clone cheaply.
 */
async function pumpAudio(child: Child): Promise<void> {
  const reader = (child.proc.stdout as ReadableStream<Uint8Array>).getReader();
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (stopping) break;
      const copy = new Uint8Array(value); // own the bytes before transferring
      const buf = copy.buffer as ArrayBuffer;
      post({ type: "pcm", buf }, [buf]);
      n++;
    }
  } finally {
    reader.releaseLock?.();
  }
  if (!stopping) {
    // A stream with no audio track simply ends this child; that is not fatal for
    // playback, so it is reported as `ended` and the caller keeps the video.
    await child.stderr.catch(() => "");
    post({ type: "ended", reason: "audio stream ended" });
  }
  void n;
}

self.onmessage = async (ev: MessageEvent<MediaToWorker>) => {
  const msg = ev.data;
  if (msg.type === "stop") {
    stopping = true;
    killChild(videoChild);
    killChild(audioChild);
    videoChild = null;
    audioChild = null;
    return;
  }
  if (msg.type !== "start") return;

  stopping = false;
  const { url, audioUrl, width, height, fps, withAudio, live, quiet, audioRate, audioChannels } =
    msg;

  // Announce immediately so the UI can show something while ffmpeg probes.
  post({ type: "ready", width, height, fps, hasAudio: withAudio, live });

  const video = spawnFfmpeg(buildVideoArgs({ url, width, height, fps, live, quiet }));
  videoChild = video;
  // Drain video stderr so its buffer can't fill and stall the pipe.
  const videoErr = video.stderr;

  let audio: Child | null = null;
  if (withAudio) {
    try {
      audio = spawnFfmpeg(
        buildAudioArgs({
          // Split-track sites (Chaturbate) publish audio as its own manifest, so the
          // video URL has no `0:a:0` to map and `-i <videoUrl>` would fail outright.
          url: audioUrl ?? url,
          rate: audioRate,
          channels: audioChannels,
          live,
          quiet,
        }),
      );
      audioChild = audio;
    } catch (err) {
      post({ type: "error", message: `audio spawn failed: ${String(err)}` });
    }
  }

  // Never await audio: it must keep forwarding PCM for the whole session.
  const audioTask = audio === null ? Promise.resolve() : pumpAudio(audio);
  audioTask.catch((err: unknown) => {
    if (!stopping) post({ type: "error", message: `audio pump: ${String(err)}` });
  });

  try {
    await pumpVideo(video, width, height, fps);
  } catch (err) {
    if (!stopping) post({ type: "error", message: `video pump: ${String(err)}` });
  }
  // If video died, tear the audio child down too — the session is over.
  if (!stopping) {
    killChild(audioChild);
    audioChild = null;
    await videoErr.catch(() => "");
  }
};
