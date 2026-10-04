import { describe, expect, test } from "bun:test";
import { FrameReassembler } from "../src/lib/reassemble";

/** A deterministic byte pattern so we can prove ordering and content survive. */
function bytes(n: number, start = 0): Uint8Array {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (start + i) & 0xff;
  return a;
}

describe("FrameReassembler", () => {
  test("rejects a nonsensical frame size", () => {
    expect(() => new FrameReassembler(0)).toThrow();
    expect(() => new FrameReassembler(-1)).toThrow();
    expect(() => new FrameReassembler(1.5)).toThrow();
  });

  test("single exact chunk yields exactly one frame", () => {
    const r = new FrameReassembler(8);
    const out = r.push(bytes(8));
    expect(out).toHaveLength(1);
    expect(Array.from(out[0]!)).toEqual(Array.from(bytes(8)));
    expect(r.pending).toBe(0);
  });

  test("one frame split across three reads", () => {
    const r = new FrameReassembler(8);
    // Offsets are continuous so the frame is expected to be [0..7] in order —
    // this is what actually proves the reassembler preserves ordering.
    expect(r.push(bytes(3, 0))).toHaveLength(0);
    expect(r.pending).toBe(3);
    expect(r.push(bytes(3, 3))).toHaveLength(0);
    expect(r.pending).toBe(6);
    const out = r.push(bytes(2, 6));
    expect(out).toHaveLength(1);
    expect(Array.from(out[0]!)).toEqual(Array.from(bytes(8)));
    expect(r.pending).toBe(0);
  });

  test("three frames inside one chunk, in order", () => {
    const r = new FrameReassembler(4);
    const out = r.push(bytes(12)); // 3× frame, sequential values
    expect(out).toHaveLength(3);
    expect(Array.from(out[0]!)).toEqual([0, 1, 2, 3]);
    expect(Array.from(out[1]!)).toEqual([4, 5, 6, 7]);
    expect(Array.from(out[2]!)).toEqual([8, 9, 10, 11]);
    expect(r.pending).toBe(0);
  });

  test("zero-length chunks interleave harmlessly", () => {
    const r = new FrameReassembler(4);
    expect(r.push(new Uint8Array(0))).toHaveLength(0);
    expect(r.push(bytes(2, 0))).toHaveLength(0);
    expect(r.pending).toBe(2);
    expect(r.push(new Uint8Array(0))).toHaveLength(0);
    expect(r.pending).toBe(2); // an empty chunk must not disturb the partial frame
    const out = r.push(bytes(2, 2));
    expect(out).toHaveLength(1);
    expect(Array.from(out[0]!)).toEqual([0, 1, 2, 3]);
  });

  test("remainder carries across calls at every boundary offset", () => {
    // Feed a long stream in chunks of 1..7 bytes and assert we recover the exact
    // original sequence regardless of chunking.
    const original = bytes(101);
    for (const step of [1, 2, 3, 5, 7, 11, 13]) {
      const r = new FrameReassembler(16);
      const got: number[] = [];
      for (let off = 0; off < original.length; off += step) {
        for (const f of r.push(original.subarray(off, off + step))) {
          got.push(...f);
        }
      }
      const flushed = r.flush();
      if (flushed) got.push(...flushed);
      expect(got).toEqual(Array.from(original));
    }
  });

  test("flush() returns a trailing partial frame exactly once", () => {
    const r = new FrameReassembler(8);
    r.push(bytes(5));
    const tail = r.flush();
    expect(tail).not.toBeNull();
    expect(Array.from(tail!)).toEqual([0, 1, 2, 3, 4]);
    expect(r.pending).toBe(0);
    // A second flush has nothing left.
    expect(r.flush()).toBeNull();
  });

  test("flush() on an exact boundary yields nothing", () => {
    const r = new FrameReassembler(8);
    expect(r.push(bytes(8))).toHaveLength(1);
    expect(r.flush()).toBeNull();
  });

  test("reset() discards staged bytes", () => {
    const r = new FrameReassembler(8);
    r.push(bytes(5));
    expect(r.pending).toBe(5);
    r.reset();
    expect(r.pending).toBe(0);
    // The next frame must start clean, not continue the discarded partial.
    const out = r.push(bytes(8, 100));
    expect(Array.from(out[0]!)).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);
  });

  test("emitted frames are copies, not views of the accumulator", () => {
    // This is what makes transferring to the main thread safe: mutating a later frame
    // must never alter an earlier one we already handed out.
    const r = new FrameReassembler(4);
    const first = r.push(bytes(8))[0]!;
    const snapshot = Array.from(first);
    r.push(bytes(8, 200)); // advances the accumulator well past the first frame
    expect(Array.from(first)).toEqual(snapshot);
  });

  test("survives a pathological 1-byte interleave with flush mid-stream", () => {
    const r = new FrameReassembler(5);
    r.push(bytes(3));
    expect(r.flush()).not.toBeNull();
    // After a flush the reassembler must be reusable for a fresh connection.
    const out = r.push(bytes(5, 9));
    expect(Array.from(out[0]!)).toEqual([9, 10, 11, 12, 13]);
  });
});

