/**
 * waveout — a winmm `waveOut` ring-buffer PCM player, decoupled from any decoder.
 *
 * This is the OUTPUT half of audio playback, lifted out of video.ts so it can be fed
 * either by Media Foundation (local files, video.ts) or by an ffmpeg `s16le` pipe
 * (live streams, stream.ts). It knows nothing about where PCM came from — you push
 * bytes with writePcm() and it queues them into a ring of pre-prepared WAVEHDR
 * buffers.
 *
 * CRITICAL INVARIANT — everything the driver may touch during playback lives at
 * MODULE SCOPE, so the GC can never free it out from under waveOut. A data buffer
 * collected mid-playback segfaults the process. That is also why this module supports
 * exactly ONE instance per process (the buffers are shared singletons, by design —
 * do not try to make this multi-instance without moving the buffers to an explicit
 * owner object that stays alive for the device's lifetime).
 */
import { dlopen, FFIType } from "bun:ffi";
import "@bun-win32/core"; // installs Buffer.prototype.ptr

// ── winmm waveOut bindings (exact signatures from the proven _audioprobe) ──────────
// HWAVEOUT is a u64 handle on x64.
const winmm = dlopen("winmm.dll", {
  waveOutOpen: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.u32],
    returns: FFIType.u32,
  },
  waveOutPrepareHeader: {
    args: [FFIType.u64, FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
  waveOutWrite: {
    args: [FFIType.u64, FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
  waveOutUnprepareHeader: {
    args: [FFIType.u64, FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
  waveOutGetPosition: {
    args: [FFIType.u64, FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
  waveOutPause: { args: [FFIType.u64], returns: FFIType.u32 },
  waveOutRestart: { args: [FFIType.u64], returns: FFIType.u32 },
  waveOutReset: { args: [FFIType.u64], returns: FFIType.u32 },
  waveOutSetVolume: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
  waveOutClose: { args: [FFIType.u64], returns: FFIType.u32 },
});

// ── constants ─────────────────────────────────────────────────────────────────────
const WAVE_MAPPER = 0xffff_ffff >>> 0; // default output device
const WHDR_DONE = 0x1; // buffer finished playing (set by the driver)
const WHDR_PREPARED = 0x2; // header has been prepared (must stay set across re-writes)
const TIME_BYTES = 4; // MMTIME.wType selecting a byte count

const RING = 8; // WAVEHDR buffers in flight
const CHUNK = 16384; // bytes per data buffer (~85ms at 48kHz/2ch/16bit → ~0.5s total)
const WAVEHDR_SIZE = 48; // x64 WAVEHDR
const WAVEFORMATEX_SIZE = 18;
const HDR_FLAGS_OFF = 24; // WAVEHDR.dwFlags offset
const HDR_LENGTH_OFF = 8; // WAVEHDR.dwBufferLength offset
const HDR_LPDATA_OFF = 0; // WAVEHDR.lpData offset

// EVERYTHING the driver may touch lives at MODULE SCOPE so the GC can never free it
// out from under waveOut (a freed data buffer mid-playback segfaults).
const wfx = Buffer.alloc(WAVEFORMATEX_SIZE);
const ringData: Buffer[] = [];
const ringHdr: Buffer[] = [];
for (let i = 0; i < RING; i++) {
  ringData.push(Buffer.alloc(CHUNK));
  ringHdr.push(Buffer.alloc(WAVEHDR_SIZE));
}
const mmtime = Buffer.alloc(16); // MMTIME (wType@0, value@4); 16B for safety
const outHwo = Buffer.alloc(8); // waveOutOpen out-param

export interface WaveOutOptions {
  rate: number;
  channels: number;
  bits: number;
}

export interface WaveOut {
  /** false when there is no output device / the format was rejected. Never throws. */
  ok: boolean;
  rate: number;
  channels: number;
  bits: number;
  /** Ticks where free slots existed but nothing was produced (starvation). */
  readonly underruns: number;
  /** Ticks where writePcm() had to drop PCM because the ring was full. */
  readonly drops: number;
  /** How many ring slots are currently free (DONE) and can accept PCM. */
  readonly freeSlots: number;
  /** Total ring slots (the queue capacity). */
  readonly ringSize: number;
  /** Push arbitrary-length PCM into the ring. Returns bytes accepted. */
  writePcm(bytes: Uint8Array): number;
  /** Device byte-clock → seconds. The master clock for A/V sync. */
  masterSec(): number;
  /** Zero the device byte counter (used at a file's loop boundary). */
  reset(): void;
  /** Per-channel volume, 0..1. */
  setVolume(left: number, right?: number): void;
  pause(): void;
  resume(): void;
  /** Idempotent: reset → unprepare every header → close. */
  shutdown(): void;
}

const DISABLED = (rate: number, channels: number, bits: number): WaveOut => ({
  ok: false,
  rate,
  channels,
  bits,
  underruns: 0,
  drops: 0,
  freeSlots: 0,
  ringSize: 0,
  writePcm: () => 0,
  masterSec: () => 0,
  reset: () => {},
  setVolume: () => {},
  pause: () => {},
  resume: () => {},
  shutdown: () => {},
});

/**
 * Open the default output device for 16-bit PCM at the requested rate/format.
 * Returns a disabled (ok:false) instance instead of throwing when there is no device.
 */
export function createWaveOut(opts: WaveOutOptions): WaveOut {
  const { rate, channels, bits } = opts;
  const blockAlign = channels * (bits / 8);
  const bytesPerSec = rate * blockAlign;
  if (blockAlign <= 0 || bytesPerSec <= 0) return DISABLED(0, 0, 0);

  // WAVEFORMATEX for the negotiated PCM.
  wfx.fill(0);
  wfx.writeUInt16LE(1, 0); // WAVE_FORMAT_PCM
  wfx.writeUInt16LE(channels, 2);
  wfx.writeUInt32LE(rate, 4);
  wfx.writeUInt32LE(bytesPerSec, 8);
  wfx.writeUInt16LE(blockAlign, 12);
  wfx.writeUInt16LE(bits, 14);
  wfx.writeUInt16LE(0, 16); // cbSize

  if (winmm.symbols.waveOutOpen(outHwo.ptr!, WAVE_MAPPER, wfx.ptr!, 0n, 0n, 0) !== 0) {
    return DISABLED(0, 0, 0); // no output device → run silent
  }
  const hwo = outHwo.readBigUInt64LE(0);

  // Prepare each header ONCE, pointed at its own fixed data buffer; mark DONE so the
  // first write treats every slot as free.
  for (let i = 0; i < RING; i++) {
    const hdr = ringHdr[i]!;
    hdr.fill(0);
    hdr.writeBigUInt64LE(BigInt(ringData[i]!.ptr!), HDR_LPDATA_OFF);
    hdr.writeUInt32LE(CHUNK, HDR_LENGTH_OFF); // dwBufferLength (reset per write)
    winmm.symbols.waveOutPrepareHeader(hwo, hdr.ptr!, WAVEHDR_SIZE);
    // dwFlags: keep PREPARED (waveOutWrite needs it) and pretend DONE so the ring
    // treats the slot as immediately writable. Clobbering PREPARED here →
    // WAVERR_UNPREPARED (34).
    hdr.writeUInt32LE(WHDR_DONE | WHDR_PREPARED, HDR_FLAGS_OFF);
  }

  let alive = true;
  let underruns = 0;
  let drops = 0;
  // A partially-filled header waiting for more PCM. Bounded to one CHUNK so a
  // starved/slow producer can never grow memory or latency without bound.
  const pending = Buffer.alloc(CHUNK);
  let pendingLen = 0;

  /** Claim the next DONE (free) ring slot, or -1 if every slot is still playing. */
  const acquireSlot = (): number => {
    for (let i = 0; i < RING; i++) {
      if ((ringHdr[i]!.readUInt32LE(HDR_FLAGS_OFF) & WHDR_DONE) === 0) continue;
      const hdr = ringHdr[i]!;
      // Clear WHDR_DONE but KEEP WHDR_PREPARED — waveOutWrite requires PREPARED and
      // rejects a cleared one with WAVERR_UNPREPARED.
      hdr.writeUInt32LE(hdr.readUInt32LE(HDR_FLAGS_OFF) & ~WHDR_DONE, HDR_FLAGS_OFF);
      return i;
    }
    return -1;
  };

  const play = (slot: number, n: number): void => {
    ringHdr[slot]!.writeUInt32LE(n, HDR_LENGTH_OFF); // dwBufferLength
    winmm.symbols.waveOutWrite(hwo, ringHdr[slot]!.ptr!, WAVEHDR_SIZE);
  };

  /** Free every slot (used after a device reset, which marks all buffers done). */
  const freeAllSlots = (): void => {
    for (let i = 0; i < RING; i++) {
      ringHdr[i]!.writeUInt32LE(WHDR_DONE | WHDR_PREPARED, HDR_FLAGS_OFF);
    }
  };

  return {
    ok: true,
    rate,
    channels,
    bits,
    get underruns() {
      return underruns;
    },
    get drops() {
      return drops;
    },
    get freeSlots() {
      let n = 0;
      for (let i = 0; i < RING; i++) {
        if ((ringHdr[i]!.readUInt32LE(HDR_FLAGS_OFF) & WHDR_DONE) !== 0) n++;
      }
      return n;
    },
    get ringSize() {
      return RING;
    },
    /**
     * Push arbitrary-length PCM into the ring. Returns bytes accepted.
     *
     * Call once per tick EVEN WITH AN EMPTY BUFFER: an empty push while a ring slot
     * is free is what counts as starvation (the producer had nothing to give).
     * That mirrors the original per-tick `feed()` accounting.
     */
    writePcm(bytes: Uint8Array): number {
      if (!alive) return 0;
      if (bytes.length === 0) {
        if (pendingLen === 0 && acquireSlot() >= 0) underruns++;
        return 0;
      }
      let off = 0;

      // Top up a partially-filled header first.
      if (pendingLen > 0) {
        const take = Math.min(CHUNK - pendingLen, bytes.length);
        pending.set(bytes.subarray(0, take), pendingLen);
        pendingLen += take;
        off = take;
        if (pendingLen === CHUNK) {
          const slot = acquireSlot();
          if (slot < 0) {
            // Ring full — keep the partial rather than discarding decoded audio.
            drops++;
            return 0;
          }
          ringData[slot]!.set(pending, 0);
          play(slot, CHUNK);
          pendingLen = 0;
        }
      }

      // Then fill whole headers straight from the caller's buffer.
      while (off < bytes.length) {
        const slot = acquireSlot();
        if (slot < 0) {
          // Ring full. On a LIVE stream the right move is to drop the excess rather
          // than buffer it — buffering would add latency without bound.
          drops++;
          return off;
        }
        const n = Math.min(CHUNK, bytes.length - off);
        ringData[slot]!.set(bytes.subarray(off, off + n), 0);
        play(slot, n);
        off += n;
      }
      return off;
    },
    masterSec(): number {
      if (!alive) return 0;
      mmtime.fill(0);
      mmtime.writeUInt32LE(TIME_BYTES, 0); // request a byte count
      if (winmm.symbols.waveOutGetPosition(hwo, mmtime.ptr!, 16) !== 0) return 0;
      if (mmtime.readUInt32LE(0) !== TIME_BYTES) return 0; // driver gave another unit
      return mmtime.readUInt32LE(4) / bytesPerSec; // bytes played → seconds
    },
    reset(): void {
      if (!alive) return;
      winmm.symbols.waveOutReset(hwo); // stops + zeroes the device byte counter
      freeAllSlots(); // reset marks all headers DONE, but write it explicitly
      pendingLen = 0;
    },
    setVolume(left: number, right?: number): void {
      if (!alive) return;
      // waveOutSetVolume takes a packed DWORD: left in the high word, right in the low.
      const l = Math.max(0, Math.min(1, left));
      const r = Math.max(0, Math.min(1, right ?? left));
      winmm.symbols.waveOutSetVolume(
        hwo,
        ((Math.round(l * 0xffff) << 16) | Math.round(r * 0xffff)) >>> 0,
      );
    },
    pause(): void {
      if (alive) winmm.symbols.waveOutPause(hwo);
    },
    resume(): void {
      if (alive) winmm.symbols.waveOutRestart(hwo);
    },
    shutdown(): void {
      if (!alive) return;
      alive = false;
      // Stop the device BEFORE unpreparing, so no callback touches a freed buffer.
      winmm.symbols.waveOutReset(hwo);
      for (let i = 0; i < RING; i++) {
        winmm.symbols.waveOutUnprepareHeader(hwo, ringHdr[i]!.ptr!, WAVEHDR_SIZE);
      }
      winmm.symbols.waveOutClose(hwo);
    },
  };
}

/** Release the winmm DLL handle. Call once, at process teardown. */
export function closeWaveOutLib(): void {
  winmm.close();
}
