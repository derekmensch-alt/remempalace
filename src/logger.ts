export interface Logger {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export function createLogger(prefix: string, base?: Partial<Logger>): Logger {
  const fmt = (msg: string) => `[${prefix}] ${msg}`;
  return {
    debug: (msg) => base?.debug?.(fmt(msg)),
    info: (msg) => (base?.info ?? console.log)(fmt(msg)),
    warn: (msg) => (base?.warn ?? console.warn)(fmt(msg)),
    error: (msg) => (base?.error ?? console.error)(fmt(msg)),
  };
}
