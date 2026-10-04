/**
 * render — the terminal RENDERING core, shared by every playback source.
 *
 * It knows nothing about where pixels came from. The decoders (Media Foundation for
 * files, an ffmpeg rawvideo pipe for live streams) hand over a tightly- or loosely-
 * packed BGRA buffer plus its stride and orientation, and this module turns that into
 * cells on the CharTerm char grid in two live-toggleable modes:
 *   • HALF-BLOCK (default): each cell is '▀' with fg = the TOP source pixel and
 *     bg = the BOTTOM source pixel → cols × (rows·2) effective video pixels.
 *   • ASCII: each cell averages a source block to a luminance/colour and picks a
 *     glyph from a density ramp.
 *
 * A per-(srcW,srcH,cols,rows) LUT precomputes every cell's source byte offsets so
 * the per-frame hot loop is pure gathered reads — no division, no Math.floor, no
 * allocation. The image is letterboxed (accounting for the ~1×2 half-block cell) so
 * the video keeps its aspect ratio.
 *
 * BYTE ORDER: sources must deliver BGRA (blue, green, red, alpha) — that is what
 * Media Foundation's MFVideoFormat_RGB32 produces, and what `ffmpeg -pix_fmt bgra`
 * produces. Both are the same layout, which is exactly why one renderer can serve
 * both the local-file and the live-stream path. Changing to rgb24 here would swap
 * the red and blue channels.
 */
import { type CharTerm, type RGB } from "@bun-win32/terminal";

export type RenderMode = "half" | "ascii";

// ── ASCII density ramp (dark → bright). ───────────────────────────────────────────
const RAMP = " .:-=+*#%@";
const RAMP_CODE = new Int32Array(RAMP.length);
for (let i = 0; i < RAMP.length; i++) RAMP_CODE[i] = RAMP.charCodeAt(i);
const RAMP_LAST = RAMP.length - 1;
const UPPER_HALF = "▀".codePointAt(0)!;

// ── Downscale LUT (point sample, allocation-free hot loop) ─────────────────────────
// For each output cell we precompute, in source byte offsets:
//   • half-block: the TOP sub-row pixel offset and the BOTTOM sub-row pixel offset
//   • ascii: the single representative source pixel offset (cell centre)
// Letterboxed: cells outside the video rectangle map to offset -1 (drawn black).
export interface DownscaleLut {
  cols: number;
  rows: number;
  srcW: number;
  srcH: number;
  stride: number;
  flip: boolean;
  topOff: Int32Array; // half-block top pixel byte offset per cell (-1 = letterbox)
  botOff: Int32Array; // half-block bottom pixel byte offset per cell (-1 = letterbox)
  midOff: Int32Array; // ascii representative pixel byte offset per cell (-1 = letterbox)
}
let lut: DownscaleLut | null = null;

/** Byte offset of source pixel (sx,sy) honouring stride + bottom-up flip. */
function srcOffset(sx: number, sy: number, srcH: number, stride: number, flip: boolean): number {
  const row = flip ? srcH - 1 - sy : sy;
  return row * stride + sx * 4;
}

export function buildLut(
  cols: number,
  rows: number,
  srcW: number,
  srcH: number,
  stride: number,
  flip: boolean,
): DownscaleLut {
  const topOff = new Int32Array(cols * rows).fill(-1);
  const botOff = new Int32Array(cols * rows).fill(-1);
  const midOff = new Int32Array(cols * rows).fill(-1);

  // Letterbox: a half-block cell is 1 source-pixel wide × 2 source-pixels tall, so the
  // grid's pixel resolution is cols × (rows·2) with square-ish pixels. Fit srcW×srcH
  // into that, preserving aspect, and centre it.
  const gridPxW = cols;
  const gridPxH = rows * 2;
  const scale = Math.min(gridPxW / srcW, gridPxH / srcH);
  const dstPxW = Math.max(1, Math.round(srcW * scale));
  const dstPxH = Math.max(1, Math.round(srcH * scale));
  const offPxX = Math.floor((gridPxW - dstPxW) / 2); // left pad, in cells
  const offPxY = Math.floor((gridPxH - dstPxH) / 2); // top pad, in half-rows
  const invScaleX = srcW / dstPxW;
  const invScaleY = srcH / dstPxH;

  for (let r = 0; r < rows; r++) {
    const pyTop = r * 2; // upper half-block pixel row (grid space)
    const pyBot = r * 2 + 1; // lower half-block pixel row
    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      // Map grid pixel → source pixel for top, bottom, and mid (ascii) samples.
      const lx = c - offPxX;
      const sxF = (lx + 0.5) * invScaleX;
      const inX = lx >= 0 && lx < dstPxW;
      let sx = sxF | 0;
      if (sx < 0) sx = 0;
      else if (sx >= srcW) sx = srcW - 1;

      const lyTop = pyTop - offPxY;
      const lyBot = pyBot - offPxY;
      const inYTop = lyTop >= 0 && lyTop < dstPxH;
      const inYBot = lyBot >= 0 && lyBot < dstPxH;
      const idx = base + c;

      if (inX && inYTop) {
        let sy = ((lyTop + 0.5) * invScaleY) | 0;
        if (sy < 0) sy = 0;
        else if (sy >= srcH) sy = srcH - 1;
        topOff[idx] = srcOffset(sx, sy, srcH, stride, flip);
      }
      if (inX && inYBot) {
        let sy = ((lyBot + 0.5) * invScaleY) | 0;
        if (sy < 0) sy = 0;
        else if (sy >= srcH) sy = srcH - 1;
        botOff[idx] = srcOffset(sx, sy, srcH, stride, flip);
      }
      // ASCII representative pixel = centre of the cell's 1×2 footprint.
      const lyMid = r * 2 + 1 - offPxY;
      if (inX && (inYTop || inYBot)) {
        let sy = ((lyMid + 0.5) * invScaleY) | 0;
        if (sy < 0) sy = 0;
        else if (sy >= srcH) sy = srcH - 1;
        midOff[idx] = srcOffset(sx, sy, srcH, stride, flip);
      }
    }
  }
  return { cols, rows, srcW, srcH, stride, flip, topOff, botOff, midOff };
}

