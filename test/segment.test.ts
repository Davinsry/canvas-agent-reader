import { describe, it, expect } from "vitest";
import path from "node:path";
import { computeContentBoxes } from "../src/extractors/figma/segment.js";
import { countMismatch } from "../src/extractors/figma/card-slicer.js";
import { toPascalCase, buildHierarchyDir } from "../src/extractors/figma/section-parser.js";

const CANVAS_GRAY: [number, number, number] = [229, 229, 229];
const WHITE: [number, number, number] = [255, 255, 255];

/** Builds an RGBA buffer filled with the Figma canvas backdrop. */
function makeImage(width: number, height: number, bg: [number, number, number] = CANVAS_GRAY) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bg[0];
    data[i + 1] = bg[1];
    data[i + 2] = bg[2];
    data[i + 3] = 255;
  }
  return data;
}

function fillRect(
  data: Uint8ClampedArray,
  width: number,
  rect: { x: number; y: number; width: number; height: number },
  color: [number, number, number] = WHITE
) {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const i = (y * width + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = 255;
    }
  }
}

describe("computeContentBoxes", () => {
  it("measures each card in a row instead of dividing the region evenly", () => {
    const width = 300;
    const height = 100;
    const data = makeImage(width, height);

    // Deliberately unequal widths - equal division would land on none of these borders.
    fillRect(data, width, { x: 10, y: 20, width: 50, height: 60 });
    fillRect(data, width, { x: 110, y: 20, width: 70, height: 60 });
    fillRect(data, width, { x: 230, y: 20, width: 50, height: 60 });

    const boxes = computeContentBoxes(width, height, data, { direction: "auto" });

    expect(boxes).toEqual([
      { x: 10, y: 20, width: 50, height: 60 },
      { x: 110, y: 20, width: 70, height: 60 },
      { x: 230, y: 20, width: 50, height: 60 },
    ]);
  });

  it("trims the surrounding backdrop off a single card", () => {
    const width = 100;
    const height = 100;
    const data = makeImage(width, height);
    fillRect(data, width, { x: 20, y: 30, width: 61, height: 61 });

    const boxes = computeContentBoxes(width, height, data);

    expect(boxes).toEqual([{ x: 20, y: 30, width: 61, height: 61 }]);
  });

  it("does not split a card on gaps narrower than minGap", () => {
    const width = 200;
    const height = 100;
    const data = makeImage(width, height);
    fillRect(data, width, { x: 10, y: 10, width: 40, height: 60 }); // left half
    fillRect(data, width, { x: 55, y: 10, width: 36, height: 60 }); // right half, 5px gutter

    const boxes = computeContentBoxes(width, height, data, { direction: "row", minGap: 12 });

    expect(boxes).toEqual([{ x: 10, y: 10, width: 81, height: 60 }]);
  });

  it("splits a column layout top to bottom", () => {
    const width = 100;
    const height = 300;
    const data = makeImage(width, height);
    fillRect(data, width, { x: 20, y: 10, width: 60, height: 80 });
    fillRect(data, width, { x: 20, y: 150, width: 60, height: 80 });

    const boxes = computeContentBoxes(width, height, data, { direction: "auto" });

    expect(boxes).toEqual([
      { x: 20, y: 10, width: 60, height: 80 },
      { x: 20, y: 150, width: 60, height: 80 },
    ]);
  });

  it("walks a grid row by row", () => {
    const width = 300;
    const height = 300;
    const data = makeImage(width, height);
    fillRect(data, width, { x: 10, y: 10, width: 80, height: 80 });
    fillRect(data, width, { x: 200, y: 10, width: 80, height: 80 });
    fillRect(data, width, { x: 10, y: 200, width: 80, height: 80 });
    fillRect(data, width, { x: 200, y: 200, width: 80, height: 80 });

    const boxes = computeContentBoxes(width, height, data, { direction: "grid" });

    expect(boxes).toEqual([
      { x: 10, y: 10, width: 80, height: 80 },
      { x: 200, y: 10, width: 80, height: 80 },
      { x: 10, y: 200, width: 80, height: 80 },
      { x: 200, y: 200, width: 80, height: 80 },
    ]);
  });

  it("still finds the backdrop when a card touches the top-left corner", () => {
    const width = 200;
    const height = 100;
    const data = makeImage(width, height);
    fillRect(data, width, { x: 0, y: 0, width: 50, height: 50 });
    fillRect(data, width, { x: 100, y: 20, width: 50, height: 50 });

    const boxes = computeContentBoxes(width, height, data, { direction: "row" });

    expect(boxes).toEqual([
      { x: 0, y: 0, width: 50, height: 50 },
      { x: 100, y: 20, width: 50, height: 50 },
    ]);
  });

  it("drops noise smaller than minSize", () => {
    const width = 200;
    const height = 100;
    const data = makeImage(width, height);
    fillRect(data, width, { x: 10, y: 10, width: 60, height: 60 });
    fillRect(data, width, { x: 150, y: 40, width: 6, height: 6 }); // cursor artefact

    const boxes = computeContentBoxes(width, height, data, { direction: "row", minSize: 40 });

    expect(boxes).toEqual([{ x: 10, y: 10, width: 60, height: 60 }]);
  });

  it("does not merge cards connected by a thin prototype flow connector line", () => {
    const width = 300;
    const height = 120;
    const data = makeImage(width, height);

    // Two cards separated by a 40px gutter
    fillRect(data, width, { x: 20, y: 20, width: 60, height: 80 });
    fillRect(data, width, { x: 120, y: 20, width: 60, height: 80 });

    // Thin 2px blue connector line bridging from card 1 to card 2
    fillRect(data, width, { x: 80, y: 50, width: 40, height: 2 }, [170, 190, 240]);

    const boxes = computeContentBoxes(width, height, data, { direction: "row", minGap: 12 });

    expect(boxes).toEqual([
      { x: 20, y: 20, width: 60, height: 80 },
      { x: 120, y: 20, width: 60, height: 80 },
    ]);
  });

  it("samples perimeter to reliably identify canvas background even when cards touch multiple corners", () => {
    const width = 300;
    const height = 150;
    const data = makeImage(width, height);

    // Cards touching top-left and top-right corners
    fillRect(data, width, { x: 0, y: 0, width: 60, height: 80 });
    fillRect(data, width, { x: 240, y: 0, width: 60, height: 80 });

    const boxes = computeContentBoxes(width, height, data, { direction: "row" });

    expect(boxes).toEqual([
      { x: 0, y: 0, width: 60, height: 80 },
      { x: 240, y: 0, width: 60, height: 80 },
    ]);
  });

  it("returns nothing for an empty canvas so the caller can fall back", () => {
    const width = 120;
    const height = 120;
    expect(computeContentBoxes(width, height, makeImage(width, height))).toEqual([]);
  });
});

