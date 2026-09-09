import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
  getBrowserSession,
  parseFigmaUrl,
  waitForFigmaCanvasReady,
  hideFigmaChrome,
  detectContentBoxes,
  sliceBoxesFromBuffer,
  parseSectionHierarchy,
  inspectFigmaPageStatus
} from '../dist/index.mjs';

function getTargetOptions() {
  const args = process.argv.slice(2);
  const isSingle = args.includes('--single') || args.includes('-s');
  const isAll = args.includes('--all') || args.includes('-a') || (!isSingle);
  
  const limitIdx = args.findIndex(a => a === '--limit' || a === '-l');
  const limit = limitIdx !== -1 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : undefined;

  const urls = args.filter((a, idx) => {
    if (a.startsWith('-')) return false;
    if (limitIdx !== -1 && (idx === limitIdx || idx === limitIdx + 1)) return false;
    return true;
  });

  if (urls.length > 0) {
    return { urls, autoDiscoverAll: isAll && !isSingle, limit };
  }

  if (process.env.FIGMA_URL) {
    return { urls: [process.env.FIGMA_URL], autoDiscoverAll: isAll && !isSingle, limit };
  }

  return { urls: [], autoDiscoverAll: true, limit };
}

async function discoverAllSections(page) {
  console.log(` -> Membuka panel Layers untuk membaca seluruh daftar section...`);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
    const target = btns.find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('expand ui'));
    if (target) target.click();
  });
  
  try {
    await page.waitForSelector('[data-testid$="-layers-panel-row"]', { timeout: 8000 });
  } catch {}
  await new Promise(r => setTimeout(r, 1500));

  const sections = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid$="-layers-panel-row"]'));
    return rows.map(r => {
      const tid = r.getAttribute('data-testid') || '';
      const m = tid.match(/^(.+)-layers-panel-row$/);
      const rawId = m ? m[1] : '';
      const text = (r.innerText || r.textContent || '').trim().split('\n')[0];
      return {
        name: text,
        nodeIdColon: rawId,
        nodeIdHyphen: rawId.replace(':', '-')
      };
    }).filter(s => s.name.length > 2 && (s.name.includes('[') || s.name.includes('Master') || s.name.includes('View')));
  });

  return sections;
}

async function detectSectionBoundsFromBuffer(page, b64) {
  return await page.evaluate((srcB64) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        const w = img.width;
        const h = img.height;
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;

        // Search vertically excluding top 5% and bottom 15%
        const minYSearch = Math.floor(h * 0.05);
        const maxYSearch = Math.floor(h * 0.85);

        const rowCounts = new Int32Array(h);
        const colCounts = new Int32Array(w);

        for (let y = minYSearch; y < maxYSearch; y++) {
          const rowOffset = y * w;
          for (let x = 0; x < w; x++) {
            const idx = (rowOffset + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            // Figma selection blue outline: #0D99FF
            if (b > 210 && r < 60 && g > 110 && g < 180) {
              rowCounts[y]++;
              colCounts[x]++;
            }
          }
        }

        const minLineWidth = Math.max(200, Math.floor(w * 0.05));
        const blueRows = [];
        for (let y = minYSearch; y < maxYSearch; y++) {
          if (rowCounts[y] >= minLineWidth) {
            blueRows.push(y);
          }
        }

        const blueCols = [];
        for (let x = 0; x < w; x++) {
          if (colCounts[x] >= 100) {
            blueCols.push(x);
          }
        }

        if (blueRows.length >= 2 && blueCols.length >= 2) {
          const topY = blueRows[0];
          const bottomY = blueRows[blueRows.length - 1];
          const leftX = blueCols[0];
          const rightX = blueCols[blueCols.length - 1];
          const pad = 15; // Inset inside blue outline
          resolve({
            found: true,
            x: leftX + pad,
            y: topY + pad,
            width: Math.max(100, (rightX - leftX) - (pad * 2)),
            height: Math.max(100, (bottomY - topY) - (pad * 2))
          });
        } else {
          resolve({
            found: false,
            x: 0,
            y: 0,
            width: w,
            height: Math.floor(h * 0.85)
          });
        }
      };
      img.src = 'data:image/png;base64,' + srcB64;
    });
  }, b64);
}

