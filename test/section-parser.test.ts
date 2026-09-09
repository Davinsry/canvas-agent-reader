import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  parseSectionHierarchy,
  formatCardFileName,
  buildHierarchyDir,
  toPascalCase,
  sanitizePathComponent,
} from "../src/extractors/figma/section-parser.js";

describe("Section Hierarchy Parser", () => {
  it("should parse [Auth] Login -> Multi Factor into section and subSection", () => {
    const parsed = parseSectionHierarchy("[Auth] Login -> Multi Factor");
    expect(parsed.section).toBe("Auth");
    expect(parsed.subSection).toBe("Login/MultiFactor");
  });

  it("should parse [Auth] Registration into section and subSection", () => {
    const parsed = parseSectionHierarchy("[Auth] Registration");
    expect(parsed.section).toBe("Auth");
    expect(parsed.subSection).toBe("Registration");
  });

  it("should parse [Admin] Create User Account", () => {
    const parsed = parseSectionHierarchy("[Admin] Create User Account");
    expect(parsed.section).toBe("Admin");
    expect(parsed.subSection).toBe("CreateUserAccount");
  });

  it("should parse slash-separated roles like Admin/Settings View", () => {
    const parsed = parseSectionHierarchy("Admin/Settings View");
    expect(parsed.section).toBe("Admin");
    expect(parsed.subSection).toBe("SettingsView");
  });

  it("should parse flat section names like Master Components", () => {
    const parsed = parseSectionHierarchy("Master Components");
    expect(parsed.section).toBe("MasterComponents");
    expect(parsed.subSection).toBeUndefined();
  });

  it("should handle empty or undefined input gracefully", () => {
    const parsed = parseSectionHierarchy("");
    expect(parsed.section).toBe("DefaultSection");
  });
});

describe("Card Filename Formatter", () => {
  it("should convert user card title 'User Profile' to 'UserProfile.png'", () => {
    expect(formatCardFileName("User Profile", 0)).toBe("UserProfile.png");
  });

  it("should convert 'Job Posting' to 'JobPosting.png'", () => {
    expect(formatCardFileName("Job Posting", 0)).toBe("JobPosting.png");
  });

  it("should convert 'Detail Position' to 'DetailPosition.png'", () => {
    expect(formatCardFileName("Detail Position", 2)).toBe("DetailPosition.png");
  });

  it("should fallback to step-N when name is missing or empty", () => {
    expect(formatCardFileName(undefined, 0)).toBe("step-1.png");
    expect(formatCardFileName("", 4)).toBe("step-5.png");
  });

  it("should fallback to step-N when name is a generic item/card label", () => {
    expect(formatCardFileName("item-1", 0)).toBe("step-1.png");
    expect(formatCardFileName("card-3", 2)).toBe("step-3.png");
  });
});

describe("buildHierarchyDir Path Builder", () => {
  it("should build nested path figma-{fileId}/{section}/{subSection}", () => {
    const dir = buildHierarchyDir({
      baseDir: "/output",
      fileId: "sampleFileKey123",
      section: "Auth",
      subSection: "Registration",
    });

    const expected = path.join("/output", "figma-sampleFileKey123", "Auth", "Registration");
    expect(dir).toBe(expected);
  });

  it("should build path for nested sub-levels like Login/MultiFactor", () => {
    const dir = buildHierarchyDir({
      baseDir: "/output",
      fileId: "sampleFileKey123",
      section: "Auth",
      subSection: "Login/MultiFactor",
    });

    const expected = path.join("/output", "figma-sampleFileKey123", "Auth", "Login", "MultiFactor");
    expect(dir).toBe(expected);
  });
});
