import { expect } from 'chai';
import { MinerManager } from './MinerManager';
import { isPvRestartUnlockCandidate, type PvRestartUnlockCandidate } from '../../pv/PvShutdownSafety';

describe('PV restart unlock and miner command queue (simulation only)', () => {
    const now = 1_800_000_000_000;
    const poweredOnAt = now - 120_000;

    function setup(): { manager: MinerManager; locks: Set<string>; calls: string[] } {
        const manager = new MinerManager();
        const locks = new Set(['s9', 's19']);
        const calls: string[] = [];
        for (const id of locks) {
            const miner = {
                settings: { id },
                start: () => {
                    calls.push(`start:${id}`);
                    return Promise.resolve();
                },
            } as unknown as ReturnType<MinerManager['getMiners']>[number];
            (manager as unknown as { miners: typeof miner[] }).miners.push(miner);
        }
        manager.setCommandGuard(id => !locks.has(id));
        return { manager, locks, calls };
    }

    function evidence(id: string, locks: ReadonlySet<string>): PvRestartUnlockCandidate {
        return {
            minerId: id,
            lockedMiners: locks,
            activeSafeStops: new Set<string>(),
            adapterShuttingDown: false,
            relayPoweredOnAt: poweredOnAt,
            adapterSessionId: 'session-current',
            prePowerOnEvidence: { minerId: id, adapterSessionId: 'session-current', approvedAt: poweredOnAt - 1000, expiresAt: now + 5000 },
            restart: {
                enabled: true,
                relayConfirmedOff: false,
                gridPower: -2500,
                batteryPower: 0,
                gridTimestamp: now,
                batteryTimestamp: now,
                now,
                maxAgeMs: 15_000,
                reserveWatts: 200,
                minimumStartWatts: 1800,
                lastStoppedAt: now - 300_000,
                restartDelayMs: 180_000,
            },
            readiness: {
                relayOn: true,
                relayAck: true,
                relayTimestamp: now,
                relayEnabledAt: poweredOnAt,
                minerReachable: true,
                minerSeenAt: now,
                now,
                maxAgeMs: 15_000,
                startupDelayMs: 120_000,
            },
        };
    }

    it('serializes a simulated unlock against a queued start for the same miner', async () => {
        const { manager, locks, calls } = setup();
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const transaction = manager.withExclusiveMiner('s9', async () => {
            calls.push('transaction:begin');
            await gate;
            expect(isPvRestartUnlockCandidate(evidence('s9', locks))).to.equal(true);
            locks.delete('s9'); // Test-only simulated commit inside the exclusive queue.
            calls.push('transaction:commit');
        });
        const queuedStart = manager.startMiner('s9');
        release();
        await transaction;
        await queuedStart;
        expect(calls).to.deep.equal(['transaction:begin', 'transaction:commit', 'start:s9']);
        expect(locks.has('s19')).to.equal(true);
    });

    it('rejects the queued start if the simulated unlock is aborted', async () => {
        const { manager, locks, calls } = setup();
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const transaction = manager.withExclusiveMiner('s9', async () => {
            await gate;
            const changed = evidence('s9', locks);
            changed.restart.gridPower = -100;
            expect(isPvRestartUnlockCandidate(changed)).to.equal(false);
        });
        const queuedStart = manager.startMiner('s9').then(
            () => false,
            () => true,
        );
        release();
        await transaction;
        expect(await queuedStart).to.equal(true);
        expect(calls).to.deep.equal([]);
        expect(locks.has('s9')).to.equal(true);
    });

    it('does not release S19 when S9 is unlocked in the serialized simulation', async () => {
        const { manager, locks, calls } = setup();
        await manager.withExclusiveMiner('s9', () => {
            expect(isPvRestartUnlockCandidate(evidence('s9', locks))).to.equal(true);
            locks.delete('s9');
            return Promise.resolve();
        });
        const s19Blocked = await manager.startMiner('s19').then(
            () => false,
            () => true,
        );
        expect(s19Blocked).to.equal(true);
        await manager.startMiner('s9');
        expect(calls).to.deep.equal(['start:s9']);
        expect(locks.has('s19')).to.equal(true);
    });
});
