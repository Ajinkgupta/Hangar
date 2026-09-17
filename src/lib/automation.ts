/**
 * Expect/send automation for SSH & bastion connections: watches a terminal's output and,
 * when it matches the current step's pattern, types the step's text + Enter.
 */
import { b64decode, b64encode, pty } from "./ipc";
import type { ConnectionStep } from "./types";

type Script = {
  steps: Array<{ re: RegExp; send: string }>;
  index: number;
  buffer: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  onStep?: (index: number) => void;
  onDone?: () => void;
};

const scripts = new Map<string, Script>();
const STEP_TIMEOUT_MS = 90_000;
const BUFFER_KEEP = 4000;

export const automation = {
  /** Starts (or replaces) the script for a session. Secrets must already be resolved. */
  start(sessionId: string, steps: Array<ConnectionStep & { resolved: string }>, hooks: Pick<Script, "onStep" | "onDone"> = {}) {
    const compiled = steps
      .filter((s) => s.expect.trim())
      .map((s) => {
        let re: RegExp;
        try {
          re = new RegExp(s.expect, "i");
        } catch {
          re = new RegExp(s.expect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        }
        return { re, send: s.resolved };
      });
    if (!compiled.length) {
      hooks.onDone?.();
      return;
    }
    automation.stop(sessionId);
    const script: Script = { steps: compiled, index: 0, buffer: "", startedAt: Date.now(), timer: null, ...hooks };
    scripts.set(sessionId, script);
    arm(sessionId, script);
  },

  stop(sessionId: string) {
    const s = scripts.get(sessionId);
    if (s?.timer) clearTimeout(s.timer);
    scripts.delete(sessionId);
  },

  isRunning(sessionId: string) {
    return scripts.has(sessionId);
  },

  /** Feed raw (base64) output; called for every session so scripts can react. */
  feed(sessionId: string, dataB64: string) {
    const s = scripts.get(sessionId);
    if (!s) return;
    const text = stripAnsi(new TextDecoder().decode(b64decode(dataB64)));
    s.buffer = (s.buffer + text).slice(-BUFFER_KEEP);
    const step = s.steps[s.index];
    if (!step.re.test(s.buffer)) return;
    // Matched: send, advance, reset the buffer so the same prompt can't re-trigger.
    s.buffer = "";
    s.startedAt = Date.now();
    pty.write(sessionId, b64encode(step.send + "\r")).catch(() => {});
    s.onStep?.(s.index);
    s.index += 1;
    if (s.index >= s.steps.length) {
      automation.stop(sessionId);
      s.onDone?.();
    } else {
      arm(sessionId, s);
    }
  },
};

/** Each step gets STEP_TIMEOUT_MS even if no output ever arrives; then the script ends. */
function arm(sessionId: string, s: Script) {
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    if (scripts.get(sessionId) !== s) return;
    scripts.delete(sessionId);
    s.onDone?.();
  }, STEP_TIMEOUT_MS);
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b[@-Z\\-_]/g, "");
}
