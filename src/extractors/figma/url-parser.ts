export interface ParsedFigmaUrl {
  isValid: boolean;
  fileKey?: string;
  fileName?: string;
  fileType?: "design" | "file" | "board" | "proto";
  nodeIdRaw?: string;
  nodeIdColon?: string; // e.g. "1234:5678"
  nodeIdHyphen?: string; // e.g. "1234-5678"
  targetUrl?: string;
}

/**
 * Parses and normalizes any Figma design, file, prototype, or FigJam URL.
 */
export function parseFigmaUrl(rawUrl: string): ParsedFigmaUrl {
  try {
    const url = new URL(rawUrl);
    if (!url.hostname.includes("figma.com")) {
      return { isValid: false };
    }

    // Path regex: /(design|file|board|proto)/:fileKey(/:fileName)?
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length < 2) {
      return { isValid: false };
    }

    const fileType = pathParts[0] as "design" | "file" | "board" | "proto";
    const fileKey = pathParts[1];
    const fileName = pathParts.length > 2 ? decodeURIComponent(pathParts[2]) : undefined;

    // Node id resolution from query params
    const rawNodeId = url.searchParams.get("node-id") || undefined;
    let nodeIdColon: string | undefined;
    let nodeIdHyphen: string | undefined;

    if (rawNodeId) {
      const decoded = decodeURIComponent(rawNodeId);
      if (decoded.includes(":")) {
        nodeIdColon = decoded;
        nodeIdHyphen = decoded.replace(/:/g, "-");
      } else if (decoded.includes("-")) {
        nodeIdHyphen = decoded;
        nodeIdColon = decoded.replace(/-/g, ":");
      } else {
        nodeIdColon = decoded;
        nodeIdHyphen = decoded;
      }
    }

    return {
      isValid: true,
      fileKey,
      fileName,
      fileType,
      nodeIdRaw: rawNodeId,
      nodeIdColon,
      nodeIdHyphen,
      targetUrl: rawUrl,
    };
  } catch {
    return { isValid: false };
  }
}