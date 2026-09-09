import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { inspectFigmaNode } from "../extractors/figma/inspector.js";
import { inspectGenericCanvas } from "../extractors/generic-canvas.js";
import { findSystemBrowserPath } from "../browser/webgl-flags.js";

const FigmaReadNodeArgs = z.object({
  url: z.string().url(),
  splitChildren: z.boolean().optional(),
  childrenCount: z.number().int().positive().optional(),
  childrenDirection: z.enum(["row", "column", "grid", "auto"]).optional(),
  cdpPort: z.number().int().positive().optional(),
  headless: z.boolean().optional(),
  outputPath: z.string().optional(),
  sectionName: z.string().optional(),
  subSectionName: z.string().optional(),
  cardNames: z.array(z.string()).optional(),
  includeBase64: z.boolean().optional(),
});

const InspectCanvasArgs = z.object({
  url: z.string().url(),
  canvasSelector: z.string().optional(),
  cdpPort: z.number().int().positive().optional(),
  headless: z.boolean().optional(),
});

const BrowserStatusArgs = z.object({
  port: z.number().int().positive().optional(),
});

/**
 * Initializes and starts the Model Context Protocol (MCP) server over stdio.
 */
export async function startMcpServer(): Promise<void> {
  const server = new Server(
    {
      name: "canvas-agent-reader",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "figma_read_node",
          description: "Navigates to a Figma design URL, waits for the WebGL canvas, saves a PNG of the design surface, and optionally measures and slices each child card into its own PNG. Returns file paths and metadata.",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "Figma design URL with node-id (e.g. https://www.figma.com/design/key/title?node-id=1234-5678)",
              },
              splitChildren: {
                type: "boolean",
                description: "If true, deterministically slices the section into individual card screenshots (0 AI).",
              },
              childrenCount: {
                type: "number",
                description: "Expected number of child cards (e.g. 5). Used to verify the measurement, not to divide the region blindly.",
              },
              childrenDirection: {
                type: "string",
                enum: ["row", "column", "grid", "auto"],
                description: "Layout direction of cards (default: auto).",
              },
              cdpPort: {
                type: "number",
                description: "Optional Chrome DevTools Protocol port (e.g. 9222) to attach to user's active logged-in Chrome browser.",
              },
              headless: {
                type: "boolean",
                description: "Whether to run browser in headless mode. Default: true.",
              },
              outputPath: {
                type: "string",
                description: "Optional file path where to save the captured PNG screenshot.",
              },
              sectionName: {
                type: "string",
                description: "Optional parent section name, e.g. '[Auth] Login' or 'Auth'.",
              },
              subSectionName: {
                type: "string",
                description: "Optional sub-section name, e.g. 'Registration' or 'PasswordReset'.",
              },
              cardNames: {
                type: "array",
                items: { type: "string" },
                description: "Explicit semantic card names in visual order (e.g. ['UserProfile', 'AccountSettings']).",
              },
              includeBase64: {
                type: "boolean",
                description: "Return PNG bytes inline as base64. Default false - read the returned screenshotPath files instead, they are 4K captures.",
              },
            },
            required: ["url"],
          },
        },
        {
          name: "inspect_canvas",
          description: "Inspects any WebGL or HTML5 Canvas on a web page, querying canvas dimensions, WebGL context, and capturing a visual snapshot.",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "Web page URL containing a <canvas> element.",
              },
              canvasSelector: {
                type: "string",
                description: "CSS selector for the canvas element. Default: 'canvas'.",
              },
              cdpPort: {
                type: "number",
                description: "Optional Chrome DevTools Protocol port (e.g. 9222).",
              },
              headless: {
                type: "boolean",
                description: "Whether to run browser in headless mode. Default: true.",
              },
            },
            required: ["url"],
          },
        },
        {
          name: "browser_status",
          description: "Checks if a local system browser (Chrome/Edge) is detected and tests if Chrome is running with remote debugging port 9222.",
          inputSchema: {
            type: "object",
            properties: {
              port: {
                type: "number",
                description: "Port to test. Default: 9222.",
              },
            },
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "figma_read_node") {
      const parsed = FigmaReadNodeArgs.safeParse(args ?? {});
      if (!parsed.success) {
        throw new Error(`Invalid arguments for figma_read_node: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      }
      const { cdpPort, headless, ...rest } = parsed.data;

      const result = await inspectFigmaNode({
        ...rest,
        cdpUrl: cdpPort,
        headless: headless !== false,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === "inspect_canvas") {
      const parsed = InspectCanvasArgs.safeParse(args ?? {});
      if (!parsed.success) {
        throw new Error(`Invalid arguments for inspect_canvas: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      }
      const { cdpPort, headless, canvasSelector, url } = parsed.data;

      const result = await inspectGenericCanvas({
        url,
        canvasSelector: canvasSelector || "canvas",
        cdpUrl: cdpPort,
        headless: headless !== false,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === "browser_status") {
      const port = BrowserStatusArgs.safeParse(args ?? {}).data?.port ?? 9222;
      const browserPath = findSystemBrowserPath();

      let cdpActive = false;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
        cdpActive = res.ok;
      } catch {
        cdpActive = false;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                detectedSystemBrowser: browserPath || "None",
                cdpEndpoint: `http://127.0.0.1:${port}`,
                cdpActive,
                instructions: cdpActive
                  ? "CDP connection ready. Agent can attach to active user Chrome."
                  : "To let agent attach to your active Chrome (with login sessions), launch Chrome with: chrome.exe --remote-debugging-port=9222",
              },
              null,
              2
            ),
          },
        ],
      };
    }

    throw new Error(`Unknown tool name: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}