# bun-video-stream

Two terminal video players over Bun FFI on Windows:

| Entry           | Input                 | Decode path                          |
| --------------- | --------------------- | ------------------------------------ |
| `src/video.ts`  | local, seekable files | Media Foundation (`IMFSourceReader`) |
| `src/stream.ts` | live streams / URLs   | ffmpeg → raw BGRA pipe               |

They share the same renderer (`src/lib/render.ts`), so anything that renders on one
renders on the other.

## Run

```bash
bun install

# local file (Media Foundation)
bun run video I:\path\to\clip.mp4

# live stream (resolved with yt-dlp, decoded by ffmpeg)
bun run stream twitch.tv/aidamoodi
bun run stream chaturbate/someone
bun run stream https://example.com/live/index.m3u8     # direct URL, skips yt-dlp
```

## Dev commands

```bash
bun run typecheck     # tsc --noEmit
bun test              # unit tests (frame reassembly + ffmpeg argv)
bun run format        # prettier
bun run format:check
```

> `tsc` reports ~191 errors inside `node_modules/@bun-win32/*`. Those packages ship
> `.ts` sources so `skipLibCheck` cannot suppress them. **Only `src/` and `test/` must
> be clean** — check with
> `bunx tsc --noEmit | Select-String "error TS" | Where-Object { $_ -notmatch 'node_modules' }`.

## Prerequisites

- **ffmpeg** on `PATH` — required for `stream.ts` only.
- **yt-dlp** on `PATH` — required unless the target is a direct media URL.
- Windows 10/11. The terminal engine is Win32-console specific.

## Architecture

```
stream.ts ──┬─ lib/resolve.ts    yt-dlp -g  → 1 or 2 URLs (+ offline polling, cookies)
            ├─ lib/media.ts      ffmpeg argv builders + MediaClient (worker lifecycle)
            │      └─ workers/media.ts   owns both ffmpeg children, on a Worker thread
            │           ├─ ffmpeg -f rawvideo -pix_fmt bgra  → frame pipe   (video URL)
            │           └─ ffmpeg -f s16le -ac 2 -ar 48000   → PCM pipe     (audio URL)
            │      └─ lib/reassemble.ts   arbitrary chunks → fixed-size frames
            ├─ lib/render.ts     LUT + half-block/ASCII → CharTerm
            └─ lib/waveout.ts    winmm waveOut ring
```

`lib/render.ts` and `lib/waveout.ts` are shared by both entry points.

## Why ffmpeg for streams

`MFCreateSourceReaderFromURL` needs a **seekable, complete local file**. Live streams
are HLS, which Media Foundation cannot demux without a hand-written
`IMFMediaSource`/`IMFByteStream` COM source resolver.

Piping into `video.ts` is not an option either:

- `yt-dlp -o file.mp4` writes a _file_, not stdout, so `|` has no source.
- `video.ts` would just re-open the path; nothing reads a pipe, and MF cannot consume
  an OS pipe or a named pipe.
- A "growing file" also fails: `decodeNextFrame()` maps `MF_SOURCE_READERF_ENDOFSTREAM`
  to `SetCurrentPosition(0)` — "loop the clip". On a live stream that is a hot spin-loop
  re-reading a zero-length file.

So ffmpeg becomes the transport, demuxer, decoder and scaler.

## The byte-order trick (important)

`ffmpeg -pix_fmt bgra` is byte-identical to Media Foundation's `MFVideoFormat_RGB32`
(B, G, R, A). That is the _only_ reason one renderer serves both paths unchanged:

```ts
fgRGB[0] = src[to + 2]; // R
fgRGB[1] = src[to + 1]; // G
fgRGB[2] = src[to]; // B
```

**Never switch to `rgb24`** — it silently swaps red and blue. Verified byte-for-byte
across a full frame; `test/media.test.ts` guards the flag.

## Gotchas that cost real debugging time

