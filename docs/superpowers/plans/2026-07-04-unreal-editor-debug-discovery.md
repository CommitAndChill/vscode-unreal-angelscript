# Unreal Editor Auto-Detect & Auto-Start Debugging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect a running Unreal Editor whose script roots match the open VS Code workspace, auto-start an AngelScript debug session against it, follow its port for autocompletion, and optionally auto-launch VS Code from the Editor.

**Architecture:** A per-user discovery directory holds two registries — `editors/<pid>.json` (written by the Engine when its debug server binds) and `vscode-windows/<pid>.json` (written by the extension). The extension watches `editors/`, matches by script-root overlap, auto-attaches one debug session per matched Editor (keyed by Editor PID), and reroutes the language server to the matched host/port. The Engine optionally auto-opens VS Code on startup, skipping if a matching window is already registered.

**Tech Stack:** VS Code extension (TypeScript, esbuild, `vscode-languageclient` v8), Node builtins (`fs`/`net`/`os`/`path`), language server (TypeScript), Unreal Engine C++ (AngelscriptCode + AngelscriptEditor plugin modules).

**Source spec:** [docs/superpowers/specs/2026-07-04-unreal-editor-debug-discovery-design.md](../specs/2026-07-04-unreal-editor-debug-discovery-design.md)

## Global Constraints

- **Discovery directory must be byte-identical on both sides.** Do NOT use UE `FPlatformProcess::UserSettingsDir()` (it may carry a vendor `Epic/` segment). Both sides compose the path explicitly from OS env/home + these literal segments:
  - Windows: `%LOCALAPPDATA%` `/ UnrealEngineAngelscript / Discovery`
  - macOS: `$HOME / Library / Application Support / UnrealEngineAngelscript / Discovery`
  - Linux: `$XDG_CONFIG_HOME` (or `$HOME/.config` if unset) `/ UnrealEngineAngelscript / Discovery`
  - Subdirectories: `editors/` and `vscode-windows/`. Files: `<pid>.json`. All path separators normalized to `/` inside JSON.
- **Timing constants (hardcoded, not settings):** window heartbeat write interval 10s; editor-dir rescan fallback 2s; TCP liveness probe timeout 500ms; auto-open skip freshness window 30s; auto-open bind-check retry ≤3s @ 0.5s.
- **`startTime`/`heartbeat` are ISO-8601 UTC strings** (lexicographically sortable): Node `new Date().toISOString()`, UE `FDateTime::UtcNow().ToIso8601()`.
- **Master toggle:** `UnrealAngelscript.autoStartDebugging` (boolean, default `true`) gates ALL extension-side discovery I/O (self-registration, watching, auto-attach, LS reroute). When off, behavior is identical to today.
- **Engine settings:** `bAnnounceDebugServerForDiscovery` (default `true`) gates writing `editors/<pid>.json`; `bAutoOpenVSCode` (default `false`) gates auto-launching VS Code.
- **Deletion of another process's registration is gated on confirmed PID death only** — never on a transient TCP-probe failure.
- **Engine build/test goes through the host project's toolbox** (`D:\Repos\BusterBlock\CkAuto\UnrealToolbox.exe` `--build` / `--test`), per the `/build-test` skill. Never invoke `Build.bat`/UBT/`UnrealEditor-Cmd` directly. Engine automation tests use `IMPLEMENT_SIMPLE_AUTOMATION_TEST`, namespace prefix `Angelscript.CppTests.*`.

## Shared Data Types

Both JSON registries (used verbatim across tasks):

```typescript
// editors/<pid>.json  — written by the Engine
interface EditorRegistration {
    projectName: string;
    projectPath: string;
    scriptRootPaths: string[]; // project Script root + every enabled-plugin Script root, forward-slashed
    port: number;
    pid: number;
    engineVersion: string;
    startTime: string;         // ISO-8601 UTC
}

// vscode-windows/<pid>.json  — written by the extension
interface WindowRegistration {
    scriptRootPaths: string[]; // fsPath of every open workspace folder, forward-slashed
    pid: number;
    heartbeat: string;         // ISO-8601 UTC
}
```

## File Structure

**Extension (`D:\Repos\vscode-unreal-angelscript`):**
- Create `extension/src/discovery/types.ts` — the two interfaces above.
- Create `extension/src/discovery/paths.ts` — pure per-platform discovery-directory resolver.
- Create `extension/src/discovery/match.ts` — pure root-normalization, overlap, and best-editor selection.
- Create `extension/src/discovery/registry.ts` — parse/validate editor files; write/refresh/remove the window file; delete stale editor files.
- Create `extension/src/discovery/liveness.ts` — PID-alive check + TCP probe.
- Create `extension/src/discovery/watcher.ts` — `fs.watch` + 2s poll over `editors/`.
- Create `extension/src/discovery/index.ts` — `activate(context, client)` / `deactivate()`: orchestration (auto-attach, decline set, terminate listener, LS notify, self-registration).
- Create tests `extension/src/discovery/match.test.ts`, `extension/src/discovery/paths.test.ts`, `extension/src/discovery/registry.test.ts`.
- Create `extension/esbuild.test.js` — bundles the `*.test.ts` files to `extension/out-test/` for `node --test`.
- Modify `extension/src/extension.ts` — import + call `discovery.activate(context, client)`; add `deactivate()`.
- Modify `package.json` — add the `autoStartDebugging` setting; add a root `test` script.
- Modify `language-server/src/server.ts` — `setUnrealConnection` notification + override precedence.

**Engine (`D:\Repos\UnrealEngineAngelscript`), all under `Engine/Plugins/Angelscript/Source/`:**
- Modify `AngelscriptCode/Public/AngelscriptSettings.h` — two new UPROPERTYs.
- Modify `AngelscriptCode/Private/Debugging/AngelscriptDebugServer.h` / `.cpp` — `Port` member, `IsListening()`, `GetPort()`, dtor delete hook.
- Create `AngelscriptCode/Private/Debugging/AngelscriptDebugDiscovery.h` / `.cpp` — discovery path helpers, write/remove editor registration, scan window registrations, `RootsOverlap`.
- Modify `AngelscriptCode/Private/AngelscriptManager.cpp` — schedule the registration write after bind confirms.
- Modify `AngelscriptEditor/Private/AngelscriptEditorModule.cpp` — factor `TryOpenVsCodeWorkspace()`, add gated auto-open on engine-init with skip-if-open.
- Create `AngelscriptCode/Private/Tests/AngelscriptDebugDiscoveryTests.cpp` — automation test for `RootsOverlap`.

---

## Task 1: Extension — discovery path resolver + test harness

**Files:**
- Create: `extension/src/discovery/types.ts`, `extension/src/discovery/paths.ts`
- Create: `extension/src/discovery/paths.test.ts`, `extension/esbuild.test.js`
- Modify: `package.json` (root `scripts`)
- Test: `extension/out-test/paths.test.js` (built artifact)

**Interfaces:**
- Produces: `EditorRegistration`, `WindowRegistration` (types.ts). `discoveryRoot(platform, env, homedir): string`, `editorsDir(...)`, `windowsDir(...)` (paths.ts) — all pure, dependency-injected so they're testable without touching the real filesystem.

- [ ] **Step 1: Write `types.ts`**

```typescript
// extension/src/discovery/types.ts
export interface EditorRegistration {
    projectName: string;
    projectPath: string;
    scriptRootPaths: string[];
    port: number;
    pid: number;
    engineVersion: string;
    startTime: string;
}

export interface WindowRegistration {
    scriptRootPaths: string[];
    pid: number;
    heartbeat: string;
}
```

- [ ] **Step 2: Write the failing test for `paths.ts`**

