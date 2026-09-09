import { describe, it, expect } from "vitest";
import { parseFigmaUrl } from "../src/extractors/figma/url-parser.js";

describe("Figma URL Parser", () => {
  it("should parse standard figma design url with hyphen node-id", () => {
    const url = "https://www.figma.com/design/AbCdEfGhIjKlMnOpQrSt/Sample-Design-2026?node-id=1234-5678&t=dummy-token";
    const result = parseFigmaUrl(url);

    expect(result.isValid).toBe(true);
    expect(result.fileType).toBe("design");
    expect(result.fileKey).toBe("AbCdEfGhIjKlMnOpQrSt");
    expect(result.fileName).toBe("Sample-Design-2026");
    expect(result.nodeIdRaw).toBe("1234-5678");
    expect(result.nodeIdColon).toBe("1234:5678");
    expect(result.nodeIdHyphen).toBe("1234-5678");
  });

  it("should parse figma url with colon or encoded colon node-id", () => {
    const url = "https://www.figma.com/file/abcdef12345/Design-System?node-id=10%3A20";
    const result = parseFigmaUrl(url);

    expect(result.isValid).toBe(true);
    expect(result.fileType).toBe("file");
    expect(result.fileKey).toBe("abcdef12345");
    expect(result.fileName).toBe("Design-System");
    expect(result.nodeIdColon).toBe("10:20");
    expect(result.nodeIdHyphen).toBe("10-20");
  });

  it("should handle url without node-id", () => {
    const url = "https://www.figma.com/design/abcdef12345/Mobile-App";
    const result = parseFigmaUrl(url);

    expect(result.isValid).toBe(true);
    expect(result.nodeIdColon).toBeUndefined();
    expect(result.nodeIdHyphen).toBeUndefined();
  });

  it("should reject non-figma urls", () => {
    const url = "https://example.com/some/path";
    const result = parseFigmaUrl(url);
    expect(result.isValid).toBe(false);
  });
});