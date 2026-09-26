# Hangar

A small macOS control panel for working across many projects with Claude Code (or
any CLI agent): persistent terminals per project, one-click saved commands, a live
port/process monitor with kill buttons, and a GitHub-style diff of the working tree.

Terminals live in a tiny background daemon, so quitting Hangar does not end them.
Reopen the app and every terminal is exactly where you left it.

Each project also has a **Files** tab with an expandable folder tree and a
text editor inside Hangar, a **Changes** tab for Git diffs, and a
shared **Tasks** tab. Settings include themes and terminal preferences. Agent alerts
use native Hangar notifications.

## Editing files

Open **Files**, select a text file, edit it, and press **Save / ⌘S**. Use
**+ file** or **+ folder** to create an entry; paths are relative to the project
and the parent folder must already exist. Unsaved drafts are retained locally
when you switch tabs or reopen Hangar, and listed above the folder tree.

If an agent changes the same file, Hangar keeps your draft and rejects the save.
Use **Copy draft** to keep your edits, then **Reload** to load the latest disk
version before merging. Binary files, non-UTF-8 files, and files larger than
2 MB are read only. The editor preserves CRLF line endings and executable permissions.

## Tasks for Claude, Codex, and other agents

In **Tasks**, click **Copy agent instructions** and paste them into the agent's
conversation. Then ask it to add your plan to Hangar and update tasks as work is
completed. This is a local command interface: it does not send prompts to an
agent or synchronize an agent's private checklist automatically.

The installed app provides these commands (JSON output):

```sh
HANGAR=/Applications/Hangar.app/Contents/MacOS/hangar
"$HANGAR" tasks --project /path/to/project list
"$HANGAR" tasks --project /path/to/project add "Review authentication tests"
"$HANGAR" tasks --project /path/to/project rename TASK_ID "Review login tests"
"$HANGAR" tasks --project /path/to/project done TASK_ID
"$HANGAR" tasks --project /path/to/project reopen TASK_ID
"$HANGAR" tasks --project /path/to/project delete TASK_ID
```

Use the IDs returned by `list` or `add`. Omit `--project` to use the current
directory. No running app window or terminal-daemon update is required for the
commands. The visible Tasks tab refreshes every two seconds. Existing checklists
are migrated once to separate task storage; concurrent agents and the UI update
individual tasks under a shared file lock. Do not edit the storage files directly.

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
| `⌘S` | save the file being edited |
| `⌥-click` a saved command | run it in a new terminal |
| double-click a tab | rename it |

## Build from source

Requires Node 20+, Rust (`rustup`), and Xcode command line tools.

```sh
npm install
npm run tauri dev        # development build with hot reload
npm run install:app      # release build → /Applications/Hangar.app + release/Hangar-<version>.dmg
```

To build without installing or interrupting a running Hangar session:

```sh
npm run tauri build -- --target universal-apple-darwin
```

The universal build requires both the `aarch64-apple-darwin` and
`x86_64-apple-darwin` Rust targets. Its app and DMG are written under
`target/universal-apple-darwin/release/bundle/`. Run `npm run tauri build`
without the target option to build for the current Mac only.

Data lives in `~/Library/Application Support/hangar/` (config, shared tasks, per-terminal
scrollback logs, daemon socket and log).
