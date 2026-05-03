import { countTokens } from "./token-counter.js";

export interface CompactIdentityOptions {
  maxTokens: number;       // default 150
  rawIdentity?: boolean;   // when true, skip compaction and return raw text
}

/**
 * Truncates `text` to at most `maxTokens` tokens (approximate).
 * Uses a binary-search on character count since countTokens ≈ chars/4.
 */
function truncateToTokens(text: string, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) return text;
  // Approximate: each token ≈ 4 chars
  let hi = text.length;
  let lo = 0;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (countTokens(text.slice(0, mid)) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}

/**
 * Compact soul + identity files into a dense, token-budget-aware string.
 *
 * When `rawIdentity` is false (default):
 *   1. Concatenate soul + "\n" + identity
 *   2. Extract headings (`#`/`##`) and non-empty bullet points (`- ` / `* `)
 *   3. Group bullets under their nearest heading; format as:
 *      SECTION: val1 | val2 | val3
 *   4. Truncate to maxTokens
 *
 * When `rawIdentity` is true:
 *   Return raw concatenation truncated to maxTokens (for debugging).
 */
export function compactIdentity(
  raw: { soul: string; identity: string },
  opts: CompactIdentityOptions,
): string {
  const maxTokens = opts.maxTokens ?? 150;

  if (opts.rawIdentity) {
    const combined = raw.soul + (raw.soul && raw.identity ? "\n" : "") + raw.identity;
    return truncateToTokens(combined, maxTokens);
  }

  const combined = raw.soul + "\n" + raw.identity;
  const lines = combined.split("\n");

  // Extract headings and bullets
  const sections: Array<{ heading: string; bullets: string[] }> = [];
  let currentHeading = "";
  let currentBullets: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      // Flush previous section if it has bullets
      if (currentBullets.length > 0) {
        sections.push({ heading: currentHeading, bullets: currentBullets });
        currentBullets = [];
      } else if (currentHeading && currentBullets.length === 0) {
        // Heading with no bullets — store as empty section so heading is preserved
        sections.push({ heading: currentHeading, bullets: [] });
      }
      // Extract heading text (strip leading #s)
      currentHeading = trimmed.replace(/^#+\s*/, "");
    } else if ((trimmed.startsWith("- ") || trimmed.startsWith("* ")) && trimmed.length > 2) {
      const bullet = trimmed.slice(2).trim();
      if (bullet) currentBullets.push(bullet);
    }
  }

  // Flush last section
  if (currentBullets.length > 0 || currentHeading) {
    sections.push({ heading: currentHeading, bullets: currentBullets });
  }

  if (sections.length === 0) return "";

  // Format sections into compact lines
  const parts: string[] = [];
  for (const { heading, bullets } of sections) {
    if (!heading && bullets.length === 0) continue;
    const label = heading
      ? heading.toUpperCase().replace(/\s+/g, "-")
      : "MISC";
    if (bullets.length > 0) {
      parts.push(`${label}: ${bullets.join(" | ")}`);
    } else {
      parts.push(label + ":");
    }
  }

  if (parts.length === 0) return "";

  const compact = parts.join("\n");
  return truncateToTokens(compact, maxTokens);
}
