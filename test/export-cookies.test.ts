import { describe, expect, test } from "bun:test";
import { buildBrowserSpec, toNetscapeJar } from "../scripts/export-cookies";

describe("buildBrowserSpec", () => {
  test("plain browser passes through", () => {
    expect(buildBrowserSpec("chrome", "")).toBe("chrome");
    expect(buildBrowserSpec("edge", "")).toBe("edge");
  });

  test("profile appends with a colon", () => {
    expect(buildBrowserSpec("chrome", "Default")).toBe("chrome:Default");
  });

  test("embedded profile wins over --profile", () => {
    expect(buildBrowserSpec("chrome:Profile 1", "Default")).toBe(
      "chrome:Profile 1",
    );
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
    expect(lines[1]).toBe(
      ".chaturbate.com\tTRUE\t/\tTRUE\t1893456000\tsession\tabc",
    );
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
