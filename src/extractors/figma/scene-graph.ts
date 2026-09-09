import type { Page } from "puppeteer-core";
import type { SceneRect } from "./viewport.js";

/** A node worth capturing: one screen, component, or supporting card the designer drew. */
export interface SceneTarget {
  /** Figma's own node id, e.g. "1234:5678". */
  id: string;
  /** The designer's layer name, verbatim. */
  name: string;
  /** Figma node type, e.g. "FRAME", "COMPONENT". */
  type: string;
  /** Names of the SECTION ancestors, outermost first. Empty for page-level nodes. */
  sectionPath: string[];
  /**
   * Node ids of the same SECTION ancestors, in the same order. Names are what a person reads;
   * ids are what a Figma link points at, and a link is how a caller asks for one part of a
   * board. Kept parallel rather than folded into `sectionPath` so the names stay printable.
   */
  sectionIds?: string[];
  bounds: SceneRect;
  /**
   * A title card is the thin labelled banner a designer puts above a screen. It is not a
   * screen itself - it is the screen's name - so it never becomes a file of its own.
   */
  isTitleCard?: boolean;
  /** Text read out of a title card, e.g. "Application Submitted". */
  label?: string;
  /** 1-based position in reading order within this screen's own folder. */
  order?: number;
}

/** One prototype arrow, reduced to the two points it visually joins. */
export interface FlowConnector {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/** A directed step in the prototype flow, between two screen ids. */
export interface FlowEdge {
  from: string;
  to: string;
}

export interface SceneSnapshot {
  pageName: string;
  targets: SceneTarget[];
  /** Prototype arrows, unresolved. Turn them into edges with resolveFlowEdges. */
  connectors: FlowConnector[];
  /** Nodes that were walked through or skipped, for the coverage report. */
  skipped: Array<{ type: string; count: number }>;
}

/**
 * Node types that represent something a designer would call a screen. Everything else on the
 * canvas - prototype connectors, loose text, stickies - is scaffolding around them.
 */
const CAPTURE_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SYMBOL", "GROUP"]);

/** Layer name designers give the label banner above a screen. Override per file if it differs. */
export const DEFAULT_TITLE_PATTERN = /^supporting\s*card$/;

/**
 * Waits until Figma has finished loading the document into its scene graph.
 *
 * A present <canvas> only means the app booted; the page's children appear later, and reading
 * before then silently yields an empty extraction.
 */
export async function waitForSceneGraph(page: Page, timeoutMs = 120000): Promise<void> {
  await page.waitForFunction(
    () => {
      const graph = (window as any)._fullscreen_?._store?.getState?.()?.mirror?.sceneGraph;
      const current = graph?.getCurrentPage?.();
      return !!current && (current.childrenNodes?.length ?? 0) > 0;
    },
    { timeout: timeoutMs, polling: 500 }
  );
}

/** What a Figma link's node id actually points at, once resolved against the document. */
export interface ResolvedSceneNode {
  /** The scene graph's own id for the node. */
  guid: string;
  /** e.g. "SECTION", "FRAME", or "CANVAS" for a whole page. */
  type: string;
  name: string;
}

/**
 * Resolves the node id carried by a Figma URL to the node it names.
 *
 * The id in a link is Figma's "developer friendly" id, which is not always the id the scene
 * graph stores, so comparing the two as strings finds nothing and looks exactly like an empty
 * section. Figma exposes the mapping itself; use it rather than guessing.
 *
 * Knowing the type matters as much as the id: a link copied with nothing selected addresses
 * the page (`CANVAS`), which as a capture scope means the entire board rather than the one
 * flow the caller had in mind.
 *
 * Only the colon spelling resolves, so hyphens are normalised first.
 */
export async function resolveSceneNode(page: Page, nodeId: string): Promise<ResolvedSceneNode | null> {
  return await page.evaluate((id: string) => {
    const graph = (window as any)._fullscreen_?._store?.getState?.()?.mirror?.sceneGraph;
    if (!graph?.getFromDeveloperFriendlyId) return null;
    try {
      const node = graph.getFromDeveloperFriendlyId(id);
      if (!node) return null;
      return { guid: String(node.guid), type: String(node.type), name: String(node.name ?? "") };
    } catch {
      return null;
    }
  }, nodeId.trim().replace(/-/g, ":"));
}

/**
 * Reads every capturable node out of Figma's own scene graph.
 *
 * Figma renders through WebGL, so there is no DOM to query - but the app keeps a plain
 * JavaScript mirror of the document on `window`, complete with layer names, node ids, and
 * absolute bounds. Reading it gives exact geometry and the designer's own naming, with no
 * REST API, no access token, and no guessing at where a card starts from its pixels.
 */
export async function readSceneTargets(page: Page, titlePattern = DEFAULT_TITLE_PATTERN): Promise<SceneSnapshot> {
  return await page.evaluate((captureTypes: string[], titleSource: string) => {
    const capturable = new Set(captureTypes);
    const isTitle = new RegExp(titleSource, "i");

    /** Concatenates the text a title card carries, which is the name the designer wrote. */
    const readLabel = (node: any, depth = 0): string[] => {
      try {
        if (node.type === "TEXT" && node.characters) return [String(node.characters)];
      } catch {
        return [];
      }
      if (depth > 6) return [];
      let children: any[] = [];
      try {
        children = node.childrenNodes || [];
      } catch {
        return [];
      }
      return children.flatMap((child) => readLabel(child, depth + 1));
    };
    const graph = (window as any)._fullscreen_?._store?.getState?.()?.mirror?.sceneGraph;
    if (!graph) throw new Error("Figma scene graph is not reachable on this page.");

    const root = graph.getCurrentPage();
    if (!root) throw new Error("Figma has not loaded a page into its scene graph yet.");

    const targets: any[] = [];
    const connectors: any[] = [];
    const skipped: Record<string, number> = {};

    /**
     * Where a connector endpoint physically points.
     *
     * Figma attaches an arrow to whatever the designer dropped it on - usually a button deep
     * inside a screen, not the screen frame - and the mirror gives no parent link to climb.
     * The endpoint's own position is enough: whichever screen encloses it owns the arrow.
     */
    const endpointCentre = (endpoint: any) => {
      try {
        const node = graph.getFromDeveloperFriendlyId(endpoint.endpointNodeID);
        const box = node?.absoluteBoundingBox;
        if (!box) return null;
        return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      } catch {
        return null;
      }
    };

    const boundsOf = (node: any) => {
      const box = node.absoluteBoundingBox;
      if (!box || !(box.w > 0) || !(box.h > 0)) return null;
      return { x: box.x, y: box.y, w: box.w, h: box.h };
    };

    const walk = (node: any, sectionPath: string[], sectionIds: string[]) => {
      let children: any[] = [];
      try {
        children = node.childrenNodes || [];
      } catch {
        children = [];
      }

      for (const child of children) {
        let type = "";
        let name = "";
        let visible = true;
        try {
          type = child.type;
          name = child.name;
          visible = child.visible !== false;
        } catch {
          continue;
        }

        if (!visible) {
          skipped["HIDDEN"] = (skipped["HIDDEN"] || 0) + 1;
          continue;
        }

        // Sections are containers, not screens: descend and remember the name for the path.
        if (type === "SECTION") {
          walk(child, [...sectionPath, name], [...sectionIds, child.guid]);
          continue;
        }

        if (type === "CONNECTOR") {
          skipped[type] = (skipped[type] || 0) + 1;
          try {
            const from = endpointCentre(child.connectorStart);
            const to = endpointCentre(child.connectorEnd);
            if (from && to) connectors.push({ from, to });
          } catch {
            // An arrow we cannot place is simply not an edge.
          }
          continue;
        }

        if (!capturable.has(type)) {
          skipped[type] = (skipped[type] || 0) + 1;
          continue;
        }

        const bounds = boundsOf(child);
        if (!bounds) {
          skipped["ZERO_SIZE"] = (skipped["ZERO_SIZE"] || 0) + 1;
          continue;
        }

        // A capturable node is a screen in its own right; its children are its contents.
        if (isTitle.test(name)) {
          const label = readLabel(child).join(" ").replace(/\s+/g, " ").trim();
          targets.push({ id: child.guid, name, type, sectionPath, sectionIds, bounds, isTitleCard: true, label });
        } else {
          targets.push({ id: child.guid, name, type, sectionPath, sectionIds, bounds });
        }
      }
    };

    walk(root, [], []);

    return {
      pageName: root.name || "Page",
      targets,
      connectors,
      skipped: Object.entries(skipped).map(([type, count]) => ({ type, count })),
    };
  }, [...CAPTURE_TYPES], titlePattern.source);
}

/**
 * Names each screen after the title card sitting above it, and drops the cards themselves.
 *
 * Designers label a flow by putting a thin banner above each screen rather than by renaming
 * the frame, so the layer names alone give six files called "Home". The banner is where the
 * meaning is - "Mandatory Requirement", "Application Submitted" - and that is what the vision
 * model downstream needs in the file name.
 *
 * A banner claims the screens directly beneath it that it substantially overlaps. Wide banners
 * head a group of screens rather than a single one; those screens all take the group's name and
 * are told apart by the usual numbering.
 */
export function resolveScreenNames(
  targets: SceneTarget[],
  options: { maxGap?: number; minOverlap?: number } = {}
): SceneTarget[] {
  const { maxGap = 250, minOverlap = 0.6 } = options;

  const cards = targets.filter((t) => t.isTitleCard && t.label);
  const screens = targets.filter((t) => !t.isTitleCard);
  if (cards.length === 0) return screens;

  const overlap = (a: SceneRect, b: SceneRect) =>
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));

  return screens.map((screen) => {
    let best: SceneTarget | undefined;
    for (const card of cards) {
      const cardBottom = card.bounds.y + card.bounds.h;
      if (cardBottom > screen.bounds.y) continue;
      if (screen.bounds.y - cardBottom > maxGap) continue;
      if (overlap(card.bounds, screen.bounds) < minOverlap * Math.min(card.bounds.w, screen.bounds.w)) continue;
      // Closest banner above wins, so a screen under two stacked rows takes its own.
      if (!best || cardBottom > best.bounds.y + best.bounds.h) best = card;
    }
    return best?.label ? { ...screen, name: best.label } : screen;
  });
}

