# canvas-agent-reader

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)

Autonomous AI Agent tool and **Model Context Protocol (MCP)** Server to inspect, capture, and semantically read **WebGL** and HTML5 `<canvas>` web applications (with dedicated deep support for **Figma** and **measured, model-free child card slicing**).

---

## 💡 Why `canvas-agent-reader`?

Modern web tools (Figma, Canva, Google Maps, 3D WebGL apps) render their UI and artboards inside a `<canvas>` element via WebGL and WebAssembly (WASM).
- To an AI Agent or web scraper, standard DOM inspection yields an empty canvas.
- Official REST APIs (like Figma REST API) enforce strict rate limits (e.g. 6 requests/month on Starter plans) and require admin/personal tokens.

`canvas-agent-reader` gives AI agents direct visual and semantic access to WebGL/Canvas interfaces without relying on rate-limited third-party APIs.

---

## 🚀 Key Capabilities

1. **Figma Canvas & Node Inspector**:
   - Parses any Figma URL (e.g. `node-id=1234-5678` or `1234:5678`).
   - Automatically navigates and focuses the WebGL canvas camera onto the target frame.
   - Captures high-DPI screenshots of the node/canvas for Multimodal / Vision AI models.
   - Detects authentication walls and supports connecting directly to your active browser session.

2. **Measured Card Slicer (no model, no guessing)**:
   - Captures the section once, samples the canvas backdrop, and finds the gutters between cards by projection profiling, so each card is cut on its own real border - cards of unequal width included.
   - Prototype connector arrows crossing the gutters are ignored via a density threshold, and Figma's own UI (toolbar, panels, cookie banner) is hidden before capture so it never lands in the PNG or welds the cards together.
   - `--count` verifies the measurement rather than driving it: a mismatch is reported as a warning instead of silently producing wrong slices. Equal division is only a fallback for when nothing can be measured; each result says which was used via `method: "segmented" | "even"`.

3. **Active Browser Attachment (CDP Mode)**:
   - Connects to your already-open, authenticated Chrome browser (`--remote-debugging-port=9222`).
   - Completely bypasses login screens, Captchas, and rate limits.

4. **Generic WebGL & Canvas Extractor**:
   - Inspects any web page with `<canvas>`.
   - Identifies context types (`webgl2`, `webgl`, `2d`).
   - Captures high-resolution framebuffer images.

5. **Multi-Interface Support**:
   - 🤖 **Model Context Protocol (MCP)**: Native plug-and-play tools for Hermes, Claude, Antigravity, Cursor, etc.
   - 💻 **CLI Binary**: `canvas-agent-reader figma <url>`
   - 📦 **TypeScript / Node.js API**: Direct programmatic import.

---

## 📦 Installation

```bash
npm install canvas-agent-reader
```

Or run directly via `npx`:

```bash
npx canvas-agent-reader --help
```

---

## 🛠️ Usage

### 1. CLI Mode

#### Inspect a Figma Node
```bash
# Capture full node
canvas-agent-reader figma "https://www.figma.com/design/AbCdEf12345/Mobile-Design-System?node-id=10-20" -o ./output/node.png

# Measure and slice a section that should contain 5 cards
canvas-agent-reader figma "https://www.figma.com/design/.../...?node-id=10-20" --split-children --count 5 --direction row

# Attach to your active Chrome browser (logged-in session)
canvas-agent-reader figma "https://www.figma.com/design/.../...?node-id=10-20" -p 9222
```

#### Inspect Any WebGL Page
```bash
canvas-agent-reader canvas "https://threejs.org/examples/#webgl_geometry_cube" -o ./output/threejs.png
```

#### Check Browser & CDP Status
```bash
canvas-agent-reader status -p 9222
```

---

### 2. Model Context Protocol (MCP) Server

Add to your AI agent configuration (e.g. `claude_desktop_config.json`, Hermes config, or Antigravity MCP settings):

```json
{
  "mcpServers": {
    "canvas-reader": {
      "command": "npx",
      "args": ["-y", "canvas-agent-reader", "mcp"]
    }
  }
}
```

#### Tools Exposed to AI Agents:
- `figma_read_node`: Navigates to a Figma URL, inspects WebGL canvas, focuses on target node, captures full frame, and can split into sub-cards with `splitChildren: true, childrenCount: 5`.
- `inspect_canvas`: Inspects any generic WebGL or Canvas page.
- `browser_status`: Tests local browser detection and CDP availability.

---

### 3. Programmatic TypeScript API

```typescript
import { inspectFigmaNode, inspectGenericCanvas } from "canvas-agent-reader";

// Inspect Figma Section & Deterministically Slice into 5 Cards
const figmaResult = await inspectFigmaNode({
  url: "https://www.figma.com/design/AbCdEf12345/Mobile-Design-System?node-id=10-20",
  headless: true,
  splitChildren: true,
  childrenCount: 5,
  childrenDirection: "row",
  outputPath: "./output/section.png",
});

console.log(figmaResult.status); // "success"
console.log(figmaResult.children?.length); // 5
// Each child card has: { name, index, bounds: { x, y, width, height }, method, screenshotPath }
// PNG bytes are written to disk, not returned: pass includeBase64: true if you really want them inline.
```

---

## 🔑 How to Bypass Figma Login (CDP Mode)

When inspecting private or restricted Figma files:
1. Start your local Google Chrome with the remote debugging port enabled:
   ```powershell
   # Windows
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
   ```
2. Open Figma in that Chrome window and log in normally.
3. Now any agent call with `cdpPort: 9222` or CLI `-p 9222` will instantly attach to your active session with full access!

---

## 🧪 Testing & Building

```bash
# Run unit tests
npm test

# Type checking
npm run typecheck

# Build dual ESM/CJS bundles
npm run build
```

---

## 📄 License

MIT