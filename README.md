# bun-video-stream

Terminal video players for Windows over Bun FFI — one for local files, one for live
streams. See [AGENTS.md](./AGENTS.md) for architecture, CLI, keys and gotchas.

```bash
bun install

bun run video I:\path\to\clip.mp4      # local file, Media Foundation
bun run stream twitch.tv/aidamoodi     # live stream, ffmpeg
bun run stream chaturbate/someone
bun run stream chaturbate/someone --cookies out/cookies.txt
```

Requires **ffmpeg** on `PATH` for `stream.ts` (and **yt-dlp** unless the target is a
direct media URL).

## Cookies

Some rooms need a logged-in session. Pass a Netscape `cookies.txt` (the format Chrome's
"Get cookies" extensions export) and it is forwarded to yt-dlp as `--cookies`:

```bash
bun run stream chaturbate/iren_wagner --cookies out/cookies.txt
```

Without it, Chaturbate's extractor hits an authenticated API and reports a model who is
**live** as `Requested format is not available`. The jar is only handed to yt-dlp — the
CDN URLs it returns carry their own `?session=` token, so ffmpeg fetches them fine
without cookies.

```bash
bun test           # unit tests
bun run typecheck
bun run format
```
