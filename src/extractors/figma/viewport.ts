import type { Page } from "puppeteer-core";

/**
 * Figma's canvas transform, read straight out of the running app.
 *
 * `offsetX`/`offsetY` are the scene coordinates sitting at the centre of the viewport, and
 * `zoomScale` is the scene-to-CSS-pixel ratio. Everything in this module is built on the
 * mapping that follows from those two facts:
 *
 *   screenX = (sceneX - offsetX) * zoomScale + viewportWidth / 2
 */
export interface FigmaViewportInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  zoomScale: number;
  isZooming: boolean;
  isPanning: boolean;
}

export interface SceneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FULLSCREEN_MISSING = "Figma's internal app object (window._fullscreen_) is not available on this page.";

export async function getViewportInfo(page: Page): Promise<FigmaViewportInfo> {
  const info = await page.evaluate(() => {
    const f = (window as any)._fullscreen_;
    return f?.getViewportInfo ? f.getViewportInfo() : null;
  });
  if (!info) throw new Error(FULLSCREEN_MISSING);
  return info as FigmaViewportInfo;
}

/**
 * Converts a scene rectangle into a CSS-pixel rectangle on screen.
 *
 * The caller must pass the viewport info that was read *after* the last pan, never the one it
 * aimed for: the clip is then correct no matter where the pan actually landed.
 */
export function sceneToScreen(
  rect: SceneRect,
  view: FigmaViewportInfo,
  viewportWidth: number,
  viewportHeight: number
): { x: number; y: number; width: number; height: number } {
  return {
    x: (rect.x - view.offsetX) * view.zoomScale + viewportWidth / 2,
    y: (rect.y - view.offsetY) * view.zoomScale + viewportHeight / 2,
    width: rect.w * view.zoomScale,
    height: rect.h * view.zoomScale,
  };
}

/**
 * Sends a keyboard shortcut straight into Figma's WebAssembly engine.
 *
 * Puppeteer's own `keyboard.press` goes through DOM focus, which an anonymous view-only
 * session does not reliably give to the canvas. Figma exposes its own event entry point, so
 * we hand it a synthetic event and skip focus entirely.
 */
async function forwardKey(
  page: Page,
  key: string,
  code: string,
  keyCode: number,
  modifiers: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}
): Promise<void> {
  await page.evaluate(
    (key, code, keyCode, modifiers) => {
      const f = (window as any)._fullscreen_;
      if (!f?.forwardKeyboardEvent) return;
      f.forwardKeyboardEvent(
        new KeyboardEvent("keydown", {
          key,
          code,
          keyCode,
          which: keyCode,
          bubbles: true,
          cancelable: true,
          ...modifiers,
        })
      );
    },
    key,
    code,
    keyCode,
    modifiers
  );
}

/**
 * Steps the canvas zoom until it reaches `target`.
 *
 * Ctrl+Plus / Ctrl+Minus move Figma's zoom in exact factors of two, so any power of two -
 * 1, 0.5, 0.25 - is hit precisely rather than approached. Shift+0 ("zoom to 100%") is ignored
 * in anonymous view-only sessions, which is why this steps instead.
 */
export async function setZoom(page: Page, target: number, maxSteps = 40): Promise<number> {
  for (let i = 0; i < maxSteps; i++) {
    const view = await getViewportInfo(page);
    if (Math.abs(view.zoomScale - target) < target * 1e-4) return view.zoomScale;

    if (view.zoomScale < target) await forwardKey(page, "=", "Equal", 187, { ctrlKey: true });
    else await forwardKey(page, "-", "Minus", 189, { ctrlKey: true });

    await new Promise((r) => setTimeout(r, 350));
  }
  return (await getViewportInfo(page)).zoomScale;
}

/**
 * Pans the canvas until the given scene point sits at the centre of the viewport.
 *
 * Space + mouse drag maps one screen pixel to exactly one CSS pixel of canvas movement (the
 * mouse wheel does not - Figma damps and smooths it). Each pass re-reads the real viewport and
 * corrects, so drag rounding cannot accumulate.
 */
export async function panTo(
  page: Page,
  sceneX: number,
  sceneY: number,
  viewportWidth: number,
  viewportHeight: number,
  options: { tolerance?: number; maxPasses?: number; maxStepPx?: number } = {}
): Promise<FigmaViewportInfo> {
  const { tolerance = 1, maxPasses = 8, maxStepPx = 600 } = options;

  for (let pass = 0; pass < maxPasses; pass++) {
    const view = await getViewportInfo(page);
    const dxScene = sceneX - view.offsetX;
    const dyScene = sceneY - view.offsetY;
    if (Math.abs(dxScene) <= tolerance && Math.abs(dyScene) <= tolerance) return view;

    // Dragging content left raises offsetX, hence the sign flip.
    const dScreenX = -dxScene * view.zoomScale;
    const dScreenY = -dyScene * view.zoomScale;

    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dScreenX), Math.abs(dScreenY)) / maxStepPx));
    for (let i = 0; i < steps; i++) {
      const stepX = dScreenX / steps;
      const stepY = dScreenY / steps;
      const startX = Math.round(viewportWidth / 2 - stepX / 2);
      const startY = Math.round(viewportHeight / 2 - stepY / 2);

      await page.keyboard.down("Space");
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(Math.round(startX + stepX), Math.round(startY + stepY), { steps: 10 });
      await page.mouse.up();
      await page.keyboard.up("Space");
      await new Promise((r) => setTimeout(r, 80));
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return await getViewportInfo(page);
}
