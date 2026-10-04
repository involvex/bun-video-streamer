/**
 * video — a real video FILE decoded by Media Foundation and played IN THE TERMINAL
 * at a ludicrous frame rate, in pure TypeScript over Bun FFI.
 *
 * Run: bun run example/video.ts <path-to-video.mp4|avi|mov|…>
 *
 * The decoder drives the full Media Foundation file pipeline synchronously on the
 * main thread (no callbacks, no worker threads): CoInitializeEx + MFStartup →
 * MFCreateAttributes with MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING=1 (lights up the
 * built-in Video Processor MFT so we can demand plain RGB32 from any codec) →
 * MFCreateSourceReaderFromURL → SetCurrentMediaType(RGB32) on the first video
 * stream. Each frame: blocking ReadSample → ConvertToContiguousBuffer →
 * IMFMediaBuffer::Lock → read the raw bytes → Unlock → Release. The actual output
 * MF_MT_DEFAULT_STRIDE is queried (it can be NEGATIVE for bottom-up DIBs, and real
 * files PAD rows, so we never assume stride == w*4). End-of-stream LOOPS the clip
 * via IMFSourceReader::SetCurrentPosition(0).
 *
 * The frame is rendered onto the CharTerm CHAR-GRID in two live-toggleable modes:
 *   • HALF-BLOCK (default): each cell is '▀' with fg = the TOP source pixel and
 *     bg = the BOTTOM source pixel → cols × (rows·2) effective video pixels.
 *   • ASCII: each cell averages a source block to a luminance/colour and picks a
 *     glyph from a density ramp.
 * A per-(srcW,srcH,cols,rows) LUT precomputes every cell's source byte offsets so
 * the per-frame hot loop is pure gathered reads — no division, no Math.floor, no
 * allocation. The image is letterboxed (accounting for the ~1×2 half-block cell)
 * so the video keeps its aspect ratio.
 *
 * SOUND is SYNCHRONIZED via a SECOND, independent IMFSourceReader on the SAME file
 * (FIRST_AUDIO → PCM), decoded to 16-bit PCM and streamed through winmm waveOut over
 * a ring of pre-prepared WAVEHDR buffers (~0.5s of look-ahead). The audio playback
 * position (waveOutGetPosition in TIME_BYTES) becomes the MASTER CLOCK: the video
 * decodes/drops frames to track the audio byte-clock instead of the wall clock, so
 * picture and sound stay locked. Files with no audio (or where PCM can't be
 * negotiated) fall back gracefully to the original wall-clock pacing — never a crash.
 * EOF loops both streams back to 0 in step. Audio init/feed is fully suppressed in
 * headless (CAPTURE_PNG / BENCH) mode so capture is silent+deterministic and BENCH
 * stays a pure video-throughput number; TURBO ignores audio sync (it's the fps
 * benchmark — audio can't speed up without pitch change).
 *
 * Playback is paced to real time off the master clock (audio byte-clock when audio is
 * active, else the wall `time`); frames are dropped when behind so lag never
 * accumulates. In CAPTURE_PNG / BENCH mode it simply decodes the next frame each call
 * so headless capture shows real video content and BENCH measures throughput.
 *
 * Keys: SPACE pause/resume · m half-block/ASCII · t TURBO (uncap fps) · q/ESC quit.
 *
 * Engine/APIs: @bun-win32/terminal (runText + CharTerm) + @bun-win32 mfplat/mfreadwrite +
 * an inline COM vtable invoker (vcall/comRelease) + ole32 + winmm (waveOut). The video and audio decoders are
 * fully independent readers, so neither touches the other's held-buffer state.
 */
import { CFunction, FFIType, dlopen, read, toArrayBuffer, type Pointer } from "bun:ffi";

import "@bun-win32/core"; // installs Buffer.prototype.ptr
import Mfplat, {
  MFMediaType_Video,
  MFVideoFormat_RGB32,
  MFMediaType_Audio,
  MFAudioFormat_PCM,
} from "@bun-win32/mfplat";
import { CharTerm, runText, type RGB } from "@bun-win32/terminal";
import { BLACK, ensureLut, releaseLut, renderFrame, type RenderMode } from "./lib/render";
import { closeWaveOutLib, createWaveOut, type WaveOut } from "./lib/waveout";

// ── Memoized COM vtable invoker (the implicit `this` u64 is prepended) ─────────────
const invokers = new Map<string, ReturnType<typeof CFunction>>();
const IUNKNOWN_RELEASE = 2;

/** Invoke COM method `slot` on `thisPtr`; argTypes/args exclude the implicit `this`. */
function vcall(
  thisPtr: bigint,
  slot: number,
  argTypes: readonly FFIType[],
  args: readonly unknown[],
  returns: FFIType = FFIType.i32,
): number {
  const vtable = read.u64(Number(thisPtr) as Pointer, 0);
  const method = read.u64(Number(vtable) as Pointer, slot * 8);
  const key = `${method}|${returns}|${argTypes.join(",")}`;
  let invoke = invokers.get(key);
  if (invoke === undefined) {
    invoke = CFunction({
      ptr: Number(method) as Pointer,
      args: [FFIType.u64, ...argTypes],
      returns,
    });
    invokers.set(key, invoke);
  }
  return invoke(thisPtr, ...args) as number;
}

/** Release a COM interface (IUnknown::Release). No-op on a null handle. */
function comRelease(thisPtr: bigint): void {
  if (thisPtr !== 0n) vcall(thisPtr, IUNKNOWN_RELEASE, [], [], FFIType.u32);
}

