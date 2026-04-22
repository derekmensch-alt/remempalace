import { promises as fs } from "node:fs";

export interface IdentityContext {
  soul: string;
  identity: string;
}

export interface LoadIdentityOptions {
  soulPath: string;
  identityPath: string;
  maxChars?: number;
}

export async function loadIdentityContext(
  opts: LoadIdentityOptions,
): Promise<IdentityContext> {
  const maxChars = opts.maxChars ?? 4000;
  const readSafe = async (path: string): Promise<string> => {
    try {
      const content = await fs.readFile(path, "utf8");
      return content.slice(0, maxChars);
    } catch {
      return "";
    }
  };
  const [soul, identity] = await Promise.all([
    readSafe(opts.soulPath),
    readSafe(opts.identityPath),
  ]);
  return { soul, identity };
}
