# Hangar: IDE interface and resource efficiency

Research and implementation notes, 18 September 2026.

## Design direction

Keep the active terminal or file as the main work surface. Make projects,
connections, changes, and tasks easy to reach without adding a permanent panel
for every feature. Preserve Hangar's persistent sessions and support for CLI agents.

References reviewed:

- [VS Code custom layout](https://code.visualstudio.com/docs/configure/custom-layout):
  sidebar and panel controls, compact layouts, and keyboard-accessible navigation.
  Applied here as a workspace command bar and a collapsible sidebar (Cmd+B).
- Agent-oriented IDEs: a dedicated agent workflow can execute commands and edit
  files. For Hangar, retain accurate terminal/agent status and quick access to
  changes and tasks; don't imply that CLI process detection supplies an agent's
  internal plan or approval state.
- [Zed quality/performance notes](https://zed.dev/blog/quality-week-december-2025):
  reducing unnecessary frame presentation to lower idle GPU work. Applied as a
  principle: hidden windows release terminal WebGL rendering and cursor blinking.
  Hangar uses a different rendering architecture; Zed's benchmarks do not transfer.
- [VS Code terminal basics](https://code.visualstudio.com/docs/terminal/basics) and
  [shell integration](https://code.visualstudio.com/docs/terminal/shell-integration):
  terminal UX is more useful when it knows the working directory, command boundaries,
  links, and exit state. Hangar currently preserves PTYs and clickable links, but does
  not yet inject shell integration. That is a worthwhile follow-up, not something to
  fake with prompt parsing.
- [VS Code source control](https://code.visualstudio.com/docs/sourcecontrol/overview):
  change review should stay close to the working tree and use side-by-side diffs.
  Hangar already provides read-only status and unified/split review; staging and commit
  are intentionally still terminal-first until their safety and conflict UX is designed.

## Implemented in this pass

| Area | Previous behavior | New behavior |
| --- | --- | --- |
| Workspace controls | Search primarily in sidebar; sidebar always visible | Command bar stays available with sidebar hidden; Cmd+B toggles it |
| Process monitor | Visibility events could overlap requests and create multiple timer chains | Serial requests; no monitor timer scheduled while hidden; refresh on return |
| Git summaries | Every fourth monitor tick; included SSH's `~` path and repeated paths | At least 15 seconds apart; unique local project paths; awaited to prevent overlap |
| Overview previews | Every card fetched terminal output every three seconds | Only intersecting cards fetch; unchanged output skips IPC; reconnection refreshes previews |
| Files, Tasks, Changes refresh | Each surface owned an independent timer | One serial, visibility-aware poller per mounted surface; no hidden-window timer chain |
| Terminal UI | Every tab in the selected project mounted its own pane and observer | Only selected terminal pane mounts; daemon sessions and previously opened xterm state remain |
| Hidden rendering | Selected terminal could retain GPU renderer while window hidden | Release WebGL renderer and disable cursor blinking until visible |
| Overview updates | Each card subscribed to every terminal's output timestamps | Each card subscribes to its own preview terminal's timestamp |

In-flight requests can finish after the window becomes hidden. These changes do
not stop agents or their PTYs. Previously opened terminals still parse output to
preserve terminal state and protocol behavior; arbitrary suspension could break
interactive programs. Idle overview cards retain a lightweight timer while visible,
but skip unchanged preview requests.

## Verification and limits

Automated tests cover hidden-window timer suppression, repeated visibility changes
during slow work, cleanup during pending requests, recovery from request errors,
and releasing the terminal renderer. Existing terminal lifecycle and daemon tests
cover related session behavior. Frontend production builds verify TypeScript and
bundling.

No before/after native CPU, memory, energy, or frame-time measurements were taken.
The verified result is less scheduled work and fewer eligible preview requests,
not a measured percentage speedup. Vite still reports a large JavaScript chunk;
this pass targets steady-state work rather than claiming a smaller bundle.

For native profiling, compare the same release build/configuration with:

1. One idle shell for five minutes, visible and then minimized.
2. Twenty idle terminals, visiting only one; then visiting all twenty.
3. Several terminals emitting output, with overview visible and scrolled off cards.
4. Ten real repositories, including a large repository with many changed files.
5. Repeated sidebar, tab, and visibility changes while monitor requests are slow.

Record Hangar/WebKit and daemon CPU, resident memory, GPU/energy impact, IPC counts,
Git subprocess counts and duration, and tab-switch latency. Measure CLI agent
processes separately so their resource use isn't attributed to Hangar's interface.

## Next improvements, in priority order

1. Replace repeated file/task/diff reads with debounced filesystem notifications,
   retaining a low-frequency reconciliation poll and save-conflict protection.
2. Bound concurrent Git work across many repositories and cache unchanged summaries.
   Use repository/worktree-aware invalidation rather than only watching `.git`.
3. Add resizable explorer and ports panels with saved sizes, then optional terminal
   splits. Keep the default layout compact; test focus and resize behavior first.
4. Profile xterm parsing and retained scrollback before adding eviction. Any memory
   cap must preserve alternate-screen state and interactive terminal responses.
5. Split optional dialogs/renderers into lazy chunks if startup profiling shows
   parse/initialization time is significant. Chunk splitting alone won't reduce
   running-agent CPU usage.
6. Add a local diagnostics view for measured poll durations, retained terminal count,
   and request failures. Avoid presenting estimates as process CPU or memory data.
