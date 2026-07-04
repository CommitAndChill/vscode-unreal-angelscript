/*
 * Pattern-driven decoration overlay for angelscript files. Renders pills /
 * chips on top of normal syntax highlighting and lets the user fade noisy
 * identifier prefixes. Configuration lives under `UnrealAngelscript.decorations.*`.
 *
 * Phase 1 (this file): regex-based detection on the client. Works on any open
 * .as document without needing the language server to be ready.
 *
 * Phase 2 (future): the language server already classifies symbols (delegate
 * types, namespaces, UFUNCTION declarations, etc.). A custom LSP request like
 * `angelscript/getDecorationRanges` would give us accurate, scope-aware ranges
 * instead of the regex approximation used here — in particular, it would skip
 * matches inside comments and strings, and would only chip identifiers that
 * actually resolve to delegates / gameplay tags rather than anything that
 * happens to match a name pattern.
 */
'use strict';

import * as vscode from 'vscode';

type PillShape = 'pill' | 'rounded' | 'square';
type PillBorderStyle = 'solid' | 'dashed' | 'dotted' | 'double' | 'none';

interface AngelscriptRule {
    name: string;
    pattern: string;
    color: string;
    fill: string;
    captureGroup?: number;
    shape?: PillShape;
    borderStyle?: PillBorderStyle;
    borderWidth?: number;
}

interface PrefixRule {
    prefix: string;
    opacity?: number;
    color?: string;
}

interface PillOptions {
    shape?: PillShape;
    borderStyle?: PillBorderStyle;
    borderWidth?: number;
}

// ─── color helpers ────────────────────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return { r: 136, g: 136, b: 136 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function clampByte(n: number): number {
    return Math.max(0, Math.min(255, Math.round(n)));
}

function toHex(r: number, g: number, b: number): string {
    const h = (n: number) => clampByte(n).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
}

// Auto-derived text colors give good contrast against a translucent fill of
// the same hue without forcing users to specify three colors per palette entry.
function deriveLightText(hex: string): string {
    const { r, g, b } = hexToRgb(hex);
    return toHex(r * 0.45, g * 0.45, b * 0.45);
}
function deriveDarkText(hex: string): string {
    const { r, g, b } = hexToRgb(hex);
    return toHex(r + (255 - r) * 0.55, g + (255 - g) * 0.55, b + (255 - b) * 0.55);
}

