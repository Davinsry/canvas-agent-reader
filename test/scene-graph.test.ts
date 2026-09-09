import { describe, it, expect } from "vitest";
import {
  resolveScreenNames,
  assignReadingOrder,
  resolveFlowEdges,
  selectSubtree,
  type SceneTarget,
} from "../src/extractors/figma/scene-graph.js";

let seq = 0;
const card = (label: string, x: number, y: number, w: number): SceneTarget => ({
  id: `c${seq++}`,
  name: "Supporting Card",
  type: "FRAME",
  sectionPath: [],
  bounds: { x, y, w, h: 88 },
  isTitleCard: true,
  label,
});
const screen = (name: string, x: number, y: number, w = 360, h = 640): SceneTarget => ({
  id: `s${seq++}`,
  name,
  type: "FRAME",
  sectionPath: [],
  bounds: { x, y, w, h },
});

describe("resolveScreenNames", () => {
  it("names a screen after the title card above it", () => {
    const out = resolveScreenNames([card("Application Submitted", 0, 0, 360), screen("Applied", 0, 150)]);
    expect(out.map((t) => t.name)).toEqual(["Application Submitted"]);
  });

  it("drops title cards so they never become files of their own", () => {
    const out = resolveScreenNames([card("Job Posting", 0, 0, 360), screen("Home", 0, 150)]);
    expect(out).toHaveLength(1);
    expect(out[0].isTitleCard).toBeUndefined();
  });

  it("gives every screen under a wide group banner the group's name", () => {
    const out = resolveScreenNames([
      card("Mandatory Requirement", 0, 0, 4324),
      screen("Home", 0, 150, 1280),
      screen("Home", 1480, 150, 1280),
      screen("Home", 2960, 150, 1280),
    ]);
    expect(out.map((t) => t.name)).toEqual([
      "Mandatory Requirement",
      "Mandatory Requirement",
      "Mandatory Requirement",
    ]);
  });

  it("keeps the layer name when no card sits above the screen", () => {
    const out = resolveScreenNames([screen("Detail Job", 0, 150)]);
    expect(out[0].name).toBe("Detail Job");
  });

  it("ignores a card too far above to belong to the screen", () => {
    const out = resolveScreenNames([card("Stale Header", 0, 0, 360), screen("Home", 0, 2000)]);
    expect(out[0].name).toBe("Home");
  });

  it("ignores a card that does not sit over the screen horizontally", () => {
    const out = resolveScreenNames([card("Other Column", 5000, 0, 360), screen("Home", 0, 150)]);
    expect(out[0].name).toBe("Home");
  });

  it("takes the closest banner when rows are stacked", () => {
    const out = resolveScreenNames([
      card("Row One", 0, 0, 360),
      card("Row Two", 0, 900, 360),
      screen("Home", 0, 1050),
    ]);
    expect(out[0].name).toBe("Row Two");
  });

  it("never names a screen after a card that sits below it", () => {
    const out = resolveScreenNames([card("Below", 0, 900, 360), screen("Home", 0, 150)]);
    expect(out[0].name).toBe("Home");
  });
});

