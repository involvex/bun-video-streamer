import { describe, expect, test } from "bun:test";
import {
  browserCandidates,
  buildBrowserSpec,
  cookieDumpHint,
  defaultProfileDir,
  toNetscapeJar,
} from "../scripts/export-cookies";

describe("buildBrowserSpec", () => {
  test("plain browser passes through", () => {
    expect(buildBrowserSpec("chrome", "")).toBe("chrome");
    expect(buildBrowserSpec("edge", "")).toBe("edge");
  });

  test("profile appends with a colon", () => {
    expect(buildBrowserSpec("chrome", "Default")).toBe("chrome:Default");
  });

  test("embedded profile wins over --profile", () => {
    expect(buildBrowserSpec("chrome:Profile 1", "Default")).toBe("chrome:Profile 1");
  });

  test("blank browser stays blank", () => {
    expect(buildBrowserSpec("", "Default")).toBe("");
    expect(buildBrowserSpec("   ", "")).toBe("");
  });
});

describe("toNetscapeJar", () => {
  test("header plus one TAB-separated row per cookie", () => {
    const jar = toNetscapeJar([
      {
        name: "session",
        value: "abc",
        domain: ".chaturbate.com",
        path: "/",
        secure: true,
        expires: 1893456000,
      },
    ]);
    const lines = jar.split("\n");
    expect(lines[0]).toBe("# Netscape HTTP Cookie File");
    expect(lines[1]).toBe(".chaturbate.com\tTRUE\t/\tTRUE\t1893456000\tsession\tabc");
  });

  test("host-only domains get FALSE and session cookies get expiry 0", () => {
    const jar = toNetscapeJar([
      {
        name: "s",
        value: "v",
        domain: "example.com",
        path: "",
        secure: false,
        expires: -1,
      },
    ]);
    expect(jar).toContain("example.com\tFALSE\t/\tFALSE\t0\ts\tv");
  });

  test("empty names are dropped and rows sort by domain/path/name", () => {
    const jar = toNetscapeJar([
      {
        name: "b",
        value: "2",
        domain: ".stripchat.com",
        path: "/",
        secure: true,
        expires: 10,
      },
      {
        name: "",
        value: "junk",
        domain: ".stripchat.com",
        path: "/",
        secure: true,
        expires: 10,
      },
      {
        name: "a",
        value: "1",
        domain: ".chaturbate.com",
        path: "/",
        secure: false,
        expires: 10,
      },
    ]);
    const rows = jar.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.startsWith(".chaturbate.com")).toBe(true);
    expect(rows[1]!.startsWith(".stripchat.com")).toBe(true);
  });

  test("empty input is just the header", () => {
    expect(toNetscapeJar([])).toBe("# Netscape HTTP Cookie File\n");
  });
});

describe("browserCandidates", () => {
  test("edge scans msedge.exe install locations first", () => {
    const list = browserCandidates("edge");
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]!.toLowerCase()).toContain("msedge.exe");
    expect(list.some((p) => p.includes("Program Files (x86)"))).toBe(true);
  });

  test("chrome scans chrome.exe locations, edge only as fallback", () => {
    const list = browserCandidates("chrome");
    expect(list[0]!.toLowerCase()).toContain("chrome.exe");
    expect(list.some((p) => p.toLowerCase().includes("msedge.exe"))).toBe(true);
    expect(list.indexOf(list.find((p) => p.toLowerCase().includes("msedge.exe"))!)).toBeGreaterThan(
      0,
    );
  });

  test("empty browser defaults to chrome-first, edge included", () => {
    const list = browserCandidates("");
    expect(list[0]!.toLowerCase()).toContain("chrome.exe");
    expect(list.some((p) => p.toLowerCase().includes("msedge.exe"))).toBe(true);
  });

  test("embedded profile does not change the flavour scan", () => {
    expect(browserCandidates("edge:Default")).toEqual(browserCandidates("edge"));
  });
});

describe("defaultProfileDir", () => {
  test("edge gets its own automation profile", () => {
    expect(defaultProfileDir("edge")).toBe("out/edge-profile");
    expect(defaultProfileDir("chrome")).toBe("out/chrome-profile");
    expect(defaultProfileDir("")).toBe("out/chrome-profile");
  });
});

describe("cookieDumpHint", () => {
  test("DPAPI failure points at cdp and firefox", () => {
    const hint = cookieDumpHint("ERROR: Failed to decrypt with DPAPI. See yt-dlp#10927");
    expect(hint).toContain("--via cdp");
    expect(hint).toContain("firefox");
  });

  test("locked cookie database points at closing the browser or cdp", () => {
    const hint = cookieDumpHint("ERROR: Could not copy Chrome cookie database. See yt-dlp#7271");
    expect(hint).toContain("--via cdp");
    expect(hint).toMatch(/close/i);
  });

  test("unknown errors get no hint suffix", () => {
    expect(cookieDumpHint("ERROR: something else broke")).toBe("");
  });
});
