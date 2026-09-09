import fs from "node:fs";
import path from "node:path";
import type { Page } from "puppeteer-core";
import { hideFigmaChrome } from "./bridge.js";
import {
  readSceneTargets,
  resolveScreenNames,
  assignReadingOrder,
  resolveFlowEdges,
  selectSubtree,
  type SceneTarget,
  type SceneSnapshot,
} from "./scene-graph.js";
import { getViewportInfo, panTo, sceneToScreen, setZoom } from "./viewport.js";
import { buildHierarchyDir, formatCardFileName, parseSectionHierarchy, toPascalCase } from "./section-parser.js";

export interface CaptureOptions {
  /** CSS pixel size of the browser viewport. Must match what the page was opened with. */
  viewportWidth: number;
  viewportHeight: number;
  /** Root output directory (default: ./output). */
  baseDir?: string;
  /** File key, used for the `figma-{fileKey}` folder. */
  fileKey?: string;
  /** Figma page name, added as its own folder level. Pages reuse section names. */
  pageFolder?: string;
  /** Milliseconds to let Figma redraw after each pan (default: 800). */
  settleMs?: number;
  /** Capture at most this many nodes. Unlimited by default. */
  limit?: number;
  /**
   * Restrict the capture to these Figma node ids and everything under them. All nodes by
   * default. A section id therefore selects the whole flow inside it, which is how a Figma
   * link addresses one feature out of a board holding many.
   */
  nodeIds?: string[];
  /**
   * File path to reuse per node id, keyed by id. A partial re-capture must pass the paths from
   * the original manifest: names are de-duplicated in visual order, so letting a subset
   * re-derive them would write the second "Home" of a folder over the first.
   */
  existingPaths?: Record<string, string>;
  /** Manifest file name, so a partial re-capture does not clobber the full one. */
  manifestFileName?: string;
  /** Device scale factor the page was opened with. Used to stay under the texture limit. */
  deviceScaleFactor?: number;
  onProgress?: (done: number, total: number, target: CapturedNode) => void;
}

export interface CapturedNode {
  id: string;
  name: string;
  type: string;
  sectionPath: string[];
  bounds: SceneTarget["bounds"];
  /** Canvas zoom used, e.g. 1 for 1:1 or 0.25 for an oversized frame. */
  zoom: number;
  file?: string;
  error?: string;
}

export interface CaptureReport {
  pageName: string;
  /**
   * The prototype flow, as steps between captured files. A branching graph, which is why the
   * file names carry the reading order instead of this.
   */
  flow: Array<{ from: string; to: string }>;
  /** Arrows that pointed at nothing capturable, kept visible rather than silently dropped. */
  unresolvedConnectors: number;
  expected: number;
  captured: number;
  failed: number;
  skipped: SceneSnapshot["skipped"];
  nodes: CapturedNode[];
  manifestPath: string;
}

/**
 * Largest power-of-two zoom at or below 1:1 that still fits the frame on screen.
 *
 * Figma's Ctrl+Plus / Ctrl+Minus move in exact factors of two, so restricting the choice to
 * powers of two means every zoom level is reached precisely instead of approximately.
 */
export function zoomToFit(width: number, height: number, viewportWidth: number, viewportHeight: number): number {
  const maxW = viewportWidth * 0.96;
  const maxH = viewportHeight * 0.96;
  let zoom = 1;
  while ((width * zoom > maxW || height * zoom > maxH) && zoom > 1 / 256) zoom /= 2;
  return zoom;
}

