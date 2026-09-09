import fs from "node:fs";
import path from "node:path";
import type { ElementHandle, Page } from "puppeteer-core";
import type { BrowserConnectOptions } from "../../browser/connector.js";
import { getBrowserSession } from "../../browser/connector.js";
import { parseFigmaUrl } from "./url-parser.js";
import { inspectFigmaPageStatus, waitForFigmaCanvasReady, ensureFigmaZoom100, hideFigmaChrome } from "./bridge.js";
import { extractAndSliceChildCards, countMismatch, type SlicedChildNode, type BoundingBox } from "./card-slicer.js";
import { parseSectionHierarchy, buildHierarchyDir } from "./section-parser.js";

export interface FigmaInspectOptions extends BrowserConnectOptions {
  url: string;
  outputPath?: string;
  saveScreenshot?: boolean;
  timeoutMs?: number;

  /**
   * Ask Figma to zoom to 100% (1:1 design pixels) before capturing. Default: true.
   * Best effort only - see ensureFigmaZoom100: a headless anonymous session never receives
   * the keystroke, so the capture is whatever zoom Figma opened the file at.
   */
  retinaZoom?: boolean;

  /**
   * Deterministically auto-splits child cards/sections from the target frame (0 AI).
   */
  splitChildren?: boolean;

  /**
   * Expected count of child cards (e.g. 5 or 7). If omitted, defaults to 1.
   */
  childrenCount?: number;

  /**
   * Layout direction for slicing: 'row' (horizontal), 'column' (vertical), or 'auto'.
   */
  childrenDirection?: "row" | "column" | "grid" | "auto";

  /**
   * Section name or prefix, e.g. "[Auth] Login" or "Auth".
   */
  sectionName?: string;

  /**
   * Sub-section name, e.g. "Registration" or "PasswordReset".
   */
  subSectionName?: string;

  /**
   * Explicit semantic names for child cards (e.g. ['UserProfile', 'AccountSettings']).
   */
  cardNames?: string[];

  /**
   * Base directory for output. Defaults to path.join(process.cwd(), "output").
   */
  baseOutputDir?: string;

  /**
   * Return PNG bytes as base64 alongside the file paths. Off by default: the deliverable
   * is the PNG files on disk, and a set of 4K captures is far too large to hand to an agent.
   */
  includeBase64?: boolean;
}

export interface FigmaNodeInspectionResult {
  status: "success" | "requires_auth" | "error";
  url: string;
  fileKey?: string;
  fileName?: string;
  nodeId?: string;
  screenshotBase64?: string;
  screenshotPath?: string;
  canvasDimensions?: { width: number; height: number };
  detectedFrames?: string[];
  children?: SlicedChildNode[];
  /** Set when the number of cards measured does not match childrenCount. */
  warning?: string;
  hierarchy?: {
    fileFolder: string;
    section?: string;
    subSection?: string;
    outputDir: string;
  };
  pageTitle?: string;
  message?: string;
}

/** Figma mounts several canvases; the design surface is simply the biggest one. */
async function findLargestCanvas(page: Page): Promise<ElementHandle<HTMLCanvasElement> | null> {
  const handles = (await page.$$("canvas")) as ElementHandle<HTMLCanvasElement>[];
  let best: ElementHandle<HTMLCanvasElement> | null = null;
  let bestArea = 0;

  for (const handle of handles) {
    const box = await handle.boundingBox();
    const area = box ? box.width * box.height : 0;
    if (area > bestArea) {
      bestArea = area;
      best = handle;
    }
  }

  return best;
}

/**
 * Inspects a Figma URL, navigates to the target frame/node, captures the WebGL canvas,
 * and extracts semantic, visual, and sliced child card details for an AI agent.
 */
