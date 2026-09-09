import path from "node:path";

export interface ParsedSectionHierarchy {
  section: string;
  subSection?: string;
  raw: string;
}

/**
 * Converts a string with spaces, dashes, or underscores into clean PascalCase.
 * Examples:
 *  "User Profile" -> "UserProfile"
 *  "Account Settings" -> "AccountSettings"
 *  "detail_position" -> "DetailPosition"
 */
export function toPascalCase(input: string): string {
  if (!input || !input.trim()) return "";

  // Split by non-alphanumeric characters (spaces, dashes, underscores, etc.)
  const words = input
    .trim()
    // Designers write flow steps with arrows and ampersands; both read as word breaks,
    // and neither belongs in a file name a downstream pipeline has to handle.
    .split(/[\s\-_+>/\\|:&→⟶⇒↳]+/)
    .filter(Boolean);

  if (words.length === 0) return "";

  return words
    // Page and section names carry emoji, brackets and punctuation that have no business in
    // a path. Letters and digits of any script survive; symbols do not.
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .map((word) => {
      // If the word is an acronym (e.g. API, SDK, UI, UX, ID), preserve all uppercase
      if (word === word.toUpperCase() && word.length <= 5) {
        return word;
      }
      // If the word has mixed case (e.g. iPhone, CamelCase), preserve the casing
      if (/[a-z]/.test(word) && /[A-Z]/.test(word)) {
        return word.charAt(0).toUpperCase() + word.slice(1);
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join("");
}

/**
 * Sanitizes a string to be safely used as a directory or file name across Windows/macOS/Linux.
 */
export function sanitizePathComponent(input: string): string {
  // Remove illegal characters: < > : " / \ | ? *
  return input
    .replace(/[<>:"/\\|?*#~&]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parses a raw Figma section or layer name into a structured hierarchy:
 * Examples:
 *  "[Auth] Login -> Multi Factor"        => { section: "Auth", subSection: "Login/MultiFactor" }
 * Sub-levels are always joined with "/" so the result is identical on every OS;
 * buildHierarchyDir converts them into real path separators.
 *  "[Auth] Registration"                 => { section: "Auth", subSection: "Registration" }
 *  "[Admin] Create User Account"         => { section: "Admin", subSection: "CreateUserAccount" }
 *  "Admin/Settings View"                 => { section: "Admin", subSection: "SettingsView" }
 *  "Master Components"                   => { section: "MasterComponents", subSection: undefined }
 */
export function parseSectionHierarchy(rawName?: string): ParsedSectionHierarchy {
  if (!rawName || !rawName.trim()) {
    return { section: "DefaultSection", raw: "" };
  }

  const trimmed = rawName.trim();

  // Pattern 1: Bracketed prefix like "[Auth] Login -> Multi Factor" or "[Auth] Registration"
  const bracketMatch = trimmed.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (bracketMatch) {
    const sectionPart = toPascalCase(bracketMatch[1]) || sanitizePathComponent(bracketMatch[1]);
    const remainder = bracketMatch[2]?.trim();

    if (!remainder) {
      return { section: sectionPart, raw: trimmed };
    }

    // Check if remainder has sub-levels separated by "->", "+", or "/"
    if (remainder.includes("->") || remainder.includes("+") || remainder.includes("/")) {
      const parts = remainder
        .split(/->|\+|\//)
        .map((p) => toPascalCase(p.trim()))
        .filter(Boolean);

      return {
        section: sectionPart,
        subSection: parts.join("/"),
        raw: trimmed,
      };
    }

    return {
      section: sectionPart,
      subSection: toPascalCase(remainder),
      raw: trimmed,
    };
  }

  // Pattern 2: Slash separated like "Admin/Settings View"
  if (trimmed.includes("/")) {
    const parts = trimmed
      .split("/")
      .map((p) => toPascalCase(p.trim()))
      .filter(Boolean);

    return {
      section: parts[0] || "Section",
      subSection: parts.slice(1).join("/") || undefined,
      raw: trimmed,
    };
  }

  // Pattern 3: Simple section name like "Master Components"
  return {
    section: toPascalCase(trimmed),
    raw: trimmed,
  };
}

/**
 * Builds the nested directory path:
 * baseDir / figma-{fileId} / section / [subSection]
 */
export function buildHierarchyDir(options: {
  baseDir?: string;
  fileId?: string;
  /** Figma page name. A file's pages reuse section names, so they need their own level. */
  page?: string;
  section?: string;
  subSection?: string;
}): string {
  const base = options.baseDir || path.join(process.cwd(), "output");
  const fileFolder = options.fileId ? `figma-${sanitizePathComponent(options.fileId)}` : "figma-doc";

  const parts = [base, fileFolder];

  if (options.page) {
    parts.push(sanitizePathComponent(options.page));
  }

  if (options.section) {
    parts.push(sanitizePathComponent(options.section));
  }

  if (options.subSection) {
    // subSection might contain path separators
    const subParts = options.subSection
      .split(/[/\\]+/)
      .map((p) => sanitizePathComponent(p))
      .filter(Boolean);
    parts.push(...subParts);
  }

  return path.join(...parts);
}

/**
 * Formats a semantic card screenshot filename.
 * If rawName is provided (e.g. "User Profile"), converts to "UserProfile.png".
 * If rawName is missing, empty, or generic, falls back to "step-1.png", "step-2.png", etc.
 */
export function formatCardFileName(rawName?: string, index = 0): string {
  if (!rawName || !rawName.trim()) {
    return `step-${index + 1}.png`;
  }

  const clean = rawName.trim();

  // If it's a generic auto-generated name like "item-1", "card-1", fallback to step-N
  if (/^(item|card|screen|step)[-_]?\d+$/i.test(clean)) {
    return `step-${index + 1}.png`;
  }

  const pascal = toPascalCase(clean);
  if (!pascal || pascal.length === 0) {
    return `step-${index + 1}.png`;
  }

  return `${pascal}.png`;
}
