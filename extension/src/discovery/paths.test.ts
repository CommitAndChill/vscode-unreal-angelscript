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
