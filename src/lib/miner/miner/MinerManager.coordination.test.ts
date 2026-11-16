import { expect } from 'chai';
import { MinerManager } from './MinerManager';
import type { Miner } from './Miner';
import type { MinerSettings } from '../model/MinerSettings';

describe('MinerManager command coordination', () => {
    function setup(): {
        manager: MinerManager;
        events: string[];
    } {
        const manager = new MinerManager();
        const events: string[] = [];
        const miner = {
            settings: { id: 'test' },
            start: () => {
                events.push('start');
                return Promise.resolve();
            },
            stop: () => {
                events.push('stop');
                return Promise.resolve();
            },
            close: () => {
                events.push('close');
                return Promise.resolve();
            },
        } as unknown as Miner<MinerSettings>;
        (manager as unknown as { miners: Miner<MinerSettings>[] }).miners.push(miner);
        return { manager, events };
    }

    it('rejects a queued start after the safety guard becomes active', async () => {
        const { manager, events } = setup();
        let release!: () => void;
        const waiting = new Promise<void>(resolve => {
            release = resolve;
        });
        const held = manager.withExclusiveMiner('test', async () => {
            await waiting;
        });
        let blocked = false;
        manager.setCommandGuard(() => !blocked);
        const start = manager.startMiner('test').then(
            () => false,
            () => true,
        );
        blocked = true;
        release();
        await held;
        expect(await start).to.equal(true);
        expect(events).to.deep.equal([]);
    });

    it('waits for an exclusive operation before closing the miner', async () => {
        const { manager, events } = setup();
        let release!: () => void;
        const waiting = new Promise<void>(resolve => {
            release = resolve;
        });
        let markStarted!: () => void;
        const started = new Promise<void>(resolve => {
            markStarted = resolve;
        });
        const held = manager.withExclusiveMiner('test', async () => {
            events.push('exclusive');
            markStarted();
            await waiting;
        });
        await started;
        const closing = manager.closeAll();
        expect(events).to.deep.equal(['exclusive']);
        release();
        await Promise.all([held, closing]);
        expect(events).to.deep.equal(['exclusive', 'close']);
        expect(manager.hasMiner('test')).to.equal(false);
    });
});
