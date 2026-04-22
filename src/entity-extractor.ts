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

  const capPattern = /\b[A-Z][\w]{2,}\b/g;
  for (const match of prompt.matchAll(capPattern)) {
    if (match[0].length >= minLength) {
      addCandidate(match[0]);
    }
  }

  const lowerPrompt = prompt.toLowerCase();
  for (const entity of knownEntities) {
    if (entity.length >= minLength && lowerPrompt.includes(entity.toLowerCase())) {
      addCandidate(entity);
    }
  }

  return [...seen.values()].slice(0, maxCandidates);
}