// ── HRESULTs / constants ─────────────────────────────────────────────────────────
const S_OK = 0;
const COINIT_APARTMENTTHREADED = 0x2;
const RPC_E_CHANGED_MODE = 0x8001_0106 >>> 0;
const MF_VERSION = 0x0002_0070;
const MFSTARTUP_LITE = 0x1;
const MF_SOURCE_READER_FIRST_VIDEO_STREAM = 0xffff_fffc;
const MF_SOURCE_READER_FIRST_AUDIO_STREAM = 0xffff_fffd;
const MF_SOURCE_READERF_ENDOFSTREAM = 0x2;
const VT_I8 = 20; // PROPVARIANT vt for a 64-bit signed integer (seek position)

// ── IMFSourceReader vtable slots (verified against mfreadwrite.h) ─────────────────
const READER_SET_STREAM_SELECTION = 4;
const READER_GET_NATIVE_MEDIA_TYPE = 5;
const READER_GET_CURRENT_MEDIA_TYPE = 6;
const READER_SET_CURRENT_MEDIA_TYPE = 7;
const READER_SET_CURRENT_POSITION = 8;
const READER_READ_SAMPLE = 9;
const READER_GET_PRESENTATION_ATTRIBUTE = 12;
// ── IMFAttributes vtable slots (verified against mfobjects.h) ──────────────────────
const ATTR_GET_UINT32 = 7;
const ATTR_GET_UINT64 = 8;
const ATTR_SET_UINT32 = 21;
const ATTR_SET_GUID = 24;
// ── IMFSample / IMFMediaBuffer slots (verified in webcam.ts / the probe) ──────────
const SAMPLE_CONVERT_TO_CONTIGUOUS_BUFFER = 41;
const BUFFER_LOCK = 3;
const BUFFER_UNLOCK = 4;

// ── Media Foundation GUIDs (verified against mfapi.h / mfobjects.h) ────────────────
const MF_MT_MAJOR_TYPE = "48eba18e-f8c9-4687-bf11-0a74c9f96a8f";
const MF_MT_SUBTYPE = "f7e34c9a-42e8-4714-b74b-cb29d72c35e5";
const MF_MT_FRAME_SIZE = "1652c33d-d6b2-4012-b834-72030849a37d";
const MF_MT_FRAME_RATE = "c459a2e8-3d2c-4e44-b132-fee5156c7bb0";
const MF_MT_DEFAULT_STRIDE = "644b4e48-1e02-4516-b0eb-c01ca9d49ac6";
const MF_PD_DURATION = "6c990d33-bb8e-477a-8598-0d5d96fcd88a"; // presentation-descriptor duration
const MF_SOURCE_READER_MEDIASOURCE = 0xffff_ffff >>> 0; // first stream = the media source
const MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING = "fb394f3d-ccf1-42ee-bbb3-f9b845d5681d";
// Audio media-type attributes (negotiated PCM format read-back) — GUIDs from mfapi.h.
const MF_MT_AUDIO_NUM_CHANNELS = "37e48bf5-645e-4c5b-89de-ada9e29b696a";
const MF_MT_AUDIO_SAMPLES_PER_SECOND = "5faeeae7-0290-4c31-9e8a-c534f68d9dba";
const MF_MT_AUDIO_BITS_PER_SAMPLE = "f2deb57f-40fa-4764-aa33-ed4f2d1ff669";

const hex = (hr: number): string => `0x${(hr >>> 0).toString(16).padStart(8, "0")}`;
const wide = (s: string): Buffer => Buffer.from(`${s}\0`, "utf16le");

function guidBytes(value: string): Buffer {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(
    value,
  );
  if (match === null) throw new Error(`Invalid GUID: ${value}`);
  const [, d1, d2, d3, d4High, d4Low] = match;
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(parseInt(d1!, 16), 0);
  buffer.writeUInt16LE(parseInt(d2!, 16), 4);
  buffer.writeUInt16LE(parseInt(d3!, 16), 6);
  const data4 = `${d4High}${d4Low}`;
  for (let i = 0; i < 8; i += 1) buffer[8 + i] = parseInt(data4.slice(i * 2, i * 2 + 2), 16);
  return buffer;
}

// ── Inline ole32 + mfreadwrite bindings (self-contained; mirrors the probe/webcam) ─
const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  CoUninitialize: { args: [], returns: FFIType.void },
});
// u64 for the URL/attrs pointers so x64 COM addresses survive without truncation.
const mfrw = dlopen("mfreadwrite.dll", {
  MFCreateSourceReaderFromURL: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
});
// ── A decoded video source, or a graceful failure. ────────────────────────────────
interface DecodedFrame {
  bytes: Uint8Array; // RGB32 (BGRA) rows, abs(stride)-pitched, length = stride*h
  stride: number; // absolute row pitch in bytes (always positive)
  flip: boolean; // true → source is bottom-up; row y lives at (h-1-y)
  tsSec: number; // sample presentation time in seconds
}
interface VideoSource {
  ok: boolean;
  error: string;
  w: number;
  h: number;
  durationSec: number; // 0 if unknown
  fps: number; // native frame rate (0 if unknown)
  /** ReadSample once. null = warm-up (no frame this call); call again. Loops at EOF. */
  decodeNextFrame(): DecodedFrame | null;
  /** UNLOCK + release the sample/buffer held since the last decodeNextFrame(). */
  releaseFrame(): void;
  shutdown(): void;
}