describe("countMismatch", () => {
  const node = (index: number) => ({
    index,
    name: `step-${index + 1}`,
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    method: "segmented" as const,
  });

  it("stays silent when the measured count matches", () => {
    expect(countMismatch([node(0), node(1)], 2)).toBeUndefined();
  });

  it("stays silent when no count was expected", () => {
    expect(countMismatch([node(0), node(1)], undefined)).toBeUndefined();
  });

  it("reports how many cards were actually measured", () => {
    expect(countMismatch([node(0)], 5)).toContain("Expected 5");
    expect(countMismatch([node(0)], 5)).toContain("measured 1");
  });
});

describe("toPascalCase", () => {
  it("treats designers' arrows and ampersands as word breaks", () => {
    expect(toPascalCase("Create Stage 1 → User Profile Setup & Verification Period")).toBe(
      "CreateStage1UserProfileSetupVerificationPeriod"
    );
  });

  it("leaves no character a file system or pipeline has to escape", () => {
    for (const raw of ["Event Visibility → by Domain", "         ↳ Flow Step 1", "A ⇒ B ⟶ C"]) {
      expect(toPascalCase(raw)).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it("still handles the plain names it always did", () => {
    expect(toPascalCase("Job Posting")).toBe("JobPosting");
    expect(toPascalCase("detail_position")).toBe("DetailPosition");
  });
});

describe("buildHierarchyDir with a page level", () => {
  it("puts the page between the file folder and the section", () => {
    const dir = buildHierarchyDir({
      baseDir: "out",
      fileId: "KEY",
      page: "Overview",
      section: "Dashboard",
      subSection: "Analytics",
    });
    expect(dir.split(path.sep)).toEqual(["out", "figma-KEY", "Overview", "Dashboard", "Analytics"]);
  });

  it("omits the page level when there is none, so single-page output is unchanged", () => {
    const dir = buildHierarchyDir({ baseDir: "out", fileId: "KEY", section: "Dashboard" });
    expect(dir.split(path.sep)).toEqual(["out", "figma-KEY", "Dashboard"]);
  });
});

describe("toPascalCase on page names", () => {
  it("drops emoji and brackets that designers put in page names", () => {
    expect(toPascalCase("💻 Handover [Final Release]")).toBe("HandoverFinalRelease");
    expect(toPascalCase("      ↳01 Jan 2026 - 🚧 End-to-End Journey")).toBe("01Jan2026EndToEndJourney");
  });

  it("returns nothing for a separator page, so it never becomes a folder", () => {
    expect(toPascalCase("-----------------------------------------------------------")).toBe("");
  });

  it("keeps letters of other scripts rather than stripping them as symbols", () => {
    expect(toPascalCase("設定 Page")).toBe("設定Page");
  });
});