```typescript
// extension/src/discovery/paths.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveryRoot, editorsDir, windowsDir } from './paths';

test('windows uses LOCALAPPDATA', () => {
    const root = discoveryRoot('win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'C:\\Users\\x');
    assert.equal(root, 'C:/Users/x/AppData/Local/UnrealEngineAngelscript/Discovery');
});

test('macos uses HOME/Library/Application Support', () => {
    const root = discoveryRoot('darwin', {}, '/Users/x');
    assert.equal(root, '/Users/x/Library/Application Support/UnrealEngineAngelscript/Discovery');
});

test('linux prefers XDG_CONFIG_HOME then falls back to ~/.config', () => {
    assert.equal(
        discoveryRoot('linux', { XDG_CONFIG_HOME: '/home/x/.cfg' }, '/home/x'),
        '/home/x/.cfg/UnrealEngineAngelscript/Discovery');
    assert.equal(
        discoveryRoot('linux', {}, '/home/x'),
        '/home/x/.config/UnrealEngineAngelscript/Discovery');
});

test('subdirs append editors/ and vscode-windows/', () => {
    const root = discoveryRoot('linux', {}, '/home/x');
    assert.equal(editorsDir(root), '/home/x/.config/UnrealEngineAngelscript/Discovery/editors');
    assert.equal(windowsDir(root), '/home/x/.config/UnrealEngineAngelscript/Discovery/vscode-windows');
});
```

- [ ] **Step 3: Write `esbuild.test.js` (the runner)**

```javascript
// extension/esbuild.test.js
const esbuild = require('esbuild');
const glob = require('fs').readdirSync('src/discovery').filter(f => f.endsWith('.test.ts'));
esbuild.build({
    entryPoints: glob.map(f => `src/discovery/${f}`),
    outdir: 'out-test',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: false,
}).catch(() => process.exit(1));
```

- [ ] **Step 4: Add the root `test` script**

In `package.json` `scripts` (root, currently lines ~816-827), add after `"compile:language-server"`:

```json
        "test": "cd extension && node esbuild.test.js && node --test out-test/",
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — esbuild error "Could not resolve ./paths" (paths.ts does not exist yet).

- [ ] **Step 6: Write `paths.ts`**

```typescript
// extension/src/discovery/paths.ts
// Compose the discovery directory explicitly from OS env/home so it is
// byte-identical to the Engine side (which composes the same segments).
// Do NOT rely on UE UserSettingsDir(): it can include a vendor 'Epic/' segment.

const APP_SEGMENT = 'UnrealEngineAngelscript';
const DISCOVERY_SEGMENT = 'Discovery';

