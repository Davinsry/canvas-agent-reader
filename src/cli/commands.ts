import { Command, Option } from "commander";
import { inspectFigmaNode } from "../extractors/figma/inspector.js";
import { inspectGenericCanvas } from "../extractors/generic-canvas.js";
import { startMcpServer } from "../mcp/server.js";
import { findSystemBrowserPath } from "../browser/webgl-flags.js";

/** Rejects --count values that are not positive integers instead of silently slicing once. */
function parseCount(raw?: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`Error: --count must be a positive integer, received '${raw}'.`);
    process.exit(1);
  }
  return value;
}

export function createCli(): Command {
  const program = new Command();

  program
    .name("canvas-agent-reader")
    .description("Autonomous AI Agent tool to inspect, capture, and semantically read WebGL & Canvas web applications")
    .version("0.1.0");

  program
    .command("figma [url]")
    .description("Inspect a Figma design URL and capture the target frame / WebGL canvas (supports FIGMA_URL in .env)")
    .option("-p, --port <number>", "Connect to Chrome CDP port (e.g. 9222, or via CDP_PORT in .env)")
    .option("-o, --output <path>", "Output file path for captured image")
    .option("-c, --split-children", "Measure the cards in the section and save each one as its own screenshot")
    .option("--count <number>", "Expected count of child cards, used to verify the measurement (e.g. 5)")
    .addOption(
      new Option("--direction <direction>", "Card layout inside the section").choices(["row", "column", "grid", "auto"]).default("auto")
    )
    .option("--section <name>", "Parent section name (e.g. '[Auth] Login' or 'Auth')")
    .option("--sub-section <name>", "Sub-section name (e.g. 'Registration' or 'PasswordReset')")
    .option("--names <comma-separated>", "Explicit semantic card names (e.g. 'UserProfile,AccountSettings')")
    .option("--headed", "Run with visible browser window")
    .option("--no-retina-zoom", "Skip the (best effort) request for 100% zoom")
    .action(async (url, options) => {
      const targetUrl = url || process.env.FIGMA_URL;
      if (!targetUrl) {
        console.error("Error: Figma URL must be provided as a CLI argument or configured as FIGMA_URL in your .env file.");
        process.exit(1);
      }

      const cdpPort = options.port
        ? Number(options.port)
        : process.env.CDP_PORT
        ? Number(process.env.CDP_PORT)
        : undefined;

      console.log(`[canvas-agent-reader] Inspecting Figma URL: ${targetUrl}`);
      const cardNames = options.names
        ? options.names.split(",").map((s: string) => s.trim()).filter(Boolean)
        : undefined;

      const result = await inspectFigmaNode({
        url: targetUrl,
        cdpUrl: cdpPort,
        outputPath: options.output,
        headless: !options.headed,
        retinaZoom: options.retinaZoom !== false,
        splitChildren: Boolean(options.splitChildren),
        childrenCount: parseCount(options.count),
        childrenDirection: options.direction,
        sectionName: options.section,
        subSectionName: options.subSection,
        cardNames,
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.warning) {
        console.warn(`[canvas-agent-reader] ${result.warning}`);
      }
    });

  program
    .command("canvas [url]")
    .description("Inspect any WebGL / HTML5 Canvas page (supports CANVAS_URL in .env)")
    .option("-s, --selector <selector>", "Canvas CSS selector", "canvas")
    .option("-p, --port <number>", "Connect to Chrome CDP port (e.g. 9222, or via CDP_PORT in .env)")
    .option("-o, --output <path>", "Output file path for captured image")
    .option("--headed", "Run with visible browser window")
    .action(async (url, options) => {
      const targetUrl = url || process.env.CANVAS_URL;
      if (!targetUrl) {
        console.error("Error: Canvas URL must be provided as a CLI argument or configured as CANVAS_URL in your .env file.");
        process.exit(1);
      }

      const cdpPort = options.port
        ? Number(options.port)
        : process.env.CDP_PORT
        ? Number(process.env.CDP_PORT)
        : undefined;

      console.log(`[canvas-agent-reader] Inspecting Canvas URL: ${targetUrl}`);
      const result = await inspectGenericCanvas({
        url: targetUrl,
        canvasSelector: options.selector,
        cdpUrl: cdpPort,
        outputPath: options.output,
        headless: !options.headed,
      });
      console.log(JSON.stringify(result, null, 2));
    });

  program
    .command("mcp")
    .description("Start the Model Context Protocol (MCP) server for AI Agents over stdio")
    .action(async () => {
      await startMcpServer();
    });

  program
    .command("status")
    .description("Check local browser detection and CDP availability")
    .option("-p, --port <number>", "CDP port to check", "9222")
    .action(async (options) => {
      const port = Number(options.port);
      const browser = findSystemBrowserPath();
      console.log(`Detected System Browser: ${browser || "None"}`);

      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          const data = await res.json();
          console.log(`[OK] Chrome CDP is active on port ${port}:`, data);
        } else {
          console.log(`[WARN] Port ${port} responded with HTTP ${res.status}`);
        }
      } catch {
        console.log(`[INFO] No active Chrome found on port ${port}.`);
        console.log(`Tip: To attach to your browser with active Figma login, start Chrome with:`);
        console.log(`chrome.exe --remote-debugging-port=${port}`);
      }
    });

  return program;
}