function resolveSectionFolder(name, parsedNodeId) {
  if (name) {
    const hierarchy = parseSectionHierarchy(name);
    if (hierarchy.section && hierarchy.section !== 'DefaultSection') {
      return hierarchy.subSection
        ? path.join(hierarchy.section, hierarchy.subSection)
        : hierarchy.section;
    }
    return name.replace(/[<>:"/\\|?*]/g, '_').trim();
  }
  return `section-${parsedNodeId || 'unknown'}`;
}

async function processSection(page, { url, name, index, totalSections, outputBaseDir, fileKey }) {
  const parsed = parseFigmaUrl(url);

  // Clean navigation to reset Figma WebAssembly camera
  await page.goto('about:blank');
  await new Promise(r => setTimeout(r, 1200));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitForFigmaCanvasReady(page, 90000);
  await new Promise(r => setTimeout(r, 3500));

  let finalName = name;
  if (!finalName) {
    const status = await inspectFigmaPageStatus(page);
    if (status.detectedFrames && status.detectedFrames.length > 0) {
      finalName = status.detectedFrames[0];
    }
  }

  const sectionFolderName = resolveSectionFolder(finalName, parsed.nodeIdHyphen);
  const targetDir = path.join(outputBaseDir, `figma-${fileKey}`, sectionFolderName);
  fs.mkdirSync(targetDir, { recursive: true });

  console.log(`\n------------------------------------------------------------------------------`);
  console.log(`[SECTION ${index}/${totalSections}] ${finalName || parsed.nodeIdHyphen}`);
  console.log(`Node ID  : ${parsed.nodeIdHyphen}`);
  console.log(`URL      : ${url}`);
  console.log(`Folder   : ${path.relative(process.cwd(), targetDir)}`);
  console.log(`------------------------------------------------------------------------------`);

  await page.keyboard.press('Escape');
  await hideFigmaChrome(page);
  await new Promise(r => setTimeout(r, 1000));

  const screenshotBuf = await page.screenshot({ type: 'png' });
  const shotB64 = screenshotBuf.toString('base64');

  // Detect exact section boundary
  const bounds = await detectSectionBoundsFromBuffer(page, shotB64);

  // Crop section buffer inside browser
  const sectionB64 = await page.evaluate(({ srcB64, bounds }) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = bounds.width;
        c.height = bounds.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
        resolve(c.toDataURL('image/png').split(',')[1]);
      };
      img.src = 'data:image/png;base64,' + srcB64;
    });
  }, { srcB64: shotB64, bounds });

  // Detect individual cards inside section
  const detection = await detectContentBoxes(page, sectionB64, {
    direction: 'grid',
    minGap: 16,
    minSize: 120,
    minDensity: 0.01
  });

  const cardsCount = detection.boxes.length;
  console.log(`-> Cek per section: Terdeteksi ${cardsCount > 0 ? cardsCount : 1} card / gambar.`);

  const savedFiles = [];

  if (cardsCount > 0) {
    const slices = await sliceBoxesFromBuffer(page, sectionB64, detection.boxes);
    for (let i = 0; i < slices.length; i++) {
      const num = String(i + 1).padStart(2, '0');
      const totalStr = String(cardsCount).padStart(2, '0');
      const fileName = `${num}-card-${i + 1}.png`;
      const filePath = path.join(targetDir, fileName);
      fs.writeFileSync(filePath, Buffer.from(slices[i].base64, 'base64'));
      savedFiles.push(fileName);
      console.log(`   [✓] Card ${num}/${totalStr} : ${fileName} (tersimpan)`);
    }
  } else {
    // Fallback if no distinct sub-cards, save the clean section snapshot
    const fileName = `01-section-full.png`;
    const filePath = path.join(targetDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(sectionB64, 'base64'));
    savedFiles.push(fileName);
    console.log(`   [✓] Card 01/01 : ${fileName} (tersimpan snapshot utuh)`);
  }

  return savedFiles.length;
}