1. **Pipe reads are NOT frame-aligned.** Measured: 300 frames arrived across 2461 reads.
   A frame routinely straddles several reads and several frames arrive in one read.
   `lib/reassemble.ts` exists solely for this; assuming one-read-one-frame yields a
   picture that scrolls diagonally.
2. **Never transfer the reassembler's accumulator.** A transferred `ArrayBuffer` is
   detached and can never be refilled. The worker keeps one reusable `held` buffer and
   posts a copy.
3. **HLS arrives in bursts.** A single read delivered 200 frames in 487 ms. Posting
   straight from the read loop measured ~5 fps. The worker instead holds the freshest
   frame and releases it on a timer, which converts bursts into a steady cadence
   (~28 fps measured).
4. **ffmpeg input options must precede `-i`.** `-live_start_index`, `-reconnect*`,
   `-fflags`, `-analyzeduration`, `-probesize` are all INPUT options.
5. **`-live_start_index*` and `-reconnect*` break progressive inputs.** ffmpeg hard-fails
   with "Option live_start_index not found" on a plain MP4. `buildVideoArgs` only emits
   them when `live` is set.
6. **`-live_start_index_max` does not exist** in current ffmpeg (verified:
   "Unrecognized option"). Only `-live_start_index` is used.
7. **Do not rate-limit with `-fps_mode drop`.** It is an _encoder_ option and the
   `rawvideo` muxer has no encoder, so ffmpeg rejects it ("Invalid value drop
   specified for fps_mode"). A bare `-r` on a muxer sets timing metadata without
   dropping frames. The worker owns rate control.
8. **`CAPTURE_PNG` cannot verify a live stream.** The engine captures the _first_ frame
   and exits (measured: ~0 ms). That is fine for `video.ts`, where Media Foundation has
   already decoded, but a stream needs ~9 s of CDN buffering, so `CAPTURE_PNG` always
   yields a black grid. Use `--selftest` instead — it waits for a real frame, renders it
   to an off-screen `CharTerm` and writes a PNG.
9. **winmm buffers are not worker-safe.** `lib/waveout.ts` keeps every buffer the driver
   may touch at module scope (a GC'd buffer mid-playback segfaults). PCM must cross the
   worker boundary as a message and be written on the main thread.
10. **Twitch playlist URLs are single-use.** Re-resolve with yt-dlp on every reconnect;
    never cache the URL.
11. **Not every site muxes audio into the video URL.** Chaturbate lists video and audio as
    SEPARATE formats, so `yt-dlp -g` prints **two** URLs and the worker needs two ffmpeg
    inputs. `resolveStreamSources` returns `StreamSources` (plural) for this reason — do
    not "simplify" it back to a single URL string. The audio ffmpeg takes
    `audioUrl ?? url`.
12. **`best[...]` does NOT mean "best available".** It means "best format containing BOTH
    video and audio". On Chaturbate it matches nothing and yt-dlp answers `Requested
format is not available` for a model who is live. The selector is a three-arm
    fallback chain ending in `bestvideo[height<=720]+bestaudio`; `test/resolve.test.ts`
    guards the shape.
13. **Cookies are for yt-dlp only, and the jar is Netscape format.** Chaturbate's
    extractor calls an authenticated API, so without `--cookies` it reports a live model
    as unavailable. The resolved CDN URLs carry their own `?session=` token, so ffmpeg
    needs nothing. Do NOT pass the jar to ffmpeg's `-cookies`: that option takes
    newline-delimited `Set-Cookie` header **values**, not a file, so a path there is
    silently ignored.

## A/V sync is deliberately absent for streams

`video.ts` paces video against the waveOut byte clock, because a file's audio and video
share a timeline. A live stream has no such timeline: the video inherently trails the
audio by the CDN's buffering delay. Copying the catch-up loop into `stream.ts` would
spin forever against a clock it can never catch. Both are paced independently and the
overlay reports the measured latency instead of hiding it.

## Measured numbers (Twitch, 480×270 BGRA)

| Metric                      | Value                                              |
| --------------------------- | -------------------------------------------------- |
| Time to first frame         | ~9.4 s (CDN-bound; probe flags made no difference) |
| Steady frame rate           | ~28 fps                                            |
| ffmpeg pipe read throughput | 195 fps / 96.6 MB/s (Bun)                          |
| Frame size                  | exactly `width * height * 4`                       |

Startup latency is dominated by Twitch's ingest→CDN propagation. It is **not** ffmpeg
buffering: `-analyzeduration`/`-probesize` variants from 500 KB to uncapped all
measured ~9.4 s.

## CLI

```
stream <url|chaturbate/<model>|twitch.tv/<channel>>
  -s, --size WxH     capture/decode size (default 480x270)
      --fit          size to exactly the terminal grid
      --fps N        render frame rate (default 30)
      --no-audio     video only
      --cookies P    Netscape cookie jar for yt-dlp (age-gated/private rooms)
      --list         list yt-dlp formats and exit
      --no-yt-dlp    treat the target as a direct media URL
      --selftest P   headless: wait for a frame, render PNG to P, exit
      --wait S       seconds to wait for the first frame in --selftest
  -q, --quiet
```

| Key       | Action                 |
| --------- | ---------------------- |
| SPACE     | pause / resume         |
| m         | half-block ⇄ ASCII     |
| r         | reconnect now          |
| a         | mute / unmute          |
| `+` / `-` | volume                 |
| `[` / `]` | capture size down / up |
| s         | save a PNG screenshot  |
| ESC / q   | quit                   |

## Env knobs

| Var                       | Meaning                                                   |
| ------------------------- | --------------------------------------------------------- |
| `VIDEO_MODE=ascii`        | start in ASCII instead of half-block                      |
| `VIDEO_OVERLAY=1`         | keep the overlay always visible (it auto-hides after 2 s) |
| `STREAM_DEBUG=1`          | trace the render loop / worker handshake on stderr        |
| `TERM_COLS` / `TERM_ROWS` | grid size (also used by `--selftest`)                     |

## Verification

```bash
bun test
bun run typecheck

# local file regression — byte-identical PNG to the pre-refactor baseline
TERM_COLS=120 TERM_ROWS=30 CAPTURE_T=1 CAPTURE_PNG=half.png bun run video clip.mp4
VIDEO_MODE=ascii CAPTURE_PNG=ascii.png bun run video clip.mp4

# live pipeline, no TTY needed (muxed source: Twitch)
bun run stream twitch.tv/aidamoodi --selftest live.png --wait 40

# split video+audio manifests, behind a cookie jar (Chaturbate)
bun run stream chaturbate/iren_wagner --cookies out/cookies.txt \
  --selftest cb.png --wait 40
```

`--selftest` exits non-zero if no frame arrives or the rendered grid is entirely black,
so it works as a CI smoke test. It reports audio separately:

```
stream_selftest OK png=cb.png 160x40 bytes=518400 expected=518400 frameAt=680ms nonBlack=true
stream_selftest audio OK pcmBytes=917504 split=yes
```

`split=yes` means the two-manifest path ran (Chaturbate); `split=no` means one muxed URL
(Twitch). Audio is reported, not enforced — exit status stays keyed on the picture, so a
stream with genuinely no audio track does not fail a video smoke test.

> **On verifying no orphan ffmpeg:** `tasklist /FI "IMAGENAME eq ffmpeg.exe"` can report
> "no tasks" for processes that are demonstrably alive, and Bun's `subprocess.kill()`
> does not promptly stop ffmpeg (it may linger until it finishes). Use
> `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'"`, check `.ParentProcessId`
> against your bun PID, and allow a grace period — a naive check produces false
> "0 orphans" _and_ false leaks.
