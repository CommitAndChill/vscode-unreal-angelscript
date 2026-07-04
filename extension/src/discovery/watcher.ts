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
