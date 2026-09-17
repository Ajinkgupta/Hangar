import { useStore } from "../store";
import { THEMES } from "../lib/themes";

export function SettingsDialog() {
  const settings = useStore((s) => s.config.settings);
  const setSettings = useStore((s) => s.setSettings);
  const close = () => useStore.getState().setSettingsOpen(false);
  return (
    <div
      className="palette-backdrop"
      onClick={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        <label>
          Theme
          <div className="theme-grid">
            {THEMES.map((t) => (
              <button
                key={t.name}
                className={"theme-swatch" + (settings.theme === t.name ? " on" : "")}
                style={{ background: t.vars["--bg-2"], borderColor: settings.theme === t.name ? t.vars["--accent"] : t.vars["--border"], color: t.vars["--fg"] }}
                onClick={() => setSettings({ theme: t.name })}
              >
                <span className="swatch-accent" style={{ background: t.vars["--accent"] }} />
                {t.label}
              </button>
            ))}
          </div>
        </label>
        <label>
          Terminal font size: {settings.fontSize}px
          <input type="range" min={10} max={22} value={settings.fontSize} onChange={(e) => setSettings({ fontSize: Number(e.target.value) })} />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={settings.notifications} onChange={(e) => setSettings({ notifications: e.target.checked })} />
          Notify me when an agent needs attention and Hangar is in the background
        </label>
        <label className="check-row">
          <input type="checkbox" checked={settings.sound} onChange={(e) => setSettings({ sound: e.target.checked })} disabled={!settings.notifications} />
          Play a sound with notifications
        </label>
        <p className="hint">
          Shortcuts: ⌘T new terminal · ⌘W close · ⌘⇧] / ⌘⇧[ tabs · ⌘1…9 projects · ⌘0 overview · ⌘P jump · ⌘F find · ⌘K clear · ⌃⌥H show/hide Hangar from anywhere · ⌘, settings
        </p>
        <div className="dialog-actions">
          <button className="primary" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}
