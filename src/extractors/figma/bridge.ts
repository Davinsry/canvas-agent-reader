import type { Page } from "puppeteer-core";

export interface FigmaPageStatus {
  isLoaded: boolean;
  requiresLogin: boolean;
  title: string;
  hasCanvas: boolean;
  canvasDimensions?: { width: number; height: number };
  detectedFrames?: string[];
  devModeDetected?: boolean;
}

/**
 * Checks the status of the Figma web application and inspects whether it is ready for extraction.
 */
export async function inspectFigmaPageStatus(page: Page): Promise<FigmaPageStatus> {
  return await page.evaluate(() => {
    const title = document.title;
    const bodyText = document.body.innerText || "";

    // Check for login wall indicators (only if progress bar cover is gone)
    const hasLoginButton = !!document.querySelector("a[href*='login'], button[data-testid='login-button']");
    const hasGoogleAuth = !!document.querySelector("iframe[src*='accounts.google.com']");
    const hasLoginForm = !!document.querySelector("form[action*='login'], input[type='password']");
    const requiresLogin =
      hasLoginForm ||
      (title.toLowerCase().includes("log in") && !title.toLowerCase().includes("figma")) ||
      bodyText.includes("Create an account to view") ||
      (bodyText.includes("Log in to Figma") && hasLoginButton);

    // Check for canvas elements
    const canvas = document.querySelector("canvas");
    const hasCanvas = !!canvas;
    const canvasDimensions = canvas
      ? { width: canvas.clientWidth || canvas.width, height: canvas.clientHeight || canvas.height }
      : undefined;

    // Detect any visible frame names from layer list or headers
    const detectedFrames: string[] = [];
    const layerNodes = document.querySelectorAll(
      "[data-testid*='layer'], [role='treeitem'], span[class*='layer_row'], [class*='supporting_card'], [class*='title']"
    );
    layerNodes.forEach((node) => {
      const text = node.textContent?.trim();
      if (text && text.length > 1 && text.length < 60 && !detectedFrames.includes(text)) {
        detectedFrames.push(text);
      }
    });

    // Check if Dev Mode or inspect panel is present
    const devModeDetected = !!document.querySelector(
      "[data-testid='dev-mode-tab'], [data-testid='inspect-panel'], [class*='code_block']"
    );

    return {
      isLoaded: true,
      requiresLogin,
      title,
      hasCanvas,
      canvasDimensions,
      detectedFrames: detectedFrames.slice(0, 30),
      devModeDetected,
    };
  });
}

/**
 * Waits for the Figma canvas and WebAssembly engine to finish downloading, compiling, and rendering.
 */
export async function waitForFigmaCanvasReady(page: Page, timeoutMs = 60000): Promise<void> {
  // 1. Wait for canvas element to appear
  await page.waitForSelector("canvas", { timeout: timeoutMs });

  // 2. Wait for the initial progress bar cover to fade out or disappear
  try {
    await page.waitForFunction(
      () => {
        const cover = document.querySelector(
          '[class*="progressBarPageCover"], [class*="progress_bar--outer"], [class*="progressBarDesignV2"]'
        ) as HTMLElement | null;
        if (!cover) return true;
        const style = window.getComputedStyle(cover);
        return cover.clientWidth === 0 || style.display === "none" || style.opacity === "0" || style.visibility === "hidden";
      },
      { timeout: timeoutMs }
    );
  } catch {
    // If progress bar check times out, continue to allow fallback capture
  }

  // 3. Give WebGL render loop 3-4 seconds to stabilize and draw the scene nodes
  await new Promise((resolve) => setTimeout(resolve, 3500));

  // 4. Dismiss cookie consent banner and popups if present so they don't block the canvas
  await dismissFigmaOverlays(page);
}

/**
 * Dismisses cookie banners, popups, and modal dialogs that might overlay the canvas.
 */
export async function dismissFigmaOverlays(page: Page): Promise<void> {
  try {
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const closeButtons = Array.from(document.querySelectorAll("button, [role='button']"));
      for (const btn of closeButtons) {
        const text = btn.textContent?.toLowerCase() || "";
        const label = btn.getAttribute("aria-label")?.toLowerCase() || "";
        if (
          text.includes("accept") ||
          text.includes("agree") ||
          text.includes("opt out") ||
          label.includes("close") ||
          text === "x" ||
          label.includes("dismiss")
        ) {
          (btn as HTMLElement).click();
        }
      }
    });
  } catch {}
}

/**
 * Reads the current Figma canvas zoom percentage displayed in the UI.
 */
