# Hangar

A small macOS control panel for working across many projects with Claude Code (or
any CLI agent): persistent terminals per project, one-click saved commands, a live
port/process monitor with kill buttons, and a GitHub-style diff of the working tree.

Terminals live in a tiny background daemon, so quitting Hangar does not end them.
Reopen the app and every terminal is exactly where you left it.

## Install (from the DMG)

1. Open `Hangar-<version>.dmg` and drag **Hangar** into **Applications**.
2. First launch: **right-click Hangar.app → Open → Open** (the build is not
   Apple-notarized, so macOS asks once). Or run:
   ```sh
   xattr -dr com.apple.quarantine /Applications/Hangar.app
   ```
3. Add a project folder. Each project starts with one terminal; press `+` or `⌘T` for more.

## Shortcuts

| Keys | Action |
|---|---|
| `⌘T` / `⌘W` | new / close terminal tab |
| `⌘⇧]` / `⌘⇧[` | next / previous tab |
| `⌘1…9` | switch project |
| `⌘F` | find in terminal |
| `⌘K` | clear terminal |
| `⌥-click` a saved command | run it in a new terminal |
| double-click a tab | rename it |

## Build from source

Requires Node 20+, Rust (`rustup`), and Xcode command line tools.

```sh
npm install
npm run tauri dev        # development build with hot reload
npm run install:app      # release build → /Applications/Hangar.app + release/Hangar-<version>.dmg
```

Data lives in `~/Library/Application Support/hangar/` (config, per-terminal
scrollback logs, daemon socket and log).
