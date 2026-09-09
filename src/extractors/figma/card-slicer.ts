import fs from "node:fs";
import path from "node:path";
import type { Page } from "puppeteer-core";
import { formatCardFileName } from "./section-parser.js";
import { detectContentBoxes, sliceBoxesFromBuffer, type SegmentOptions, type ContentBox } from "./segment.js";
import { panFigmaCanvas } from "./bridge.js";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SlicedChildNode {
  id?: string;
  name: string;
  index: number;
  bounds: BoundingBox;
  /** How the bounds were obtained: measured from pixels, or blindly divided as a fallback. */
  method: "segmented" | "even";
  screenshotPath?: string;
  screenshotBase64?: string;
  error?: string;
}

export interface SplitChildrenOptions extends SegmentOptions {
  /**
   * Expected count of child cards. Used to verify the detection, never to divide blindly
   * unless detection fails outright.
   */
  expectedCount?: number;

  /**
   * Semantic names for child cards (e.g. ['UserProfile', 'AccountSettings']), applied in visual order
   * (left-to-right for rows, top-to-bottom for columns). Missing names fall back to 'step-N'.
   */
  cardNames?: string[];

  /**
   * Output directory where child screenshots will be saved.
   */
  outputDir?: string;

  /**
   * Padding kept around each detected card in CSS pixels, e.g. to keep drop shadows (default: 0).
   */
  padding?: number;

  /**
   * Include the PNG bytes as base64 in the returned nodes. Off by default: a handful of
   * 4K cards is tens of megabytes, which is not something to hand back to an agent.
   */
  includeBase64?: boolean;

  /**
   * Automatically pans the Figma WebGL canvas to discover off-screen cards when expectedCount
   * exceeds the visible viewport capacity (default: true).
   */
  autoFlow?: boolean;
}

/** Splits a region into `count` equal strips. Only used when pixel detection finds nothing. */
function evenDivision(parentBounds: BoundingBox, count: number, direction: string): BoundingBox[] {
  if (count <= 1) return [parentBounds];

  const isRow = direction === "row" || (direction !== "column" && parentBounds.width >= parentBounds.height);
  const boxes: BoundingBox[] = [];

  for (let i = 0; i < count; i++) {
    if (isRow) {
      const cardWidth = Math.floor(parentBounds.width / count);
      const width = i === count - 1 ? parentBounds.width - i * cardWidth : cardWidth;
      boxes.push({ x: parentBounds.x + i * cardWidth, y: parentBounds.y, width, height: parentBounds.height });
    } else {
      const cardHeight = Math.floor(parentBounds.height / count);
      const height = i === count - 1 ? parentBounds.height - i * cardHeight : cardHeight;
      boxes.push({ x: parentBounds.x, y: parentBounds.y + i * cardHeight, width: parentBounds.width, height });
    }
  }

  return boxes;
}

/**
 * Splits a canvas region into its individual cards by measuring where the cards actually are:
 * the region is captured once, the background colour is sampled from its corners, and the
 * gutters between cards are found by projection profiling. No model, no guessing - but also
 * no pretending that dividing a viewport into N equal strips lands on card borders.
 *
 * Falls back to equal division only when nothing could be measured.
 */