export async function getFigmaZoomPercent(page: Page): Promise<number | null> {
  try {
    return await page.evaluate(() => {
      // The zoom widget is a leaf element in the top toolbar. Restricting to that avoids
      // picking up an opacity or line-height field that also reads like "100%".
      const candidates = Array.from(document.querySelectorAll("*")).filter((e) => {
        if (e.children.length > 0) return false;
        if (!/^\d+%$/.test(e.textContent?.trim() || "")) return false;
        return e.getBoundingClientRect().top < 80;
      });
      if (candidates.length === 0) return null;

      // Figma puts it at the far right of the toolbar.
      const el = candidates.reduce((a, b) =>
        b.getBoundingClientRect().right > a.getBoundingClientRect().right ? b : a
      );
      const match = el.textContent?.trim().match(/^(\d+)%$/);
      return match ? parseInt(match[1], 10) : null;
    });
  } catch {
    return null;
  }
}

/**
 * Asks Figma to zoom to exactly 100% (1:1 design pixels) with its own shortcut (Shift+0).
 * If the zoom widget cannot be read (common in anonymous headless sessions), applies
 * targeted zoom stepping so the canvas renders at native Retina vector scale.
 */
export async function ensureFigmaZoom100(page: Page): Promise<number | null> {
  await dismissFigmaOverlays(page);

  // Focus the canvas surface so keyboard shortcuts reach Figma's WebGL engine
  try {
    const canvas = await page.$("canvas");
    if (canvas) {
      const box = await canvas.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
    }
  } catch {}

  // 1. Try Figma's native 100% shortcut: Shift + 0
  await page.keyboard.down("Shift");
  await page.keyboard.press("Digit0");
  await page.keyboard.up("Shift");
  await new Promise((r) => setTimeout(r, 600));

  let zoom = await getFigmaZoomPercent(page);
  if (zoom === 100) return 100;

  // 2. Fallback: In headless anonymous sessions where Shift+0 is ignored by Wasm,
  // step zoom in with Ctrl + Equal to avoid tiny zoomed-out canvas viewports
  if (zoom === null || zoom < 80) {
    for (let i = 0; i < 2; i++) {
      await page.keyboard.down("Control");
      await page.keyboard.press("Equal");
      await page.keyboard.up("Control");
      await new Promise((r) => setTimeout(r, 400));
    }
    zoom = await getFigmaZoomPercent(page);
  }

  return zoom;
}

/**
 * Smoothly pans the Figma WebGL canvas by simulating Space + Mouse Drag.
 * Necessary when an artboard flow or prototype sequence extends beyond the single viewport.
 */
export async function panFigmaCanvas(
  page: Page,
  dx: number,
  dy = 0,
  viewport: { width: number; height: number } = { width: 1920, height: 1080 }
): Promise<void> {
  const stepSize = 800;
  let remainingX = dx;
  let remainingY = dy;
  const centerX = Math.floor(viewport.width / 2);
  const centerY = Math.floor(viewport.height / 2);

  while (Math.abs(remainingX) > 0 || Math.abs(remainingY) > 0) {
    const curDx = Math.sign(remainingX) * Math.min(Math.abs(remainingX), stepSize);
    const curDy = Math.sign(remainingY) * Math.min(Math.abs(remainingY), stepSize);
    const startX = centerX - Math.floor(curDx / 2);
    const startY = centerY - Math.floor(curDy / 2);
    const endX = startX + curDx;
    const endY = startY + curDy;

    await page.keyboard.down("Space");
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    await new Promise((r) => setTimeout(r, 250));

    remainingX -= curDx;
    remainingY -= curDy;
  }
}

/**
 * Hides Figma's own interface so a canvas capture contains only the design surface.
 *
 * The toolbar, layers panel, cookie banner and sign-up prompt are DOM layers painted over
 * the canvas, so an element screenshot composites them into the PNG - and a full-width
 * banner also destroys card detection by filling every column with content. Every sibling
 * along the canvas' ancestor chain is exactly the set of those layers.
 *
 * Uses visibility rather than display so the canvas keeps its size and needs no re-render.
 */
export async function hideFigmaChrome(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll("canvas"));
    let canvas: HTMLCanvasElement | null = null;
    let bestArea = 0;
    for (const c of canvases) {
      const rect = c.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        canvas = c;
      }
    }
    if (!canvas) return 0;

    let hidden = 0;
    let el: HTMLElement | null = canvas;
    while (el && el !== document.body) {
      const parent: HTMLElement | null = el.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children) as Element[]) {
        if (sibling === el || !(sibling instanceof HTMLElement)) continue;
        if (sibling.style.visibility === "hidden") continue;
        sibling.style.visibility = "hidden";
        hidden++;
      }
      el = parent;
    }
    return hidden;
  });
}
