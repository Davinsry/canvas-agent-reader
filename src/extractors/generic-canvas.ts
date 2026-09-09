import fs from "node:fs";
import path from "node:path";
import type { BrowserConnectOptions } from "../browser/connector.js";
import { getBrowserSession } from "../browser/connector.js";

export interface CanvasInspectOptions extends BrowserConnectOptions {
  url: string;
  canvasSelector?: string;
  outputPath?: string;
  saveScreenshot?: boolean;
  timeoutMs?: number;
  waitForSelector?: string;

  /** Return the PNG inline as base64 as well as writing it to disk. Default false. */
  includeBase64?: boolean;
}

export interface CanvasInfo {
  index: number;
  selector?: string;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  contextType?: string;
  id?: string;
  className?: string;
}

export interface GenericCanvasInspectionResult {
  status: "success" | "no_canvas_found" | "error";
  url: string;
  pageTitle: string;
  canvases: CanvasInfo[];
  selectedCanvas?: CanvasInfo;
  screenshotBase64?: string;
  screenshotPath?: string;
  message?: string;
}

/**
 * Inspects any WebGL or HTML5 Canvas page, detecting canvas elements, contexts,
 * and capturing visual output.
 */
export async function inspectGenericCanvas(options: CanvasInspectOptions): Promise<GenericCanvasInspectionResult> {
  const {
    url,
    canvasSelector = "canvas",
    outputPath,
    saveScreenshot = true,
    timeoutMs = 30000,
    waitForSelector,
    includeBase64 = false,
    ...connectOptions
  } = options;

  const session = await getBrowserSession(connectOptions);

  try {
    const page = session.page;

    // Record the context type each canvas actually asks for. Probing with getContext()
    // afterwards would *create* a context on unused canvases and break the page's own
    // later getContext() call, which returns null for a mismatched type.
    await page.evaluateOnNewDocument(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      const seen = new WeakMap<HTMLCanvasElement, string>();
      (window as any).__canvasContextTypes = seen;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: any, ...rest: any[]) {
        const ctx = (original as any).call(this, type, ...rest);
        if (ctx && !seen.has(this)) seen.set(this, String(type));
        return ctx;
      } as typeof HTMLCanvasElement.prototype.getContext;
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: timeoutMs });

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 10000 }).catch(() => {});
    }

    const pageTitle = await page.title();

    // Query all canvas elements on the page
    const canvases: CanvasInfo[] = await page.evaluate(() => {
      const seen = (window as any).__canvasContextTypes as WeakMap<HTMLCanvasElement, string> | undefined;
      const elements = Array.from(document.querySelectorAll("canvas"));
      return elements.map((canvas, index) => {
        const contextType = seen?.get(canvas) || "unknown";

        return {
          index,
          id: canvas.id || undefined,
          className: canvas.className || undefined,
          width: canvas.width,
          height: canvas.height,
          clientWidth: canvas.clientWidth,
          clientHeight: canvas.clientHeight,
          contextType,
        };
      });
    });

    if (canvases.length === 0) {
      return {
        status: "no_canvas_found",
        url,
        pageTitle,
        canvases: [],
        message: "No <canvas> elements were detected on this page.",
      };
    }

    // Pick target canvas
    const targetElement = await page.$(canvasSelector);
    if (!targetElement) {
      return {
        status: "no_canvas_found",
        url,
        pageTitle,
        canvases,
        message: `Canvas matching selector '${canvasSelector}' was not found.`,
      };
    }

    const selectedIndex = await page.evaluate(
      (el) => Array.from(document.querySelectorAll("canvas")).indexOf(el as HTMLCanvasElement),
      targetElement
    );

    const rawBytes = await targetElement.screenshot({ type: "png" });
    const buffer = Buffer.from(rawBytes);

    let savedPath: string | undefined;
    if (saveScreenshot) {
      const destDir = outputPath ? path.dirname(outputPath) : path.join(process.cwd(), "output");
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      const safeName = (url.split("/").pop() || "page").replace(/[^a-zA-Z0-9_-]/g, "_");
      savedPath = outputPath || path.join(destDir, `canvas-${safeName}-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(savedPath), { recursive: true });
      fs.writeFileSync(savedPath, buffer);
    }

    return {
      status: "success",
      url,
      pageTitle,
      canvases,
      selectedCanvas: canvases[selectedIndex] ?? canvases[0],
      screenshotPath: savedPath,
      ...(includeBase64 ? { screenshotBase64: buffer.toString("base64") } : {}),
    };
  } catch (error: any) {
    return {
      status: "error",
      url,
      pageTitle: "",
      canvases: [],
      message: error.message || String(error),
    };
  } finally {
    // Safe for attached sessions too: close() only closes the tab we opened, then disconnects.
    await session.close();
  }
}