# Architecture & Specification: `canvas-agent-reader`

A standalone, agnostic Node.js/TypeScript package and MCP Server that enables AI agents to inspect, read, and extract visual & semantic data from WebGL and Canvas-based web applications (with specialized deep support for Figma).

---

## 1. Background & Problem Statement

Modern web applications increasingly render complex user interfaces inside `<canvas>` using **WebGL and WebAssembly (WASM)** instead of standard HTML DOM elements:
- **Figma** compiles a C++ rendering engine into WASM, rendering vector graphics directly to a WebGL canvas.
- To an AI agent or standard web scraper, the DOM contains only a blank `<canvas>` element. The visual hierarchy, text, layers, styling, and geometry are opaque raw GPU buffers.
- The official Figma REST API imposes strict rate limits (e.g. 6 requests/month on Starter plans, 10/min on Pro) and requires personal access tokens with specific organizational permissions.

`canvas-agent-reader` solves this by giving agents eyes and semantic extraction capabilities for Canvas/WebGL applications without relying on rate-limited third-party REST APIs.

---

## 2. Core Architecture

```
                                  +-----------------------+
                                  |       AI Agent        |
                                  | (Hermes / Claude/ etc)|
                                  +-----------+-----------+
                                              |
                   +--------------------------+--------------------------+
                   | (MCP / stdio)            | (CLI Subprocess)         | (TS/Node API)
                   v                          v                          v
       +-------------------------------------------------------------------------+
       |                         canvas-agent-reader                             |
       |                                                                         |
       |  +------------------------+             +----------------------------+  |
       |  |     Browser Runner     |             |      Session Manager       |  |
       |  |  (Playwright / CDP)    |             | (Connect to active Chrome  |  |
       |  |  - GPU WebGL enabled   |             |  or persist user cookies)  |  |
       |  +-----------+------------+             +-------------+--------------+  |
       |              |                                        |                 |
       |              +-------------------+--------------------+                 |
       |                                  |                                      |
       |                                  v                                      |
       |  +-------------------------------------------------------------------+  |
       |  |                       Core Extraction Engines                     |  |
       |  |                                                                   |  |
       |  |  [1] Canvas Visual Engine         [2] Figma Injected Bridge       |  |
       |  |  - Framebuffer capture            - Runtime scene graph query     |  |
       |  |  - High-DPI node crop             - Node bounding box & CSS       |  |
       |  |  - Viewport auto-pan to node      - Direct SVG & PNG export       |  |
       |  |  - Visual grid & coordinate map   - Text content extraction       |  |
       |  +-------------------------------------------------------------------+  |
       +-------------------------------------------------------------------------+
                                          |
                                          v
                              +-----------------------+
                              |    Target WebGL /     |
                              |     Figma Canvas      |
                              +-----------------------+
```

---

## 3. The Extraction Workflow (Step-by-Step)

### Phase 1: Browser Session & Target Resolution
1. **Connection Mode**:
   - **Mode A (Attach to Active User Chrome)**: Connects via Chrome DevTools Protocol (`http://127.0.0.1:9222`). The agent leverages the user's existing authenticated Figma session immediately with zero login hassle.
   - **Mode B (Dedicated Headless/Headed Runner)**: Launches an isolated Chromium instance with persistent storage (`userDataDir`) and WebGL enabled (`--enable-webgl --ignore-gpu-blocklist`).
2. **Target Navigation**:
   - When given a URL like `https://www.figma.com/design/:fileKey/:fileName?node-id=:nodeId`, parses the file key and target `node-id` (e.g. `1234-5678` -> `1234:5678`).

### Phase 2: In-Page Inspection & Bridge Injection
1. Evaluates whether the page is a recognized canvas app (Figma, Canva, Google Maps, generic WebGL).
2. **For Figma**:
   - Injects the `figma-runtime-bridge.js` helper into the page context.
   - Probes Figma's runtime state:
     - Accesses Figma's internal scene/viewport controllers.
     - Pans and zooms the canvas camera directly to center on the target node.
     - Retrieves the node's geometry: absolute coordinates (x, y, w, h), padding, auto-layout attributes, typography, and fills.
     - Triggers in-browser SVG/vector export for that specific node if needed.
3. **For Generic WebGL**:
   - Detects the primary `<canvas>` element.
   - Extracts framebuffer dimensions and captures high-resolution canvas snapshot.

### Phase 3: Agent Output Formatting
The package packages the findings into an agent-friendly payload:
```json
{
  "status": "success",
  "appType": "figma",
  "nodeId": "1234:5678",
  "dimensions": { "width": 1440, "height": 900 },
  "visual": {
    "screenshotPath": "./output/node-1234-5678.png",
    "base64Thumbnail": "data:image/png;base64,..."
  },
  "semantic": {
    "name": "Dashboard / Main View",
    "type": "FRAME",
    "textContents": ["Total Balance", "Rp 12.500.000", "Transfer", "Riwayat"],
    "colors": ["#0050AE", "#FFFFFF", "#1E1E1E"],
    "fonts": ["Inter", "Roboto"],
    "svgExport": "<svg ...>...</svg>"
  }
}
```

---

## 4. Package Structure & Tech Stack

- **Language**: TypeScript (ESM + CommonJS via `tsup`)
- **Automation**: `playwright-core` / `chrome-remote-interface` (lightweight, uses local Chrome if available)
- **Tooling**: `tsup` for bundling, `vitest` for unit tests, `@modelcontextprotocol/sdk` for MCP support
- **Directory Layout**:
  ```
  canvas-agent-reader/
  ├── package.json
  ├── tsconfig.json
  ├── tsup.config.ts
  ├── bin/
  │   └── cli.js                  # Standalone CLI binary
  ├── src/
  │   ├── index.ts                # Main API exports
  │   ├── browser/
  │   │   ├── connector.ts        # Connect to CDP port 9222 or launch browser
  │   │   └── webgl-flags.ts      # WebGL & GPU hardware acceleration flags
  │   ├── extractors/
  │   │   ├── base.ts             # Generic canvas extractor interface
  │   │   ├── generic-canvas.ts   # Fallback WebGL/Canvas visual snapshotter
  │   │   └── figma/
  │   │       ├── url-parser.ts   # Parse Figma node IDs and file keys
  │   │       ├── bridge.ts       # Runtime script injection & scene queries
  │   │       └── inspector.ts    # Extracts layout, text, colors, & SVG
  │   ├── mcp/
  │   │   └── server.ts           # Model Context Protocol server definition
  │   └── cli/
  │       └── commands.ts         # CLI argument parser & execution
  └── test/
      ├── url-parser.test.ts
      └── visual-capture.test.ts
  ```

---

## 5. Planned Agent Tools (MCP Interface)

| Tool Name | Parameters | Description |
|---|---|---|
| `inspect_canvas` | `url`, `selector?` | Connects to a WebGL page and takes a structured snapshot + dimensions. |
| `figma_read_node` | `url`, `nodeId?`, `exportFormat?: 'png' \| 'svg' \| 'json'` | Focuses on a Figma node, extracts visual render, text hierarchy, layout & styles. |
| `figma_list_frames` | `url` | Lists top-level frames/screens visible in the current Figma document. |
| `browser_attach` | `cdpPort?: number` (default 9222) | Verifies connection to the user's active Chrome browser. |
