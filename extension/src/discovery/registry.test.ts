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
