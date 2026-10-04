/**
 * export-cookies — persistent browser cookies → Netscape jar for yt-dlp.
 *
 *   bun scripts/export-cookies.ts --browser chrome --out out/cookies.txt --via cdp --login
 *   bun scripts/export-cookies.ts --browser firefox --out out/cookies.txt   (via yt-dlp)
 *
 * WHY THIS EXISTS: Chaturbate/Stripchat extractors call an authenticated API, so a
 * live room resolves as "Requested format is not available" without a session cookie.
 * Logging in once and reusing that profile is the persistent fix — no manual
 * extension copy-paste on every expiry.
 *
 * TWO ROUTES, because Chrome 127+ broke the obvious one:
 *
 *  --via ytdlp (default): yt-dlp reads the browser store itself
 *    (`--cookies-from-browser <spec> --cookies <out> --skip-download <url>`), per
 *    https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp
 *    Works for Firefox/older browsers. FAILS on current Chrome/Edge (v127+):
 *    App-Bound encryption means "Failed to decrypt with DPAPI"
 *    (yt-dlp issue #10927, still open). The jar then feeds the existing
 *    `stream --cookies <jar>` path — or skip the file and use
 *    `stream --cookies-from-browser <spec>` directly (same limitation applies).
 *
 *  --via cdp: launch system Chrome/Edge (--browser picks the flavour) against a DEDICATED
 *    (`--user-data-dir`, never your main profile — it would be locked anyway),
 *    log in once headed (`--login`), then read the PLAINTEXT cookies over CDP
 *    (`Network.getAllCookies`) and write the Netscape jar ourselves. Chrome
 *    decrypts its own store in memory, so App-Bound encryption is irrelevant.
 *    Zero new dependencies: fetch + WebSocket are Bun built-ins.
 *
 * NOTE: any jar contains cookies for ALL sites in that profile. Treat it like a
 * password: it is gitignored via `out/`, never logged, never pasted. This script
 * only ever prints the header line, line counts and domain HIT COUNTS — never
 * cookie names or values.
 */
import { resolve } from "node:path";

const USAGE = `
export-cookies — browser cookies → Netscape jar for yt-dlp

Usage:
  bun scripts/export-cookies.ts --browser SPEC --out FILE [--via ytdlp|cdp] [...]

ytdlp mode (default; broken on Chrome/Edge 127+ — see header):
  --browser SPEC   chrome, edge, brave, firefox, ... (a profile can be embedded: "chrome:Default")
  --profile P      profile name appended as ":P" (ignored if --browser has one)
  --url URL        page to resolve while dumping (default: skipped YouTube lookup)
  --check TARGET   after export, verify the jar resolves TARGET via yt-dlp -g
  --binary BIN     yt-dlp executable (default yt-dlp from PATH)

cdp mode (for current Chrome/Edge; dedicated automation profile):
  --profile-dir D  browser --user-data-dir (default out/chrome-profile,
                   out/edge-profile when --browser edge)
  --chrome EXE     explicit browser executable (default: auto-detect,
                   CHROME_PATH / EDGE_PATH win over the install scan)
  --browser B    chromium flavour to LAUNCH: chrome (default), edge, brave, ...
  --port N         remote-debugging port (default 19327)
  --url URL        page to visit before export, so its cookies exist (repeatable)
  --wait S         seconds to let pages settle before export (default 8)
  --login          headed: open the --url pages, wait for Enter (you log in), then export
  --check TARGET   same jar check as above

Examples:
  bun scripts/export-cookies.ts --browser firefox --out out/cookies.txt
  bun scripts/export-cookies.ts --browser chrome --out out/cookies.txt --via cdp \\
    --url https://chaturbate.com/ --url https://stripchat.com/ --login
  bun scripts/export-cookies.ts --browser chrome --out out/cookies.txt --via cdp --check chaturbate/iren_wagner
bun scripts/export-cookies.ts --browser edge --out out/cookies.txt --via cdp \\
  --url https://chaturbate.com/ --url https://stripchat.com/ --login
`;

