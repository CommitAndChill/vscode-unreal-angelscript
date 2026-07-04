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
