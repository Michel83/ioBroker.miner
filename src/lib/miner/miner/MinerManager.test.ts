import { expect } from 'chai';
import { MinerManager } from './MinerManager';

describe('MinerManager PV command interlock', () => {
    const id = 'pv-miner';

    function createManager(): { manager: MinerManager; calls: string[] } {
        const manager = new MinerManager();
        const calls: string[] = [];
        const miner = {
            settings: { id },
            start: () => { calls.push('start'); return Promise.resolve(); },
            stop: () => { calls.push('stop'); return Promise.resolve(); },
            setProfile: () => { calls.push('profile'); return Promise.resolve(); },
            setPowerTarget: () => { calls.push('powerTarget'); return Promise.resolve(); },
            setCustomFeature: () => { calls.push('custom'); return Promise.resolve(true); },
        } as unknown as ReturnType<MinerManager['getMiners']>[number];
        // Test-only miner: no hardware connections or network calls.
        (manager as unknown as { miners: typeof miner[] }).miners.push(miner);
        return { manager, calls };
    }

    it('blocks queued start, power and custom commands while restart-locked', async () => {
        const { manager, calls } = createManager();
        manager.setCommandGuard(() => false);
        for (const operation of [
            () => manager.startMiner(id),
            () => manager.setPowerTarget(id, 2000),
            () => manager.withExclusiveMinerCommand(id, miner => miner.setCustomFeature('test', true)),
        ]) {
            let rejected = false;
            try {
                await operation();
            } catch {
                rejected = true;
            }
            expect(rejected).to.equal(true);
        }
        expect(calls).to.deep.equal([]);
    });

    it('rejects a blocked profile command instead of reporting success', async () => {
        const { manager, calls } = createManager();
        manager.setCommandGuard(() => false);
        let rejected = false;
        try {
            await manager.setProfile(id, 'high');
        } catch {
            rejected = true;
        }
        expect(rejected).to.equal(true);
        expect(calls).to.deep.equal([]);
    });

    it('still permits a safety stop while other commands are locked', async () => {
        const { manager, calls } = createManager();
        manager.setCommandGuard(() => false);
        await manager.stopMiner(id);
        expect(calls).to.deep.equal(['stop']);
    });

    it('rechecks the guard after a queued command waits for another operation', async () => {
        const { manager, calls } = createManager();
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        manager.setCommandGuard(() => true);
        const first = manager.withExclusiveMiner(id, async () => { await waiting; });
        const second = manager.withExclusiveMinerCommand(id, async miner => {
            calls.push('custom');
            return miner.setCustomFeature('test', true);
        });
        manager.setCommandGuard(() => false);
        release();
        await first;
        let rejected = false;
        try {
            await second;
        } catch {
            rejected = true;
        }
        expect(rejected).to.equal(true);
        expect(calls).to.deep.equal([]);
    });
});
