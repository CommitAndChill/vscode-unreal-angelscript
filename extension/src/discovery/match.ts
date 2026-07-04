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