/**
 * A Figma node id, in the one spelling both sides can be compared in.
 *
 * A URL writes "1234-5678"; the scene graph writes "1234:5678". Callers paste links through
 * verbatim, so neither spelling can be made the caller's problem.
 */
const normaliseNodeId = (id: string): string => id.trim().replace(/-/g, ":");

/**
 * Keeps only the screens at, or anywhere under, the given node ids.
 *
 * A Figma link already carries the node the designer was pointing at - for a requirement
 * document that is one SECTION holding one feature's flow, occasionally a single frame.
 * Sweeping the whole page to find it costs the other three hundred screens on the board, and
 * that cost is the only reason a capture ever takes long enough to need waiting on.
 *
 * Matching is by ancestry rather than by name: sections are the only containers walked into,
 * so a screen belongs to the requested node exactly when that node is one of its SECTION
 * ancestors - which `sectionIds` records as the walk descends.
 *
 * An empty id list means no restriction, so a caller can pass one through unconditionally.
 */
export function selectSubtree(screens: SceneTarget[], nodeIds: string[]): SceneTarget[] {
  const wanted = new Set(nodeIds.filter(Boolean).map(normaliseNodeId));
  if (wanted.size === 0) return screens;
  return screens.filter(
    (screen) =>
      wanted.has(normaliseNodeId(screen.id)) ||
      (screen.sectionIds ?? []).some((id) => wanted.has(normaliseNodeId(id)))
  );
}