interface Args {
  browser: string;
  profile: string;
  out: string;
  urls: string[];
  check: string;
  binary: string;
  via: string;
  profileDir: string;
  chrome: string;
  port: number;
  wait: number;
  login: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const o: Args = {
    browser: "",
    profile: "",
    out: "",
    urls: [],
    check: "",
    binary: "yt-dlp",
    via: "ytdlp",
    profileDir: "",
    chrome: "",
    port: 19327,
    wait: 8,
    login: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--browser") o.browser = argv[++i] ?? "";
    else if (a === "--profile") o.profile = argv[++i] ?? "";
    else if (a === "--out") o.out = argv[++i] ?? "";
    else if (a === "--url") o.urls.push(argv[++i] ?? "");
    else if (a === "--check") o.check = argv[++i] ?? "";
    else if (a === "--binary") o.binary = argv[++i] ?? "yt-dlp";
    else if (a === "--via") o.via = argv[++i] ?? "ytdlp";
    else if (a === "--profile-dir") o.profileDir = argv[++i] ?? o.profileDir;
    else if (a === "--chrome") o.chrome = argv[++i] ?? "";
    else if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--wait") o.wait = Number(argv[++i]);
    else if (a === "--login") o.login = true;
    else {
      process.stderr.write(`export-cookies: unknown option ${a}\n`);
      return null;
    }
  }
  return o;
}

/** `chrome` + profile `Default` → `chrome:Default`; embedded `:` wins over --profile. */
export function buildBrowserSpec(browser: string, profile: string): string {
  const b = browser.trim();
  const p = profile.trim();
  if (b === "") return "";
  if (p === "" || b.includes(":")) return b;
  return `${b}:${p}`;
}

function fail(msg: string): never {
  process.stderr.write(`export-cookies: ${msg}\n`);
  process.exit(1);
}

async function run(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// ── Netscape jar ─────────────────────────────────────────────────────────────

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  /** Seconds since epoch; -1/0 for session cookies. */
  expires: number;
}

/**
 * CDP cookies → Mozilla/Netscape jar. Pure, so it is unit-tested without a browser.
 * Sorted by (domain, path, name) for stable diffs; session cookies get expiry 0.
 */
export function toNetscapeJar(cookies: CdpCookie[]): string {
  const rows = [...cookies]
    .filter((c) => c.name !== "")
    .sort(
      (a, b) =>
        a.domain.localeCompare(b.domain) ||
        a.path.localeCompare(b.path) ||
        a.name.localeCompare(b.name),
    )
    .map((c) => {
      const sub = c.domain.startsWith(".") ? "TRUE" : "FALSE";
      const sec = c.secure ? "TRUE" : "FALSE";
      const exp = c.expires > 0 ? String(Math.floor(c.expires)) : "0";
      return `${c.domain}\t${sub}\t${c.path === "" ? "/" : c.path}\t${sec}\t${exp}\t${c.name}\t${c.value}`;
    });
  return `# Netscape HTTP Cookie File\n${rows.join("\n")}${rows.length > 0 ? "\n" : ""}`;
}

function jarStats(text: string): {
  count: number;
  chaturbate: number;
  stripchat: number;
} {
  const lines = text.split(/\r?\n/).filter((l) => l !== "" && !l.startsWith("#"));
  const hits = (d: string): number =>
    lines.filter((l) => (l.split("\t")[0] ?? "").toLowerCase().includes(d)).length;
  return {
    count: lines.length,
    chaturbate: hits("chaturbate"),
    stripchat: hits("stripchat"),
  };
}

// ── --via ytdlp ──────────────────────────────────────────────────────────────

/**
 * Human-readable follow-up for a failed `yt-dlp --cookies-from-browser` dump.
 * Pure, so the wording for each known failure is unit-tested.
 */
export function cookieDumpHint(stderr: string): string {
  if (/decrypt with DPAPI/i.test(stderr)) {
    return (
      " — Chrome/Edge 127+ use App-Bound encryption yt-dlp cannot read" +
      " (yt-dlp#10927). Use --via cdp with a dedicated profile, or --browser firefox."
    );
  }
  if (/could not copy .*cookie database/i.test(stderr)) {
    return (
      " — the browser's cookie store is locked (usually: the browser is still" +
      " running, see yt-dlp#7271). Close ALL browser windows and retry, or" +
      " sidestep it with --via cdp, which uses a dedicated profile instead."
    );
  }
  return "";
}

