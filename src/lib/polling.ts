/** Serial polling with no scheduled wakeups while the window is hidden. */
export function pollWhileVisible(
  task: () => Promise<void>,
  interval: () => number,
  visibility: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
  onError: (error: unknown) => void = () => {},
): () => void {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const tick = async () => {
    clear();
    if (stopped || running || visibility.visibilityState !== "visible") return;
    running = true;
    try { await task(); }
    catch (error) { onError(error); }
    finally {
      running = false;
      if (!stopped && visibility.visibilityState === "visible") timer = setTimeout(tick, interval());
    }
  };
  const changed = () => { clear(); void tick(); };
  visibility.addEventListener("visibilitychange", changed);
  void tick();
  return () => {
    stopped = true;
    clear();
    visibility.removeEventListener("visibilitychange", changed);
  };
}
