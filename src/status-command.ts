import type { CacheStats } from "./cache.js";

export interface StatusReportInput {
  mcpReady: boolean;
  hasDiaryWrite: boolean;
  hasDiaryRead: boolean;
  hasKgInvalidate: boolean;
  searchCache: CacheStats;
  kgCache: CacheStats;
}

function formatCacheLine(label: string, s: CacheStats): string {
  return `${label}: ${s.hits} hits, ${s.misses} misses, ${s.size} entries`;
}

export function buildStatusReport(input: StatusReportInput): string {
  const lines: string[] = ["remempalace status", ""];

  if (input.mcpReady) {
    lines.push("MCP: ready");
  } else {
    lines.push("MCP: down / not ready (memory recall unavailable)");
  }

  lines.push("");
  lines.push("Capabilities:");
  lines.push(`  diary_write: ${input.hasDiaryWrite ? "ok" : "missing (falling back to local JSONL)"}`);
  lines.push(`  diary_read:  ${input.hasDiaryRead ? "ok" : "missing"}`);
  lines.push(`  kg_invalidate: ${input.hasKgInvalidate ? "ok" : "missing (conflict invalidation disabled)"}`);

  lines.push("");
  lines.push("Caches:");
  lines.push(`  ${formatCacheLine("search cache", input.searchCache)}`);
  lines.push(`  ${formatCacheLine("kg cache", input.kgCache)}`);

  return lines.join("\n");
}
