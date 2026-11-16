import type { Miner } from './Miner';
import type { MinerSettings } from '../model/MinerSettings';
import { createMiner } from './MinerFactory';
import { Logger } from '../model/Logger';

const logger = Logger.getLogger('MinerManager');

/**
 *
 */
export class MinerManager {
    private readonly miners: Miner<MinerSettings>[] = [];

    // Serialize control commands per miner; a failure must not block later commands.
    private readonly commandTails = new Map<string, Promise<void>>();
    private commandGuard: ((id: string) => boolean) | undefined;

    /** Reject queued control commands after a PV stop or during adapter shutdown. */
    public setCommandGuard(guard: (id: string) => boolean): void {
        this.commandGuard = guard;
    }

    private assertCommandAllowed(id: string): void {
        if (this.commandGuard?.(id) === false) {
            throw new Error(`Miner ${id}: command blocked by PV safe stop or adapter shutdown`);
        }
    }

    private async runSerialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.commandTails.get(id) ?? Promise.resolve();
        let release!: () => void;
        const tail = new Promise<void>(resolve => {
            release = resolve;
        });
        this.commandTails.set(id, tail);
        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.commandTails.get(id) === tail) {
                this.commandTails.delete(id);
            }
        }
    }

    /**
     * Reserve exclusive access to a miner across a multi-step control operation.
     * Use the provided miner rather than calling other manager methods inside the callback.
     */
    public async withExclusiveMiner<T>(id: string, operation: (miner: Miner<MinerSettings>) => Promise<T>): Promise<T> {
        return this.runSerialized(id, async () => {
            const miner = this.getMinerById(id);
            if (!miner) {
                throw new Error(`Miner with id ${id} not found`);
            }
            return operation(miner);
        });
    }

    /**
     *
     * @param settings - the miner configuration to initialize
     */
    public async init(settings: MinerSettings): Promise<Miner<MinerSettings>> {
        logger.info(`[init] initializing miner with id ${settings.id}`);

        const miner: Miner<MinerSettings> = createMiner(settings);
        try {
            await miner.init();
        } catch (e) {
            await miner.close();
            throw e;
        }
        this.miners.push(miner);
        return miner;
    }

    /**
     *
     * @param id - the miner id to close
     */
    public async close(id: string): Promise<void> {
        logger.info(`[close] unloading miner with id ${id}`);

        if (id == null) {
            logger.error('[close] id must be provided');
            return;
        }

        const miner = this.getMinerById(id);
        if (!miner) {
            logger.error(`[close] miner with id ${id} not found`);
            return;
        }

        await this.runSerialized(id, async () => {
            await miner.close();
            this.miners.splice(this.miners.indexOf(miner), 1);
        });
    }

    /**
     *
     */
    public async closeAll(): Promise<void> {
        logger.log('[closeAll] unloading all miners');

        for (const miner of [...this.miners]) {
            await this.close(miner.settings.id);
        }
    }

    /**
     * The initialized miner with the given id, if it is running.
     *
     * @param id - the miner id to look up
     */
    public getMiner(id: string): Miner<MinerSettings> | undefined {
        return this.getMinerById(id);
    }

    /**
     *
     * @param id - the miner id to look up
     */
    private getMinerById(id: string): Miner<MinerSettings> | undefined {
        return this.miners.find(miner => miner.settings.id === id);
    }

    /**
     * All currently initialized miners (a copy, so callers can't change the managed list).
     */
    public getMiners(): Miner<MinerSettings>[] {
        return [...this.miners];
    }

    /**
     *
     * @param id - the miner id to check
     */
    public hasMiner(id: string): boolean {
        return this.getMinerById(id) != null;
    }

    /**
     *
     * @param id - the miner id to start
     */
    public async startMiner(id: string): Promise<void> {
        logger.info(`[startMiner] starting miner with id ${id}`);

        const miner = this.getMinerById(id);
        if (!miner) {
            logger.warn(`[startMiner] miner with id ${id} not found`);
            throw new Error(`[startMiner] miner with id ${id} not found`);
        }

        try {
            await this.runSerialized(id, () => {
                this.assertCommandAllowed(id);
                return miner.start();
            });
        } catch (e) {
            logger.error(`[startMiner] failed to start miner with id ${id}: ${String(e)}`);
            throw e;
        }
    }

    /**
     *
     * @param id - the miner id to stop
     */
    public async stopMiner(id: string): Promise<void> {
        logger.info(`[stopMiner] stopping miner with id ${id}`);

        const miner = this.getMinerById(id);
        if (!miner) {
            logger.warn(`[stopMiner] miner with id ${id} not found`);
            throw new Error(`[stopMiner] miner with id ${id} not found`);
        }

        try {
            await this.runSerialized(id, () => miner.stop());
        } catch (e) {
            logger.error(`[stopMiner] failed to stop miner with id ${id}: ${String(e)}`);
            throw e;
        }
    }

    /**
     * Set the active performance profile on a miner.
     *
     * @param id - the miner id
     * @param profile - the profile name to activate
     */
    public async setProfile(id: string, profile: string): Promise<void> {
        logger.info(`[setProfile] setting profile "${profile}" on miner with id ${id}`);

        const miner = this.getMinerById(id);
        if (!miner) {
            logger.warn(`[setProfile] miner with id ${id} not found`);
            return;
        }

        try {
            await this.runSerialized(id, () => {
                this.assertCommandAllowed(id);
                return miner.setProfile(profile);
            });
        } catch (e) {
            logger.error(`[setProfile] failed to set profile "${profile}" on miner with id ${id}: ${String(e)}`);
        }
    }

    /**
     * Set the power target on a miner.
     *
     * @param id - the miner id
     * @param powerTarget - the power target in watts
     */
    public async setPowerTarget(id: string, powerTarget: number): Promise<void> {
        logger.info(`[setPowerTarget] setting power target ${powerTarget} W on miner with id ${id}`);

        const miner = this.getMinerById(id);
        if (!miner) {
            logger.warn(`[setPowerTarget] miner with id ${id} not found`);
            throw new Error(`[setPowerTarget] miner with id ${id} not found`);
        }

        try {
            await this.runSerialized(id, () => {
                this.assertCommandAllowed(id);
                return miner.setPowerTarget(powerTarget);
            });
        } catch (e) {
            logger.error(
                `[setPowerTarget] failed to set power target ${powerTarget} W on miner with id ${id}: ${String(e)}`,
            );
            throw e;
        }
    }
}