/**
 * Cached wrapper around buildLut. Rebuilds whenever ANY input changes — including the
 * source dimensions, which matters for the live path where the source size can be
 * renegotiated (a resolution change, or a `[`/`]` capture-size change at runtime).
 */
export function ensureLut(
  cols: number,
  rows: number,
  srcW: number,
  srcH: number,
  stride: number,
  flip: boolean,
): DownscaleLut {
  if (
    lut === null ||
    lut.cols !== cols ||
    lut.rows !== rows ||
    lut.srcW !== srcW ||
    lut.srcH !== srcH ||
    lut.stride !== stride ||
    lut.flip !== flip
  ) {
    lut = buildLut(cols, rows, srcW, srcH, stride, flip);
  }
  return lut;
}

/** Drop the cached LUT (used on shutdown / explicit teardown). */
export function releaseLut(): void {
  lut = null;
}

// ── Render one decoded frame onto the char grid (the hot loop) ─────────────────────
// Reusable scratch RGB for put() so we never allocate inside the loop. These MUST be
// mutable tuples (not the readonly `RGB` alias) because the hot loop rewrites them in
// place for every cell.
const fgRGB: [number, number, number] = [0, 0, 0];
const bgRGB: [number, number, number] = [0, 0, 0];
export const BLACK: RGB = [0, 0, 0];

export function renderHalfBlock(t: CharTerm, src: Uint8Array, L: DownscaleLut): void {
  const { cols, rows, topOff, botOff } = L;
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      const idx = base + c;
      const to = topOff[idx]!;
      const bo = botOff[idx]!;
      if (to < 0 && bo < 0) {
        t.put(c, r, " ", BLACK, BLACK);
        continue;
      }
      // BGRA → RGB. Letterbox sub-pixels read black.
      if (to >= 0) {
        fgRGB[0] = src[to + 2]!;
        fgRGB[1] = src[to + 1]!;
        fgRGB[2] = src[to]!;
      } else {
        fgRGB[0] = 0;
        fgRGB[1] = 0;
        fgRGB[2] = 0;
      }
      if (bo >= 0) {
        bgRGB[0] = src[bo + 2]!;
        bgRGB[1] = src[bo + 1]!;
        bgRGB[2] = src[bo]!;
      } else {
        bgRGB[0] = 0;
        bgRGB[1] = 0;
        bgRGB[2] = 0;
      }
      t.put(c, r, UPPER_HALF, fgRGB, bgRGB);
    }
  }
}

export function renderAscii(t: CharTerm, src: Uint8Array, L: DownscaleLut): void {
  const { cols, rows, midOff } = L;
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      const idx = base + c;
      const mo = midOff[idx]!;
      if (mo < 0) {
        t.put(c, r, " ", BLACK, BLACK);
        continue;
      }
      const b = src[mo]!;
      const g = src[mo + 1]!;
      const rr = src[mo + 2]!;
      // Integer luminance (0..255): 0.299r + 0.587g + 0.114b ≈ (77r+150g+29b)>>8.
      const lum = (77 * rr + 150 * g + 29 * b) >> 8;
      const gi = (lum * RAMP_LAST) >> 8; // 0..RAMP_LAST
      const glyph = RAMP_CODE[gi <= RAMP_LAST ? gi : RAMP_LAST]!;
      // Boost colour so dim glyphs still read (the glyph density already encodes value).
      fgRGB[0] = rr;
      fgRGB[1] = g;
      fgRGB[2] = b;
      t.put(c, r, glyph, fgRGB, BLACK);
    }
  }
}

/** Dispatch to the renderer for `mode`. Both read the SAME BGRA buffer. */
export function renderFrame(t: CharTerm, src: Uint8Array, mode: RenderMode, L: DownscaleLut): void {
  if (mode === "half") renderHalfBlock(t, src, L);
  else renderAscii(t, src, L);
}
