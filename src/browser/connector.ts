import puppeteer, { type Browser, type LaunchOptions, type Page } from "puppeteer-core";
import { getDefaultChromiumArgs, findSystemBrowserPath } from "./webgl-flags.js";

export interface BrowserConnectOptions {
  /**
   * If provided, attempts to connect to an existing running Chrome instance via CDP.
   * Default port is 9222 if set to true.
   */
  cdpUrl?: string | number;

  /**
   * Custom path to Chrome or Edge executable. If omitted, auto-discovers system browser.
   */
  executablePath?: string;

  /**
   * Run in headless mode or show visible UI.
   * Default: true.
   */
  headless?: boolean;

  /**
   * Path to persistent user data directory to retain cookies and logins.
   */
  userDataDir?: string;

  /**
   * Default viewport width and height.
   */
  viewport?: { width: number; height: number; deviceScaleFactor?: number };

  /**
   * How long a single CDP call may take. Puppeteer's 180s default is not enough to read a
   * Figma page holding several hundred frames, which fails as a bare protocol timeout.
   */
  protocolTimeout?: number;
}

export interface BrowserContextSession {
  browser: Browser;
  page: Page;
  isAttached: boolean;
  close: () => Promise<void>;
}

const REAL_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/**
 * Prepares the page with anti-detection headers and browser fingerprinting masking.
 */
async function setupStealthPage(page: Page): Promise<void> {
  await page.setUserAgent(REAL_USER_AGENT);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
}

/**
 * Connects to an existing Chrome browser via CDP or launches a new browser instance.
 */
export async function getBrowserSession(options: BrowserConnectOptions = {}): Promise<BrowserContextSession> {
  const {
    cdpUrl,
    executablePath = findSystemBrowserPath(),
    headless = true,
    userDataDir,
    viewport = { width: 1920, height: 1080, deviceScaleFactor: 2 },
    protocolTimeout = 600000,
  } = options;

  // 1. Try attaching to existing browser if cdpUrl is specified
  if (cdpUrl) {
    const port = typeof cdpUrl === "string" && cdpUrl.startsWith("http") ? 9222 : Number(cdpUrl) || 9222;
    const browserURL = typeof cdpUrl === "string" && cdpUrl.startsWith("http")
      ? cdpUrl
      : `http://127.0.0.1:${port}`;

    try {
      const browser = await puppeteer.connect({ browserURL, protocolTimeout });

      // Always work in our own tab: reusing pages[0] would navigate and resize
      // whatever the user happens to have open.
      const page = await browser.newPage();

      if (viewport) {
        await page.setViewport(viewport);
      }
      await setupStealthPage(page);

      return {
        browser,
        page,
        isAttached: true,
        close: async () => {
          await page.close().catch(() => {});
          await browser.disconnect();
        },
      };
    } catch (err: any) {
      throw new Error(`Failed to attach to browser at ${browserURL}: ${err.message}. Is Chrome running with --remote-debugging-port=${port}?`);
    }
  }

  // 2. Launch new browser instance
  if (!executablePath) {
    throw new Error(
      "No Chrome/Edge executable found on this system. Please install Google Chrome, or specify options.executablePath."
    );
  }

  const launchArgs = getDefaultChromiumArgs(headless);

  const launchOpts: LaunchOptions = {
    executablePath,
    headless,
    args: launchArgs,
    userDataDir,
    defaultViewport: viewport,
    protocolTimeout,
  };

  const browser = await puppeteer.launch(launchOpts);
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  await setupStealthPage(page);

  return {
    browser,
    page,
    isAttached: false,
    close: async () => {
      await browser.close();
    },
  };
}