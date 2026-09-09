import type { Page } from "puppeteer-core";

export interface ContentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SegmentOptions {
  /**
   * Layout of the cards inside the region.
   * 'row' splits left-to-right, 'column' top-to-bottom, 'grid' rows then columns,
   * 'auto' picks whichever axis actually has gutters.
   */
  direction?: "row" | "column" | "grid" | "auto";

  /**
   * Sum of per-channel distance from the background colour above which a pixel counts as content.
   */
  tolerance?: number;

  /**
   * Minimum run of background rows/columns that counts as a gutter between two cards.
   * Anything narrower is treated as space inside a single card.
   */
  minGap?: number;

  /**
   * Boxes smaller than this on either axis are discarded as noise (cursors, labels, artefacts).
   */
  minSize?: number;

  /**
   * Fraction of a band a line must be covered by to count as content rather than as a stray
   * mark. Figma prototypes draw connector arrows across the gutters between cards; without
   * this every linked card merges into one box (default: 0.02).
   */
  minDensity?: number;
}

/**
 * Finds the real bounding box of every card inside an image by projection profiling:
 * a column (or row) counts as content once enough of its pixels differ from the canvas
 * background, and a run of background columns wider than `minGap` is a gutter between
 * two cards. The density rule is what keeps prototype connector arrows from welding
 * every linked card into a single box.
 *
 * Pure and self-contained on purpose - it is unit tested directly in Node and also
 * shipped into the browser via `toString()` by `detectContentBoxes`, so it must not
 * reference anything outside its own body.
 */
export function computeContentBoxes(
  width: number,
  height: number,
  data: Uint8ClampedArray | number[],
  options: SegmentOptions = {}
): ContentBox[] {
  const direction = options.direction || "auto";
  const tolerance = options.tolerance ?? 25;
  const minGap = options.minGap ?? 12;
  const minSize = options.minSize ?? 40;
  const minDensity = options.minDensity ?? 0.02;

  if (width <= 0 || height <= 0) return [];

  // Background colour: sample perimeter edges to robustly find the canvas backdrop
  // even if an artboard or shadow touches one or more corners.
  const colorAt = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };

  const samplePoints: Array<[number, number]> = [];
  const numSteps = 12;
  for (let s = 0; s <= numSteps; s++) {
    const x = Math.min(width - 1, Math.floor((s / numSteps) * (width - 1)));
    const y = Math.min(height - 1, Math.floor((s / numSteps) * (height - 1)));
    samplePoints.push([x, 0]);
    samplePoints.push([x, height - 1]);
    samplePoints.push([0, y]);
    samplePoints.push([width - 1, y]);
  }

  const candidates = samplePoints.map(([x, y]) => colorAt(x, y));
  let bg = candidates[0];
  let bestVotes = 0;
  for (const c of candidates) {
    let votes = 0;
    for (const other of candidates) {
      const d = Math.abs(c[0] - other[0]) + Math.abs(c[1] - other[1]) + Math.abs(c[2] - other[2]);
      if (d <= tolerance) votes++;
    }
    if (votes > bestVotes) {
      bestVotes = votes;
      bg = c;
    }
  }

  // Content mask + projection counts in one pass.
  const mask = new Uint8Array(width * height);
  const colCount = new Int32Array(width);
  const rowCount = new Int32Array(height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const i = (rowOffset + x) * 4;
      const diff =
        Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      if (diff > tolerance) {
        mask[rowOffset + x] = 1;
        colCount[x]++;
        rowCount[y]++;
      }
    }
  }

  /**
   * How many content pixels a line needs before it counts as part of a card.
   * Filters out thin connector arrows/flow lines (typically 1-3px) in prototype gutters.
   */
  const thresholdFor = (span: number) => {
    if (span < 40) return Math.max(2, Math.ceil(minDensity * span));
    return Math.max(6, Math.ceil(minDensity * span));
  };

  /** Groups lines above `threshold` into runs, merging gaps narrower than minGap. */
  const runsOf = (
    profile: Int32Array,
    from: number,
    to: number,
    threshold: number
  ): Array<[number, number]> => {
    const runs: Array<[number, number]> = [];
    let start = -1;
    let lastContent = -1;
    for (let i = from; i <= to; i++) {
      if (profile[i] >= threshold) {
        if (start === -1) start = i;
        lastContent = i;
      } else if (start !== -1 && i - lastContent >= minGap) {
        runs.push([start, lastContent]);
        start = -1;
      }
    }
    if (start !== -1) runs.push([start, lastContent]);
    return runs;
  };

  /** Content counts of a sub-rectangle, projected onto one axis. */
  const profileIn = (x0: number, x1: number, y0: number, y1: number, axis: "x" | "y") => {
    const profile = new Int32Array(axis === "x" ? width : height);
    for (let y = y0; y <= y1; y++) {
      const rowOffset = y * width;
      for (let x = x0; x <= x1; x++) {
        if (mask[rowOffset + x]) profile[axis === "x" ? x : y]++;
      }
    }
    return profile;
  };

  const tighten = (x0: number, x1: number, y0: number, y1: number): ContentBox | null => {
    const xs = runsOf(profileIn(x0, x1, y0, y1, "x"), x0, x1, thresholdFor(y1 - y0 + 1));
    const ys = runsOf(profileIn(x0, x1, y0, y1, "y"), y0, y1, thresholdFor(x1 - x0 + 1));
    if (xs.length === 0 || ys.length === 0) return null;
    const left = xs[0][0];
    const right = xs[xs.length - 1][1];
    const top = ys[0][0];
    const bottom = ys[ys.length - 1][1];
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  };

  const colRuns = runsOf(colCount, 0, width - 1, thresholdFor(height));
  const rowRuns = runsOf(rowCount, 0, height - 1, thresholdFor(width));

  let resolved = direction;
  if (resolved === "auto") {
    if (colRuns.length > 1 && colRuns.length >= rowRuns.length) resolved = "row";
    else if (rowRuns.length > 1) resolved = "column";
    else resolved = "row";
  }

  const boxes: ContentBox[] = [];

  if (resolved === "grid") {
    for (const [y0, y1] of rowRuns) {
      const cells = runsOf(profileIn(0, width - 1, y0, y1, "x"), 0, width - 1, thresholdFor(y1 - y0 + 1));
      for (const [x0, x1] of cells) {
        const box = tighten(x0, x1, y0, y1);
        if (box) boxes.push(box);
      }
    }
  } else if (resolved === "column") {
    for (const [y0, y1] of rowRuns) {
      const box = tighten(0, width - 1, y0, y1);
      if (box) boxes.push(box);
    }
  } else {
    for (const [x0, x1] of colRuns) {
      const box = tighten(x0, x1, 0, height - 1);
      if (box) boxes.push(box);
    }
  }

  return boxes.filter((b) => b.width >= minSize && b.height >= minSize);
}

