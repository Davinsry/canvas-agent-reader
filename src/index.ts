import "dotenv/config";

// Browser
export { getBrowserSession, type BrowserConnectOptions, type BrowserContextSession } from "./browser/connector.js";
export { getDefaultChromiumArgs, findSystemBrowserPath } from "./browser/webgl-flags.js";

// Figma Extractor
export { parseFigmaUrl, type ParsedFigmaUrl } from "./extractors/figma/url-parser.js";
export {
  inspectFigmaPageStatus,
  waitForFigmaCanvasReady,
  dismissFigmaOverlays,
  ensureFigmaZoom100,
  panFigmaCanvas,
  hideFigmaChrome,
  type FigmaPageStatus,
} from "./extractors/figma/bridge.js";
export { inspectFigmaNode, type FigmaInspectOptions, type FigmaNodeInspectionResult } from "./extractors/figma/inspector.js";
export {
  extractAndSliceChildCards,
  countMismatch,
  type SlicedChildNode,
  type BoundingBox,
  type SplitChildrenOptions,
} from "./extractors/figma/card-slicer.js";
export {
  computeContentBoxes,
  detectContentBoxes,
  sliceBoxesFromBuffer,
  type ContentBox,
  type SegmentOptions,
  type DetectionResult,
} from "./extractors/figma/segment.js";
export {
  readSceneTargets,
  resolveScreenNames,
  assignReadingOrder,
  resolveFlowEdges,
  selectSubtree,
  resolveSceneNode,
  type ResolvedSceneNode,
  type FlowConnector,
  type FlowEdge,
  DEFAULT_TITLE_PATTERN,
  waitForSceneGraph,
  listScenePages,
  setScenePage,
  getCurrentScenePage,
  type ScenePage,
  type SceneTarget,
  type SceneSnapshot,
} from "./extractors/figma/scene-graph.js";
export {
  getViewportInfo,
  sceneToScreen,
  setZoom,
  panTo,
  type FigmaViewportInfo,
  type SceneRect,
} from "./extractors/figma/viewport.js";
export {
  captureScenePage,
  zoomToFit,
  fitsInWindow,
  type CaptureOptions,
  type CapturedNode,
  type CaptureReport,
} from "./extractors/figma/scene-capture.js";
export {
  parseSectionHierarchy,
  buildHierarchyDir,
  formatCardFileName,
  toPascalCase,
  sanitizePathComponent,
  type ParsedSectionHierarchy,
} from "./extractors/figma/section-parser.js";

// Generic WebGL / Canvas Extractor
export {
  inspectGenericCanvas,
  type CanvasInspectOptions,
  type GenericCanvasInspectionResult,
  type CanvasInfo,
} from "./extractors/generic-canvas.js";

// MCP Server
export { startMcpServer } from "./mcp/server.js";