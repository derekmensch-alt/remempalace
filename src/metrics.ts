export class Metrics {
  private counters = new Map<string, number>();

  inc(name: string, n = 1): void {
    if (!Number.isFinite(n)) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + n);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  setMax(name: string, n: number): void {
    if (!Number.isFinite(n)) return;
    const prev = this.counters.get(name);
    if (prev === undefined || n > prev) this.counters.set(name, n);
  }

  reset(): void {
    this.counters.clear();
  }
}
