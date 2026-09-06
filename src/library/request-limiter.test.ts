import { describe, expect, it, vi } from "vitest";

import { InFlightGate, RequestStartScheduler } from "@/library/request-limiter";

describe("request limiters", () => {
  it("queues requests beyond the in-flight limit", async () => {
    const gate = new InFlightGate(1);
    const firstRelease = await gate.acquire();
    let secondStarted = false;
    const second = gate.acquire().then((release) => {
      secondStarted = true;
      release();
    });

    await Promise.resolve();
    expect(secondStarted).toBe(false);
    firstRelease();
    await second;
    expect(secondStarted).toBe(true);
    expect(gate.activeCount).toBe(0);
  });

  it("spaces request starts according to RPM", async () => {
    let now = 10_000;
    const sleep = vi.fn(async (delayMs: number) => {
      now += delayMs;
    });
    const scheduler = new RequestStartScheduler(60, () => now, sleep);

    await scheduler.waitForStart();
    await scheduler.waitForStart();
    await scheduler.waitForStart();

    expect(sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 1_000);
  });
});
