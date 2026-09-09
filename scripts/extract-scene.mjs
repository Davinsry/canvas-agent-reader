#!/usr/bin/env node
/**
 * Captures every screen of a Figma page as its own PNG, using Figma's own scene graph for the
 * geometry and layer names. No Figma API key, no access token, no hardcoded coordinates.
 *
 *   node scripts/extract-scene.mjs "<figma url>" [--limit N] [--out DIR] [--headful]
 */
import {
  getBrowserSession,
  parseFigmaUrl,
  waitForSceneGraph,
  captureScenePage,
  listScenePages,
  setScenePage,
  getCurrentScenePage,
  parseSectionHierarchy,
} from '../dist/index.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const url = args.find((a) => a.startsWith('http'));
if (!url) {
  console.error('Usage: node scripts/extract-scene.mjs "<figma url>" [--all-pages] [--limit N] [--out DIR] [--headful]');
  process.exit(1);
}

const parsed = parseFigmaUrl(url);
if (!parsed.isValid) {
  console.error(`Not a Figma URL: ${url}`);
  process.exit(1);
}

const VIEWPORT_WIDTH = Number(flag('--width', 1920));
const VIEWPORT_HEIGHT = Number(flag('--height', 2400));
const limit = flag('--limit') ? Number(flag('--limit')) : undefined;
const baseDir = flag('--out');

const session = await getBrowserSession({
  headless: !args.includes('--headful'),
  // deviceScaleFactor 2 renders text at Retina density, which is what a vision model needs to
  // read a 12px label without guessing.
  viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 2 },
});

try {
  session.page.setDefaultNavigationTimeout(180000);
  console.log(`Opening ${parsed.fileName || parsed.fileKey} ...`);
  await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });

  await session.page.waitForSelector('canvas', { timeout: 180000 });
  await waitForSceneGraph(session.page, 180000);
  console.log('Scene graph loaded.');

  const capture = (pageFolder) =>
    captureScenePage(session.page, {
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
      baseDir,
      fileKey: parsed.fileKey,
      pageFolder,
      limit,
      onProgress: (done, total, node) => {
        const where = [...node.sectionPath, node.name].join(' / ');
        const status = node.error ? `FAILED (${node.error})` : `${node.zoom}x`;
        console.log(`[${String(done).padStart(3)}/${total}] ${status.padEnd(14)} ${where}`);
      },
    });

  const summarise = (report) => {
    console.log('');
    console.log(`Page          : ${report.pageName}`);
    console.log(`Captured      : ${report.captured}/${report.expected}`);
    if (report.failed) console.log(`Failed        : ${report.failed}`);
    console.log(`Flow steps    : ${report.flow.length} (${report.unresolvedConnectors} arrows unresolved)`);
    console.log(`Skipped types : ${report.skipped.map((s) => `${s.type}=${s.count}`).join(', ') || 'none'}`);
    console.log(`Manifest      : ${report.manifestPath}`);
  };

  if (!args.includes('--all-pages')) {
    const report = await capture(undefined);
    summarise(report);
    if (report.captured !== report.expected) process.exitCode = 1;
  } else {
    // Pages of one file reuse section names, so each needs its own folder to land in.
    const pages = await listScenePages(session.page);
    console.log(`Document has ${pages.length} pages.`);
    const totals = { captured: 0, expected: 0, failed: 0, empty: [] };

    for (const [index, figmaPage] of pages.entries()) {
      const folder = parseSectionHierarchy(figmaPage.name).section || `Page${index + 1}`;
      console.log(`
=== [${index + 1}/${pages.length}] ${figmaPage.name.trim() || '(unnamed)'} -> ${folder} ===`);
      let hasContent = true;
      try {
        ({ hasContent } = await setScenePage(session.page, figmaPage.id));
      } catch (err) {
        // Switching in place is the fast path, not the only one: a page big enough to block
        // the renderer is still reachable by reopening the file at it.
        console.log(`  in-place switch failed (${err.message}); reopening the file at this page`);
        try {
          const pageUrl = new URL(url);
          pageUrl.searchParams.set('node-id', figmaPage.id.replace(':', '-'));
          await session.page.goto(pageUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 180000 });
          await session.page.waitForSelector('canvas', { timeout: 180000 });
          await waitForSceneGraph(session.page, 180000);

          // Figma silently redirects a node-id it will not open to the default page. Landing
          // somewhere else and captioning it with the name we asked for would be worse than
          // not capturing it at all.
          const landed = await getCurrentScenePage(session.page);
          if (!landed || landed.id !== figmaPage.id) {
            console.log(`  reopening landed on "${(landed?.name || '?').trim()}" instead; skipping this page.`);
            process.exitCode = 1;
            continue;
          }
          hasContent = true;
        } catch (reloadErr) {
          console.log(`  could not open: ${reloadErr.message}`);
          process.exitCode = 1;
          continue;
        }
      }

      if (!hasContent) {
        console.log('  no content arrived for this page (empty, or slower than the wait).');
        totals.empty.push(figmaPage.name.trim() || '(unnamed)');
        continue;
      }

      const report = await capture(folder);
      if (report.expected === 0) {
        console.log('  nothing to capture on this page.');
        totals.empty.push(figmaPage.name.trim() || '(unnamed)');
        continue;
      }
      summarise(report);
      totals.captured += report.captured;
      totals.expected += report.expected;
      totals.failed += report.failed;
    }

    console.log('');
    console.log(`ALL PAGES     : ${totals.captured}/${totals.expected} captured, ${totals.failed} failed`);
    console.log(`Empty pages   : ${totals.empty.length}${totals.empty.length ? ' (' + totals.empty.join(', ') + ')' : ''}`);
    if (totals.captured !== totals.expected) process.exitCode = 1;
  }
} finally {
  await session.close();
}
