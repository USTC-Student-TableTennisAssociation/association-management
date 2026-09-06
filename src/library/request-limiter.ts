export class InFlightGate {
  private active = 0;
  private readonly queue: Array<(release: () => void) => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("在途请求上限必须大于 0");
  }

  get activeCount(): number {
    return this.active;
  }

  async acquire(onQueued?: (position: number) => void | Promise<void>): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaseHandle();
    }
    const position = this.queue.length + 1;
    const lease = new Promise<() => void>((resolve) => this.queue.push(resolve));
    await onQueued?.(position);
    return lease;
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next(this.releaseHandle());
      else this.active -= 1;
    };
  }
}

export class RequestStartScheduler {
  private nextStartAt = 0;

  constructor(
    readonly requestsPerMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (delayMs: number) => Promise<void> = (delayMs) =>
      new Promise((resolve) => setTimeout(resolve, delayMs)),
  ) {
    if (!Number.isFinite(requestsPerMinute) || requestsPerMinute < 1) {
      throw new Error("每分钟请求数必须大于 0");
    }
  }

  async waitForStart(onWaiting?: (delayMs: number) => void | Promise<void>): Promise<void> {
    const now = this.now();
    const scheduledAt = Math.max(now, this.nextStartAt);
    this.nextStartAt = scheduledAt + Math.ceil(60_000 / this.requestsPerMinute);
    const delayMs = scheduledAt - now;
    if (delayMs <= 0) return;
    await onWaiting?.(delayMs);
    await this.sleep(delayMs);
  }
}
