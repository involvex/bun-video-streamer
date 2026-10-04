/**
 * reassemble — turn an arbitrarily-chunked byte stream into fixed-size frames.
 *
 * This is the single most correctness-critical piece of the live-streaming path.
 *
 * A pipe is a BYTE stream with no frame boundaries: Bun's reader hands back whatever
 * the OS had available. Measured on a real 480×270 BGRA stream from ffmpeg, 300
 * frames arrived across 2461 reads (~63 KB average) — so frames routinely straddle
 * several reads, and several frames routinely arrive in one read. Any code that
 * assumes "one read == one frame" produces a corrupted picture: garbage rows, colour
 * banding, or a picture that scrolls diagonally.
 *
 * The accumulator lives in this object and is NEVER handed out. Each emitted frame is
 * a fresh copy, because the worker transfers frames to the main thread and a
 * transferred (neutered) buffer cannot be refilled.
 */
export class FrameReassembler {
  /** Bytes per frame (e.g. width * height * 4 for BGRA). */
  readonly frameSize: number;
  private readonly acc: Uint8Array;
  private filled = 0;

  constructor(frameSize: number) {
    if (!Number.isInteger(frameSize) || frameSize <= 0) {
      throw new Error(`FrameReassembler: bad frameSize ${frameSize}`);
    }
    this.frameSize = frameSize;
    this.acc = new Uint8Array(frameSize);
  }

  /** How many bytes of the next frame are already staged. */
  get pending(): number {
    return this.filled;
  }

  /**
   * Append a chunk and return every COMPLETE frame it completed, in order.
   * Returns an empty array when the chunk did not finish a frame (the common case).
   *
   * The returned arrays are fresh copies — safe to transfer.
   */
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length === 0) return [];
    const frames: Uint8Array[] = [];
    let off = 0;

    while (off < chunk.length) {
      // Copy up to the end of the current frame.
      const need = this.frameSize - this.filled;
      const take = Math.min(need, chunk.length - off);
      this.acc.set(chunk.subarray(off, off + take), this.filled);
      this.filled += take;
      off += take;

      if (this.filled === this.frameSize) {
        // Fresh copy — the accumulator is reused for the next frame.
        frames.push(this.acc.slice());
        this.filled = 0;
      }
    }
    return frames;
  }

  /**
   * Reassemble a chunk but keep ONLY the newest complete frame, copied into `dest`.
   *
   * Returns true when `dest` holds a complete frame.
   *
   * This exists because an HLS segment lands as one large burst (measured: 200 frames
   * inside a single 487 ms read) while we render at ~30 fps. push() would allocate a
   * fresh copy per frame — ~100 MB of throwaway copies per burst. Here the caller owns
   * ONE reusable `dest` and we simply overwrite it, so the steady-state cost is a
   * memcpy with zero allocation. The FRESHEST frame always wins: posting the oldest of
   * a burst would display stale picture for an extra frame interval.
   *
   * `dest.byteLength` must be at least frameSize.
   */
  pushLatest(chunk: Uint8Array, dest: Uint8Array): boolean {
    if (chunk.length === 0) return false;
    if (dest.byteLength < this.frameSize) {
      throw new Error(
        `FrameReassembler.pushLatest: dest ${dest.byteLength} < frameSize ${this.frameSize}`,
      );
    }
    let got = false;
    let off = 0;
    while (off < chunk.length) {
      const take = Math.min(this.frameSize - this.filled, chunk.length - off);
      this.acc.set(chunk.subarray(off, off + take), this.filled);
      this.filled += take;
      off += take;
      if (this.filled === this.frameSize) {
        dest.set(this.acc, 0); // overwrite — later frames in this chunk supersede it
        got = true;
        this.filled = 0;
      }
    }
    return got;
  }

  /**
   * Emit any trailing partial frame and clear it. Called on stream end: a partial
   * frame is a truncated final frame, so it is returned (the caller can render it)
   * but never carried into a subsequent connection.
   */
  flush(): Uint8Array | null {
    if (this.filled === 0) return null;
    const tail = this.acc.slice(0, this.filled);
    this.filled = 0;
    return tail;
  }

  /** Drop any staged bytes (used when a connection is reset). */
  reset(): void {
    this.filled = 0;
  }
}
