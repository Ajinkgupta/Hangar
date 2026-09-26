import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollWhileVisible } from "./polling";

class Visibility extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  change(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

describe("visibility-aware polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does no polling or timer wakeups while hidden and refreshes on return", async () => {
    const visibility = new Visibility();
    const task = vi.fn().mockResolvedValue(undefined);
    const stop = pollWhileVisible(task, () => 2000, visibility);
    await vi.advanceTimersByTimeAsync(4000);
    expect(task).toHaveBeenCalledTimes(3);
    visibility.change("hidden");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(3);
    visibility.change("visible");
    expect(task).toHaveBeenCalledTimes(4);
    stop();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never overlaps requests when visibility changes during slow work", async () => {
    const visibility = new Visibility();
    let finish!: () => void;
    const task = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const stop = pollWhileVisible(task, () => 2000, visibility);
    for (let i = 0; i < 10; i++) {
      visibility.change("hidden");
      visibility.change("visible");
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(task).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reschedule pending work after cleanup", async () => {
    const visibility = new Visibility();
    let finish!: () => void;
    const stop = pollWhileVisible(() => new Promise<void>((resolve) => { finish = resolve; }), () => 2000, visibility);
    stop();
    finish();
    await Promise.resolve();
    visibility.change("visible");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts hidden without a timer and recovers after a failed request", async () => {
    const visibility = new Visibility();
    visibility.visibilityState = "hidden";
    const error = new Error("offline");
    const task = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onError = vi.fn();
    const stop = pollWhileVisible(task, () => 2000, visibility, onError);
    expect(task).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    visibility.change("visible");
    await vi.advanceTimersByTimeAsync(2000);
    expect(onError).toHaveBeenCalledWith(error);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });
});
