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
