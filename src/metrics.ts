export class Metrics {
  private counters = new Map<string, number>();

  inc(name: string, n = 1): void {
    if (!Number.isFinite(n)) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + n);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  reset(): void {
    this.counters.clear();
  }
}
