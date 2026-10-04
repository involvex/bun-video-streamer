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
bun run cookies --browser firefox --out out/cookies.txt   # yt-dlp reads the store itself
```

Chrome 127+ (incl. your Chrome 154) encrypts its store so yt-dlp answers
`Failed to decrypt with DPAPI` (yt-dlp#10927), and Edge dumps fail with
`Could not copy Chrome cookie database` while the browser is running
(yt-dlp#7271). For either, keep one persistent automation profile and
export over CDP instead — log in once, headed, then
re-export headless any time (`--browser` picks the flavour to launch):

```bash
bun run cookies --browser chrome --out out/cookies.txt --via cdp \
  --url https://chaturbate.com/ --url https://stripchat.com/ --login
bun run cookies --browser chrome --out out/cookies.txt --via cdp   # re-export later
bun run cookies --browser edge --out out/cookies.txt --via cdp \
  --url https://chaturbate.com/ --url https://stripchat.com/ --login
```

Or skip the file and let yt-dlp read the browser directly
(same Chrome limitation applies):

```bash
bun run stream chaturbate/iren_wagner --cookies-from-browser firefox
```

```bash
bun test           # unit tests
bun run typecheck
bun run format
```