export async function inspectFigmaNode(options: FigmaInspectOptions): Promise<FigmaNodeInspectionResult> {
  const {
    url,
    outputPath,
    saveScreenshot = true,
    timeoutMs = 30000,
    retinaZoom = true,
    splitChildren = false,
    childrenCount,
    childrenDirection = "auto",
    sectionName,
    subSectionName,
    cardNames,
    baseOutputDir,
    includeBase64 = false,
    ...connectOptions
  } = options;

  const parsed = parseFigmaUrl(url);
  if (!parsed.isValid) {
    return {
      status: "error",
      url,
      message: "Invalid Figma URL. Expected format: https://www.figma.com/design/:fileKey/:fileName?node-id=:nodeId",
    };
  }

  // Ensure high-DPI 4K viewport for Retina crispness
  if (!connectOptions.viewport) {
    connectOptions.viewport = { width: 3840, height: 2800, deviceScaleFactor: 2 };
  }

  const session = await getBrowserSession(connectOptions);

  try {
    const page = session.page;

    // Navigate to Figma design URL
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    const authResult = (title?: string): FigmaNodeInspectionResult => ({
      status: "requires_auth",
      url,
      fileKey: parsed.fileKey,
      fileName: parsed.fileName,
      nodeId: parsed.nodeIdColon,
      pageTitle: title,
      message:
        "Authentication required to view this Figma file. Attach to your active Chrome browser via CDP (e.g. cdpUrl: 9222) or pass a persistent userDataDir.",
    });

    // Wait for the WebGL canvas to finish rendering. A login wall never renders one, so a
    // timeout here is re-tested as auth before being reported as a generic failure - the
    // login form itself only exists in the DOM well after domcontentloaded.
    try {
      await waitForFigmaCanvasReady(page, timeoutMs);
    } catch (waitErr: any) {
      const failedStatus = await inspectFigmaPageStatus(page);
      if (failedStatus.requiresLogin) {
        return authResult(failedStatus.title);
      }
      return {
        status: "error",
        url,
        fileKey: parsed.fileKey,
        fileName: parsed.fileName,
        nodeId: parsed.nodeIdColon,
        pageTitle: failedStatus.title,
        message: `Figma canvas never finished rendering (${waitErr?.message || waitErr}). Most often this is an unauthenticated session: attach to your logged-in Chrome via cdpUrl: 9222.`,
      };
    }

    const loadedStatus = await inspectFigmaPageStatus(page);
    if (loadedStatus.requiresLogin) {
      return authResult(loadedStatus.title);
    }

    // Auto-zoom to 100% for Retina sharpness
    if (retinaZoom) {
      await ensureFigmaZoom100(page);
      await new Promise((r) => setTimeout(r, 1500));
    }

    const readyStatus = await inspectFigmaPageStatus(page);


    // Resolve section and sub-section hierarchy
    let detectedSectionRaw = sectionName;
    if (!detectedSectionRaw && readyStatus.detectedFrames) {
      const bracketMatch = readyStatus.detectedFrames.find((f) => /^\[[^\]]+\]/.test(f));
      if (bracketMatch) {
        detectedSectionRaw = bracketMatch;
      }
    }

    const hierarchyParsed = parseSectionHierarchy(detectedSectionRaw);
    const resolvedSection = sectionName ? (hierarchyParsed.section || sectionName) : (hierarchyParsed.section !== "DefaultSection" ? hierarchyParsed.section : undefined);
    const resolvedSubSection = subSectionName || hierarchyParsed.subSection;

    // Build hierarchical output directory: output / figma-{id} / section / [subSection]
    const targetHierarchyDir = buildHierarchyDir({
      baseDir: baseOutputDir || (outputPath ? path.dirname(outputPath) : path.join(process.cwd(), "output")),
      fileId: parsed.fileKey,
      section: resolvedSection,
      subSection: resolvedSubSection,
    });

    if (!fs.existsSync(targetHierarchyDir)) {
      fs.mkdirSync(targetHierarchyDir, { recursive: true });
    }

    // Strip Figma's own UI before capturing - it is composited into canvas screenshots,
    // and a full-width cookie banner alone is enough to defeat card detection.
    // Done after readyStatus so the zoom widget and layer names are still readable above.
    await hideFigmaChrome(page);

    // Capture visual snapshot. Figma renders several canvases; the design surface is the
    // largest one, so picking document order would sometimes capture an overlay.
    const canvasHandle = await findLargestCanvas(page);
    const canvasBox = canvasHandle ? await canvasHandle.boundingBox() : null;

    const rawBytes = canvasHandle
      ? await canvasHandle.screenshot({ type: "png" })
      : await page.screenshot({ type: "png", fullPage: false });

    const buffer = Buffer.from(rawBytes);

    const defaultFilename = `figma-${parsed.fileKey || "doc"}-${parsed.nodeIdHyphen || "view"}.png`;
    let savedPath: string | undefined;
    if (saveScreenshot) {
      savedPath = outputPath || path.join(targetHierarchyDir, defaultFilename);
      fs.mkdirSync(path.dirname(savedPath), { recursive: true });
      fs.writeFileSync(savedPath, buffer);
    }

    // Deterministic child card slicing
    let slicedChildren: SlicedChildNode[] | undefined;
    let childrenWarning: string | undefined;
    if (splitChildren) {
      let bounds: BoundingBox = { x: 0, y: 0, width: 1920, height: 1080 };
      if (canvasBox) {
        bounds = { x: canvasBox.x, y: canvasBox.y, width: canvasBox.width, height: canvasBox.height };
      } else if (readyStatus.canvasDimensions) {
        bounds = { x: 0, y: 0, width: readyStatus.canvasDimensions.width, height: readyStatus.canvasDimensions.height };
      }

      slicedChildren = await extractAndSliceChildCards(page, bounds, {
        direction: childrenDirection,
        expectedCount: childrenCount,
        cardNames,
        outputDir: targetHierarchyDir,
        includeBase64,
      });
      childrenWarning = countMismatch(slicedChildren, childrenCount);
    }

    return {
      status: "success",
      url,
      fileKey: parsed.fileKey,
      fileName: parsed.fileName,
      nodeId: parsed.nodeIdColon,
      pageTitle: readyStatus.title,
      canvasDimensions: readyStatus.canvasDimensions,
      detectedFrames: readyStatus.detectedFrames,
      children: slicedChildren,
      warning: childrenWarning,
      hierarchy: {
        fileFolder: `figma-${parsed.fileKey || "doc"}`,
        section: resolvedSection,
        subSection: resolvedSubSection,
        outputDir: targetHierarchyDir,
      },
      screenshotPath: savedPath,
      ...(includeBase64 ? { screenshotBase64: buffer.toString("base64") } : {}),
    };
  } catch (error: any) {
    return {
      status: "error",
      url,
      fileKey: parsed.fileKey,
      fileName: parsed.fileName,
      nodeId: parsed.nodeIdColon,
      message: error.message || String(error),
    };
  } finally {
    // Safe for attached sessions too: close() only closes the tab we opened, then disconnects.
    await session.close();
  }
}