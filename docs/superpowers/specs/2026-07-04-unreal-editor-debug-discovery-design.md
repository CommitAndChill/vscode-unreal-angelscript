# Unreal Editor Auto-Detect & Auto-Start Debugging — Design

**Date:** 2026-07-04
**Repos touched:** `D:\Repos\vscode-unreal-angelscript` (extension + language server), `D:\Repos\UnrealEngineAngelscript` (engine)

## Problem

Debugging AngelScript today requires the user to manually press F5 / "Start Debugging" every time they want to attach to a running Unreal Editor instance. There is no way for the VS Code extension to know an Editor is running, which project it belongs to, or which port its debug server bound to — and no way for the Editor to know a matching VS Code window is (or isn't) already open. This design adds:

1. Detection of a running Unreal Editor instance whose script folders match the currently open VS Code workspace, including correctly discriminating among multiple concurrently-running Editor instances (different projects, different ports).
2. Automatic start of a debug session against the matched instance.
3. An opt-in Engine-side setting to auto-launch VS Code when the Editor starts, skipping the launch if a matching VS Code window is already open.

## Non-goals

- **Concurrent multi-instance debugging from one VS Code window.** If more than one running Editor instance matches the same workspace (e.g. a Client+Server PIE pair), the extension auto-attaches to exactly one (the most recently started); the others remain reachable only via manual F5. Supporting simultaneous auto-attach to all matches would require refactoring `extension/src/unreal-debugclient.ts`'s and `language-server/src/server.ts`'s module-level singleton socket state into per-session instances. That refactor is real but explicitly out of scope for this feature — it is a pre-existing limitation (a second manual F5 session already stomps the first today), not something introduced or fixed here.
- Configurable poll intervals / freshness windows as user-facing settings — these are implementation constants (see below).
- Any change to the wire protocol used once a debug session is connected (breakpoints, call stack, etc.) — unaffected.

## Architecture

Two lightweight JSON discovery registries live in a well-known **per-user** directory, outside any single project (so they're discoverable regardless of which project/workspace is involved):

- Windows: `%LOCALAPPDATA%\UnrealEngineAngelscript\Discovery\`
- macOS: `~/Library/Application Support/UnrealEngineAngelscript/Discovery/`
- Linux: `~/.config/UnrealEngineAngelscript/Discovery/`

Each has two subfolders:

- `editors/<pid>.json` — written by the Engine, one file per running Editor instance whose AngelScript debug server successfully bound its port.
- `vscode-windows/<pid>.json` — written by the extension, one file per open VS Code window (extension host process).

### `editors/<pid>.json` schema

```json
{
  "projectName": "MyProject",
  "projectPath": "D:/MyProject",
  "scriptRootPaths": ["D:/MyProject/Script", "D:/UE/Engine/Plugins/MyPlugin/Script"],
  "port": 27099,
  "pid": 12345,
  "engineVersion": "5.4.2-angelscript",
  "startTime": "2026-07-04T10:15:00Z"
}
```

`scriptRootPaths` reuses the same root list `FAngelscriptManager::GenerateVSCodeWorkspaceFile()` already computes (`AllRootPaths`) — not recomputed independently.

### `vscode-windows/<pid>.json` schema

```json
{
  "scriptRootPaths": ["D:/MyProject/Script"],
  "pid": 54321,
  "heartbeat": "2026-07-04T10:16:30Z"
}
```

`scriptRootPaths` here is simply the fsPath of every open `vscode.workspace.workspaceFolders` entry.

### End-to-end flow

1. Editor starts; `FAngelscriptDebugServer`'s `FTcpListener` binds successfully. Engine writes `editors/<pid>.json`. Deleted on clean shutdown (debug server destructor); a crash leaves it behind for the extension to invalidate via liveness checks.
2. Extension activates in a VS Code window; writes `vscode-windows/<pid>.json`, refreshing `heartbeat` every ~10s; deletes it on deactivate.
3. Extension continuously watches `editors/` (fs.watch plus a ~2s polling fallback, since fs.watch is unreliable on some platforms/network drives — not just at activation, since the Editor may launch after VS Code is already open).
4. **Two-tier liveness, and deletion is gated on process death only.** Before *attaching* to an `editors/` entry the extension requires both: the PID is alive (`process.kill(pid, 0)`) AND a quick TCP connect to `host:port` succeeds. But the two checks have different consequences, because the Engine writes its file exactly once (at bind) and never re-asserts it:
   - **PID dead** → the entry is genuinely stale; the extension may delete the file.
   - **PID alive but TCP probe fails** → treat as *not-attachable-right-now* and retry on the next scan. **Do NOT delete the file.** A live Editor mid-hitch (asset cook, PIE spin-up, GC, blocking load) can fail a probe transiently; deleting its once-written registration would permanently lose auto-attach for that Editor until it restarts. Deletion of another process's registration must never be driven by a transient network probe — only by confirmed process death.
5. Matching, **per Editor entry** (not per workspace folder): for each live `editors/` entry, test **any overlap** (ancestor/descendant/equal path comparison) between that entry's `scriptRootPaths` and this window's open workspace folders. An entry either matches this window or it doesn't; a multi-root workspace overlapping the same Editor on several folders is still **one** matched Editor. Among multiple *distinct* matching Editors, pick the highest `startTime`.
6. **One auto session per matched Editor, keyed by Editor identity.** Maintain `{ editorPid → { sessionId, host, port } }`. On a newly-matched Editor with no tracked session and not in the declined set: synthesize `{ type: 'angelscript', request: 'launch', name: 'Auto: <projectName>', hostname, port, stopOnEntry: false }` and call `vscode.debug.startDebugging(folder, config)` **exactly once**, passing any one overlapping folder (or `undefined`) — never once per overlapping folder. Keying on `editorPid` rather than on workspace folder is what prevents a 3-folder multi-root workspace from spawning three sessions against one Editor (Testing plan case 2 guards this directly).
7. Send a custom LSP notification `angelscript/setUnrealConnection { hostname, port }` to the language server whenever the matched target changes (including "no match" → falls back to the static `unrealConnectionPort` setting). `language-server/src/server.ts`'s `connect_unreal()` reconnects only when the effective target actually changes.
8. If the user manually stops an auto-started session while its Editor is still running (discovery entry still present), that `editorPid` is added to a declined set for the rest of this VS Code window's lifetime — no automatic re-attach to it unless the entry disappears and reappears. Because a restarted Editor gets a **new** PID (and thus a new `editors/<pid>.json`), a genuine restart naturally clears the decline and re-attaches; only the same still-running instance stays declined.
9. Engine-side, when `bAutoOpenVSCode` is enabled: before calling the existing `GenerateVSCodeWorkspaceFile()` + `OpenVsCode()` path, scan `vscode-windows/` for an entry with fresh heartbeat (< 30s old) whose `scriptRootPaths` overlap this instance's `AllRootPaths`; skip launching if found. **This check is inherently racy** (see Known limitations): the extension writes its heartbeat asynchronously, so an Editor and a VS Code window launched near-simultaneously can each fail to observe the other. To narrow the window the Engine retries the scan for a short bounded period (e.g. poll every 0.5s for up to ~3s) before deciding to launch; it does not, and cannot, fully eliminate the race.

## Engine-side changes (`D:\Repos\UnrealEngineAngelscript`)

- **New settings** on `UAngelscriptSettings` (`D:\Repos\UnrealEngineAngelscript\Engine\Plugins\Angelscript\Source\AngelscriptCode\Public\AngelscriptSettings.h:41-269` — separate sibling repo, not a subpath of this one):
  - `bAutoOpenVSCode` (bool, default `false`).
  - `bAnnounceDebugServerForDiscovery` (bool, default `true`).
- **New discovery helper**, e.g. `AngelscriptDebugDiscovery.h/.cpp` alongside `AngelscriptDebugServer.*`, invoked right after the debug server's listener binds successfully in `AngelscriptManager.cpp` (~lines 424-430). Writes/removes `editors/<pid>.json`.
- **Auto-open VS Code**: factor the existing menu button body (`AngelscriptEditorModule.cpp`, ~lines 820-842) into a reusable `TryOpenVsCodeWorkspace()`, called from the menu action as today, and additionally once at module startup when `bAutoOpenVSCode` is true, gated by the `vscode-windows/` freshness scan described above.

## Extension-side changes (this repo)

- **New module** `extension/src/unreal-discovery.ts`, activated from `extension/src/extension.ts`'s `activate()`. Owns: self-registration/heartbeat, watching `editors/`, two-tier liveness validation (delete on PID-death only, per flow step 4), **per-Editor** matching and at-most-one-session-per-Editor auto-attach keyed by `editorPid` (per flow steps 5–6), decline-tracking, and sending the LSP reroute notification.
- **`language-server/src/server.ts`**: add a handler for `angelscript/setUnrealConnection`; `connect_unreal()` reconnects only on an actual target change; falls back to the static `unrealConnectionPort` setting when notified of "no match."
- **New setting** `UnrealAngelscript.autoStartDebugging` (boolean, default `true`) — master toggle for discovery watching, auto-attach, and LS rerouting together.
- **No changes** to `unreal-debugclient.ts`'s or `server.ts`'s singleton connection model beyond the reconnect-on-notified-target-change described above (see Non-goals).

## Edge cases / error handling

- Missing discovery directory on first run: both sides create it lazily; the extension's watcher tolerates it not existing yet.
- Permission errors writing the shared directory: log once, degrade silently to today's fully-manual behavior; never blocks Editor startup or extension activation.
- Torn/partial JSON reads: parse errors are swallowed and retried next scan.
- Stale files from a crash: the extension deletes an `editors/` entry only after confirming the PID is dead (a transient TCP-probe failure never triggers deletion — see flow step 4), so a hitching-but-alive Editor keeps its registration.
- Two Editors racing for the same default port: the Engine only writes its discovery entry after a successful bind, so a failed-to-bind instance is correctly invisible.
- Two VS Code windows matching the same project: both are allowed to independently auto-attach; the Engine's `ClientsThatAreDebugging` list already supports multiple simultaneous debug clients.
- Editor closes mid-session: existing socket-close/termination handling is unchanged; the extension clears its `{ editorPid → session }` tracking on `onDidTerminateDebugSession` so a later relaunch can re-match.
- No bind-to-connect race: the discovery file only appears once the port is already accepting connections.
- Manual F5 after an LS reroute: a manually-started debug session uses the static `unrealConnectionPort` setting (via `resolveDebugConfiguration`), *not* the discovered port, so if discovery has rerouted the language server to a non-default port, a manual F5 would connect the debugger to a different Editor than autocomplete is talking to. Acceptable on the manual path (the whole point of this feature is to make the auto path the norm), but noted so it isn't mistaken for a bug.

## Known limitations

- **Standalone shared-plugin folder can match the wrong Editor.** Match criterion is any-overlap (a deliberate choice — it's what makes the generated multi-root workspace and single-project layouts both work). Its sharp edge: if the user opens *only* a shared plugin's `…/PluginX/Script` folder standalone, and two different projects both enable PluginX, both Editors overlap that folder and both match; the `startTime` tiebreak attaches to whichever launched most recently, which may be the wrong project. This cannot happen when the full multi-root workspace (or the single project) is open, because the unique project root disambiguates. Documented, not fixed — fixing would mean abandoning the any-overlap criterion the user chose.
- **Auto-open-VSCode duplicate-window race.** The Engine's skip-if-already-open check (flow step 9) reads a heartbeat file the extension writes asynchronously. An Editor and a VS Code window launched near-simultaneously can each miss the other, producing a second VS Code window. The bounded retry in step 9 narrows but cannot close this window. Considered acceptable: the setting is opt-in (`bAutoOpenVSCode`, default off) and the failure mode is a duplicate window, not data loss.
- **Debug server binds on all interfaces.** Pre-existing: `FAngelscriptDebugServer` binds on `FIPv4Address::Any` (`AngelscriptDebugServer.cpp:297`), so the debug port is remotely reachable, and this feature now advertises that port via the per-user discovery files. Not changed here — flagged so the exposure is a conscious choice rather than an accidental one introduced by discovery. Restricting the bind to loopback (when no remote debugging is configured) is a separate, out-of-scope hardening.

## Testing plan

Manual integration matrix (cross-process/cross-repo — no realistic way to unit test the Engine↔VSCode handshake in isolation beyond the pure path-matching logic, which should get unit tests):

1. Single Editor + single VS Code window (single project Script folder open), defaults → auto-attaches quietly, no `stopOnEntry` break.
2. **Multi-root `Angelscript.code-workspace` open (project + 2 plugin roots), one matching Editor → exactly ONE debug session, not one per folder.** (Direct regression guard for the per-Editor dedup keying.)
3. Two Editor instances (two projects, distinct `-asdebugport`), two VS Code windows → each attaches only to its own match.
4. Editor launched *after* VS Code is already open → still detected.
5. Manual stop of an auto-attached session while the Editor keeps running → no immediate re-attach; Editor restart (new PID) → re-attaches.
6. Editor mid-hitch: PID alive but TCP probe times out transiently → the `editors/` file is **not** deleted, and auto-attach succeeds on a later scan once the Editor is responsive again.
7. Simulated Editor crash (kill process, PID gone) → stale entry deleted, no zombie attach attempts.
8. `bAutoOpenVSCode=true`: skips launching a second VS Code when a matching window is already open; launches when none is.
9. `autoStartDebugging=false` → falls back fully to current manual-F5 behavior (regression check).
10. Language server correctly follows the discovered port when it differs from the static `unrealConnectionPort` setting.

## Settings summary

| Side | Setting | Default | Purpose |
|---|---|---|---|
| Engine `UAngelscriptSettings` | `bAutoOpenVSCode` | `false` | Launch VS Code automatically on Editor startup |
| Engine `UAngelscriptSettings` | `bAnnounceDebugServerForDiscovery` | `true` | Write `editors/<pid>.json` registration at all |
| Extension `UnrealAngelscript.*` | `autoStartDebugging` | `true` | Master toggle: discovery watching + auto-attach + LS reroute |
