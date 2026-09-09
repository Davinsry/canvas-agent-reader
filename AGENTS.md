# Antigravity Agent Engineering Standards & Deep Code Intelligence

This configuration defines the behavioral protocol and engineering rigor for all AI coding agents working in this workspace.

---

## 1. Core Engineering Philosophy: Deep Root-Cause & Exhaustive Investigation

You must operate with the depth, thoroughness, and architectural precision of a Principal Software Engineer and autonomous deep investigator (Claude Code Rigor).

### Mandates:
1. **Never Settle for Surface Fixes**:
   - Do not merely patch symptoms or suppress errors to pass builds.
   - Always trace and eliminate the root cause across the full system lifecycle (API, DB, UI, background runners, and state management).
2. **Exhaustive Dependency & Call-Graph Tracing**:
   - Before modifying any function, component, API route, or database schema:
     - Map every caller and callee.
     - Search across the entire codebase for indirect usages, serialized payloads, and type contracts.
     - Identify all upstream inputs and downstream consumers.
3. **Edge-Case & Failure-Mode Analysis**:
   - Actively analyze race conditions, network disconnections, timeout states, null/undefined states, empty arrays, unicode/encoding quirks, and multi-user concurrency issues.

---

## 2. Multi-Layer Verification Protocol

Every change must pass a 4-tier verification process before completion:

1. **Static Type & Build Verification**:
   - Ensure zero TypeScript/Linter errors and clean production builds (`npm run build`, `python -m py_compile`, etc.).
2. **Runtime Contract & Boundary Testing**:
   - Verify API response shapes, status codes, payload serialization, and database row formats.
   - Test against real responses and edge-case inputs.
3. **No Regressions & Side-Effects**:
   - Verify that adjacent features, connected views, modals, and helper utilities remain 100% intact.
4. **End-to-End Validation**:
   - When deploying to servers/containers, verify live service status, endpoints, process lifecycles, and logs.

---

## 3. Communication & Transparency

- Be concise, direct, and actionable in communication.
- Provide clickable file links using Markdown `file:///` format for all modified files and symbols.
- Present architectural findings clearly when proposing major structural changes.

---

## 4. Absolute Confidentiality & Data Security Protocol

1. **Zero Link / Credential Leaks**:
   - Never commit real/client Figma links, project tokens, or private node keys into Git.
   - All target URLs MUST strictly reside in `.env` (which is gitignored).
   - All documentation, tests, and examples must use dummy placeholders (`SAMPLE_FILE_KEY`, `Sample-Project`).
2. **Zero Output / Artifact Leaks**:
   - Never commit generated images, client screenshots, or files inside `output/` (`*.png`, `*.jpg`, `*.webp`).
   - `.gitignore` must strictly block `.env`, `output/`, and all media captures.

---

## 5. WebGL / Canvas Reverse-Engineering Protocol (The Scene Graph Law)

1. **State & Store Probing Over Blind Pixel Heuristics**:
   - In modern complex WebGL, WebAssembly, or Canvas-rendered web applications (Figma, Canva, Miro, Google Docs/Sheets Canvas):
   - **NEVER** jump directly to Computer Vision (CV), contour detection, or pixel-guessing heuristics as the first resort.
   - The WebGL rendering engine is almost ALWAYS fed by an in-memory JavaScript/TypeScript state store.
   - **ALWAYS** inspect browser runtime globals first:
     - Probe `window` objects (e.g. `window._fullscreen_`, internal Redux/Flux stores, state mirrors, model trees).
     - Extract geometry directly: node IDs, layer names, hierarchy paths, and `absoluteBoundingBox` coordinates exist directly in memory without requiring official API tokens.
2. **Direct Engine Event Forwarding**:
   - Avoid brittle DOM-level focus (`page.keyboard.press` or click events often fail silently on headless WebGL canvases).
   - Search for internal application event dispatchers (e.g. `forwardKeyboardEvent`) to pass synthetic keyboard and pointer events straight into the WebAssembly engine.
3. **Exact Mathematical Viewport Transforms**:
   - Derive screen positions directly from the engine's viewport matrix:
     `screenX = (sceneX - offsetX) * zoomScale + viewportWidth / 2`
   - Read the settled transform *after* canvas movement to eliminate animation damping and drifting errors.
