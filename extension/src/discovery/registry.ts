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
