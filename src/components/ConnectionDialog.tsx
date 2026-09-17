import { useState } from "react";
import { useStore } from "../store";
import { uid, type Connection, type ConnectionStep } from "../lib/types";

type DraftStep = ConnectionStep & { secret: boolean; plain: string };

/** Create/edit a saved ssh or bastion connection with expect/send automation steps. */
export function ConnectionDialog({ editing }: { editing: Connection | "new" }) {
  const save = useStore((s) => s.saveConnection);
  const remove = useStore((s) => s.removeConnection);
  const close = () => useStore.getState().setConnectionEditor(null);
  const base: Connection = editing === "new" ? { id: uid(), name: "", command: "", steps: [] } : editing;
  const [name, setName] = useState(base.name);
  const [command, setCommand] = useState(base.command);
  const [steps, setSteps] = useState<DraftStep[]>(
    base.steps.length
      ? base.steps.map((s) => ({ ...s, secret: !!s.secretRef, plain: "" }))
      : [{ expect: "password:", send: "", secret: true, plain: "" }],
  );
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: Partial<DraftStep>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const valid = name.trim() && command.trim();

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const plainSecrets: Record<number, string> = {};
    const cleaned: ConnectionStep[] = [];
    steps
      .filter((s) => s.expect.trim())
      .forEach((s, i) => {
        if (s.secret) {
          // Keep an existing keychain secret unless a new value was typed.
          if (s.plain) plainSecrets[i] = s.plain;
          cleaned.push({ expect: s.expect, send: "", secretRef: s.plain ? undefined : s.secretRef });
        } else {
          cleaned.push({ expect: s.expect, send: s.send });
        }
      });
    await save({ id: base.id, name: name.trim(), command: command.trim(), steps: cleaned }, plainSecrets);
    setBusy(false);
  };

  return (
    <div
      className="palette-backdrop"
      onClick={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
        <h3>{editing === "new" ? "New connection" : `Edit ${base.name}`}</h3>
        <label>
          Name
          <input autoFocus placeholder="prod bastion" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Command to run in the terminal
          <input placeholder="ssh -J bastion.example.com user@10.0.0.5" value={command} onChange={(e) => setCommand(e.target.value)} />
        </label>
        <div className="steps">
          <div className="steps-head">
            <span>Then, when the output shows…</span>
            <span>…type this and press Enter</span>
            <span />
          </div>
          {steps.map((s, i) => (
            <div className="step" key={i}>
              <input placeholder="password:" value={s.expect} onChange={(e) => update(i, { expect: e.target.value })} title="Text or regex, case-insensitive" />
              <div className="send">
                <input
                  type={s.secret ? "password" : "text"}
                  placeholder={s.secret ? (s.secretRef ? "•••••• (saved in Keychain)" : "password") : "cd /app"}
                  value={s.secret ? s.plain : s.send}
                  onChange={(e) => update(i, s.secret ? { plain: e.target.value } : { send: e.target.value })}
                />
                <label className="check" title="Store in the macOS Keychain, never in the config file">
                  <input type="checkbox" checked={s.secret} onChange={(e) => update(i, { secret: e.target.checked })} /> secret
                </label>
              </div>
              <button className="ghost danger" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="ghost small" onClick={() => setSteps([...steps, { expect: "", send: "", secret: false, plain: "" }])}>
            + add step
          </button>
          <p className="hint">
            Examples: expect <span className="mono">password:</span> → secret · expect <span className="mono">\$ $</span> (a shell prompt) → <span className="mono">cd /srv && ls</span>.
            Steps run in order; each waits up to 90 s.
          </p>
        </div>
        <div className="dialog-actions">
          {editing !== "new" && (
            <button className="ghost danger" onClick={() => void remove(base.id)}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button className="ghost" onClick={close}>Cancel</button>
          <button className="primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