/** Resolves the output directory and unique file name for one node. */
function destinationFor(
  target: SceneTarget,
  pageName: string,
  baseDir: string | undefined,
  fileKey: string | undefined,
  pageFolder: string | undefined,
  used: Set<string>
): string {
  const [first, ...rest] = target.sectionPath;
  // A screen sitting straight on the page has no section of its own. Falling back to the page
  // name names it after where it already is - fine on its own, but doubled up (Cover/Cover)
  // once the page is a folder in its own right.
  const parsed = parseSectionHierarchy(first || pageName);
  const hasSection = Boolean(first) || !pageFolder;
  const subSection = [hasSection ? parsed.subSection : undefined, ...rest.map((name) => toPascalCase(name))]
    .filter(Boolean)
    .join("/");

  const dir = buildHierarchyDir({
    baseDir,
    fileId: fileKey,
    page: pageFolder,
    section: hasSection ? parsed.section : undefined,
    subSection: subSection || undefined,
  });

  // The number goes first so a plain directory listing is already in flow order.
  const prefix = target.order ? `${String(target.order).padStart(2, "0")}-` : "";
  const base = prefix + formatCardFileName(target.name).replace(/\.png$/i, "");
  let candidate = path.join(dir, `${base}.png`);
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = path.join(dir, `${base}-${n}.png`);
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Chromium refuses to composite a surface past roughly 16384 device pixels on a side, so a
 * frame is only worth re-capturing at 1:1 if the window it would need stays under that.
 */
export function fitsInWindow(sceneSize: number, deviceScaleFactor: number, limitPx = 16000): boolean {
  return (Math.ceil(sceneSize / 0.96) + 40) * deviceScaleFactor <= limitPx;
}

/** True when the whole rectangle sits inside the capture surface, with a pixel to spare. */
function isFullyVisible(
  rect: { x: number; y: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number
): boolean {
  return (
    rect.x >= 1 &&
    rect.y >= 1 &&
    rect.x + rect.width <= viewportWidth - 1 &&
    rect.y + rect.height <= viewportHeight - 1
  );
}

/**
 * Captures every screen on the current Figma page, one PNG per node.
 *
 * The geometry comes from Figma's own scene graph rather than from the pixels, so each file is
 * the exact frame the designer drew - no projection profiling, no equal division, no per-file
 * calibration. The canvas is driven to each frame in turn and the clip is computed from the
 * viewport transform read back *after* the pan, which makes the crop correct regardless of
 * where the pan actually landed.
 *
 * Because the crop does not depend on the pan being precise, the pan does not have to be: it
 * only has to bring a frame fully on screen. That slack is what makes this fast. Each pan is
 * aimed roughly, and then every other pending frame that happens to have landed on screen is
 * captured from the same position - neighbouring screens usually arrive in groups, so most
 * frames cost a screenshot rather than a pan.
 */
export async function captureScenePage(page: Page, options: CaptureOptions): Promise<CaptureReport> {
  const {
    viewportWidth,
    viewportHeight,
    baseDir,
    fileKey,
    pageFolder,
    settleMs = 600,
    limit,
    nodeIds,
    existingPaths,
    manifestFileName = "manifest.json",
    deviceScaleFactor = 2,
    onProgress,
  } = options;
  await hideFigmaChrome(page);
  const snapshot = await readSceneTargets(page);
  // Title cards are names, not screens: they are folded into the screen below and dropped.
  const screens = assignReadingOrder(resolveScreenNames(snapshot.targets));

  const used = new Set<string>();
  const pending = selectSubtree(screens, nodeIds ?? [])
    .slice(0, limit ?? snapshot.targets.length)
    .map((target) => ({
      target,
      zoom: zoomToFit(target.bounds.w, target.bounds.h, viewportWidth, viewportHeight),
    }))
    // Coarse zoom levels first, then top-to-bottom and left-to-right, so neighbours are
    // reached together and land on screen in the same pan.
    .sort((a, b) => b.zoom - a.zoom || a.target.bounds.y - b.target.bounds.y || a.target.bounds.x - b.target.bounds.x);

  const total = pending.length;
  const nodes: CapturedNode[] = [];
  const done = new Set<number>();
  let currentZoom = 0;

  const write = (entry: (typeof pending)[number], view: Awaited<ReturnType<typeof getViewportInfo>>) => {
    const record: CapturedNode = { ...entry.target, zoom: view.zoomScale };
    try {
      const rect = sceneToScreen(entry.target.bounds, view, viewportWidth, viewportHeight);
      const clip = {
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      };
      const file =
        existingPaths?.[entry.target.id] ??
        destinationFor(entry.target, snapshot.pageName, baseDir, fileKey, pageFolder, used);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      record.file = file;
      return { record, clip };
    } catch (err: any) {
      record.error = err?.message || String(err);
      return { record, clip: null };
    }
  };

  for (let i = 0; i < pending.length; i++) {
    if (done.has(i)) continue;
    const entry = pending[i];
    const record: CapturedNode = { ...entry.target, zoom: entry.zoom };

    try {
      if (entry.zoom !== currentZoom) currentZoom = await setZoom(page, entry.zoom);

      // Aim the pan only well enough to land the frame on screen: the slack between the frame
      // and the viewport is how far off centre we are allowed to be.
      const slackScene = Math.min(
        (viewportWidth / currentZoom - entry.target.bounds.w) / 2,
        (viewportHeight / currentZoom - entry.target.bounds.h) / 2
      );
      await panTo(
        page,
        entry.target.bounds.x + entry.target.bounds.w / 2,
        entry.target.bounds.y + entry.target.bounds.h / 2,
        viewportWidth,
        viewportHeight,
        { tolerance: Math.max(1, slackScene * 0.6), maxPasses: 3 }
      );
      await new Promise((r) => setTimeout(r, settleMs));

      // Read the transform after settling: a still-animating pan would otherwise be baked in.
      const view = await getViewportInfo(page);

      // Everything at this zoom that landed on screen comes along for free.
      for (let j = i; j < pending.length; j++) {
        if (done.has(j)) continue;
        const candidate = pending[j];
        if (candidate.zoom !== entry.zoom) continue;

        const rect = sceneToScreen(candidate.target.bounds, view, viewportWidth, viewportHeight);
        if (j !== i && !isFullyVisible(rect, viewportWidth, viewportHeight)) continue;

        const { record: written, clip } = write(candidate, view);
        if (clip) {
          try {
            fs.writeFileSync(written.file!, Buffer.from(await page.screenshot({ type: "png", clip })));
          } catch (err: any) {
            written.error = err?.message || String(err);
            delete written.file;
          }
        }
        done.add(j);
        nodes.push(written);
        onProgress?.(nodes.length, total, written);
      }
      continue;
    } catch (err: any) {
      record.error = err?.message || String(err);
    }

    done.add(i);
    nodes.push(record);
    onProgress?.(nodes.length, total, record);
  }

  // A frame taller or wider than the viewport was captured zoomed out, which costs exactly the
  // resolution the downstream vision model needs. Growing the window is free where the canvas
  // still fits under the renderer's texture limit, so redo those at 1:1.
  const oversized = nodes.filter(
    (node) =>
      node.file &&
      node.zoom < 1 &&
      fitsInWindow(node.bounds.w, deviceScaleFactor) &&
      fitsInWindow(node.bounds.h, deviceScaleFactor)
  );

  for (const node of oversized) {
    // Keep a floor on both sides: a window sized to a 4324x88 section banner would be 132px
    // tall, which leaves Figma's canvas no room to render or pan in.
    const width = Math.max(800, Math.ceil(node.bounds.w / 0.96) + 40);
    const height = Math.max(600, Math.ceil(node.bounds.h / 0.96) + 40);
    try {
      await page.setViewport({ width, height, deviceScaleFactor });
      await new Promise((r) => setTimeout(r, 400));
      currentZoom = await setZoom(page, 1);
      const view = await panTo(page, node.bounds.x + node.bounds.w / 2, node.bounds.y + node.bounds.h / 2, width, height, {
        tolerance: Math.max(1, Math.min(width - node.bounds.w, height - node.bounds.h) * 0.3),
        maxPasses: 3,
      });
      await new Promise((r) => setTimeout(r, settleMs));

      const settled = await getViewportInfo(page);
      const rect = sceneToScreen(node.bounds, settled, width, height);
      if (!isFullyVisible(rect, width, height)) continue;

      fs.writeFileSync(
        node.file!,
        Buffer.from(
          await page.screenshot({
            type: "png",
            clip: {
              x: Math.max(0, Math.round(rect.x)),
              y: Math.max(0, Math.round(rect.y)),
              width: Math.max(1, Math.round(rect.width)),
              height: Math.max(1, Math.round(rect.height)),
            },
          })
        )
      );
      node.zoom = settled.zoomScale;
      void view;
    } catch {
      // Keep the zoomed-out capture already on disk rather than losing the screen entirely.
    }
  }

  if (oversized.length) {
    await page.setViewport({ width: viewportWidth, height: viewportHeight, deviceScaleFactor }).catch(() => {});
    currentZoom = 0;
  }
  void currentZoom;

  const manifestPath = path.join(buildHierarchyDir({ baseDir, fileId: fileKey, page: pageFolder }), manifestFileName);
  // Prototype arrows describe the flow between screens; express them as file-to-file steps so
  // the manifest is usable without resolving Figma node ids.
  const resolved = resolveFlowEdges(screens, snapshot.connectors);
  const fileById = new Map(nodes.filter((n) => n.file).map((n) => [n.id, n.file!]));
  const flow = resolved.edges
    .filter((edge) => fileById.has(edge.from) && fileById.has(edge.to))
    .map((edge) => ({ from: fileById.get(edge.from)!, to: fileById.get(edge.to)! }));

  const report: CaptureReport = {
    pageName: snapshot.pageName,
    flow,
    unresolvedConnectors: resolved.unresolved,
    expected: total,
    captured: nodes.filter((n) => n.file).length,
    failed: nodes.filter((n) => n.error).length,
    skipped: snapshot.skipped,
    nodes,
    manifestPath,
  };

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(report, null, 2));

  return report;
}
