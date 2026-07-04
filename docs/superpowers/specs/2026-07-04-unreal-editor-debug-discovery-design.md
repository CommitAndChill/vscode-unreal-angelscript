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
4. Before trusting an `editors/` entry, the extension verifies: the PID is alive (`process.kill(pid, 0)`) AND a quick TCP connect to `host:port` succeeds. Entries failing either check are treated as stale and opportunistically deleted.
5. Matching: **any overlap** (ancestor/descendant/equal path comparison) between an entry's `scriptRootPaths` and this window's open workspace folders. Among multiple matching entries, pick the highest `startTime`.
6. On a new match for a workspace with no currently-tracked auto session: synthesize `{ type: 'angelscript', request: 'launch', name: 'Auto: <projectName>', hostname, port, stopOnEntry: false }` and call `vscode.debug.startDebugging(folder, config)`. Track `{ folder → { pid, sessionId } }`.
7. Send a custom LSP notification `angelscript/setUnrealConnection { hostname, port }` to the language server whenever the matched target changes (including "no match" → falls back to the static `unrealConnectionPort` setting). `language-server/src/server.ts`'s `connect_unreal()` reconnects only when the effective target actually changes.
8. If the user manually stops an auto-started session while its Editor is still running (discovery entry still present), that `pid` is marked declined for the rest of this VS Code window's lifetime — no automatic re-attach to it unless the entry disappears and reappears (i.e. the Editor actually restarted).
9. Engine-side, when `bAutoOpenVSCode` is enabled: before calling the existing `GenerateVSCodeWorkspaceFile()` + `OpenVsCode()` path, scan `vscode-windows/` for an entry with fresh heartbeat (< 30s old) whose `scriptRootPaths` overlap this instance's `AllRootPaths`; skip launching if found.

## Engine-side changes (`D:\Repos\UnrealEngineAngelscript`)

- **New settings** on `UAngelscriptSettings` (`D:\Repos\UnrealEngineAngelscript\Engine\Plugins\Angelscript\Source\AngelscriptCode\Public\AngelscriptSettings.h:41-269` — separate sibling repo, not a subpath of this one):
  - `bAutoOpenVSCode` (bool, default `false`).
  - `bAnnounceDebugServerForDiscovery` (bool, default `true`).
- **New discovery helper**, e.g. `AngelscriptDebugDiscovery.h/.cpp` alongside `AngelscriptDebugServer.*`, invoked right after the debug server's listener binds successfully in `AngelscriptManager.cpp` (~lines 424-430). Writes/removes `editors/<pid>.json`.
- **Auto-open VS Code**: factor the existing menu button body (`AngelscriptEditorModule.cpp`, ~lines 820-842) into a reusable `TryOpenVsCodeWorkspace()`, called from the menu action as today, and additionally once at module startup when `bAutoOpenVSCode` is true, gated by the `vscode-windows/` freshness scan described above.

## Extension-side changes (this repo)

- **New module** `extension/src/unreal-discovery.ts`, activated from `extension/src/extension.ts`'s `activate()`. Owns: self-registration/heartbeat, watching `editors/`, liveness validation, matching, auto-attach via `vscode.debug.startDebugging`, decline-tracking, and sending the LSP reroute notification.
- **`language-server/src/server.ts`**: add a handler for `angelscript/setUnrealConnection`; `connect_unreal()` reconnects only on an actual target change; falls back to the static `unrealConnectionPort` setting when notified of "no match."
- **New setting** `UnrealAngelscript.autoStartDebugging` (boolean, default `true`) — master toggle for discovery watching, auto-attach, and LS rerouting together.
- **No changes** to `unreal-debugclient.ts`'s or `server.ts`'s singleton connection model beyond the reconnect-on-notified-target-change described above (see Non-goals).

## Edge cases / error handling

- Missing discovery directory on first run: both sides create it lazily; the extension's watcher tolerates it not existing yet.
- Permission errors writing the shared directory: log once, degrade silently to today's fully-manual behavior; never blocks Editor startup or extension activation.
- Torn/partial JSON reads: parse errors are swallowed and retried next scan.
- Stale files from a crash: PID-liveness + freshness checks on both sides, with opportunistic cleanup.
- Two Editors racing for the same default port: the Engine only writes its discovery entry after a successful bind, so a failed-to-bind instance is correctly invisible.
- Two VS Code windows matching the same project: both are allowed to independently auto-attach; the Engine's `ClientsThatAreDebugging` list already supports multiple simultaneous debug clients.
- Editor closes mid-session: existing socket-close/termination handling is unchanged; the extension clears its tracking map on `onDidTerminateDebugSession` so a later relaunch can re-match.
- No bind-to-connect race: the discovery file only appears once the port is already accepting connections.

## Testing plan

Manual integration matrix (cross-process/cross-repo — no realistic way to unit test the Engine↔VSCode handshake in isolation beyond the pure path-matching logic, which should get unit tests):

1. Single Editor + single VS Code window, defaults → auto-attaches quietly, no `stopOnEntry` break.
2. Two Editor instances (two projects, distinct `-asdebugport`), two VS Code windows → each attaches only to its own match.
3. Editor launched *after* VS Code is already open → still detected.
4. Manual stop of an auto-attached session while the Editor keeps running → no immediate re-attach; Editor restart → re-attaches.
5. Simulated Editor crash (kill process) → stale entry cleaned up, no zombie attach attempts.
6. `bAutoOpenVSCode=true`: skips launching a second VS Code when a matching window is already open; launches when none is.
7. `autoStartDebugging=false` → falls back fully to current manual-F5 behavior (regression check).
8. Language server correctly follows the discovered port when it differs from the static `unrealConnectionPort` setting.

## Settings summary

| Side | Setting | Default | Purpose |
|---|---|---|---|
| Engine `UAngelscriptSettings` | `bAutoOpenVSCode` | `false` | Launch VS Code automatically on Editor startup |
| Engine `UAngelscriptSettings` | `bAnnounceDebugServerForDiscovery` | `true` | Write `editors/<pid>.json` registration at all |
| Extension `UnrealAngelscript.*` | `autoStartDebugging` | `true` | Master toggle: discovery watching + auto-attach + LS reroute |