async function main() {
  const { urls, autoDiscoverAll, limit } = getTargetOptions();

  if (urls.length === 0) {
    console.log(`
==============================================================================
[canvas-agent-reader] BATCH & AUTO-DISCOVER FIGMA EXTRACTOR
==============================================================================
Cara pakai:
  1. Konfigurasi link Figma di file .env Anda:
     FIGMA_URL="https://www.figma.com/design/..."
     lalu jalankan:
     npm run extract

  2. Atau jalankan via CLI langsung:
     node scripts/extract.mjs "https://www.figma.com/design/..."

  3. Ekstrak 1 section spesifik saja:
     node scripts/extract.mjs "https://www.figma.com/design/...?...node-id=..." --single
==============================================================================`);
    process.exit(0);
  }

  let session = null;
  const startTimeTotal = Date.now();
  const outputBaseDir = path.resolve('output');

  try {
    console.log(`
==============================================================================
[canvas-agent-reader] Menyiapkan Ekstraksi (Retina 4K 3840x2800)
==============================================================================`);

    session = await getBrowserSession({
      headless: true,
      viewport: { width: 3840, height: 2800, deviceScaleFactor: 2 }
    });
    const page = session.page;
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(90000);

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const firstUrl = urls[0];
    const firstParsed = parseFigmaUrl(firstUrl);
    const fileKey = firstParsed.fileKey || 'unknown';

    let sectionsToProcess = [];

    if (autoDiscoverAll) {
      console.log(`\n[MODE AUTO-DISCOVER AKTIF] Membuka link untuk membaca semua section...`);
      await page.goto(firstUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await waitForFigmaCanvasReady(page, 90000);
      await new Promise(r => setTimeout(r, 4000));
      await page.keyboard.press('Escape');

      const discovered = await discoverAllSections(page);
      if (discovered.length > 0) {
        console.log(`\n-> Berhasil mendeteksi ${discovered.length} section dari link ini:`);
        discovered.forEach((s, i) => console.log(`   ${i + 1}. ${s.name} (node-id=${s.nodeIdHyphen})`));

        sectionsToProcess = discovered.map(s => ({
          name: s.name,
          url: `https://www.figma.com/design/${fileKey}/${firstParsed.fileName || 'design'}?node-id=${s.nodeIdHyphen}`
        }));
      } else {
        console.log(` -> Tidak mendeteksi panel layer section tambahan, memproses URL target langsung.`);
        sectionsToProcess = urls.map(u => ({ url: u, name: null }));
      }
    } else {
      sectionsToProcess = urls.map(u => ({ url: u, name: null }));
    }

    if (limit && limit > 0) {
      console.log(`\n[INFO] Dibatasi ${limit} section pertama sesuai flag --limit.`);
      sectionsToProcess = sectionsToProcess.slice(0, limit);
    }

    console.log(`\nMemulai ekstraksi ${sectionsToProcess.length} section...`);

    let totalPhotos = 0;
    let totalSections = 0;

    for (let idx = 0; idx < sectionsToProcess.length; idx++) {
      const item = sectionsToProcess[idx];
      const count = await processSection(page, {
        url: item.url,
        name: item.name,
        index: idx + 1,
        totalSections: sectionsToProcess.length,
        outputBaseDir,
        fileKey
      });
      totalPhotos += count;
      totalSections += 1;
    }

    const totalElapsed = ((Date.now() - startTimeTotal) / 1000).toFixed(1);
    console.log(`
==============================================================================
RINGKASAN EKSTRAKSI:
Total Foto    : ${totalPhotos}
Total Section : ${totalSections}
Waktu Total   : ${totalElapsed} detik
Output Path   : ${path.join(outputBaseDir, `figma-${fileKey}`)}
==============================================================================`);

  } catch (err) {
    console.error(`\n[ERROR] Terjadi kesalahan saat ekstraksi:`, err);
  } finally {
    if (session) {
      await session.close().catch(() => {});
    }
  }
}

main();