export async function extractAndSliceChildCards(
  page: Page,
  parentBounds: BoundingBox,
  options: SplitChildrenOptions = {}
): Promise<SlicedChildNode[]> {
  const {
    direction = "auto",
    expectedCount,
    cardNames,
    outputDir = path.join(process.cwd(), "output"),
    padding = 0,
    includeBase64 = false,
    tolerance,
    minGap,
    minSize,
    autoFlow = true,
  } = options;

  fs.mkdirSync(outputDir, { recursive: true });

  const clipOf = (b: BoundingBox) => ({
    x: Math.max(0, Math.round(b.x)),
    y: Math.max(0, Math.round(b.y)),
    width: Math.max(1, Math.round(b.width)),
    height: Math.max(1, Math.round(b.height)),
  });

  // 1. Capture the parent region once and measure where the cards really are.
  let boxes: BoundingBox[] = [];
  let rawBoxes: ContentBox[] = [];
  let rawB64: string = "";
  let method: SlicedChildNode["method"] = "segmented";

  try {
    const parentBytes = await page.screenshot({ type: "png", clip: clipOf(parentBounds) });
    rawB64 = Buffer.from(parentBytes).toString("base64");
    const detection = await detectContentBoxes(page, rawB64, {
      direction,
      tolerance,
      minGap,
      minSize,
    });

    if (detection.imageWidth > 0 && detection.boxes.length > 0) {
      // Screenshots come out at deviceScaleFactor resolution; map pixels back to CSS units.
      const scale = detection.imageWidth / clipOf(parentBounds).width;
      rawBoxes = detection.boxes;
      boxes = detection.boxes.map((b) => ({
        x: parentBounds.x + b.x / scale,
        y: parentBounds.y + b.y / scale,
        width: b.width / scale,
        height: b.height / scale,
      }));
    }
  } catch {
    // fall through to even division
  }

  if (boxes.length === 0) {
    method = "even";
    boxes = evenDivision(parentBounds, expectedCount && expectedCount > 0 ? expectedCount : 1, direction);
  }

  // 2. Apply padding, clamped so a clip never escapes the parent region.
  if (padding > 0) {
    boxes = boxes.map((b) => {
      const x = Math.max(parentBounds.x, b.x - padding);
      const y = Math.max(parentBounds.y, b.y - padding);
      return {
        x,
        y,
        width: Math.min(parentBounds.x + parentBounds.width, b.x + b.width + padding) - x,
        height: Math.min(parentBounds.y + parentBounds.height, b.y + b.height + padding) - y,
      };
    });
  }

  // 3. Fast buffer slicing in browser memory to avoid multiple round-trip CDP screenshot calls
  let fastSlices: Array<{ index: number; base64: string }> = [];
  if (rawB64 && rawBoxes.length === boxes.length && method === "segmented") {
    try {
      fastSlices = await sliceBoxesFromBuffer(page, rawB64, rawBoxes);
    } catch {}
  }

  // 4. Save each card
  const results: SlicedChildNode[] = [];

  for (let i = 0; i < boxes.length; i++) {
    const bounds = boxes[i];
    const fileName = formatCardFileName(cardNames?.[i], i);
    const name = fileName.replace(/\.png$/i, "");
    const filePath = path.join(outputDir, fileName);

    try {
      let buffer: Buffer;
      const fast = fastSlices.find((s) => s.index === i);
      if (fast && fast.base64) {
        buffer = Buffer.from(fast.base64, "base64");
      } else {
        const bytes = await page.screenshot({ type: "png", clip: clipOf(bounds) });
        buffer = Buffer.from(bytes);
      }
      fs.writeFileSync(filePath, buffer);

      results.push({
        index: i,
        name,
        bounds,
        method,
        screenshotPath: filePath,
        ...(includeBase64 ? { screenshotBase64: buffer.toString("base64") } : {}),
      });
    } catch (err: any) {
      results.push({
        index: i,
        name,
        bounds,
        method,
        error: err?.message || String(err),
      });
    }
  }

  // 5. Flow sweep: If caller expects more cards and autoFlow is active, pan canvas to capture off-screen cards
  if (autoFlow && expectedCount && results.length < expectedCount) {
    try {
      const panStep = Math.round(parentBounds.width * 0.7);
      await panFigmaCanvas(page, -panStep, 0, { width: parentBounds.width, height: parentBounds.height });
      await new Promise((r) => setTimeout(r, 1200));

      const nextBytes = await page.screenshot({ type: "png", clip: clipOf(parentBounds) });
      const nextB64 = Buffer.from(nextBytes).toString("base64");
      const nextDetection = await detectContentBoxes(page, nextB64, {
        direction,
        tolerance,
        minGap,
        minSize,
      });

      if (nextDetection.boxes.length > 0) {
        const nextSlices = await sliceBoxesFromBuffer(page, nextB64, nextDetection.boxes);
        const startIndex = results.length;
        for (let j = 0; j < nextDetection.boxes.length && results.length < expectedCount; j++) {
          const cardIdx = startIndex + j;
          const fileName = formatCardFileName(cardNames?.[cardIdx], cardIdx);
          const name = fileName.replace(/\.png$/i, "");
          const filePath = path.join(outputDir, fileName);
          const fast = nextSlices.find((s) => s.index === j);
          if (fast && fast.base64) {
            const buffer = Buffer.from(fast.base64, "base64");
            fs.writeFileSync(filePath, buffer);
            results.push({
              index: cardIdx,
              name,
              bounds: {
                x: parentBounds.x + nextDetection.boxes[j].x,
                y: parentBounds.y + nextDetection.boxes[j].y,
                width: nextDetection.boxes[j].width,
                height: nextDetection.boxes[j].height,
              },
              method: "segmented",
              screenshotPath: filePath,
              ...(includeBase64 ? { screenshotBase64: fast.base64 } : {}),
            });
          }
        }
      }
    } catch {}
  }

  return results;
}

/** True when the number of cards found does not match what the caller expected. */
export function countMismatch(results: SlicedChildNode[], expectedCount?: number): string | undefined {
  if (!expectedCount || expectedCount <= 0 || results.length === expectedCount) return undefined;
  return `Expected ${expectedCount} child cards but measured ${results.length}. Adjust --direction, or tune minGap/minSize if cards are being merged or split.`;
}
