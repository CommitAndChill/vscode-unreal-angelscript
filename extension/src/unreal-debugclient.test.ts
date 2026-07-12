import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server, Socket } from 'node:net';
import * as unreal from './unreal-debugclient';

function listen(): Promise<{ server: Server, port: number, sockets: Socket[] }> {
    return new Promise(resolve => {
        const sockets: Socket[] = [];
        const server = createServer(s => sockets.push(s));
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: (server.address() as any).port, sockets });
        });
    });
}

// Resolves true if "Closed" fires within `ms`, false otherwise.
function closedWithin(ms: number): Promise<boolean> {
    return new Promise(resolve => {
        const timer = setTimeout(() => { unreal.events.removeListener('Closed', onClosed); resolve(false); }, ms);
        const onClosed = () => { clearTimeout(timer); resolve(true); };
        unreal.events.once('Closed', onClosed);
    });
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Teardown must never throw (a throwing disconnect would skip the server
// cleanup and leave the test process hanging on open handles).
function cleanup(...fixtures: { server: Server, sockets: Socket[] }[]) {
    try { unreal.disconnect(); } catch { /* the assertion already reported the defect */ }
    for (const f of fixtures) {
        for (const s of f.sockets) s.destroy();
        f.server.close();
    }
}

test('emits Closed when the editor drops the connection', { timeout: 10000 }, async () => {
    const { server, port, sockets } = await listen();
    try {
        const closed = closedWithin(2000);
        unreal.connect('127.0.0.1', port);
        while (sockets.length === 0) await delay(10);
        sockets[0].destroy(); // editor goes away
        assert.equal(await closed, true);
        assert.equal(unreal.connected, false);
    } finally {
        cleanup({ server, sockets });
    }
});

test('a stale socket closing does not tear down a newer connection', { timeout: 10000 }, async () => {
    const a = await listen();
    const b = await listen();
    try {
        unreal.connect('127.0.0.1', a.port);
        while (a.sockets.length === 0) await delay(10);

        // Reconnect while the first socket is still open: connect() destroys it.
        // Its deferred 'close' event must neither emit "Closed" nor destroy the
        // new socket (the old handlers used to act on the module-level variable).
        const closed = closedWithin(300);
        unreal.connect('127.0.0.1', b.port);
        while (b.sockets.length === 0) await delay(10);
        assert.equal(await closed, false);

        // The new connection still carries traffic.
        const received = new Promise<void>(resolve => b.sockets[0].once('data', () => resolve()));
        unreal.sendPause();
        await Promise.race([received, delay(2000).then(() => { throw new Error('no data on new socket'); })]);
    } finally {
        cleanup(a, b);
    }
});

test('deliberate disconnect does not emit Closed, and later sends are safe no-ops', { timeout: 10000 }, async () => {
    const { server, port, sockets } = await listen();
    try {
        unreal.connect('127.0.0.1', port);
        while (sockets.length === 0) await delay(10);

        const closed = closedWithin(300);
        unreal.disconnect();
        assert.equal(await closed, false);
        assert.equal(unreal.connected, false);

        unreal.sendPause(); // must not throw with no live socket
        unreal.disconnect(); // double-disconnect must not throw
    } finally {
        cleanup({ server, sockets });
    }
});