async function exportViaYtDlp(args: Args, spec: string): Promise<string> {
  // A URL is required to make yt-dlp run its extraction (which is what triggers the
  // jar dump). --skip-download keeps it cheap: no media is fetched.
  const url = args.urls[0] ?? "https://www.youtube.com/";
  if (args.urls.length === 0) {
    process.stderr.write("export-cookies: no --url given, dumping via a skipped YouTube lookup\n");
  }
  const dump = await run([
    args.binary,
    "--cookies-from-browser",
    spec,
    "--cookies",
    args.out,
    "--skip-download",
    "--no-playlist",
    "--no-warnings",
    url,
  ]);
  if (dump.exitCode !== 0) {
    const line = dump.stderr.split(/\r?\n/).find((l) => /ERROR/i.test(l)) ?? "";
    let hint = line.trim();
    hint += cookieDumpHint(dump.stderr);
    fail(`yt-dlp dump failed (exit ${dump.exitCode}): ${hint}`);
  }
  return args.out;
}

// ── --via cdp ────────────────────────────────────────────────────────────────

export function browserCandidates(browser: string): string[] {
  const flavour = browser.trim().toLowerCase().split(":")[0];
  const local = process.env.LOCALAPPDATA ?? "";
  const chrome = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${local}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  const edge = [
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    `${local}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ];
  const env = (name: string): string[] => {
    const v = (process.env[name] ?? "").trim();
    return v === "" ? [] : [v];
  };
  // Empty/unknown flavour scans Chrome first, then Edge — the common laptop
  // case is "whichever Chromium is installed".
  const list =
    flavour === "edge"
      ? [...env("EDGE_PATH"), ...edge, ...chrome]
      : [...env("CHROME_PATH"), ...env("EDGE_PATH"), ...chrome, ...edge];
  return list.filter((p) => p !== "" && !p.startsWith("\\"));
}

export function defaultProfileDir(browser: string): string {
  return browser.trim().toLowerCase().split(":")[0] === "edge"
    ? "out/edge-profile"
    : "out/chrome-profile";
}

async function resolveBrowserExe(browser: string, explicit: string): Promise<string> {
  if (explicit !== "") {
    if (await Bun.file(explicit).exists()) return explicit;
    fail(`browser executable not found at ${explicit}`);
  }
  for (const p of browserCandidates(browser)) {
    if (await Bun.file(p).exists()) return p;
  }
  const pathNames =
    browser.trim().toLowerCase().split(":")[0] === "edge"
      ? ["msedge", "chrome"]
      : ["chrome", "msedge"];
  for (const name of pathNames) {
    if (Bun.which(name) !== null) return name;
  }
  fail(
    `no ${browser.trim() === "" ? "Chrome/Edge" : browser} executable found` +
      ` (tried ${browserCandidates(browser).join(", ")}). Use --chrome <path>.`,
  );
}

async function waitForDebugger(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() >= deadline) fail(`chrome DevTools did not answer on port ${port}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

interface CdpTarget {
  id: string;
  webSocketDebuggerUrl: string;
}

async function newPage(port: number, url: string): Promise<CdpTarget> {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  if (!res.ok) fail(`could not open ${url} (HTTP ${res.status})`);
  return (await res.json()) as CdpTarget;
}

/** Open a WS to a page target, call Network.getAllCookies, return the cookies. */
function getAllCookies(wsUrl: string, timeoutMs: number): Promise<CdpCookie[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      reject(new Error("CDP getAllCookies timed out"));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Network.getAllCookies", params: {} }));
    });
    ws.addEventListener("message", (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // event notification, not our reply
      }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (msg.error !== undefined) reject(new Error(`CDP: ${msg.error.message ?? "unknown"}`));
      else resolve((msg.result?.cookies ?? []) as CdpCookie[]);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP websocket error"));
    });
  });
}