/**
 * Numbers screens in the order a person reads the board: row by row down the section, left to
 * right along each row.
 *
 * A file name can only carry one linear order, and a prototype flow is a branching graph - the
 * same screen leads to two others - so no linearisation of the arrows is canonical. Nearly a
 * quarter of the screens on a real file have no connector attached at all and would get no
 * number from the graph. Layout, on the other hand, is defined for every screen, and designers
 * lay a flow out in the order they mean it to be read.
 *
 * Rows are found rather than assumed: screens are grouped by vertical proximity using half the
 * median screen height, so a tall screen sitting beside short ones does not start a new row.
 */
export function assignReadingOrder(screens: SceneTarget[]): SceneTarget[] {
  const groups = new Map<string, SceneTarget[]>();
  for (const screen of screens) {
    const key = JSON.stringify(screen.sectionPath);
    const group = groups.get(key);
    if (group) group.push(screen);
    else groups.set(key, [screen]);
  }

  const ordered = new Map<string, number>();
  for (const group of groups.values()) {
    const heights = group.map((s) => s.bounds.h).sort((a, b) => a - b);
    const tolerance = (heights[Math.floor(heights.length / 2)] ?? 0) * 0.5;

    const rows: Array<{ y: number; items: SceneTarget[] }> = [];
    for (const screen of [...group].sort((a, b) => a.bounds.y - b.bounds.y)) {
      const row = rows.find((r) => Math.abs(r.y - screen.bounds.y) <= tolerance);
      if (row) row.items.push(screen);
      else rows.push({ y: screen.bounds.y, items: [screen] });
    }

    let position = 0;
    for (const row of rows) {
      for (const screen of row.items.sort((a, b) => a.bounds.x - b.bounds.x)) {
        ordered.set(screen.id, ++position);
      }
    }
  }

  return screens.map((screen) => ({ ...screen, order: ordered.get(screen.id) }));
}

/**
 * Turns prototype arrows into edges between screens.
 *
 * An arrow lands somewhere inside a screen, so the screen that encloses the point owns it.
 * Where screens nest, the smallest enclosing one wins - an arrow pointing at a dialog means
 * the dialog, not the page behind it.
 *
 * The result is a graph, not a sequence: a screen may lead to several others. That is exactly
 * why the file names are numbered by layout instead - see assignReadingOrder - and why this
 * belongs in the manifest, which can hold a shape a file name cannot.
 */