export interface DetectionResult {
  /** Pixel width of the decoded image, so the caller can map boxes back to CSS pixels. */
  imageWidth: number;
  imageHeight: number;
  boxes: ContentBox[];
}

/**
 * Runs `computeContentBoxes` against a PNG using the browser's own image decoder,
 * because Node has no PNG decoder in its standard library.
 * Returns boxes in image pixels; the caller converts them back to CSS pixels.
 * Resolves with an empty result rather than hanging if decoding stalls or fails.
 */
export async function detectContentBoxes(
  page: Page,
  pngBase64: string,
  options: SegmentOptions = {},
  timeoutMs = 20000
): Promise<DetectionResult> {
  const empty: DetectionResult = { imageWidth: 0, imageHeight: 0, boxes: [] };
  const source = computeContentBoxes.toString();

  try {
    return await Promise.race([
      page.evaluate(
        async (b64: string, fnSource: string, opts: SegmentOptions) => {
          const compute = new Function(`return (${fnSource})`)() as (
            w: number,
            h: number,
            d: Uint8ClampedArray,
            o: unknown
          ) => Array<{ x: number; y: number; width: number; height: number }>;

          const bitmap = await new Promise<HTMLImageElement | null>((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = `data:image/png;base64,${b64}`;
          });
          if (!bitmap) return { imageWidth: 0, imageHeight: 0, boxes: [] };

          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) return { imageWidth: 0, imageHeight: 0, boxes: [] };
          ctx.drawImage(bitmap, 0, 0);

          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          return {
            imageWidth: canvas.width,
            imageHeight: canvas.height,
            boxes: compute(canvas.width, canvas.height, imageData.data, opts),
          };
        },
        pngBase64,
        source,
        options
      ),
      new Promise<DetectionResult>((resolve) => setTimeout(() => resolve(empty), timeoutMs)),
    ]);
  } catch {
    return empty;
  }
}

/**
 * Slices multiple bounding boxes directly from a decoded PNG in browser memory.
 * Avoids dozens of separate page.screenshot calls over CDP and ensures sub-millisecond
 * slicing performance with zero visual shift across frames.
 */
export async function sliceBoxesFromBuffer(
  page: Page,
  pngBase64: string,
  boxes: ContentBox[],
  timeoutMs = 15000
): Promise<Array<{ index: number; base64: string }>> {
  try {
    return await Promise.race([
      page.evaluate(
        async (b64: string, cardBoxes: ContentBox[]) => {
          const bitmap = await new Promise<HTMLImageElement | null>((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = `data:image/png;base64,${b64}`;
          });
          if (!bitmap) return [];

          const srcCanvas = document.createElement("canvas");
          srcCanvas.width = bitmap.width;
          srcCanvas.height = bitmap.height;
          const srcCtx = srcCanvas.getContext("2d");
          if (!srcCtx) return [];
          srcCtx.drawImage(bitmap, 0, 0);

          const results: Array<{ index: number; base64: string }> = [];
          for (let i = 0; i < cardBoxes.length; i++) {
            const b = cardBoxes[i];
            const outCanvas = document.createElement("canvas");
            outCanvas.width = Math.max(1, Math.round(b.width));
            outCanvas.height = Math.max(1, Math.round(b.height));
            const outCtx = outCanvas.getContext("2d");
            if (outCtx) {
              outCtx.drawImage(
                srcCanvas,
                Math.max(0, Math.round(b.x)),
                Math.max(0, Math.round(b.y)),
                outCanvas.width,
                outCanvas.height,
                0,
                0,
                outCanvas.width,
                outCanvas.height
              );
              results.push({
                index: i,
                base64: outCanvas.toDataURL("image/png").split(",")[1],
              });
            }
          }
          return results;
        },
        pngBase64,
        boxes
      ),
      new Promise<Array<{ index: number; base64: string }>>((resolve) =>
        setTimeout(() => resolve([]), timeoutMs)
      ),
    ]);
  } catch {
    return [];
  }
}

