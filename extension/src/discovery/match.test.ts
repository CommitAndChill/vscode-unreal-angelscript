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