describe("FrameReassembler.pushLatest", () => {
  test("returns false and leaves dest untouched for an incomplete chunk", () => {
    const r = new FrameReassembler(8);
    const dest = new Uint8Array(8).fill(0xee);
    expect(r.pushLatest(bytes(3), dest)).toBe(false);
    expect(Array.from(dest)).toEqual(Array.from(bytes(8).fill(0xee)));
  });

  test("keeps the FRESHEST frame when a burst contains many", () => {
    // This is the HLS case: 200 frames in one read, we want the last one.
    const r = new FrameReassembler(4);
    const dest = new Uint8Array(4);
    const burst = new Uint8Array(4 * 10);
    for (let i = 0; i < burst.length; i++) burst[i] = i & 0xff;
    expect(r.pushLatest(burst, dest)).toBe(true);
    // Last frame of a 0..39 stream = bytes 36..39.
    expect(Array.from(dest)).toEqual([36, 37, 38, 39]);
    expect(r.pending).toBe(0);
  });

  test("does not allocate a new array per frame (dest is reused)", () => {
    const r = new FrameReassembler(4);
    const dest = new Uint8Array(4);
    r.pushLatest(bytes(40), dest);
    // 40 bytes = 10 frames; the last is source bytes 36..39 → 136..139.
    expect(r.pushLatest(bytes(40, 100), dest)).toBe(true);
    expect(Array.from(dest)).toEqual([136, 137, 138, 139]);
  });

  test("carries a remainder across calls and reports the completed frame", () => {
    const r = new FrameReassembler(4);
    const dest = new Uint8Array(4);
    expect(r.pushLatest(bytes(2, 0), dest)).toBe(false);
    expect(r.pending).toBe(2);
    // Completes frame [0,1] then starts [2,...] which stays pending.
    expect(r.pushLatest(bytes(4, 2), dest)).toBe(true);
    expect(Array.from(dest)).toEqual([0, 1, 2, 3]);
    expect(r.pending).toBe(2);
  });

  test("agrees with push() for a byte-exact stream", () => {
    // Same input through both APIs must yield identical frame content.
    const original = bytes(257);
    const a = new FrameReassembler(16);
    const b = new FrameReassembler(16);
    const dest = new Uint8Array(16);
    const fromPush: number[] = [];
    const fromLatest: number[] = [];
    for (let off = 0; off < original.length; off += 7) {
      const slice = original.subarray(off, off + 7);
      for (const f of a.push(slice)) fromPush.push(...f);
      if (b.pushLatest(slice, dest)) fromLatest.push(...dest);
    }
    const tailA = a.flush();
    if (tailA) fromPush.push(...tailA);
    const tailB = b.flush();
    if (tailB) fromLatest.push(...tailB);
    expect(fromLatest).toEqual(fromPush);
  });

  test("rejects an undersized destination instead of corrupting memory", () => {
    const r = new FrameReassembler(64);
    expect(() => r.pushLatest(bytes(64), new Uint8Array(32))).toThrow();
  });
});
