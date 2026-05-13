export interface HeartbeatWarmerOptions {
  intervalMs: number;
  warm: () => Promise<void>;
}

export class HeartbeatWarmer {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: HeartbeatWarmerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.opts.warm().catch(() => {
        // tolerate failures — best effort
      });
    }, this.opts.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