describe("assignReadingOrder", () => {
  const at = (name: string, x: number, y: number, section = "Flow", h = 640): SceneTarget => ({
    id: `${section}:${name}:${x}:${y}`,
    name,
    type: "FRAME",
    sectionPath: [section],
    bounds: { x, y, w: 360, h },
  });
  const names = (out: SceneTarget[]) =>
    [...out].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((t) => t.name);

  it("numbers a single row left to right", () => {
    const out = assignReadingOrder([at("c", 800, 0), at("a", 0, 0), at("b", 400, 0)]);
    expect(names(out)).toEqual(["a", "b", "c"]);
  });

  it("finishes a row before moving to the one below", () => {
    const out = assignReadingOrder([at("b2", 400, 900), at("a1", 0, 0), at("b1", 400, 0), at("a2", 0, 900)]);
    expect(names(out)).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("keeps a taller screen in the row it is aligned with", () => {
    // A 1200px screen beside 640px ones is the same row, not a new one.
    const out = assignReadingOrder([at("tall", 400, 0, "Flow", 1200), at("left", 0, 0), at("right", 800, 0)]);
    expect(names(out)).toEqual(["left", "tall", "right"]);
  });

  it("numbers each section from one, since each becomes its own folder", () => {
    const out = assignReadingOrder([at("x", 0, 0, "A"), at("y", 400, 0, "A"), at("z", 0, 0, "B")]);
    const byName = Object.fromEntries(out.map((t) => [t.name, t.order]));
    expect(byName).toEqual({ x: 1, y: 2, z: 1 });
  });

  it("orders by position, not by the order nodes happen to arrive in", () => {
    const forward = assignReadingOrder([at("a", 0, 0), at("b", 400, 0)]);
    const reversed = assignReadingOrder([at("b", 400, 0), at("a", 0, 0)]);
    expect(names(forward)).toEqual(names(reversed));
  });
});

describe("resolveFlowEdges", () => {
  const box = (id: string, x: number, y: number, w = 100, h = 100): SceneTarget => ({
    id,
    name: id,
    type: "FRAME",
    sectionPath: [],
    bounds: { x, y, w, h },
  });
  const arrow = (fx: number, fy: number, tx: number, ty: number) => ({
    from: { x: fx, y: fy },
    to: { x: tx, y: ty },
  });

  it("joins the screens the arrow's ends land inside", () => {
    const out = resolveFlowEdges([box("a", 0, 0), box("b", 500, 0)], [arrow(50, 50, 550, 50)]);
    expect(out.edges).toEqual([{ from: "a", to: "b" }]);
    expect(out.unresolved).toBe(0);
  });

  it("keeps the direction the designer drew", () => {
    const out = resolveFlowEdges([box("a", 0, 0), box("b", 500, 0)], [arrow(550, 50, 50, 50)]);
    expect(out.edges).toEqual([{ from: "b", to: "a" }]);
  });

  it("attributes an arrow to the smallest screen enclosing its end", () => {
    // A dialog drawn on top of a page: the arrow means the dialog.
    const out = resolveFlowEdges(
      [box("page", 0, 0, 1000, 1000), box("dialog", 400, 400, 100, 100), box("start", 2000, 0)],
      [arrow(2050, 50, 450, 450)]
    );
    expect(out.edges).toEqual([{ from: "start", to: "dialog" }]);
  });

  it("records a branch as two edges out of the same screen", () => {
    const out = resolveFlowEdges(
      [box("a", 0, 0), box("b", 500, 0), box("c", 500, 500)],
      [arrow(50, 50, 550, 50), arrow(50, 50, 550, 550)]
    );
    expect(out.edges).toEqual([
      { from: "a", to: "b" },
      { from: "a", to: "c" },
    ]);
  });

  it("drops an arrow that loops inside one screen", () => {
    const out = resolveFlowEdges([box("a", 0, 0)], [arrow(10, 10, 90, 90)]);
    expect(out.edges).toEqual([]);
    expect(out.unresolved).toBe(1);
  });

  it("counts an arrow pointing at empty canvas instead of hiding it", () => {
    const out = resolveFlowEdges([box("a", 0, 0)], [arrow(50, 50, 9000, 9000)]);
    expect(out.edges).toEqual([]);
    expect(out.unresolved).toBe(1);
  });

  it("does not repeat a step drawn twice", () => {
    const out = resolveFlowEdges(
      [box("a", 0, 0), box("b", 500, 0)],
      [arrow(50, 50, 550, 50), arrow(60, 60, 560, 60)]
    );
    expect(out.edges).toHaveLength(1);
  });
});

describe("selectSubtree", () => {
  const inSection = (id: string, sectionIds: string[]): SceneTarget => ({
    id,
    name: id,
    type: "FRAME",
    sectionPath: sectionIds.map((s) => `section-${s}`),
    sectionIds,
    bounds: { x: 0, y: 0, w: 360, h: 640 },
  });

  it("keeps every screen under the requested section", () => {
    const out = selectSubtree(
      [inSection("1:1", ["9:9"]), inSection("1:2", ["9:9"]), inSection("1:3", ["8:8"])],
      ["9:9"]
    );
    expect(out.map((s) => s.id)).toEqual(["1:1", "1:2"]);
  });

  it("reaches a screen nested several sections deep", () => {
    const out = selectSubtree([inSection("1:1", ["9:9", "7:7", "6:6"])], ["7:7"]);
    expect(out).toHaveLength(1);
  });

  it("matches a link's hyphenated node id against the graph's colons", () => {
    const out = selectSubtree([inSection("1:1", ["1234:5678"])], ["1234-5678"]);
    expect(out).toHaveLength(1);
  });

  it("keeps a screen asked for by its own id", () => {
    const out = selectSubtree([inSection("1:1", ["9:9"]), inSection("1:2", ["9:9"])], ["1:2"]);
    expect(out.map((s) => s.id)).toEqual(["1:2"]);
  });

  it("returns nothing when the id is on the board but holds no screens", () => {
    // A typo'd or empty node must not quietly become a full-page sweep: the caller has to be
    // able to tell "this section is empty" from "you asked for everything".
    expect(selectSubtree([inSection("1:1", ["9:9"])], ["5:5"])).toEqual([]);
  });

  it("treats an empty id list as no restriction", () => {
    const all = [inSection("1:1", ["9:9"]), inSection("1:2", [])];
    expect(selectSubtree(all, [])).toHaveLength(2);
  });

  it("keeps a page-level screen only when asked for by its own id", () => {
    const loose = inSection("1:9", []);
    expect(selectSubtree([loose], ["1:9"])).toHaveLength(1);
    expect(selectSubtree([loose], ["9:9"])).toHaveLength(0);
  });
});