function toForwardSlashes(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function discoveryRoot(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    homedir: string,
): string {
    let base: string;
    if (platform === 'win32') {
        base = env.LOCALAPPDATA ?? `${homedir}\\AppData\\Local`;
    } else if (platform === 'darwin') {
        base = `${homedir}/Library/Application Support`;
    } else {
        base = env.XDG_CONFIG_HOME ?? `${homedir}/.config`;
    }
    return `${toForwardSlashes(base)}/${APP_SEGMENT}/${DISCOVERY_SEGMENT}`;
}

export function editorsDir(root: string): string {
    return `${root}/editors`;
}

export function windowsDir(root: string): string {
    return `${root}/vscode-windows`;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all `paths.test.ts` cases green.

- [ ] **Step 8: Commit**

```bash
git add extension/src/discovery/types.ts extension/src/discovery/paths.ts extension/src/discovery/paths.test.ts extension/esbuild.test.js package.json
git commit -m "feat(discovery): cross-platform discovery-dir resolver + node --test harness"
```

---

## Task 2: Extension — root matching & best-editor selection

**Files:**
- Create: `extension/src/discovery/match.ts`
- Test: `extension/src/discovery/match.test.ts`

**Interfaces:**
- Consumes: `EditorRegistration` (types.ts).
- Produces: `normalizeRoot(p): string`, `rootsOverlap(a, b): boolean`, `editorMatchesWorkspace(editorRoots, workspaceRoots): boolean`, `pickBestEditor(editors, workspaceRoots): EditorRegistration | null`.

- [ ] **Step 1: Write the failing test**

```typescript
// extension/src/discovery/match.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoot, rootsOverlap, editorMatchesWorkspace, pickBestEditor } from './match';
import { EditorRegistration } from './types';

test('normalizeRoot lowercases drive, forward-slashes, strips trailing slash', () => {
    assert.equal(normalizeRoot('C:\\Proj\\Script\\'), 'c:/proj/script');
    assert.equal(normalizeRoot('/Home/X/Script'), '/home/x/script');
});

test('rootsOverlap: equal, ancestor, descendant true; siblings false', () => {
    assert.equal(rootsOverlap('C:/Proj/Script', 'c:/proj/script'), true);
    assert.equal(rootsOverlap('C:/Proj', 'C:/Proj/Script'), true);          // ancestor
    assert.equal(rootsOverlap('C:/Proj/Script/Sub', 'C:/Proj/Script'), true); // descendant
    assert.equal(rootsOverlap('C:/Proj/ScriptOther', 'C:/Proj/Script'), false); // prefix but not path-boundary
    assert.equal(rootsOverlap('C:/A/Script', 'C:/B/Script'), false);
});

test('editorMatchesWorkspace: any overlap wins', () => {
    const editorRoots = ['C:/Proj/Script', 'C:/UE/Plugins/P/Script'];
    assert.equal(editorMatchesWorkspace(editorRoots, ['C:/Proj/Script']), true);
    assert.equal(editorMatchesWorkspace(editorRoots, ['C:/UE/Plugins/P/Script']), true);
    assert.equal(editorMatchesWorkspace(editorRoots, ['C:/Unrelated']), false);
    assert.equal(editorMatchesWorkspace(editorRoots, []), false);
});

function ed(pid: number, startTime: string, roots: string[]): EditorRegistration {
    return { projectName: 'P', projectPath: 'C:/Proj', scriptRootPaths: roots,
             port: 27099, pid, engineVersion: '5.x', startTime };
}

test('pickBestEditor returns most-recent matching editor, or null', () => {
    const a = ed(1, '2026-07-04T10:00:00Z', ['C:/Proj/Script']);
    const b = ed(2, '2026-07-04T11:00:00Z', ['C:/Proj/Script']);
    const c = ed(3, '2026-07-04T12:00:00Z', ['C:/Other/Script']);
    assert.equal(pickBestEditor([a, b, c], ['C:/Proj/Script'])?.pid, 2); // b is newest match
    assert.equal(pickBestEditor([a, c], ['C:/Nope'])!, null);
    assert.equal(pickBestEditor([], ['C:/Proj/Script'])!, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./match`.

- [ ] **Step 3: Write `match.ts`**

```typescript
// extension/src/discovery/match.ts
import { EditorRegistration } from './types';

export function normalizeRoot(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// True when a and b are the same path, or one is an ancestor of the other,
// compared on path boundaries so 'Script' does not match 'ScriptOther'.
export function rootsOverlap(a: string, b: string): boolean {
    const na = normalizeRoot(a);
    const nb = normalizeRoot(b);
    if (na === nb) return true;
    const shorter = na.length < nb.length ? na : nb;
    const longer = na.length < nb.length ? nb : na;
    return longer.startsWith(shorter + '/');
}

export function editorMatchesWorkspace(editorRoots: string[], workspaceRoots: string[]): boolean {
    for (const e of editorRoots) {
        for (const w of workspaceRoots) {
            if (rootsOverlap(e, w)) return true;
        }
    }
    return false;
}

// Most-recently-started matching editor (ISO-8601 startTime sorts lexically), else null.
export function pickBestEditor(
    editors: EditorRegistration[],
    workspaceRoots: string[],
): EditorRegistration | null {
    let best: EditorRegistration | null = null;
    for (const e of editors) {
        if (!editorMatchesWorkspace(e.scriptRootPaths, workspaceRoots)) continue;
        if (best === null || e.startTime > best.startTime) best = e;
    }
    return best;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS — `paths.test.ts` and `match.test.ts` all green.

- [ ] **Step 5: Commit**

```bash
git add extension/src/discovery/match.ts extension/src/discovery/match.test.ts
git commit -m "feat(discovery): pure root-overlap matching and best-editor selection"
```

---

## Task 3: Extension — editor-file parse/validate + window-file write/remove

**Files:**
- Create: `extension/src/discovery/registry.ts`
- Test: `extension/src/discovery/registry.test.ts`

**Interfaces:**
- Consumes: `EditorRegistration`, `WindowRegistration` (types.ts).
- Produces: `isValidEditorRegistration(o): o is EditorRegistration`, `parseEditorRegistrations(files: {name, contents}[]): EditorRegistration[]`, `readEditorRegistrations(editorsDir): EditorRegistration[]`, `writeWindowRegistration(windowsDir, reg)`, `removeWindowRegistration(windowsDir, pid)`, `deleteEditorRegistration(editorsDir, pid)`.

The validation/parse split keeps the pure part (`isValidEditorRegistration`, `parseEditorRegistrations`) unit-testable without touching disk; the disk wrappers (`read*`, `write*`, `*remove*`, `delete*`) are thin and integration-verified.

- [ ] **Step 1: Write the failing test (pure parts only)**

```typescript
// extension/src/discovery/registry.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidEditorRegistration, parseEditorRegistrations } from './registry';

const good = JSON.stringify({
    projectName: 'P', projectPath: 'C:/Proj', scriptRootPaths: ['C:/Proj/Script'],
    port: 27099, pid: 1234, engineVersion: '5.x', startTime: '2026-07-04T10:00:00Z',
});

test('isValidEditorRegistration accepts a well-formed object', () => {
    assert.equal(isValidEditorRegistration(JSON.parse(good)), true);
});

test('isValidEditorRegistration rejects missing/mistyped fields', () => {
    assert.equal(isValidEditorRegistration({}), false);
    assert.equal(isValidEditorRegistration({ ...JSON.parse(good), port: 'x' }), false);
    assert.equal(isValidEditorRegistration({ ...JSON.parse(good), scriptRootPaths: 'no' }), false);
    assert.equal(isValidEditorRegistration(null), false);
});

test('parseEditorRegistrations skips torn/invalid files, keeps valid ones', () => {
    const out = parseEditorRegistrations([
        { name: '1.json', contents: good },
        { name: '2.json', contents: '{ this is not json' },     // torn
        { name: '3.json', contents: '{"port":1}' },             // invalid shape
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].pid, 1234);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./registry`.

- [ ] **Step 3: Write `registry.ts`**

```typescript
// extension/src/discovery/registry.ts
import * as fs from 'fs';
import { EditorRegistration, WindowRegistration } from './types';

export function isValidEditorRegistration(o: any): o is EditorRegistration {
    return !!o
        && typeof o.projectName === 'string'
        && typeof o.projectPath === 'string'
        && Array.isArray(o.scriptRootPaths)
        && o.scriptRootPaths.every((s: any) => typeof s === 'string')
        && typeof o.port === 'number'
        && typeof o.pid === 'number'
        && typeof o.engineVersion === 'string'
        && typeof o.startTime === 'string';
}

export function parseEditorRegistrations(files: { name: string; contents: string }[]): EditorRegistration[] {
    const out: EditorRegistration[] = [];
    for (const f of files) {
        let obj: any;
        try { obj = JSON.parse(f.contents); } catch { continue; } // torn/partial read: skip, retried next scan
        if (isValidEditorRegistration(obj)) out.push(obj);
    }
    return out;
}

export function readEditorRegistrations(editorsDir: string): EditorRegistration[] {
    let names: string[];
    try { names = fs.readdirSync(editorsDir); } catch { return []; } // dir may not exist yet
    const files: { name: string; contents: string }[] = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try { files.push({ name, contents: fs.readFileSync(`${editorsDir}/${name}`, 'utf8') }); } catch { /* vanished */ }
    }
    return parseEditorRegistrations(files);
}

export function writeWindowRegistration(windowsDir: string, reg: WindowRegistration): void {
    try {
        fs.mkdirSync(windowsDir, { recursive: true });
        // Atomic-ish: write temp then rename so a reader never sees a torn file.
        const target = `${windowsDir}/${reg.pid}.json`;
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(reg), 'utf8');
        fs.renameSync(tmp, target);
    } catch { /* permission/degrade: silently fall back to manual behavior */ }
}

export function removeWindowRegistration(windowsDir: string, pid: number): void {
    try { fs.unlinkSync(`${windowsDir}/${pid}.json`); } catch { /* already gone */ }
}

// Deletes another process's editor file — call ONLY after confirming its PID is dead.
export function deleteEditorRegistration(editorsDir: string, pid: number): void {
    try { fs.unlinkSync(`${editorsDir}/${pid}.json`); } catch { /* already gone */ }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS — all three test files green.

- [ ] **Step 5: Commit**

```bash
git add extension/src/discovery/registry.ts extension/src/discovery/registry.test.ts
git commit -m "feat(discovery): editor-file validation/parse + window-file registry IO"
```

---

## Task 4: Extension — liveness (PID + TCP probe)

**Files:**
- Create: `extension/src/discovery/liveness.ts`

**Interfaces:**
- Produces: `isPidAlive(pid: number): boolean`, `tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean>`.

No unit test — both are thin wrappers over OS/network primitives with no pure logic; they are exercised by the integration matrix (Task 12). Keeping them in their own module documents that boundary.

- [ ] **Step 1: Write `liveness.ts`**

```typescript
// extension/src/discovery/liveness.ts
import { Socket } from 'net';

// process.kill(pid, 0) sends no signal; it throws ESRCH if the pid is dead,
// EPERM if alive-but-not-ours (still alive). Anything non-ESRCH => alive.
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        return e && e.code === 'EPERM';
    }
}

export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = new Socket();
        let done = false;
        const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            sock.destroy();
            resolve(ok);
        };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        sock.connect(port, host);
    });
}
```

- [ ] **Step 2: Type-check (no unit test)**

Run: `npm run compile:extension`
Expected: esbuild bundles with no errors.

- [ ] **Step 3: Commit**

```bash
git add extension/src/discovery/liveness.ts
git commit -m "feat(discovery): PID-alive check and TCP liveness probe"
```

---

## Task 5: Extension — editors/ watcher (fs.watch + poll)

**Files:**
- Create: `extension/src/discovery/watcher.ts`

**Interfaces:**
- Produces: `class DiscoveryWatcher { constructor(editorsDir: string, onChange: () => void); start(): void; dispose(): void; }` — fires `onChange` (debounced ~200ms) on any fs.watch event and on a 2s poll; tolerates the directory not existing yet.

No unit test (filesystem timing); verified in Task 12.

- [ ] **Step 1: Write `watcher.ts`**

```typescript
// extension/src/discovery/watcher.ts
import * as fs from 'fs';

const POLL_MS = 2000;
const DEBOUNCE_MS = 200;

export class DiscoveryWatcher {
    private watcher?: fs.FSWatcher;
    private poll?: NodeJS.Timeout;
    private debounce?: NodeJS.Timeout;
    private disposed = false;

    constructor(private editorsDir: string, private onChange: () => void) {}

    start(): void {
        try { fs.mkdirSync(this.editorsDir, { recursive: true }); } catch { /* best effort */ }
        this.tryWatch();
        // Poll fallback: fs.watch is unreliable on network drives / some platforms,
        // and re-establishes the watch if the directory is recreated.
        this.poll = setInterval(() => {
            if (!this.watcher) this.tryWatch();
            this.fire();
        }, POLL_MS);
    }

    private tryWatch(): void {
        try {
            this.watcher = fs.watch(this.editorsDir, () => this.fire());
            this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
        } catch { this.watcher = undefined; }
    }

    private fire(): void {
        if (this.disposed) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.onChange(), DEBOUNCE_MS);
    }

    dispose(): void {
        this.disposed = true;
        if (this.debounce) clearTimeout(this.debounce);
        if (this.poll) clearInterval(this.poll);
        this.watcher?.close();
    }
}
```

- [ ] **Step 2: Type-check**

Run: `npm run compile:extension`
Expected: bundles with no errors.

- [ ] **Step 3: Commit**

```bash
git add extension/src/discovery/watcher.ts
git commit -m "feat(discovery): editors/ directory watcher with poll fallback"
```

---

## Task 6: Extension — orchestration (activate/deactivate) + wiring + setting

**Files:**
- Create: `extension/src/discovery/index.ts`
- Modify: `extension/src/extension.ts` (import near line 17; call after line 61; add `deactivate()`)
- Modify: `package.json` (config property after line 91)

**Interfaces:**
- Consumes: everything from Tasks 1–5, plus the `LanguageClient` (`client`) from `extension.ts:52`.
- Produces: `activate(context: vscode.ExtensionContext, client: LanguageClient): void`, `deactivate(): Promise<void>`.

**Behavior contract:**
- Self-register `vscode-windows/<pid>.json` on activate (guarded by `autoStartDebugging`), refresh heartbeat every 10s, remove on deactivate.
- On each `editors/` change: read registrations; for each, if `isPidAlive(pid)===false` delete its file; from the survivors, `pickBestEditor` against workspace roots.
- For the chosen editor (if any) not already tracked and not in the declined set: `tcpProbe(host, port, 500)`; if it connects, `vscode.debug.startDebugging(folder, config)` exactly once with `{ type:'angelscript', request:'launch', name:'Auto: <projectName>', hostname:'localhost', port, stopOnEntry:false }`, and record `editorPid -> {sessionId?}`. If the probe fails (PID alive), do nothing and retry next scan — never delete the file.
- On chosen-editor change (gained/lost/different host:port): `client.sendNotification('angelscript/setUnrealConnection', { hostname, port })`, or `{ hostname: null, port: null }` when no editor matches.
- `onDidTerminateDebugSession`: find the `editorPid` owning that session; if its file still present, add `editorPid` to the declined set; drop it from tracking regardless.
- All of the above no-ops when `autoStartDebugging` is `false`.

- [ ] **Step 1: Write `index.ts`**

```typescript
// extension/src/discovery/index.ts
import * as vscode from 'vscode';
import * as os from 'os';
import { LanguageClient } from 'vscode-languageclient/node';
import { discoveryRoot, editorsDir, windowsDir } from './paths';
import { readEditorRegistrations, writeWindowRegistration, removeWindowRegistration, deleteEditorRegistration } from './registry';
import { pickBestEditor } from './match';
import { isPidAlive, tcpProbe } from './liveness';
import { DiscoveryWatcher } from './watcher';
import { EditorRegistration } from './types';

const HEARTBEAT_MS = 10000;
const PROBE_TIMEOUT_MS = 500;
const SETTINGS_SECTION = 'UnrealAngelscript';
const PID_CONFIG_KEY = '__discoveryEditorPid'; // stashed in the debug config so sessions carry their editor pid

let root: string;
let watcher: DiscoveryWatcher | undefined;
let heartbeat: NodeJS.Timeout | undefined;
let langClient: LanguageClient | undefined;

const tracked = new Set<number>();   // editorPids we currently have an auto session for
const declined = new Set<number>();  // editorPids the user stopped while still running
let lastNotified: string | undefined; // `${host}:${port}` last sent to the LS
let scanning = false;                 // re-entrancy guard for onDiscoveryChanged
let rescanQueued = false;

function enabled(): boolean {
    return vscode.workspace.getConfiguration(SETTINGS_SECTION).get<boolean>('autoStartDebugging', true);
}

function workspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
}

function writeSelf(): void {
    writeWindowRegistration(windowsDir(root), {
        scriptRootPaths: workspaceRoots(),
        pid: process.pid,
        heartbeat: new Date().toISOString(),
    });
}

async function notifyLanguageServer(host: string | null, port: number | null): Promise<void> {
    const key = host && port ? `${host}:${port}` : 'none';
    if (key === lastNotified) return;
    lastNotified = key;
    try { await langClient?.sendNotification('angelscript/setUnrealConnection', { hostname: host, port }); }
    catch { /* server not ready yet; next change re-sends */ }
}

// Serialized via the `scanning` flag so overlapping watcher fires can never double-attach.
async function onDiscoveryChanged(): Promise<void> {
    if (!enabled()) return;
    if (scanning) { rescanQueued = true; return; }
    scanning = true;
    try {
        const editors = readEditorRegistrations(editorsDir(root));
        // Deletion gated on confirmed PID death only.
        const live: EditorRegistration[] = [];
        for (const e of editors) {
            if (isPidAlive(e.pid)) live.push(e);
            else deleteEditorRegistration(editorsDir(root), e.pid);
        }

        const chosen = pickBestEditor(live, workspaceRoots());

        // Language server follows the chosen editor (or reverts to the static setting).
        if (chosen) await notifyLanguageServer('127.0.0.1', chosen.port);
        else await notifyLanguageServer(null, null);

        if (!chosen) return;
        if (tracked.has(chosen.pid) || declined.has(chosen.pid)) return;

        // Reserve the slot synchronously BEFORE any await, so a concurrent scan sees it taken.
        tracked.add(chosen.pid);

        if (!(await tcpProbe('127.0.0.1', chosen.port, PROBE_TIMEOUT_MS))) {
            tracked.delete(chosen.pid); // not attachable yet; retry next scan, do NOT delete the file
            return;
        }

        const config: vscode.DebugConfiguration = {
            type: 'angelscript',
            request: 'launch',
            name: `Auto: ${chosen.projectName}`,
            hostname: 'localhost',
            port: chosen.port,
            stopOnEntry: false,
            [PID_CONFIG_KEY]: chosen.pid, // survives into session.configuration; used by the terminate handler
        };
        const ok = await vscode.debug.startDebugging(matchingFolder(), config);
        if (!ok) tracked.delete(chosen.pid); // launch refused; allow a later retry
    } finally {
        scanning = false;
        if (rescanQueued) { rescanQueued = false; void onDiscoveryChanged(); }
    }
}

function matchingFolder(): vscode.WorkspaceFolder | undefined {
    return (vscode.workspace.workspaceFolders ?? [])[0]; // any folder is a valid scope; VS Code needs one, not a match
}

export function activate(context: vscode.ExtensionContext, client: LanguageClient): void {
    langClient = client;
    root = discoveryRoot(process.platform, process.env, os.homedir());

    if (enabled()) {
        writeSelf();
        heartbeat = setInterval(writeSelf, HEARTBEAT_MS);
        watcher = new DiscoveryWatcher(editorsDir(root), () => { void onDiscoveryChanged(); });
        watcher.start();
        void onDiscoveryChanged(); // initial pass for an Editor already running at activation
    }

    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
        const pid = session.configuration?.[PID_CONFIG_KEY];
        if (typeof pid !== 'number' || !tracked.has(pid)) return;
        tracked.delete(pid);
        if (isPidAlive(pid)) declined.add(pid); // don't re-attach the same still-running instance
    }));

    context.subscriptions.push({ dispose: () => { void deactivate(); } });
}

export async function deactivate(): Promise<void> {
    watcher?.dispose();
    if (heartbeat) clearInterval(heartbeat);
    removeWindowRegistration(windowsDir(root), process.pid);
}
```

Note on session identity: the chosen editor's PID is stashed in the synthesized config under `__discoveryEditorPid`. VS Code preserves custom config fields on `DebugSession.configuration`, so the terminate handler reads the PID directly off the stopped session — no fragile name-matching, and no `onDidStartDebugSession` bookkeeping. The `scanning` flag plus a synchronous `tracked.add` before the first `await` closes the double-attach window when the watcher fires repeatedly during a probe.

- [ ] **Step 2: Wire into `extension.ts` — import**

Add next to the `decorations` import (extension.ts:17):

```typescript
import * as discovery from './discovery';
```

- [ ] **Step 3: Wire into `extension.ts` — activate call**

Immediately after `decorations.activate(context);` (extension.ts:61), insert:

```typescript
    // Auto-detect a running Unreal Editor and auto-start debugging.
    discovery.activate(context, client);
```

(`client` is declared at extension.ts:52 and in scope here.)

- [ ] **Step 4: Wire into `extension.ts` — deactivate export**

At the end of `extension.ts` (after the `activate` function closes), add:

```typescript
export function deactivate(): Thenable<void> {
    return discovery.deactivate();
}
```

- [ ] **Step 5: Add the `autoStartDebugging` setting**

In `package.json`, inside `contributes.configuration.properties`, immediately after the `UnrealAngelscript.unrealConnectionPort` block (after line 91's closing `},`), add (matching 16/20-space indentation):

```json
                "UnrealAngelscript.autoStartDebugging": {
                    "type": "boolean",
                    "default": true,
                    "description": "Automatically detect a running Unreal Editor whose script folders match this workspace, start debugging against it, and point auto-completion at its port. Turn off to require manually starting the debugger."
                },
```

- [ ] **Step 6: Compile**

Run: `npm run compile`
Expected: both bundles build with no errors.

- [ ] **Step 7: Run the pure-logic tests (regression)**

Run: `npm test`
Expected: PASS — Tasks 1–3 tests still green (this task added no pure logic, but confirms nothing broke the build the runner depends on).

- [ ] **Step 8: Commit**

```bash
git add extension/src/discovery/index.ts extension/src/extension.ts package.json
git commit -m "feat(discovery): auto-attach orchestration, LS reroute, window self-registration"
```

---

## Task 7: Language server — `setUnrealConnection` notification + override precedence

**Files:**
- Modify: `language-server/src/server.ts`

**Interfaces:**
- Consumes: the `angelscript/setUnrealConnection` notification `{ hostname: string | null, port: number | null }` sent by Task 6.
- Produces: a runtime override of the module `hostname`/`port` that survives config syncs.

**The precedence problem (load-bearing):** `onDidChangeConfiguration` (server.ts:1224) sets `port = settings.unrealConnectionPort` and reconnects whenever VS Code syncs config — this would clobber a live reroute. The fix: an `overrideActive` flag that, when set, suppresses the config handler's port assignment.

- [ ] **Step 1: Make `hostname` mutable**

At server.ts:62, change:

```typescript
const hostname = "127.0.0.1";
```
to:
```typescript
let hostname = "127.0.0.1";
```

- [ ] **Step 2: Add override state + a target-applying helper**

Immediately after the `port` declaration (server.ts:63) add:

```typescript
let overrideActive = false;       // true while an editor-discovery reroute is in effect
let configuredPort = 27099;       // last port from VS Code settings, used to revert on clear

// Apply a connection target and reconnect only if it actually changed.
function applyConnectionTarget(newHost: string, newPort: number)
{
    if (newHost === hostname && newPort === port)
        return;
    hostname = newHost;
    port = newPort;
    connect_unreal();
}
```

- [ ] **Step 3: Register the notification handler**

Near the existing `angelscript/*` handlers (e.g. right after the `connection.onRequest("angelscript/getModuleForSymbol", ...)` block around server.ts:1036), add:

```typescript
connection.onNotification("angelscript/setUnrealConnection", (target : { hostname : string | null, port : number | null }) =>
{
    if (target && target.hostname && target.port)
    {
        overrideActive = true;
        applyConnectionTarget(target.hostname, target.port);
    }
    else
    {
        // Cleared: revert to the statically configured port on loopback.
        overrideActive = false;
        applyConnectionTarget("127.0.0.1", configuredPort);
    }
});
```

- [ ] **Step 4: Stop the config handler from clobbering an active override**

In `onDidChangeConfiguration` (server.ts:1224), replace the trailing port block (currently lines ~1249-1254):

```typescript
    if (port != settings.unrealConnectionPort)
    {
        port = settings.unrealConnectionPort;

        // If the port has changed, reconnect
        connect_unreal();
    }
```
with:
```typescript
    configuredPort = settings.unrealConnectionPort;
    if (!overrideActive && port != configuredPort)
    {
        // No discovery override in effect — honor the static setting as before.
        applyConnectionTarget("127.0.0.1", configuredPort);
    }
```

- [ ] **Step 5: Compile the language server**

Run: `npm run compile:language-server`
Expected: esbuild bundles with no errors.

- [ ] **Step 6: Commit**

```bash
git add language-server/src/server.ts
git commit -m "feat(lsp): honor angelscript/setUnrealConnection reroute over static port setting"
```

---

## Task 8: Engine — new settings on `UAngelscriptSettings`

**Files:**
- Modify: `Engine/Plugins/Angelscript/Source/AngelscriptCode/Public/AngelscriptSettings.h`

**Interfaces:**
- Produces: `UAngelscriptSettings::bAutoOpenVSCode` (bool), `UAngelscriptSettings::bAnnounceDebugServerForDiscovery` (bool), read via `FAngelscriptManager::ConfigSettings->...` as the existing settings are.

- [ ] **Step 1: Add the two UPROPERTYs**

In `AngelscriptSettings.h`, immediately after the `VSCodeWorkspacePath` property (line 198), add:

```cpp
	/**
	 * When enabled, automatically launch Visual Studio Code (opening this project's Angelscript
	 * workspace) once when the editor finishes starting. Skipped if a VS Code window that already
	 * has this project's script roots open is detected. Off by default.
	 */
	UPROPERTY(Config, EditDefaultsOnly, Category = "Editor")
	bool bAutoOpenVSCode = false;

	/**
	 * When enabled, publish a small discovery file for the running debug server so an external
	 * VS Code instance can detect this editor and auto-start debugging. On by default; inert
	 * unless a matching VS Code window is watching.
	 */
	UPROPERTY(Config, EditDefaultsOnly, Category = "Angelscript", Meta = (ConfigRestartRequired = true))
	bool bAnnounceDebugServerForDiscovery = true;
```

- [ ] **Step 2: Build (via toolbox) — verify it compiles**

Use the `/build-test` skill to run the host-project build through `D:\Repos\BusterBlock\CkAuto\UnrealToolbox.exe --build`.
Expected: AngelscriptCode compiles; the settings appear under Project Settings → Angelscript / Editor.

- [ ] **Step 3: Commit (engine repo)**

```bash
cd /d/Repos/UnrealEngineAngelscript
git add Engine/Plugins/Angelscript/Source/AngelscriptCode/Public/AngelscriptSettings.h
git commit -m "feat(angelscript): add bAutoOpenVSCode and bAnnounceDebugServerForDiscovery settings"
```

---

## Task 9: Engine — debug server exposes port + listening state; deletes registration on shutdown

**Files:**
- Modify: `AngelscriptCode/Private/Debugging/AngelscriptDebugServer.h`
- Modify: `AngelscriptCode/Private/Debugging/AngelscriptDebugServer.cpp`

**Interfaces:**
- Produces: `FAngelscriptDebugServer::IsListening() const`, `FAngelscriptDebugServer::GetPort() const`. Depends on `FAngelscriptDebugDiscovery::RemoveEditorRegistration()` from Task 10 for the dtor hook — implement Task 10 before this task's Step 3, or stub the call and fill it in Task 10.

- [ ] **Step 1: Add members + accessors (header)**

In `AngelscriptDebugServer.h`, in the `class FAngelscriptDebugServer` private section (after `Listener` at line 512) add:

```cpp
	int Port = 0;
```

and in the `public:` section (near the ctor/dtor declarations ~565) add:

```cpp
	bool IsListening() const;
	int GetPort() const { return Port; }
```

- [ ] **Step 2: Capture the port + implement `IsListening` (cpp)**

In the ctor (AngelscriptDebugServer.cpp:297), set the member as the first line of the body:

```cpp
FAngelscriptDebugServer::FAngelscriptDebugServer(int InPort)
{
	Port = InPort;
	Listener = new FTcpListener(FIPv4Endpoint(FIPv4Address::Any, InPort));
```

(Rename the parameter `Port` → `InPort` to avoid shadowing the new member; update the `FIPv4Endpoint(..., InPort)` and any other in-ctor use.)

Add the accessor implementation after the dtor:

```cpp
bool FAngelscriptDebugServer::IsListening() const
{
	return Listener && Listener->IsActive();
}
```

Also update the header declaration `FAngelscriptDebugServer(int Port);` → `FAngelscriptDebugServer(int InPort);` for consistency.

- [ ] **Step 3: Delete the discovery file on clean shutdown (dtor)**

In the dtor (AngelscriptDebugServer.cpp:312), after `Listener->Stop(); delete Listener; Listener = NULL;`, add:

```cpp
#if WITH_AS_DEBUGSERVER
	FAngelscriptDebugDiscovery::RemoveEditorRegistration();
#endif
```

Add the include at the top of the .cpp:

```cpp
#include "AngelscriptDebugDiscovery.h"
```

- [ ] **Step 4: Build (toolbox) — verify**

`/build-test` → `UnrealToolbox.exe --build`. Expected: compiles (with Task 10's file present).

- [ ] **Step 5: Commit**

```bash
git add Engine/Plugins/Angelscript/Source/AngelscriptCode/Private/Debugging/AngelscriptDebugServer.h Engine/Plugins/Angelscript/Source/AngelscriptCode/Private/Debugging/AngelscriptDebugServer.cpp
git commit -m "feat(angelscript): expose debug-server port/listening state; remove discovery file on shutdown"
```

---

## Task 10: Engine — `FAngelscriptDebugDiscovery` helper + manager wiring

**Files:**
- Create: `AngelscriptCode/Private/Debugging/AngelscriptDebugDiscovery.h`
- Create: `AngelscriptCode/Private/Debugging/AngelscriptDebugDiscovery.cpp`
- Modify: `AngelscriptCode/Private/AngelscriptManager.cpp`

**Interfaces:**
- Produces:
  - `static FString FAngelscriptDebugDiscovery::GetDiscoveryRoot()` / `GetEditorsDir()` / `GetWindowsDir()` — byte-identical to the extension's `paths.ts`.
  - `static void FAngelscriptDebugDiscovery::WriteEditorRegistration(int Port)` — builds the JSON (project name, `MakeAllScriptRoots()` full list, port, pid, engine version, UtcNow) and writes `editors/<pid>.json`.
  - `static void FAngelscriptDebugDiscovery::RemoveEditorRegistration()` — deletes `editors/<pid>.json` (quiet).
  - `static bool FAngelscriptDebugDiscovery::IsMatchingVSCodeWindowOpen(const TArray<FString>& Roots)` — scans `vscode-windows/`, returns true if any fresh (<30s) window overlaps `Roots`.
  - `static bool FAngelscriptDebugDiscovery::RootsOverlap(const FString& A, const FString& B)` — path-boundary overlap, mirrors `match.ts` `rootsOverlap`.

- [ ] **Step 1: Write the header**

```cpp
// AngelscriptDebugDiscovery.h
#pragma once
#include "CoreMinimal.h"

// Publishes / consumes the cross-tool discovery registry shared with the VS Code extension.
// Path layout mirrors extension/src/discovery/paths.ts EXACTLY (do not use UserSettingsDir()).
class FAngelscriptDebugDiscovery
{
public:
	static FString GetDiscoveryRoot();
	static FString GetEditorsDir();
	static FString GetWindowsDir();

	static void WriteEditorRegistration(int Port);
	static void RemoveEditorRegistration();

	static bool IsMatchingVSCodeWindowOpen(const TArray<FString>& Roots);

	// True when A == B, or one is a path-boundary ancestor of the other (case-insensitive).
	static bool RootsOverlap(const FString& A, const FString& B);

private:
	static FString NormalizeRoot(const FString& Path);
	static FString RegistrationFilePath(); // editors/<pid>.json
};
```

- [ ] **Step 2: Write the implementation**

```cpp
// AngelscriptDebugDiscovery.cpp
#include "AngelscriptDebugDiscovery.h"
#include "AngelscriptManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/DateTime.h"
#include "Misc/App.h"
#include "Misc/EngineVersion.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformMisc.h"
#include "HAL/FileManager.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"

static const TCHAR* AppSegment = TEXT("UnrealEngineAngelscript");
static const TCHAR* DiscoverySegment = TEXT("Discovery");

FString FAngelscriptDebugDiscovery::GetDiscoveryRoot()
{
	FString Base;
#if PLATFORM_WINDOWS
	Base = FPlatformMisc::GetEnvironmentVariable(TEXT("LOCALAPPDATA"));
	if (Base.IsEmpty())
		Base = FString(FPlatformProcess::UserHomeDir()) / TEXT("AppData") / TEXT("Local");
#elif PLATFORM_MAC
	Base = FString(FPlatformProcess::UserHomeDir()) / TEXT("Library") / TEXT("Application Support");
#else
	Base = FPlatformMisc::GetEnvironmentVariable(TEXT("XDG_CONFIG_HOME"));
	if (Base.IsEmpty())
		Base = FString(FPlatformProcess::UserHomeDir()) / TEXT(".config");
#endif
	FString Root = Base / AppSegment / DiscoverySegment;
	FPaths::NormalizeDirectoryName(Root);
	Root.ReplaceInline(TEXT("\\"), TEXT("/"));
	return Root;
}

FString FAngelscriptDebugDiscovery::GetEditorsDir()  { return GetDiscoveryRoot() / TEXT("editors"); }
FString FAngelscriptDebugDiscovery::GetWindowsDir()  { return GetDiscoveryRoot() / TEXT("vscode-windows"); }

FString FAngelscriptDebugDiscovery::RegistrationFilePath()
{
	return GetEditorsDir() / FString::Printf(TEXT("%u.json"), FPlatformProcess::GetCurrentProcessId());
}

FString FAngelscriptDebugDiscovery::NormalizeRoot(const FString& Path)
{
	FString N = FPaths::ConvertRelativePathToFull(Path);
	N.ReplaceInline(TEXT("\\"), TEXT("/"));
	while (N.EndsWith(TEXT("/"))) N.LeftChopInline(1);
	return N.ToLower();
}

bool FAngelscriptDebugDiscovery::RootsOverlap(const FString& A, const FString& B)
{
	const FString NA = NormalizeRoot(A);
	const FString NB = NormalizeRoot(B);
	if (NA == NB) return true;
	const FString& Shorter = NA.Len() < NB.Len() ? NA : NB;
	const FString& Longer  = NA.Len() < NB.Len() ? NB : NA;
	return Longer.StartsWith(Shorter + TEXT("/"), ESearchCase::CaseSensitive);
}

void FAngelscriptDebugDiscovery::WriteEditorRegistration(int Port)
{
	const TArray<FString> Roots = FAngelscriptManager::MakeAllScriptRoots(/*bOnlyProjectRoot=*/false);

	TArray<TSharedPtr<FJsonValue>> RootValues;
	for (const FString& R : Roots)
	{
		FString Full = FPaths::ConvertRelativePathToFull(R);
		Full.ReplaceInline(TEXT("\\"), TEXT("/"));
		RootValues.Add(MakeShared<FJsonValueString>(Full));
	}

	TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetStringField(TEXT("projectName"), FApp::GetProjectName());
	Json->SetStringField(TEXT("projectPath"), FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()).Replace(TEXT("\\"), TEXT("/")));
	Json->SetArrayField(TEXT("scriptRootPaths"), RootValues);
	Json->SetNumberField(TEXT("port"), Port);
	Json->SetNumberField(TEXT("pid"), FPlatformProcess::GetCurrentProcessId());
	Json->SetStringField(TEXT("engineVersion"), FEngineVersion::Current().ToString());
	Json->SetStringField(TEXT("startTime"), FDateTime::UtcNow().ToIso8601());

	FString Out;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
	FJsonSerializer::Serialize(Json, Writer);

	const FString Path = RegistrationFilePath();
	IFileManager::Get().MakeDirectory(*GetEditorsDir(), /*Tree=*/true);
	FFileHelper::SaveStringToFile(Out, *Path);
}

void FAngelscriptDebugDiscovery::RemoveEditorRegistration()
{
	IFileManager::Get().Delete(*RegistrationFilePath(), /*RequireExists=*/false, /*EvenReadOnly=*/false, /*Quiet=*/true);
}

bool FAngelscriptDebugDiscovery::IsMatchingVSCodeWindowOpen(const TArray<FString>& Roots)
{
	const FString Dir = GetWindowsDir();
	TArray<FString> Files;
	IFileManager::Get().FindFiles(Files, *(Dir / TEXT("*.json")), /*Files=*/true, /*Directories=*/false);

	const FDateTime Now = FDateTime::UtcNow();
	for (const FString& File : Files)
	{
		FString Contents;
		if (!FFileHelper::LoadFileToString(Contents, *(Dir / File)))
			continue;

		TSharedPtr<FJsonObject> Obj;
		TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Contents);
		if (!FJsonSerializer::Deserialize(Reader, Obj) || !Obj.IsValid())
			continue;

		FString Heartbeat;
		if (!Obj->TryGetStringField(TEXT("heartbeat"), Heartbeat))
			continue;
		FDateTime HbTime;
		if (!FDateTime::ParseIso8601(*Heartbeat, HbTime))
			continue;
		if ((Now - HbTime).GetTotalSeconds() > 30.0)
			continue; // stale window

		const TArray<TSharedPtr<FJsonValue>>* WindowRoots;
		if (!Obj->TryGetArrayField(TEXT("scriptRootPaths"), WindowRoots))
			continue;
		for (const TSharedPtr<FJsonValue>& WR : *WindowRoots)
		{
			for (const FString& R : Roots)
			{
				if (RootsOverlap(WR->AsString(), R))
					return true;
			}
		}
	}
	return false;
}
```

- [ ] **Step 3: Trigger the write after the bind confirms (manager)**

In `AngelscriptManager.cpp`, replace the debug-server construction block (lines 424-431) with a version that captures the port and schedules a bind-confirmed write:

```cpp
#if WITH_AS_DEBUGSERVER
	if ((!bUsePrecompiledData || bScriptDevelopmentMode) && FApp::HasProjectName())
	{
		int Port = FAngelscriptManager::ConfigSettings->ConnectionPort;
		FParse::Value(FCommandLine::Get(), TEXT("-asdebugport="), Port);
		DebugServer = new FAngelscriptDebugServer(Port);

		if (FAngelscriptManager::ConfigSettings->bAnnounceDebugServerForDiscovery)
		{
			// FTcpListener binds on a worker thread, so poll IsListening() before publishing.
			FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda(
				[Port](float) -> bool
				{
					FAngelscriptDebugServer* Server = GAngelscriptManager ? GAngelscriptManager->DebugServer : nullptr;
					if (Server == nullptr)
						return false; // server gone; stop ticking
					if (!Server->IsListening())
						return true;  // keep waiting for the bind
					FAngelscriptDebugDiscovery::WriteEditorRegistration(Server->GetPort());
					return false;     // done
				}), 0.25f);
		}
	}
#endif
```

Add includes at the top of `AngelscriptManager.cpp` (if absent):

```cpp
#include "Debugging/AngelscriptDebugDiscovery.h"
#include "Debugging/AngelscriptDebugServer.h"
#include "Containers/Ticker.h"
```

Confirm `DebugServer` is a reachable member of `FAngelscriptManager` (it is assigned here); if it is a local rather than a member, promote it to a member so the ticker and dtor can reach it. (Grounding shows it assigned as `DebugServer = new ...`; verify its declaration in `AngelscriptManager.h` and promote if needed — a one-line change.)

- [ ] **Step 4: Add `AngelscriptDebugDiscovery.cpp` to the module**

The plugin uses UBT's automatic `*.cpp` discovery (no explicit file lists), so no `.Build.cs` change is required. Confirm `Json` and `JsonUtilities` are in `AngelscriptCode.Build.cs` Public/PrivateDependencyModuleNames (grounding confirms lines 21-22) — they are, so no dependency edit is needed.

- [ ] **Step 5: Build (toolbox)**

`/build-test` → `UnrealToolbox.exe --build`. Expected: AngelscriptCode compiles clean.

- [ ] **Step 6: Commit**

```bash
git add Engine/Plugins/Angelscript/Source/AngelscriptCode/Private/Debugging/AngelscriptDebugDiscovery.h Engine/Plugins/Angelscript/Source/AngelscriptCode/Private/Debugging/AngelscriptDebugDiscovery.cpp Engine/Plugins/Angelscript/Source/AngelscriptCode/Private/AngelscriptManager.cpp
git commit -m "feat(angelscript): publish debug-server discovery file after bind confirms"
```

---

## Task 11: Engine — auto-open VS Code on startup (opt-in, skip-if-open)

**Files:**
- Modify: `AngelscriptEditor/Private/AngelscriptEditorModule.cpp`
- Modify: `AngelscriptEditor/Private/AngelscriptEditorModule.h` (declare the helper)

**Interfaces:**
- Consumes: `FAngelscriptDebugDiscovery::IsMatchingVSCodeWindowOpen`, `FAngelscriptManager::GenerateVSCodeWorkspaceFile`, `FAngelscriptManager::MakeAllScriptRoots`, `FAngelscriptEditorModule::OpenVsCode`.
- Produces: `static void FAngelscriptEditorModule::TryOpenVsCodeWorkspace()` used by both the existing menu button and the new startup path.

- [ ] **Step 1: Declare the helper**

In `AngelscriptEditorModule.h`, near the `OpenVsCode` declaration (line 17), add:

```cpp
	static void TryOpenVsCodeWorkspace();
```

- [ ] **Step 2: Implement the helper by extracting the menu lambda body**

In `AngelscriptEditorModule.cpp`, add the function (e.g. just above `RegisterToolsMenuEntries`, ~line 815):

```cpp
void FAngelscriptEditorModule::TryOpenVsCodeWorkspace()
{
	const FString VSCodeWorkspacePath = FAngelscriptManager::ConfigSettings->VSCodeWorkspacePath;
	FString ParamPath;
	if (VSCodeWorkspacePath.IsEmpty())
		ParamPath = FAngelscriptManager::GenerateVSCodeWorkspaceFile();
	else
		ParamPath = FPaths::ProjectDir() / VSCodeWorkspacePath;
	FAngelscriptEditorModule::OpenVsCode(FString::Printf(TEXT("\"%s\""), *ParamPath), /*bPrependWorkspace=*/ false);
}
```

- [ ] **Step 3: Point the menu button at the helper**

In `RegisterToolsMenuEntries` (line 815), replace the lambda body (824-840) so the `FExecuteAction::CreateLambda` simply calls:

```cpp
	FToolUIActionChoice Action(FExecuteAction::CreateStatic(&FAngelscriptEditorModule::TryOpenVsCodeWorkspace));
```

(This removes the inline duplicate and reuses the helper.)

- [ ] **Step 4: Add the gated startup auto-open**

`StartupModule` (line 367) already registers `FCoreDelegates::OnPostEngineInit.AddStatic(&OnEngineInitDone)` (line 377). In `OnEngineInitDone` (the existing static), append — guarded so it fires once after roots are populated:

```cpp
	if (FAngelscriptManager::ConfigSettings->bAutoOpenVSCode)
	{
		// Give a VS Code window that launched alongside us a moment to register, then
		// skip the launch if one already has this project's script roots open.
		const TArray<FString> Roots = FAngelscriptManager::MakeAllScriptRoots(/*bOnlyProjectRoot=*/false);
		int32 Attempts = 0;
		FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda(
			[Roots, Attempts](float) mutable -> bool
			{
				if (FAngelscriptDebugDiscovery::IsMatchingVSCodeWindowOpen(Roots))
					return false; // already open — do not launch
				if (++Attempts >= 6) // ~3s at 0.5s
				{
					FAngelscriptEditorModule::TryOpenVsCodeWorkspace();
					return false;
				}
				return true;
			}), 0.5f);
	}
```

Add includes at the top of `AngelscriptEditorModule.cpp` (if absent):

```cpp
#include "Debugging/AngelscriptDebugDiscovery.h"
#include "Containers/Ticker.h"
```

Note: if `OnEngineInitDone` is a file-local `static` function without access to member statics, `TryOpenVsCodeWorkspace` and `OpenVsCode` are already `static` members of `FAngelscriptEditorModule`, so they are callable by qualified name — no instance needed.

- [ ] **Step 5: Build (toolbox)**

`/build-test` → `UnrealToolbox.exe --build`. Expected: AngelscriptEditor compiles clean; the menu button still works.

- [ ] **Step 6: Commit**

```bash
git add Engine/Plugins/Angelscript/Source/AngelscriptEditor/Private/AngelscriptEditorModule.cpp Engine/Plugins/Angelscript/Source/AngelscriptEditor/Private/AngelscriptEditorModule.h
git commit -m "feat(angelscript): opt-in auto-open VS Code on editor startup, skip if already open"
```

---

## Task 12: Engine — `RootsOverlap` automation test + full integration matrix

**Files:**
- Create: `AngelscriptCode/Private/Tests/AngelscriptDebugDiscoveryTests.cpp`

**Interfaces:**
- Consumes: `FAngelscriptDebugDiscovery::RootsOverlap`.

- [ ] **Step 1: Write the automation test (mirrors `match.test.ts`)**

```cpp
// AngelscriptDebugDiscoveryTests.cpp
#include "Misc/AutomationTest.h"
#include "Debugging/AngelscriptDebugDiscovery.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FAngelscriptDebugDiscoveryRootsOverlapTest,
	"Angelscript.CppTests.DebugDiscovery.RootsOverlap",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FAngelscriptDebugDiscoveryRootsOverlapTest::RunTest(const FString& Parameters)
{
	TestTrue(TEXT("equal (case/slash-insensitive)"), FAngelscriptDebugDiscovery::RootsOverlap(TEXT("C:\\Proj\\Script"), TEXT("c:/proj/script")));
	TestTrue(TEXT("ancestor"),   FAngelscriptDebugDiscovery::RootsOverlap(TEXT("C:/Proj"), TEXT("C:/Proj/Script")));
	TestTrue(TEXT("descendant"), FAngelscriptDebugDiscovery::RootsOverlap(TEXT("C:/Proj/Script/Sub"), TEXT("C:/Proj/Script")));
	TestFalse(TEXT("prefix but not path boundary"), FAngelscriptDebugDiscovery::RootsOverlap(TEXT("C:/Proj/ScriptOther"), TEXT("C:/Proj/Script")));
	TestFalse(TEXT("siblings"),  FAngelscriptDebugDiscovery::RootsOverlap(TEXT("C:/A/Script"), TEXT("C:/B/Script")));
	return true;
}
```

- [ ] **Step 2: Build + run the automation test (toolbox)**

Use `/build-test`: `UnrealToolbox.exe --build` then `--test` filtered to `Angelscript.CppTests.DebugDiscovery`.
Expected: `FAngelscriptDebugDiscoveryRootsOverlapTest` passes.

- [ ] **Step 3: Commit**

```bash
git add Engine/Plugins/Angelscript/Source/AngelscriptCode/Private/Tests/AngelscriptDebugDiscoveryTests.cpp
git commit -m "test(angelscript): RootsOverlap automation coverage for debug discovery"
```

- [ ] **Step 4: Run the full manual integration matrix**

With the extension side (`npm run compile` a fresh build, launched via the Extension Development Host) and an editor built with these engine changes:

1. Single Editor + single VS Code window (project Script folder open), defaults → auto-attaches quietly, no `stopOnEntry` break.
2. **Multi-root `Angelscript.code-workspace` (project + 2 plugin roots), one matching Editor → exactly ONE debug session** (per-Editor dedup guard).
3. Two Editor instances (two projects, distinct `-asdebugport`), two VS Code windows → each attaches only to its own match.
4. Editor launched *after* VS Code is already open → still detected (watcher + poll).
5. Manual stop of an auto-attached session while the Editor keeps running → no immediate re-attach; Editor restart (new PID) → re-attaches.
6. Editor mid-hitch: PID alive, probe times out → `editors/<pid>.json` NOT deleted; attaches on a later scan.
7. Simulated Editor crash (kill process) → stale entry deleted, no zombie attach attempts.
8. `bAutoOpenVSCode=true`: skips launching a second VS Code when a matching window is already open; launches when none is.
9. `autoStartDebugging=false` → falls back fully to current manual-F5 behavior (regression).
10. Language server follows the discovered port when it differs from the static `unrealConnectionPort` (autocomplete works against a `-asdebugport` instance).

- [ ] **Step 5: Record results** in the PR description; note any deviations for follow-up.

---

## Self-Review Notes (author)

- **Spec coverage:** detection (Tasks 3,5,6,10), auto-attach one-per-Editor (Task 6), LS reroute w/ precedence (Tasks 6,7), auto-open opt-in + skip-if-open (Tasks 8,10,11), settings (Tasks 6,8), all four Known-Limitations behaviors (per-Editor dedup Task 6; probe-not-delete Tasks 6,10; auto-open race retry Task 11; any-overlap in match.ts Task 2). Covered.
- **Cross-side identity:** `paths.ts` (Task 1) and `GetDiscoveryRoot()` (Task 10) intentionally compose the same segments from env/home; both normalize to `/`. This pairing is the single most breakage-prone seam — Task 12 case 1 fails immediately if they diverge.
- **Type consistency:** `EditorRegistration`/`WindowRegistration` shapes match the C++ writer field names exactly (`projectName`, `projectPath`, `scriptRootPaths`, `port`, `pid`, `engineVersion`, `startTime` / `heartbeat`).
- **Open verification item for the executor:** confirm `FAngelscriptManager::DebugServer` is a member (not a local) before Task 10 Step 3; promote if needed. Confirm `OnEngineInitDone` is a suitable one-time post-init hook (Task 11 Step 4) — if it can fire before `AllRootPaths`/first compile completes in some configs, move the auto-open to a first-compile-finished delegate.