// Out-param Buffers kept at module scope so GC can't free a struct mid FFI call.
const ppAttrs = Buffer.alloc(8);
const ppReader = Buffer.alloc(8);
const ppNativeType = Buffer.alloc(8);
const ppMediaType = Buffer.alloc(8);
const ppOutputType = Buffer.alloc(8);
const frameSizeOut = Buffer.alloc(8);
const frameRateOut = Buffer.alloc(8);
const strideOut = Buffer.alloc(4);
const durationOut = Buffer.alloc(16); // PROPVARIANT (vt at 0, value at 8)
// ReadSample out-params (reused every frame).
const pActualIndex = Buffer.alloc(4);
const pStreamFlags = Buffer.alloc(4);
const pTimestamp = Buffer.alloc(8);
const ppSample = Buffer.alloc(8);
const ppBuffer = Buffer.alloc(8);
const ppData = Buffer.alloc(8);
const pMaxLen = Buffer.alloc(4);
const pCurLen = Buffer.alloc(4);
// Seek PROPVARIANT (16 bytes: vt at 0, value at 8) + a GUID_NULL time format.
const seekProp = Buffer.alloc(16);
const guidNull = Buffer.alloc(16);

function openVideo(path: string): VideoSource {
  const fail = (error: string): VideoSource => ({
    ok: false,
    error,
    w: 0,
    h: 0,
    durationSec: 0,
    fps: 0,
    decodeNextFrame: () => null,
    releaseFrame: () => {},
    shutdown: () => {},
  });

  // 1. Reader attributes: enable the built-in video processor MFT (so any codec can
  //    be demanded as RGB32, and stride normalisation works for padded formats).
  if (Mfplat.MFCreateAttributes(ppAttrs.ptr!, 1) !== S_OK) return fail("MFCreateAttributes failed");
  const attrs = ppAttrs.readBigUInt64LE(0);
  const keyVP = guidBytes(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING);
  vcall(attrs, ATTR_SET_UINT32, [FFIType.ptr, FFIType.u32], [keyVP.ptr!, 1]);

  // 2. Create the source reader from the file URL.
  const wpath = wide(path);
  const createHr = mfrw.symbols.MFCreateSourceReaderFromURL(wpath.ptr!, attrs, ppReader.ptr!);
  comRelease(attrs);
  if (createHr !== S_OK)
    return fail(`MFCreateSourceReaderFromURL ${hex(createHr)} (unsupported/missing file or codec)`);
  const reader = ppReader.readBigUInt64LE(0);

  // 3. Native WxH + frame rate from the first native media type.
  let w = 0;
  let h = 0;
  let fps = 0;
  if (
    vcall(
      reader,
      READER_GET_NATIVE_MEDIA_TYPE,
      [FFIType.u32, FFIType.u32, FFIType.ptr],
      [MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, ppNativeType.ptr!],
    ) === S_OK
  ) {
    const nativeType = ppNativeType.readBigUInt64LE(0);
    const keySize = guidBytes(MF_MT_FRAME_SIZE);
    if (
      vcall(
        nativeType,
        ATTR_GET_UINT64,
        [FFIType.ptr, FFIType.ptr],
        [keySize.ptr!, frameSizeOut.ptr!],
      ) === S_OK
    ) {
      w = frameSizeOut.readUInt32LE(4); // width packs into the high DWORD
      h = frameSizeOut.readUInt32LE(0); // height into the low DWORD
    }
    const keyRate = guidBytes(MF_MT_FRAME_RATE);
    if (
      vcall(
        nativeType,
        ATTR_GET_UINT64,
        [FFIType.ptr, FFIType.ptr],
        [keyRate.ptr!, frameRateOut.ptr!],
      ) === S_OK
    ) {
      const num = frameRateOut.readUInt32LE(4);
      const den = frameRateOut.readUInt32LE(0);
      if (den > 0) fps = num / den;
    }
    comRelease(nativeType);
  }
  if (w <= 0 || h <= 0) {
    comRelease(reader);
    return fail("no video stream / zero frame size");
  }

  // 4. Demand RGB32 output on the first video stream (video processor makes this work
  //    for H.264/HEVC/etc.; if a container's codec is genuinely undecodable this fails).
  if (Mfplat.MFCreateMediaType(ppMediaType.ptr!) !== S_OK) {
    comRelease(reader);
    return fail("MFCreateMediaType failed");
  }
  const mt = ppMediaType.readBigUInt64LE(0);
  const keyMajor = guidBytes(MF_MT_MAJOR_TYPE);
  const valVideo = guidBytes(MFMediaType_Video);
  vcall(mt, ATTR_SET_GUID, [FFIType.ptr, FFIType.ptr], [keyMajor.ptr!, valVideo.ptr!]);
  const keySub = guidBytes(MF_MT_SUBTYPE);
  const valRGB32 = guidBytes(MFVideoFormat_RGB32);
  vcall(mt, ATTR_SET_GUID, [FFIType.ptr, FFIType.ptr], [keySub.ptr!, valRGB32.ptr!]);
  const setHr = vcall(
    reader,
    READER_SET_CURRENT_MEDIA_TYPE,
    [FFIType.u32, FFIType.ptr, FFIType.u64],
    [MF_SOURCE_READER_FIRST_VIDEO_STREAM, null, mt],
  );
  comRelease(mt);
  if (setHr !== S_OK) {
    comRelease(reader);
    return fail(`SetCurrentMediaType(RGB32) ${hex(setHr)} (codec cannot be converted to RGB32)`);
  }
  vcall(
    reader,
    READER_SET_STREAM_SELECTION,
    [FFIType.u32, FFIType.i32],
    [MF_SOURCE_READER_FIRST_VIDEO_STREAM, 1],
  );

  // 5. Read the ACTUAL output media type's default stride. May be negative (bottom-up
  //    DIB) and is NOT necessarily w*4 — real files pad rows. Fall back gracefully.
  let stride = w * 4;
  let flip = false;
  let strideKnown = false;
  if (
    vcall(
      reader,
      READER_GET_CURRENT_MEDIA_TYPE,
      [FFIType.u32, FFIType.ptr],
      [MF_SOURCE_READER_FIRST_VIDEO_STREAM, ppOutputType.ptr!],
    ) === S_OK
  ) {
    const outType = ppOutputType.readBigUInt64LE(0);
    const keyStride = guidBytes(MF_MT_DEFAULT_STRIDE);
    if (
      vcall(
        outType,
        ATTR_GET_UINT32,
        [FFIType.ptr, FFIType.ptr],
        [keyStride.ptr!, strideOut.ptr!],
      ) === S_OK
    ) {
      const signed = strideOut.readInt32LE(0); // MF_MT_DEFAULT_STRIDE is a UINT32 holding an INT32
      if (signed !== 0) {
        flip = signed < 0;
        stride = Math.abs(signed);
        strideKnown = true;
      }
    }
    comRelease(outType);
  }

  // 6. Presentation duration (100ns units) → seconds, best-effort. GetPresentationAttribute
  //    (vtable slot 12) fills a PROPVARIANT: vt at offset 0, the UI8 value at offset 8.
  let durationSec = 0;
  const keyDur = guidBytes(MF_PD_DURATION);
  durationOut.fill(0);
  if (
    vcall(
      reader,
      READER_GET_PRESENTATION_ATTRIBUTE,
      [FFIType.u32, FFIType.ptr, FFIType.ptr],
      [MF_SOURCE_READER_MEDIASOURCE, keyDur.ptr!, durationOut.ptr!],
    ) === S_OK
  ) {
    const ticks = durationOut.readBigUInt64LE(8);
    if (ticks > 0n) durationSec = Number(ticks) / 1e7;
  }

  let alive = true;
  let frameHeld = false;
  let heldBuffer = 0n;
  let heldSample = 0n;

  // Unlock + release the currently-held MF buffer/sample (idempotent). The decoder
  // holds AT MOST ONE locked buffer; this frees it so the next can be locked.
  const releaseHeld = (): void => {
    if (!frameHeld) return;
    frameHeld = false;
    vcall(heldBuffer, BUFFER_UNLOCK, [], [], FFIType.i32);
    comRelease(heldBuffer);
    comRelease(heldSample);
    heldBuffer = 0n;
    heldSample = 0n;
  };

  return {
    ok: true,
    error: "",
    w,
    h,
    durationSec, // 0 = unknown (we surface video time, not a hard duration)
    fps,
    decodeNextFrame(): DecodedFrame | null {
      if (!alive) return null;
      const hr = vcall(
        reader,
        READER_READ_SAMPLE,
        [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        [
          MF_SOURCE_READER_FIRST_VIDEO_STREAM,
          0,
          pActualIndex.ptr!,
          pStreamFlags.ptr!,
          pTimestamp.ptr!,
          ppSample.ptr!,
        ],
      );
      if (hr !== S_OK) return null;

      // End of stream → loop the clip by seeking back to position 0.
      if ((pStreamFlags.readUInt32LE(0) & MF_SOURCE_READERF_ENDOFSTREAM) !== 0) {
        seekProp.fill(0);
        seekProp.writeUInt16LE(VT_I8, 0); // vt = VT_I8
        seekProp.writeBigInt64LE(0n, 8); // value = 0 (100ns units)
        vcall(
          reader,
          READER_SET_CURRENT_POSITION,
          [FFIType.ptr, FFIType.ptr],
          [guidNull.ptr!, seekProp.ptr!],
        );
        return null;
      }

      const sample = ppSample.readBigUInt64LE(0);
      if (sample === 0n) return null; // warm-up: no frame ready this call

      const tsSec = Number(pTimestamp.readBigInt64LE(0)) / 1e7;
      if (
        vcall(sample, SAMPLE_CONVERT_TO_CONTIGUOUS_BUFFER, [FFIType.ptr], [ppBuffer.ptr!]) !== S_OK
      ) {
        comRelease(sample);
        return null;
      }
      const buffer = ppBuffer.readBigUInt64LE(0);
      if (
        vcall(
          buffer,
          BUFFER_LOCK,
          [FFIType.ptr, FFIType.ptr, FFIType.ptr],
          [ppData.ptr!, pMaxLen.ptr!, pCurLen.ptr!],
        ) !== S_OK
      ) {
        comRelease(buffer);
        comRelease(sample);
        return null;
      }
      const dataPtr = ppData.readBigUInt64LE(0);
      const curLen = pCurLen.readUInt32LE(0);
      if (dataPtr === 0n || curLen === 0) {
        vcall(buffer, BUFFER_UNLOCK, [], [], FFIType.i32);
        comRelease(buffer);
        comRelease(sample);
        return null;
      }

      // Resolve stride from the buffer length when the media type didn't expose it.
      let rowStride = stride;
      if (!strideKnown) {
        const fromLen = Math.floor(curLen / h);
        rowStride = fromLen >= w * 4 ? fromLen : w * 4;
      }

      // SUCCESS — only NOW release the PREVIOUSLY-held buffer. Every null return above
      // leaves the prior frame held & valid, so a caller's last good frame survives a
      // warm-up / EOF poll (it's only freed when a genuine new frame replaces it).
      releaseHeld();
      heldBuffer = buffer;
      heldSample = sample;
      frameHeld = true;
      const bytes = new Uint8Array(toArrayBuffer(Number(dataPtr) as Pointer, 0, curLen));
      return { bytes, stride: rowStride, flip, tsSec };
    },
    releaseFrame(): void {
      releaseHeld();
    },
    shutdown(): void {
      if (!alive) return;
      this.releaseFrame();
      alive = false;
      comRelease(reader);
    },
  };
}

// ── Audio: a SECOND, independent IMFSourceReader → PCM → winmm waveOut ─────────────
// This reader is wholly separate from the video reader (its own held-buffer state, its
// own out-param Buffers), so neither can corrupt the other. The waveOut ring is fed a
// little ahead of playback each tick; its byte position is the demo's master clock.
// The waveOut ring itself now lives in lib/waveout.ts (shared with the live-stream
// path); what stays here is the Media Foundation PCM *decode* half plus the EOF-loop
// bookkeeping, which is specific to a seekable file.
const AUDIO_CHUNK = 16384; // max PCM bytes per decode (~85ms at 48kHz/2ch/16bit)
const EMPTY_PCM = Buffer.alloc(0); // an empty push is how we report "nothing decoded"
// Audio reader out-params — DISTINCT from the video reader's so the two never collide.
const aPpReader = Buffer.alloc(8);
const aPpMediaType = Buffer.alloc(8);
const aPpCurType = Buffer.alloc(8);
const aU32Out = Buffer.alloc(4);
const aActualIndex = Buffer.alloc(4);
const aStreamFlags = Buffer.alloc(4);
const aTimestamp = Buffer.alloc(8);
const aPpSample = Buffer.alloc(8);
const aPpBuffer = Buffer.alloc(8);
const aPpData = Buffer.alloc(8);
const aMaxLen = Buffer.alloc(4);
const aCurLen = Buffer.alloc(4);
const aSeekProp = Buffer.alloc(16);
const aGuidNull = Buffer.alloc(16);
const aChunkScratch = Buffer.alloc(AUDIO_CHUNK); // decode target, then pushed to waveOut

interface AudioSource {
  ok: boolean;
  rate: number;
  channels: number;
  bits: number;
  underruns: number;
  /** Top up the ring with freshly-decoded PCM so waveOut never underruns. */
  feed(): void;
  /** Master-clock seconds from the device's byte position. */
  masterSec(): number;
  pause(): void;
  resume(): void;
  shutdown(): void;
}

// Open + negotiate audio. Returns ok:false (and leaves audio disabled) for any silent
// file or unsupported codec — the caller then keeps the original wall-clock pacing.
function openAudio(path: string): AudioSource {
  const disabled: AudioSource = {
    ok: false,
    rate: 0,
    channels: 0,
    bits: 0,
    underruns: 0,
    feed: () => {},
    masterSec: () => 0,
    pause: () => {},
    resume: () => {},
    shutdown: () => {},
  };

  const wpath = wide(path);
  if (mfrw.symbols.MFCreateSourceReaderFromURL(wpath.ptr!, 0n, aPpReader.ptr!) !== S_OK)
    return disabled;
  const reader = aPpReader.readBigUInt64LE(0);

  // Demand PCM on the FIRST audio stream (the reader inserts the AAC/etc. decoder).
  if (Mfplat.MFCreateMediaType(aPpMediaType.ptr!) !== S_OK) {
    comRelease(reader);
    return disabled;
  }
  const mt = aPpMediaType.readBigUInt64LE(0);
  vcall(
    mt,
    ATTR_SET_GUID,
    [FFIType.ptr, FFIType.ptr],
    [guidBytes(MF_MT_MAJOR_TYPE).ptr!, guidBytes(MFMediaType_Audio).ptr!],
  );
  vcall(
    mt,
    ATTR_SET_GUID,
    [FFIType.ptr, FFIType.ptr],
    [guidBytes(MF_MT_SUBTYPE).ptr!, guidBytes(MFAudioFormat_PCM).ptr!],
  );
  const setHr = vcall(
    reader,
    READER_SET_CURRENT_MEDIA_TYPE,
    [FFIType.u32, FFIType.ptr, FFIType.u64],
    [MF_SOURCE_READER_FIRST_AUDIO_STREAM, null, mt],
  );
  comRelease(mt);
  if (setHr !== S_OK) {
    comRelease(reader); // no audio stream / can't make PCM → graceful disable
    return disabled;
  }
  vcall(
    reader,
    READER_SET_STREAM_SELECTION,
    [FFIType.u32, FFIType.i32],
    [MF_SOURCE_READER_FIRST_AUDIO_STREAM, 1],
  );

  // Read back the negotiated PCM format.
  let rate = 48000;
  let channels = 2;
  let bits = 16;
  if (
    vcall(
      reader,
      READER_GET_CURRENT_MEDIA_TYPE,
      [FFIType.u32, FFIType.ptr],
      [MF_SOURCE_READER_FIRST_AUDIO_STREAM, aPpCurType.ptr!],
    ) === S_OK
  ) {
    const cur = aPpCurType.readBigUInt64LE(0);
    const getU32 = (guid: string, def: number): number =>
      vcall(
        cur,
        ATTR_GET_UINT32,
        [FFIType.ptr, FFIType.ptr],
        [guidBytes(guid).ptr!, aU32Out.ptr!],
      ) === S_OK
        ? aU32Out.readUInt32LE(0)
        : def;
    rate = getU32(MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000);
    channels = getU32(MF_MT_AUDIO_NUM_CHANNELS, 2);
    bits = getU32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    comRelease(cur);
  }
  const blockAlign = channels * (bits / 8);
  const bytesPerSec = rate * blockAlign;
  if (blockAlign <= 0 || bytesPerSec <= 0) {
    comRelease(reader);
    return disabled;
  }

  // Open the output device. A failure here (no output device) leaves audio disabled
  // and the caller falls back to wall-clock pacing — never a crash.
  const waveOut: WaveOut = createWaveOut({ rate, channels, bits });
  if (!waveOut.ok) {
    comRelease(reader);
    return disabled;
  }

  let alive = true;
  let atEof = false;

  // Decode the next PCM chunk into `dest`. Returns bytes written (0 = EOF/warm-up).
  const decodeInto = (dest: Buffer): number => {
    let written = 0;
    // ReadSample can return a warm-up null; try a few times to land real bytes.
    for (let tries = 0; tries < 8 && written === 0; tries++) {
      const hr = vcall(
        reader,
        READER_READ_SAMPLE,
        [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        [
          MF_SOURCE_READER_FIRST_AUDIO_STREAM,
          0,
          aActualIndex.ptr!,
          aStreamFlags.ptr!,
          aTimestamp.ptr!,
          aPpSample.ptr!,
        ],
      );
      if (hr !== S_OK) return 0;
      if ((aStreamFlags.readUInt32LE(0) & MF_SOURCE_READERF_ENDOFSTREAM) !== 0) {
        atEof = true; // loop: seek this reader back to 0 (mirrors the video reader)
        aSeekProp.fill(0);
        aSeekProp.writeUInt16LE(VT_I8, 0);
        aSeekProp.writeBigInt64LE(0n, 8);
        vcall(
          reader,
          READER_SET_CURRENT_POSITION,
          [FFIType.ptr, FFIType.ptr],
          [aGuidNull.ptr!, aSeekProp.ptr!],
        );
        return 0;
      }
      const sample = aPpSample.readBigUInt64LE(0);
      if (sample === 0n) continue; // warm-up
      if (
        vcall(sample, SAMPLE_CONVERT_TO_CONTIGUOUS_BUFFER, [FFIType.ptr], [aPpBuffer.ptr!]) === S_OK
      ) {
        const buffer = aPpBuffer.readBigUInt64LE(0);
        if (
          vcall(
            buffer,
            BUFFER_LOCK,
            [FFIType.ptr, FFIType.ptr, FFIType.ptr],
            [aPpData.ptr!, aMaxLen.ptr!, aCurLen.ptr!],
          ) === S_OK
        ) {
          const dataPtr = aPpData.readBigUInt64LE(0);
          const curLen = aCurLen.readUInt32LE(0);
          if (dataPtr !== 0n && curLen > 0) {
            const n = Math.min(curLen, dest.length); // chunk is sized to hold a frame; clamp defensively
            const view = new Uint8Array(toArrayBuffer(Number(dataPtr) as Pointer, 0, n));
            dest.set(view, 0);
            written = n;
          }
          vcall(buffer, BUFFER_UNLOCK, [], [], FFIType.i32);
        }
        comRelease(buffer);
      }
      comRelease(sample);
    }
    return written;
  };

  return {
    ok: true,
    rate,
    channels,
    bits,
    get underruns() {
      return waveOut.underruns;
    },
    feed(): void {
      if (!alive) return;
      let wrote = false;
      // Fill every ring slot that is currently free. freeSlots is re-read each
      // iteration, so it shrinks as we fill — exactly the original per-slot scan.
      for (let i = 0; i < waveOut.freeSlots; i++) {
        if (atEof) break; // at EOF this epoch: stop topping up until the loop reset runs
        const n = decodeInto(aChunkScratch);
        if (n === 0) break; // warm-up / EOF — try again next tick
        if (waveOut.writePcm(aChunkScratch.subarray(0, n)) === 0) break;
        wrote = true;
      }
      // Loop boundary: the reader hit EOF AND every ring buffer has drained → reset the
      // device (zeroes the byte clock so masterSec restarts near 0 in lock-step with the
      // video reader's own EOF→seek(0)) and let the next feed() re-prime from 0.
      if (atEof) {
        if (waveOut.freeSlots === waveOut.ringSize) {
          waveOut.reset(); // zeroes the device byte counter (epoch restart)
          atEof = false;
        }
        return;
      }
      // Underrun accounting is owned by the ring: an empty push on a free slot counts.
      if (!wrote && waveOut.freeSlots > 0) waveOut.writePcm(EMPTY_PCM);
    },
    masterSec(): number {
      return waveOut.masterSec();
    },
    pause(): void {
      waveOut.pause();
    },
    resume(): void {
      waveOut.resume();
    },
    shutdown(): void {
      if (!alive) return;
      alive = false;
      waveOut.shutdown();
      comRelease(reader);
    },
  };
}

// ── Boot: argv + Media Foundation init ────────────────────────────────────────────
const path = process.argv[2];
if (path === undefined || path === "") {
  process.stdout.write("usage: bun run example/video.ts <path-to-video.mp4|avi|mov|…>\n");
  process.exit(1);
}

const coHr = ole32.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
const coOwned = coHr >= 0;
if (coHr < 0 && coHr >>> 0 !== RPC_E_CHANGED_MODE)
  process.stderr.write(`video: CoInitializeEx ${hex(coHr)} (continuing)\n`);
const mfStartHr = Mfplat.MFStartup(MF_VERSION, MFSTARTUP_LITE);
if (mfStartHr !== S_OK) {
  process.stdout.write(`video: MFStartup ${hex(mfStartHr)} — Media Foundation unavailable.\n`);
  process.exit(1);
}

const video = openVideo(path);
if (!video.ok) {
  process.stdout.write(`video: cannot play "${path}": ${video.error}\n`);
  Mfplat.MFShutdown();
  if (coOwned) ole32.symbols.CoUninitialize();
  process.exit(1);
}

const SRC_W = video.w;
const SRC_H = video.h;
const fileName = path.replace(/^.*[\\/]/, "");

// ── Playback state ────────────────────────────────────────────────────────────────
// Half-block (high-fidelity) is the default; VIDEO_MODE=ascii starts in ASCII (handy
// for a headless ASCII capture). Either way 'm' toggles live.
let mode: RenderMode = process.env.VIDEO_MODE === "ascii" ? "ascii" : "half";
let paused = false;
let turbo = false;
let displayedTs = 0; // presentation time of the frame currently on screen (seconds)
let everDrew = false;
let framesDecoded = 0;
let framesDropped = 0;
const headless =
  (process.env.CAPTURE_PNG !== undefined && process.env.CAPTURE_PNG !== "") ||
  process.env.BENCH === "1";

// AUDIO is opened only for live playback — NEVER in headless (no device touched, so
// capture is silent + deterministic and BENCH stays a pure video number).
const audio: AudioSource = headless
  ? {
      ok: false,
      rate: 0,
      channels: 0,
      bits: 0,
      underruns: 0,
      feed: () => {},
      masterSec: () => 0,
      pause: () => {},
      resume: () => {},
      shutdown: () => {},
    }
  : openAudio(path);
const audioActive = audio.ok; // sound + audio-master clock both on
// Sync diagnostics: a few (masterSec, displayedTs) pairs sampled over the run.
const syncSamples: Array<{ master: number; disp: number }> = [];
let syncNextAt = 0.5; // first sample at ~0.5s of audio time

// Pull one real frame, retrying a bounded number of warm-up / EOF-loop nulls so a
// genuine frame lands. Returns the frame (still LOCKED — caller must releaseFrame()).
function pullFrame(): DecodedFrame | null {
  let frame: DecodedFrame | null = null;
  for (let tries = 0; tries < 8 && frame === null; tries++) frame = video.decodeNextFrame();
  return frame;
}

// Decode one frame and render it onto the grid. Returns true if a frame was drawn.
function decodeAndRender(t: CharTerm): boolean {
  const frame = pullFrame();
  if (frame === null) return false;
  framesDecoded++;
  displayedTs = frame.tsSec;
  const L = ensureLut(t.columns, t.rows, SRC_W, SRC_H, frame.stride, frame.flip);
  renderFrame(t, frame.bytes, mode, L);
  video.releaseFrame();
  everDrew = true;
  return true;
}

function frameStep(t: CharTerm, time: number): void {
  if (paused) return; // hold the last drawn frame (the grid still carries its cells)

  // CAPTURE / BENCH / TURBO: no real-time pacing — decode + render the next frame
  // every call so headless capture shows real content and BENCH/turbo flex throughput.
  // TURBO is the fps benchmark: audio CAN'T speed up without pitch change, so we simply
  // don't sync to (or feed) it here — the ring just drains, video runs flat out.
  if (headless || turbo) {
    if (!decodeAndRender(t) && !everDrew) t.fillRect(0, 0, t.columns, t.rows, BLACK);
    return;
  }

  // Keep the waveOut ring topped up so it never underruns in the ~16ms frame gaps, and
  // derive the master clock from the device byte position. With no audio we fall back to
  // the wall clock `time` exactly as before.
  let clock = time;
  if (audioActive) {
    audio.feed();
    clock = audio.masterSec();
    // Audio looped (byte clock reset to ~0) while the video is still near the clip end →
    // drop displayedTs so the catch-up loop pulls the video forward through its OWN EOF
    // seek and the two re-align. Threshold avoids reacting to normal small jitter.
    if (clock + 1 < displayedTs) displayedTs = 0;
    if (clock >= syncNextAt && syncSamples.length < 16) {
      syncSamples.push({ master: clock, disp: displayedTs });
      syncNextAt = clock + 1; // sample roughly once per second
    }
  }

  // First live frame: show frame 0 immediately.
  if (!everDrew) {
    if (!decodeAndRender(t)) t.fillRect(0, 0, t.columns, t.rows, BLACK);
    return;
  }

  // Real-time pacing: decode forward until the displayed timestamp reaches the master
  // clock, dropping intermediate frames so lag never accumulates. Only the final
  // caught-up frame is rendered. A per-call guard caps catch-up work after a stall.
  if (displayedTs >= clock) return; // already ahead of (or at) the clock — nothing to do
  let guard = 0;
  let lastFrame: DecodedFrame | null = null;
  while (displayedTs < clock && guard < 240) {
    guard++;
    const frame = pullFrame();
    if (frame === null) break; // warm-up / EOF: the prior decode stays held & valid
    framesDecoded++;
    // The previous decode (if any) was auto-released by THIS successful decode and was
    // skipped without drawing → count it as dropped. Do NOT releaseFrame() here: that
    // would free the buffer `frame` now points into (the bug that segfaulted at 1440p).
    if (lastFrame !== null) framesDropped++;
    displayedTs = frame.tsSec;
    lastFrame = frame;
    if (frame.tsSec >= clock) break; // caught up
  }
  if (lastFrame !== null) {
    const L = ensureLut(t.columns, t.rows, SRC_W, SRC_H, lastFrame.stride, lastFrame.flip);
    renderFrame(t, lastFrame.bytes, mode, L);
    video.releaseFrame();
  }
}

// Overlay = top-right FPS readout + bottom controls/info bar. Hidden by default;
// REVEALED only by MOUSE MOVEMENT over the window, then hides HIDE_AFTER_S after the
// last move. (Keys still work — they just don't summon it.)
const HIDE_AFTER_S = 2;
let lastMoveT = -1000; // sim-time of the last mouse move (far past → hidden at startup)
let lastMouseSeq = -1; // engine mouse-event counter, to detect movement
let fpsEma = 60; // our own FPS average (the engine's readout is off via drawFps:false)

function drawOverlay(t: CharTerm, fps: number): void {
  // Bottom controls/info bar.
  const y = t.rows - 1;
  const m = mode === "half" ? "HALF-BLOCK" : "ASCII";
  const dur = video.durationSec > 0 ? `/${video.durationSec.toFixed(1)}s` : "s";
  const snd = audioActive
    ? ` · ♪ ${(audio.rate / 1000).toFixed(0)}k/${audio.channels}ch`
    : " · (silent)";
  const flags = `${paused ? " [PAUSED]" : ""}${turbo ? " [TURBO]" : ""}`;
  const left = ` ${fileName} ${SRC_W}x${SRC_H} · ${m} · ${displayedTs.toFixed(1)}${dur}${snd}${flags}`;
  const right = "SPACE pause · m mode · t turbo · ESC quit ";
  t.fillRect(0, y, t.columns, 1, [18, 18, 24]);
  t.text(
    0,
    y,
    left.slice(0, Math.max(0, t.columns - right.length - 1)),
    [180, 200, 255],
    [18, 18, 24],
    true,
  );
  const rx = Math.max(0, t.columns - right.length);
  if (rx > left.length) t.text(rx, y, right, [130, 130, 150], [18, 18, 24]);
  // Top-right FPS readout (same style/colours as the engine's mandatory HUD).
  const fc: RGB = fps >= 60 ? [120, 255, 140] : fps >= 30 ? [255, 200, 90] : [255, 110, 110];
  const fl = ` ${fps.toFixed(0).padStart(3)} FPS `;
  const fx = Math.max(0, t.columns - fl.length);
  t.fillRect(fx, 0, fl.length, 1, [22, 22, 30]);
  t.text(fx, 0, fl, fc, [22, 22, 30], true);
}

function onKey(key: string): void {
  if (key === "space") {
    paused = !paused;
    if (audioActive) {
      if (paused) audio.pause();
      else audio.resume();
    }
  } else if (key === "m" || key === "M") {
    mode = mode === "half" ? "ascii" : "half";
  } else if (key === "t" || key === "T") {
    turbo = !turbo;
    // TURBO is the pure-fps benchmark; audio can't follow without pitch change, so we
    // pause the device (no drain → no underrun spam) and resume on the way out.
    if (audioActive && !paused) {
      if (turbo) audio.pause();
      else audio.resume();
    }
  }
}

await runText({
  title: `${fileName}`,
  hud: "",
  targetFps: Infinity,
  drawFps: false, // we draw our own FPS in the overlay so it shows/hides with the controls
  mouse: true, // report mouse motion so we can reveal the overlay on move
  frame: (t, time, dt) => {
    const inst = dt > 0 ? 1 / dt : 60;
    fpsEma = fpsEma * 0.9 + inst * 0.1;
    // Mouse moved (or clicked/scrolled) over the window → reveal the overlay.
    if (t.mouse.active && t.mouse.sequence !== lastMouseSeq) {
      lastMouseSeq = t.mouse.sequence;
      lastMoveT = time;
    }
    frameStep(t, time);
    // Show for HIDE_AFTER_S after the last move. Suppressed in BENCH (keeps the throughput
    // number pure); VIDEO_OVERLAY=1 forces it on for headless verification.
    if (
      process.env.BENCH !== "1" &&
      (process.env.VIDEO_OVERLAY === "1" || time - lastMoveT < HIDE_AFTER_S)
    ) {
      drawOverlay(t, fpsEma);
    }
  },
  onKey: (key) => {
    onKey(key);
  },
});

// ── Teardown ──────────────────────────────────────────────────────────────────────
// waveOutReset + unprepare all headers + close (inside audio.shutdown) BEFORE releasing
// the reader, then the MF/COM teardown. Order matters: stop the device first so no
// callback touches a freed buffer.
audio.shutdown();
video.shutdown();
releaseLut();
Mfplat.MFShutdown();
if (coOwned) ole32.symbols.CoUninitialize();
ole32.close();
mfrw.close();
closeWaveOutLib();

if (process.env.FPS_REPORT === "1") {
  const sync = syncSamples.map((s) => `${s.master.toFixed(2)}:${s.disp.toFixed(2)}`).join(" ");
  process.stderr.write(
    `video_stats decoded=${framesDecoded} dropped=${framesDropped} audio=${audioActive ? `${audio.rate}/${audio.channels}/${audio.bits}` : "off"} underruns=${audio.underruns} sync[master:disp]=${sync}\n`,
  );
}
process.exit(0);