function killTree(proc: { pid?: number; kill: () => void }): void {
  // Chrome spawns children that outlive the parent; /T takes the whole tree on Windows.
  if (process.platform === "win32" && proc.pid !== undefined) {
    const killer = Bun.spawn(["taskkill", "/F", "/T", "/PID", String(proc.pid)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    void killer.exited.catch(() => {});
    return;
  }
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
}

async function exportViaCdp(args: Args): Promise<string> {
  const flavour = args.browser.trim().toLowerCase().split(":")[0];
  if (
    flavour !== "" &&
    flavour !== "chrome" &&
    flavour !== "chromium" &&
    flavour !== "edge" &&
    flavour !== "brave" &&
    flavour !== "vivaldi" &&
    flavour !== "opera"
  ) {
    fail(
      `--via cdp needs a Chromium browser, got --browser ${args.browser} (use --via ytdlp for firefox/safari)`,
    );
  }
  const exe = await resolveBrowserExe(args.browser, args.chrome.trim());
  const port = Number.isInteger(args.port) && args.port > 0 ? args.port : 19327;
  const waitS = Number.isFinite(args.wait) && args.wait >= 0 ? args.wait : 8;
  // Chrome resolves --user-data-dir against its own cwd, NOT ours — a relative path
  // makes it fail with "kann im folgenden Datenverzeichnis weder lesen noch schreiben".
  const profileDir = resolve(
    args.profileDir === "" ? defaultProfileDir(args.browser) : args.profileDir,
  );
  process.stderr.write(`export-cookies: launching ${exe} with profile ${profileDir}\n`);
  const chrome = Bun.spawn(
    [
      exe,
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      ...(args.login ? [] : ["--headless=new", "--disable-gpu"]),
      "about:blank",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  try {
    await waitForDebugger(port, 20_000);
    const pages = args.urls.length > 0 ? args.urls : ["about:blank"];
    const targets: CdpTarget[] = [];
    for (const url of pages) {
      if (url === "about:blank") continue;
      targets.push(await newPage(port, url));
    }
    if (args.login) {
      process.stderr.write(
        `export-cookies: headed chrome open — log in on ${pages.join(", ")}, then press Enter here\n`,
      );
      prompt("press Enter after logging in...");
    } else if (targets.length > 0) {
      await new Promise((r) => setTimeout(r, waitS * 1000));
    }
    // The first page sees every cookie in the profile; the rest are only there so
    // visiting them SETS the cookies. Dump from one session.
    let cookies: CdpCookie[] = [];
    if (targets.length > 0) {
      cookies = await getAllCookies(targets[0]!.webSocketDebuggerUrl, 15_000);
    } else {
      const list = (await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json()) as CdpTarget[];
      const page = list.find((t) => t.webSocketDebuggerUrl !== undefined);
      if (page === undefined) fail("no debuggable page found");
      cookies = await getAllCookies(page.webSocketDebuggerUrl, 15_000);
    }
    await Bun.write(args.out, toNetscapeJar(cookies));
    return args.out;
  } finally {
    killTree(chrome);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) process.exit(1);
  if (args.help || args.out === "" || (args.via !== "cdp" && args.browser === "")) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  if (args.via !== "ytdlp" && args.via !== "cdp")
    fail(`--via must be ytdlp or cdp, got ${args.via}`);

  const out =
    args.via === "cdp"
      ? await exportViaCdp(args)
      : await exportViaYtDlp(args, buildBrowserSpec(args.browser, args.profile));

  const jar = Bun.file(out);
  if (!(await jar.exists())) fail(`export succeeded but no jar at ${out}`);
  const text = await jar.text();
  const header = text.split(/\r?\n/)[0] ?? "";
  if (
    !header.startsWith("# HTTP Cookie File") &&
    !header.startsWith("# Netscape HTTP Cookie File")
  ) {
    fail(`jar at ${out} has an unexpected header: ${JSON.stringify(header)}`);
  }
  const s = jarStats(text);
  process.stderr.write(
    `export-cookies: OK ${out} cookies=${s.count} chaturbate=${s.chaturbate} stripchat=${s.stripchat}\n`,
  );

  if (args.check !== "") {
    const check = await run([
      "yt-dlp",
      "-g",
      "--no-playlist",
      "--no-warnings",
      "--cookies",
      out,
      "-f",
      "best[height<=720]/bestvideo[height<=720]+bestaudio/best",
      args.check,
    ]);
    if (check.exitCode !== 0) {
      const line = check.stderr.split(/\r?\n/).find((l) => /ERROR/i.test(l)) ?? "";
      fail(`jar check failed for ${args.check}: ${line.trim()}`);
    }
    const n = check.stdout.split(/\r?\n/).filter((l) => /^https?:\/\//i.test(l.trim())).length;
    process.stderr.write(`export-cookies: check OK ${args.check} urls=${n}\n`);
  }
}

if (import.meta.main) {
  await main();
}