export function resolveFlowEdges(
  screens: SceneTarget[],
  connectors: FlowConnector[]
): { edges: FlowEdge[]; unresolved: number } {
  const owner = (point: { x: number; y: number }): SceneTarget | undefined => {
    let best: SceneTarget | undefined;
    for (const screen of screens) {
      const { x, y, w, h } = screen.bounds;
      if (point.x < x || point.x > x + w || point.y < y || point.y > y + h) continue;
      if (!best || w * h < best.bounds.w * best.bounds.h) best = screen;
    }
    return best;
  };

  const edges: FlowEdge[] = [];
  const seen = new Set<string>();
  let unresolved = 0;

  for (const connector of connectors) {
    const from = owner(connector.from);
    const to = owner(connector.to);
    // A self-edge is an arrow looping inside one screen, which is not a step in the flow.
    if (!from || !to || from.id === to.id) {
      unresolved++;
      continue;
    }
    const key = from.id + ">" + to.id;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: from.id, to: to.id });
  }

  return { edges, unresolved };
}

/** One page ("canvas") of a Figma document. */
export interface ScenePage {
  id: string;
  name: string;
}

/**
 * Lists every page in the open Figma document.
 *
 * A link points at one page, but the document root holds them all, so a single session can
 * walk the whole file. Pages a designer uses as separators appear here too; they simply hold
 * nothing to capture and fall out on their own.
 */
export async function listScenePages(page: Page): Promise<ScenePage[]> {
  return await page.evaluate(() => {
    const graph = (window as any)._fullscreen_?._store?.getState?.()?.mirror?.sceneGraph;
    const root = graph?.getRoot?.();
    if (!root) throw new Error("Figma scene graph is not reachable on this page.");

    const pages: Array<{ id: string; name: string }> = [];
    for (const child of root.childrenNodes || []) {
      try {
        if (child.type === "CANVAS") pages.push({ id: child.guid, name: child.name || "Page" });
      } catch {
        // A page we cannot read is a page we cannot capture.
      }
    }
    return pages;
  });
}

/** The page the document currently has open. */
export async function getCurrentScenePage(page: Page): Promise<ScenePage | null> {
  return await page.evaluate(() => {
    const current = (window as any)._fullscreen_?._store?.getState?.()?.mirror?.sceneGraph?.getCurrentPage?.();
    if (!current) return null;
    try {
      return { id: current.guid, name: current.name || "Page" };
    } catch {
      return null;
    }
  });
}

/**
 * Switches the open document to another page and waits for it to load.
 *
 * Figma takes a page's id here, not the node - handing it the node object is rejected with
 * "Page not found". Switching in place costs a second; reopening the URL for each page costs
 * a full WebAssembly boot, which on a file this size is over a minute each.
 */
export async function setScenePage(
  page: Page,
  pageId: string,
  options: { timeoutMs?: number; contentTimeoutMs?: number; switchTimeoutMs?: number } = {}
): Promise<{ hasContent: boolean }> {
  const { timeoutMs = 60000, contentTimeoutMs = 20000, switchTimeoutMs = 60000 } = options;
  // Switching to a page with several hundred frames can block Figma's renderer for minutes,
  // and a blocked renderer cannot answer the very call that is waiting on it. Bound the
  // attempt so the caller can fall back to reopening the URL at that page instead of hanging.
  const switching = page.evaluate(async (id: string) => {
    const graph = (window as any)._fullscreen_?._store?.getState?.()?.mirror?.sceneGraph;
    if (!graph?.setCurrentPageAsync) return "Figma scene graph is not reachable on this page.";
    try {
      await graph.setCurrentPageAsync(id);
      return null;
    } catch (err: any) {
      return err?.message || String(err);
    }
  }, pageId);

  const failure = await Promise.race([
    switching.catch((err: any) => err?.message || String(err)),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve(`the page did not open within ${switchTimeoutMs}ms`), switchTimeoutMs)
    ),
  ]);

  if (failure) throw new Error(`Could not open Figma page ${pageId}: ${failure}`);

  await page.waitForFunction(
    (id: string) => {
      const graph = (window as any)._fullscreen_?._store?.getState?.()?.mirror?.sceneGraph;
      return graph?.getCurrentPage?.()?.guid === id;
    },
    { timeout: timeoutMs, polling: 250 },
    pageId
  );

  // A page becomes current before its contents have streamed in, so a fixed pause would
  // report a slow page as an empty one - the kind of loss that leaves no trace. Wait for
  // content instead, and say plainly when none arrived.
  try {
    await page.waitForFunction(
      () => {
        const graph = (window as any)._fullscreen_?._store?.getState?.()?.mirror?.sceneGraph;
        return (graph?.getCurrentPage?.()?.childrenNodes?.length ?? 0) > 0;
      },
      { timeout: contentTimeoutMs, polling: 500 }
    );
  } catch {
    return { hasContent: false };
  }

  // Let the last of the children settle before anything measures them.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return { hasContent: true };
}
