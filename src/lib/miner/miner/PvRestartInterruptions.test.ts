import { expect } from 'chai';
import { MinerManager } from './MinerManager';
import { executePvStartup, type PvStartReadiness } from '../../pv/PvShutdownSafety';

describe('PV restart interruption simulation (no hardware)', () => {
    const now = 1_800_000_000_000;
    const ready = (): PvStartReadiness => ({
        relayOn: true,
        relayAck: true,
        relayTimestamp: now,
        relayEnabledAt: now - 120_000,
        minerReachable: true,
        minerSeenAt: now,
        now,
        maxAgeMs: 15_000,
        startupDelayMs: 120_000,
    });

    function setup() {
        const manager = new MinerManager();
        const locks = new Set(['s9', 's19']);
        const calls: string[] = [];
        for (const id of locks) {
            const miner = {
                settings: { id },
                start: () => {
                    calls.push(`miner-start:${id}`);
                    return Promise.resolve();
                },
            } as unknown as ReturnType<MinerManager['getMiners']>[number];
            (manager as unknown as { miners: typeof miner[] }).miners.push(miner);
        }
        manager.setCommandGuard(id => !locks.has(id));
        return { manager, locks, calls };
    }

    it('keeps both miners locked after a simulated adapter restart during startup', async () => {
        const { manager, locks, calls } = setup();
        let powerOn!: () => void;
        const relayRequest = new Promise<void>(resolve => {
            powerOn = resolve;
        });
        let entered!: () => void;
        const enteredRelayRequest = new Promise<void>(resolve => {
            entered = resolve;
        });
        let restarting = false;
        const attempt = manager.withExclusiveMiner('s9', async () => {
            await executePvStartup({
                mayPowerOn: () => Promise.resolve(true),
                powerOnRelay: async () => {
                    entered();
                    await relayRequest;
                },
                awaitReadiness: () => Promise.resolve(ready()),
                mayStartMining: () => Promise.resolve(!restarting),
                startMining: () => {
                    calls.push('unexpected-start');
                    return Promise.resolve();
                },
            });
        }).then(
            () => false,
            () => true,
        );
        await enteredRelayRequest;
        restarting = true;
        powerOn();
        expect(await attempt).to.equal(true);
        // New adapter instance recreates PV locks before accepting commands.
        const restoredLocks = new Set(['s9', 's19']);
        manager.setCommandGuard(id => !restoredLocks.has(id));
        expect(await manager.startMiner('s9').then(() => false, () => true)).to.equal(true);
        expect(locks.has('s9')).to.equal(true);
        expect(restoredLocks.has('s19')).to.equal(true);
        expect(calls).to.deep.equal([]);
    });

    it('keeps restart locked when miner communication is lost after relay ON', async () => {
        const { manager, locks, calls } = setup();
        const attempt = manager.withExclusiveMiner('s9', () =>
            executePvStartup({
                mayPowerOn: () => Promise.resolve(true),
                powerOnRelay: () => {
                    calls.push('relay-on-request');
                    return Promise.resolve();
                },
                awaitReadiness: () => Promise.resolve({ ...ready(), minerReachable: false }),
                mayStartMining: () => Promise.resolve(true),
                startMining: () => {
                    calls.push('unexpected-start');
                    return Promise.resolve();
                },
            }),
        );
        expect(await attempt.then(() => false, () => true)).to.equal(true);
        expect(calls).to.deep.equal(['relay-on-request']);
        expect(locks.has('s9')).to.equal(true);
        expect(locks.has('s19')).to.equal(true);
    });

    it('does not unlock after miner start throws or confirmation is missing', async () => {
        const { manager, locks, calls } = setup();
        const attempt = manager.withExclusiveMiner('s19', () =>
            executePvStartup({
                mayPowerOn: () => Promise.resolve(true),
                powerOnRelay: () => {
                    calls.push('relay-on-request');
                    return Promise.resolve();
                },
                awaitReadiness: () => Promise.resolve(ready()),
                mayStartMining: () => Promise.resolve(true),
                startMining: () => {
                    calls.push('miner-start-request');
                    return Promise.reject(new Error('miner did not confirm start'));
                },
            }),
        );
        expect(await attempt.then(() => false, () => true)).to.equal(true);
        expect(locks.has('s19')).to.equal(true);
        expect(locks.has('s9')).to.equal(true);
        expect(calls).to.deep.equal(['relay-on-request', 'miner-start-request']);
    });
});
