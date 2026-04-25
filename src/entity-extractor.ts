export interface EntityExtractionOptions {
  knownEntities: string[];
  maxCandidates: number;
  minLength: number;
}

export function extractEntityCandidates(
  prompt: string,
  opts: EntityExtractionOptions,
): string[] {
  const { knownEntities, maxCandidates, minLength } = opts;
  const seen = new Map<string, string>();

  const addCandidate = (token: string) => {
    const lower = token.toLowerCase();
    if (!seen.has(lower)) {
      seen.set(lower, token);
    }
  };

  // knownEntities first — priority insertion. Cap-pattern below can flood the slot
  // budget with JSON-metadata noise ("Conversation", "EDT", ...) and starve
  // whitelisted entities that only match via the word-boundary loop.
  for (const entity of knownEntities) {
    if (entity.length < minLength) continue;
    const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    if (pattern.test(prompt)) {
      addCandidate(entity);
    }
  }

  const capPattern = /\b[A-Z][\w]{2,}\b/g;
  for (const match of prompt.matchAll(capPattern)) {
    if (match[0].length >= minLength) {
      addCandidate(match[0]);
    }
  }

  return [...seen.values()].slice(0, maxCandidates);
}
