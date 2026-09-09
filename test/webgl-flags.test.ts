import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { getDefaultChromiumArgs, findSystemBrowserPath } from "../src/browser/webgl-flags.js";

describe("WebGL & Browser Flags", () => {
  it("should provide essential WebGL and GPU acceleration flags", () => {
    const args = getDefaultChromiumArgs(true);

    expect(args).toContain("--enable-webgl");
    expect(args).toContain("--ignore-gpu-blocklist");
    expect(args).toContain("--enable-gpu-rasterization");
    expect(args).toContain("--hide-scrollbars");
  });

  it("should omit headless flags when headless=false", () => {
    const args = getDefaultChromiumArgs(false);
    expect(args).not.toContain("--hide-scrollbars");
    expect(args).toContain("--enable-webgl");
  });

  it("should not fight puppeteer over the window size or headless switch", () => {
    // puppeteer supplies --headless itself, and --window-size overrides defaultViewport.
    const args = getDefaultChromiumArgs(true);
    expect(args.some((a) => a.startsWith("--window-size"))).toBe(false);
    expect(args).not.toContain("--headless=new");
  });

  it("should find system browser or return undefined without crashing", () => {
    const browserPath = findSystemBrowserPath();
    expect(browserPath === undefined || typeof browserPath === "string").toBe(true);
  });
});
describe("findSystemBrowserPath", () => {
  const saved = process.env.PUPPETEER_EXECUTABLE_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = saved;
  });

  it("uses PUPPETEER_EXECUTABLE_PATH when it points at a real file", () => {
    // The env var names a browser; any existing file proves the branch is taken.
    process.env.PUPPETEER_EXECUTABLE_PATH = fileURLToPath(import.meta.url);
    expect(findSystemBrowserPath()).toBe(fileURLToPath(import.meta.url));
  });

  it("falls back to discovery when the override points at nothing", () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = "/nonexistent/chromium-that-is-not-there";
    expect(findSystemBrowserPath()).not.toBe("/nonexistent/chromium-that-is-not-there");
  });
});
