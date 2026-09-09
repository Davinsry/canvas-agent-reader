import { describe, it, expect } from "vitest";
import { sceneToScreen, type FigmaViewportInfo } from "../src/extractors/figma/viewport.js";
import { zoomToFit, fitsInWindow } from "../src/extractors/figma/scene-capture.js";

const view = (over: Partial<FigmaViewportInfo> = {}): FigmaViewportInfo => ({
  x: 0,
  y: 0,
  width: 1920,
  height: 1200,
  offsetX: 0,
  offsetY: 0,
  zoomScale: 1,
  isZooming: false,
  isPanning: false,
  ...over,
});

describe("sceneToScreen", () => {
  it("puts the scene point under the viewport centre at the viewport centre", () => {
    const rect = sceneToScreen({ x: 500, y: 300, w: 10, h: 10 }, view({ offsetX: 500, offsetY: 300 }), 1920, 1200);
    expect(rect.x).toBe(960);
    expect(rect.y).toBe(600);
  });

  it("reproduces the transform measured against the live canvas", () => {
    // Captured from a real session: frame "Job Posting" landed at exactly x=782, y=136.
    const rect = sceneToScreen(
      { x: -1921, y: -2166, w: 360, h: 936 },
      view({ offsetX: -1743, offsetY: -1702 }),
      1920,
      1200
    );
    expect(rect).toEqual({ x: 782, y: 136, width: 360, height: 936 });
  });

  it("scales the rectangle by the canvas zoom", () => {
    const rect = sceneToScreen({ x: 0, y: 0, w: 400, h: 200 }, view({ zoomScale: 0.25 }), 1920, 1200);
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(50);
  });
});

describe("zoomToFit", () => {
  it("stays at 1:1 for a frame that already fits", () => {
    expect(zoomToFit(360, 936, 1920, 1200)).toBe(1);
  });

  it("only ever returns powers of two, because that is all Figma's zoom steps can hit", () => {
    for (const [w, h] of [[4081, 4306], [2600, 900], [12000, 400]] as const) {
      const zoom = zoomToFit(w, h, 1920, 1200);
      expect(Number.isInteger(Math.log2(zoom))).toBe(true);
    }
  });

  it("steps down until an oversized frame fits inside the viewport", () => {
    const zoom = zoomToFit(4081, 4306, 1920, 1200);
    expect(4081 * zoom).toBeLessThanOrEqual(1920 * 0.96);
    expect(4306 * zoom).toBeLessThanOrEqual(1200 * 0.96);
    expect(zoomToFit(4081, 4306, 1920, 1200) * 2).toBeGreaterThan(zoom);
  });
});

describe("fitsInWindow", () => {
  it("accepts a tall page that still fits under the renderer's texture limit", () => {
    expect(fitsInWindow(6184, 2)).toBe(true);
  });

  it("rejects a frame whose window would exceed the texture limit", () => {
    expect(fitsInWindow(9000, 2)).toBe(false);
  });

  it("accepts that same frame at a lower device scale factor", () => {
    expect(fitsInWindow(9000, 1)).toBe(true);
  });
});
