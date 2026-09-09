import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Chromium launch flags optimized for WebGL, Canvas 2D, and hardware acceleration.
 */
export function getDefaultChromiumArgs(headless = true): string[] {
  const flags = [
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    "--enable-zero-copy",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-infobars",
    // Figma sits behind a CDN that drops requests carrying the automation signature this
    // flag removes. Masking navigator.webdriver from inside the page is not enough on its
    // own: the give-away is present before any document script runs.
    "--disable-blink-features=AutomationControlled",
  ];

  if (headless) {
    flags.push(
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding"
    );
  }

  return flags;
}

/**
 * Automatically detects the installed path of Google Chrome or Microsoft Edge.
 */
export function findSystemBrowserPath(): string | undefined {
  // An explicit override wins over discovery. A container that ships one browser on purpose
  // says so this way, and honouring it turns "the guess happened to be right" into a
  // guarantee -- the image sets it precisely so a second Chromium is never downloaded.
  const override = process.env["PUPPETEER_EXECUTABLE_PATH"];
  if (override && fs.existsSync(override)) return override;

  const platform = os.platform();

  if (platform === "win32") {
    const candidates = [
      // Chrome
      path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env["LOCALAPPDATA"] || "C:\\Users\\Default\\AppData\\Local", "Google\\Chrome\\Application\\chrome.exe"),
      // Edge
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
      path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
      path.join(process.env["LOCALAPPDATA"] || "C:\\Users\\Default\\AppData\\Local", "Microsoft\\Edge\\Application\\msedge.exe"),
    ];

    for (const exe of candidates) {
      if (fs.existsSync(exe)) {
        return exe;
      }
    }
  } else if (platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    for (const exe of candidates) {
      if (fs.existsSync(exe)) {
        return exe;
      }
    }
  } else {
    // Linux
    const candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge-stable",
    ];
    for (const exe of candidates) {
      if (fs.existsSync(exe)) {
        return exe;
      }
    }
  }

  return undefined;
}