function shapeToBorderRadius(shape: PillShape): string {
    switch (shape) {
        case 'square':  return '0';
        case 'rounded': return '3px';
        case 'pill':
        default:        return '9999px';
    }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── settings readers ─────────────────────────────────────────────────────

const CFG = 'UnrealAngelscript.decorations';

function readPalette(): Record<string, string> {
    return vscode.workspace.getConfiguration(CFG).get<Record<string, string>>('colorPalette', {}) || {};
}
function readFillLevels(): Record<string, number> {
    return vscode.workspace.getConfiguration(CFG).get<Record<string, number>>('fillLevels', {}) || {};
}
function readRules(): AngelscriptRule[] {
    return vscode.workspace.getConfiguration(CFG).get<AngelscriptRule[]>('rules', []) || [];
}
function readFadeConfig() {
    const cfg = vscode.workspace.getConfiguration(CFG);
    const raw = cfg.get<Array<string | PrefixRule>>('fadedPrefixes', []) || [];
    const prefixes: PrefixRule[] = raw
        .map(p => typeof p === 'string' ? { prefix: p } : p)
        .filter(p => p && typeof p.prefix === 'string' && p.prefix.length > 0)
        .slice()
        .sort((a, b) => b.prefix.length - a.prefix.length);
    return {
        prefixes,
        opacity: cfg.get<number>('fadedOpacity', 0.35),
        revealOnCursorLine: cfg.get<boolean>('revealOnCursorLine', true),
        cursorLineOpacity: cfg.get<number>('cursorLineOpacity', 1),
        enabled: cfg.get<boolean>('enabled', true),
    };
}

// ─── decoration caches ────────────────────────────────────────────────────

class PillCache {
    private map = new Map<string, vscode.TextEditorDecorationType>();

    get(color: string, fill: string, opts: PillOptions = {}): vscode.TextEditorDecorationType {
        const shape = opts.shape ?? 'pill';
        const borderStyle = opts.borderStyle ?? 'solid';
        const borderWidth = typeof opts.borderWidth === 'number' ? opts.borderWidth : 1;
        const key = `${color}:${fill}:${shape}:${borderStyle}:${borderWidth}`;
        let dec = this.map.get(key);
        if (dec) return dec;

        const hex = readPalette()[color] || '#888888';
        const alpha = readFillLevels()[fill] ?? 0.25;
        const { r, g, b } = hexToRgb(hex);
        // We intentionally do NOT set `color` here so that the underlying
        // syntax highlighting (TextMate grammar + the LS's semantic tokens)
        // still controls the text color. The pill only contributes the
        // background fill and border. Users who want to force a text color
        // can add `tokenColorCustomizations` or a future per-rule field.
        const renderOpts: vscode.DecorationRenderOptions = {
            backgroundColor: `rgba(${r}, ${g}, ${b}, ${alpha})`,
            borderRadius: shapeToBorderRadius(shape),
        };
        if (borderStyle !== 'none' && borderWidth > 0) {
            renderOpts.border = `${borderWidth}px ${borderStyle} ${hex}`;
        }
        dec = vscode.window.createTextEditorDecorationType(renderOpts);
        this.map.set(key, dec);
        return dec;
    }

    disposeAll() {
        for (const d of this.map.values()) d.dispose();
        this.map.clear();
    }
}

class PrefixTintCache {
    private map = new Map<string, vscode.TextEditorDecorationType>();

    get(opacity: number, color?: string): vscode.TextEditorDecorationType {
        const key = color ? `${color}:${opacity}` : `:${opacity}`;
        let dec = this.map.get(key);
        if (dec) return dec;

        const opts: vscode.DecorationRenderOptions = { opacity: String(opacity) };
        if (color) {
            const hex = readPalette()[color];
            if (hex) {
                opts.light = { color: deriveLightText(hex) };
                opts.dark  = { color: deriveDarkText(hex) };
            }
        }
        dec = vscode.window.createTextEditorDecorationType(opts);
        this.map.set(key, dec);
        return dec;
    }

    disposeAll() {
        for (const d of this.map.values()) d.dispose();
        this.map.clear();
    }
}

// ─── delegate detection (for the click-to-navigate behavior) ──────────────

interface DelegateBind {
    outerStart: number;
    outerEnd: number;
    literalStart: number;
    literalEnd: number;
    functionName: string;
}

function findDelegateBinds(text: string): DelegateBind[] {
    const re = /\bF[A-Z]\w+\s*\(\s*this\s*,\s*(n"(\w+)")\s*\)/g;
    const out: DelegateBind[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const literalStart = m.index + m[0].indexOf(m[1]);
        out.push({
            outerStart: m.index,
            outerEnd: m.index + m[0].length,
            literalStart,
            literalEnd: literalStart + m[1].length,
            functionName: m[2],
        });
    }
    return out;
}

// Regex-based fallback. Phase 2 should ask the language server for the
// canonical location of `functionName` inside this module — it already knows
// where every function is declared.
function findFunctionDeclaration(text: string, name: string): number | null {
    const re = new RegExp(`\\bvoid\\s+(${name})\\s*\\(`);
    const m = re.exec(text);
    return m ? m.index + m[0].indexOf(m[1]) : null;
}

// ─── activate ─────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    const pillCache = new PillCache();
    const prefixTintCache = new PrefixTintCache();
    let appliedRulePills: vscode.TextEditorDecorationType[] = [];
    let appliedPrefixTints: vscode.TextEditorDecorationType[] = [];

    let fadeFarType = vscode.window.createTextEditorDecorationType({
        opacity: String(readFadeConfig().opacity),
    });
    let fadeNearType = vscode.window.createTextEditorDecorationType({
        opacity: String(readFadeConfig().cursorLineOpacity),
    });

    function rebuildFadeTypes() {
        fadeFarType.dispose();
        fadeNearType.dispose();
        const cfg = readFadeConfig();
        fadeFarType = vscode.window.createTextEditorDecorationType({
            opacity: String(cfg.opacity),
        });
        fadeNearType = vscode.window.createTextEditorDecorationType({
            opacity: String(cfg.cursorLineOpacity),
        });
    }

    function rebuildAllDecorationCaches() {
        if (activeEditor) {
            for (const t of appliedRulePills) activeEditor.setDecorations(t, []);
            for (const t of appliedPrefixTints) activeEditor.setDecorations(t, []);
        }
        appliedRulePills = [];
        appliedPrefixTints = [];
        pillCache.disposeAll();
        prefixTintCache.disposeAll();
    }

    let timeout: NodeJS.Timeout | undefined;
    let activeEditor = vscode.window.activeTextEditor;

    function isAngelscript(ed?: vscode.TextEditor): ed is vscode.TextEditor {
        return !!ed && ed.document.languageId === 'angelscript';
    }

    function updateDecorations() {
        if (!isAngelscript(activeEditor)) return;
        const cfgEnabled = readFadeConfig().enabled;
        if (!cfgEnabled) {
            // Clear anything that's currently applied.
            for (const t of appliedRulePills) activeEditor.setDecorations(t, []);
            for (const t of appliedPrefixTints) activeEditor.setDecorations(t, []);
            activeEditor.setDecorations(fadeFarType, []);
            activeEditor.setDecorations(fadeNearType, []);
            return;
        }

        const text = activeEditor.document.getText();

        // Apply each configured rule. captureGroup decorates only a regex
        // capture group instead of the whole match (used by n"..." / f"...").
        const rules = readRules();
        const rulesByType = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();
        for (const rule of rules) {
            if (!rule.pattern) continue;
            let re: RegExp;
            try { re = new RegExp(rule.pattern, 'g'); }
            catch { continue; }
            const dec = pillCache.get(rule.color, rule.fill, {
                shape: rule.shape,
                borderStyle: rule.borderStyle,
                borderWidth: rule.borderWidth,
            });
            const opts = rulesByType.get(dec) ?? [];
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
                const cg = rule.captureGroup;
                let startOff: number;
                let endOff: number;
                if (cg && m[cg]) {
                    startOff = m.index + m[0].indexOf(m[cg]);
                    endOff = startOff + m[cg].length;
                } else {
                    startOff = m.index;
                    endOff = m.index + m[0].length;
                }
                opts.push({
                    range: new vscode.Range(
                        activeEditor.document.positionAt(startOff),
                        activeEditor.document.positionAt(endOff),
                    ),
                    hoverMessage: `${rule.name} (${rule.color}/${rule.fill})`,
                });
                if (m[0].length === 0) re.lastIndex++;
            }
            rulesByType.set(dec, opts);
        }
        appliedRulePills = Array.from(rulesByType.keys());
        for (const [dec, opts] of rulesByType) {
            activeEditor.setDecorations(dec, opts);
        }

        // Delegate-constructor pill overlay covers the whole `FDelegate(this,
        // n"...")` expression. Decorated by the rule-painting cache so it can
        // share a type with rule overrides if the user reconfigures.
        const delegateColor = vscode.workspace.getConfiguration(CFG).get<string>('delegateColor', 'red');
        const delegateFill  = vscode.workspace.getConfiguration(CFG).get<string>('delegateFill',  'medium');
        const delegateBinds = findDelegateBinds(text);
        const delegateDec = pillCache.get(delegateColor, delegateFill);
        const delegateOpts: vscode.DecorationOptions[] = [];
        for (const bind of delegateBinds) {
            delegateOpts.push({
                range: new vscode.Range(
                    activeEditor.document.positionAt(bind.outerStart),
                    activeEditor.document.positionAt(bind.outerEnd),
                ),
                hoverMessage: `Delegate → ${bind.functionName} (Ctrl/Cmd+click)`,
            });
        }
        activeEditor.setDecorations(delegateDec, delegateOpts);
        if (!appliedRulePills.includes(delegateDec)) appliedRulePills.push(delegateDec);

        // Prefix fade / tint.
        const fadeCfg = readFadeConfig();
        const cursorLines = new Set<number>();
        if (fadeCfg.revealOnCursorLine) {
            for (const sel of activeEditor.selections) {
                for (let l = sel.start.line; l <= sel.end.line; l++) cursorLines.add(l);
            }
        }
        const farRanges: vscode.Range[] = [];
        const nearRanges: vscode.Range[] = [];
        const tintRangesByType = new Map<vscode.TextEditorDecorationType, vscode.Range[]>();
        const consumed: Array<{ start: number; end: number }> = [];
        for (const p of fadeCfg.prefixes) {
            const re = new RegExp('\\b' + escapeRegex(p.prefix), 'g');
            let pm: RegExpExecArray | null;
            while ((pm = re.exec(text)) !== null) {
                const s = pm.index;
                const e = pm.index + pm[0].length;
                if (consumed.some(c => c.start <= s && c.end >= e)) continue;
                consumed.push({ start: s, end: e });
                const startPos = activeEditor.document.positionAt(s);
                const range = new vscode.Range(startPos, activeEditor.document.positionAt(e));
                const onCursorLine = cursorLines.has(startPos.line);
                if (p.color) {
                    const opacity = onCursorLine
                        ? fadeCfg.cursorLineOpacity
                        : (typeof p.opacity === 'number' ? p.opacity : fadeCfg.opacity);
                    const dec = prefixTintCache.get(opacity, p.color);
                    const arr = tintRangesByType.get(dec) ?? [];
                    arr.push(range);
                    tintRangesByType.set(dec, arr);
                } else if (typeof p.opacity === 'number' && !onCursorLine) {
                    const dec = prefixTintCache.get(p.opacity);
                    const arr = tintRangesByType.get(dec) ?? [];
                    arr.push(range);
                    tintRangesByType.set(dec, arr);
                } else if (onCursorLine) {
                    nearRanges.push(range);
                } else {
                    farRanges.push(range);
                }
            }
        }
        activeEditor.setDecorations(fadeFarType, farRanges);
        activeEditor.setDecorations(fadeNearType, nearRanges);
        appliedPrefixTints = Array.from(tintRangesByType.keys());
        for (const [dec, arr] of tintRangesByType) {
            activeEditor.setDecorations(dec, arr);
        }
    }

    function scheduleUpdate(throttle = false) {
        if (timeout) { clearTimeout(timeout); timeout = undefined; }
        if (throttle) timeout = setTimeout(updateDecorations, 250);
        else updateDecorations();
    }

    if (activeEditor) scheduleUpdate();

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            activeEditor = editor;
            if (editor) scheduleUpdate();
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (activeEditor && event.document === activeEditor.document) {
                scheduleUpdate(true);
            }
        }),
        vscode.window.onDidChangeTextEditorSelection(event => {
            if (event.textEditor === activeEditor) scheduleUpdate(true);
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration(CFG)) return;
            const opacityChanged = event.affectsConfiguration(`${CFG}.fadedOpacity`)
                || event.affectsConfiguration(`${CFG}.cursorLineOpacity`);
            if (opacityChanged) rebuildFadeTypes();
            rebuildAllDecorationCaches();
            scheduleUpdate();
        }),
    );

    // Click-to-navigate on delegate pills. We register a command (used as the
    // link target) and a DocumentLinkProvider that points each delegate's
    // outer range at it.
    context.subscriptions.push(vscode.commands.registerCommand(
        'angelscript.decorations.gotoOffset',
        async (uri: string, offset: number) => {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
            const pos = doc.positionAt(offset);
            await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
        },
    ));
    context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(
        { scheme: 'file', language: 'angelscript' },
        {
            provideDocumentLinks(document) {
                if (!readFadeConfig().enabled) return [];
                const text = document.getText();
                const links: vscode.DocumentLink[] = [];
                for (const bind of findDelegateBinds(text)) {
                    const declOffset = findFunctionDeclaration(text, bind.functionName);
                    if (declOffset === null) continue;
                    const args = encodeURIComponent(JSON.stringify([document.uri.toString(), declOffset]));
                    const link = new vscode.DocumentLink(
                        new vscode.Range(
                            document.positionAt(bind.outerStart),
                            document.positionAt(bind.outerEnd),
                        ),
                        vscode.Uri.parse(`command:angelscript.decorations.gotoOffset?${args}`),
                    );
                    link.tooltip = `Go to ${bind.functionName}`;
                    links.push(link);
                }
                return links;
            },
        },
    ));

    context.subscriptions.push({
        dispose: () => {
            fadeFarType.dispose();
            fadeNearType.dispose();
            pillCache.disposeAll();
            prefixTintCache.disposeAll();
        },
    });
}
