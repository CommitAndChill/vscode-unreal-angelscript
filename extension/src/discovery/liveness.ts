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
