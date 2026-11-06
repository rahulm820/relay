/**
 * Runs `pass` now and then every `intervalMs` until closed. A pass that throws is reported and the loop carries
 * on; passes never overlap (the next one is scheduled after the previous finishes). `close()` waits for a pass in flight.
 */
export class PeriodicJob {
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly pass: () => Promise<void>, private readonly intervalMs: number, private readonly onError: (err: unknown) => void = () => undefined) {}

  start(): void {
    this.loop = this.run();
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try { await this.pass(); } catch (err) { this.onError(err); }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { this.wake = undefined; resolve(); }, this.intervalMs);
        this.wake = () => { clearTimeout(t); this.wake = undefined; resolve(); };
        if (this.stopping) this.wake();
      });
    }
  }
}
