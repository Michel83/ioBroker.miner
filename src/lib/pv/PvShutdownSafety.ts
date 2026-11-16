/**
 * Measurements used to confirm a safe PV miner shutdown.
 */
export interface PvShutdownMeasurements {
    hashrate: number | undefined;
    hashrateTimestamp: number | undefined;
    power: number | undefined;
    powerTimestamp: number | undefined;
    lastSeen: number | undefined;
}

/**
 * Pure safety check. This function never controls hardware.
 *
 * @param values - current measurements
 * @param now - current timestamp in milliseconds
 * @param maxAgeMs - maximum permitted measurement age
 * @param pausedAt - timestamp when the pause command completed
 */
export function isPvShutdownSafe(
    values: PvShutdownMeasurements,
    now: number,
    maxAgeMs: number,
    pausedAt: number,
): boolean {
    const fresh = (timestamp: number | undefined): boolean =>
        timestamp !== undefined && Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= maxAgeMs;

    return (
        values.hashrate === 0 &&
        values.power !== undefined &&
        Number.isFinite(values.power) &&
        values.power >= 0 &&
        values.power <= 100 &&
        fresh(values.hashrateTimestamp) &&
        fresh(values.powerTimestamp) &&
        fresh(values.lastSeen) &&
        values.hashrateTimestamp !== undefined &&
        values.hashrateTimestamp > pausedAt &&
        values.powerTimestamp !== undefined &&
        values.powerTimestamp > pausedAt
    );
}

/**
 * Tracks consecutive safe measurements before allowing relay shutdown.
 * This class never sends hardware commands.
 */
export class PvShutdownConfirmation {
    private stableSince: number | undefined;
    private lastCheckAt: number | undefined;
    private firstHashTimestamp: number | undefined;
    private firstPowerTimestamp: number | undefined;
    private lastHashTimestamp: number | undefined;
    private lastPowerTimestamp: number | undefined;
    private confirmedSamples = 0;

    public reset(): void {
        this.stableSince = undefined;
        this.lastCheckAt = undefined;
        this.firstHashTimestamp = undefined;
        this.firstPowerTimestamp = undefined;
        this.lastHashTimestamp = undefined;
        this.lastPowerTimestamp = undefined;
        this.confirmedSamples = 0;
    }

    public update(
        values: PvShutdownMeasurements,
        now: number,
        maxAgeMs: number,
        pausedAt: number,
        stableMs = 30_000,
        maxCheckGapMs = 10_000,
        maxSensorGapMs = 15_000,
    ): boolean {
        if (!isPvShutdownSafe(values, now, maxAgeMs, pausedAt)) {
            this.reset();
            return false;
        }

        if (this.lastCheckAt !== undefined && (now < this.lastCheckAt || now - this.lastCheckAt > maxCheckGapMs)) {
            this.reset();
        }

        this.lastCheckAt = now;

        // Both sensors must provide recent measurements throughout confirmation.
        if (
            values.hashrateTimestamp === undefined ||
            values.powerTimestamp === undefined ||
            now - values.hashrateTimestamp > maxSensorGapMs ||
            now - values.powerTimestamp > maxSensorGapMs
        ) {
            this.reset();
            return false;
        }

        if (this.stableSince === undefined) {
            this.stableSince = now;
            this.firstHashTimestamp = values.hashrateTimestamp;
            this.firstPowerTimestamp = values.powerTimestamp;
            this.lastHashTimestamp = values.hashrateTimestamp;
            this.lastPowerTimestamp = values.powerTimestamp;
            this.confirmedSamples = 1;
            return false;
        }

        if (
            values.hashrateTimestamp !== undefined &&
            values.powerTimestamp !== undefined &&
            this.lastHashTimestamp !== undefined &&
            this.lastPowerTimestamp !== undefined &&
            values.hashrateTimestamp > this.lastHashTimestamp &&
            values.powerTimestamp > this.lastPowerTimestamp
        ) {
            this.confirmedSamples++;
            this.lastHashTimestamp = values.hashrateTimestamp;
            this.lastPowerTimestamp = values.powerTimestamp;
        }

        if (
            this.confirmedSamples >= 3 &&
            now - this.stableSince >= stableMs &&
            values.hashrateTimestamp !== undefined &&
            values.powerTimestamp !== undefined &&
            this.firstHashTimestamp !== undefined &&
            this.firstPowerTimestamp !== undefined &&
            values.hashrateTimestamp > this.firstHashTimestamp &&
            values.powerTimestamp > this.firstPowerTimestamp
        ) {
            return true;
        }

        return false;
    }
}

/** Inputs for a fail-closed automatic PV restart decision. No hardware commands. */
export interface PvRestartMeasurements {
    enabled: boolean;
    relayConfirmedOff: boolean;
    gridPower: number | undefined;
    batteryPower: number | undefined;
    gridTimestamp: number | undefined;
    batteryTimestamp: number | undefined;
    now: number;
    maxAgeMs: number;
    reserveWatts: number;
    minimumStartWatts: number;
    lastStoppedAt: number | undefined;
    restartDelayMs: number;
}

/** Allow a new relay-on request only with fresh measurements and sufficient export. */
export function isPvRestartAllowed(values: PvRestartMeasurements): boolean {
    const fresh = (timestamp: number | undefined): boolean =>
        timestamp !== undefined &&
        Number.isFinite(timestamp) &&
        timestamp <= values.now &&
        values.now - timestamp <= values.maxAgeMs;

    if (
        !values.enabled ||
        !values.relayConfirmedOff ||
        !fresh(values.gridTimestamp) ||
        !fresh(values.batteryTimestamp) ||
        values.gridPower === undefined ||
        values.batteryPower === undefined ||
        !Number.isFinite(values.gridPower) ||
        !Number.isFinite(values.batteryPower) ||
        !Number.isFinite(values.reserveWatts) ||
        !Number.isFinite(values.minimumStartWatts) ||
        values.reserveWatts < 0 ||
        values.minimumStartWatts <= 0 ||
        !Number.isFinite(values.restartDelayMs) ||
        values.restartDelayMs < 0 ||
        values.lastStoppedAt === undefined ||
        !Number.isFinite(values.lastStoppedAt) ||
        values.lastStoppedAt > values.now ||
        values.now - values.lastStoppedAt < values.restartDelayMs
    ) {
        return false;
    }

    // Negative grid means export; positive battery means discharge.
    const availableWatts = -values.gridPower - values.reserveWatts - Math.max(0, values.batteryPower);
    return availableWatts >= values.minimumStartWatts;
}

/** Evidence required before issuing a miner start command after relay power-on. */
export interface PvStartReadiness {
    relayOn: boolean;
    relayTimestamp: number | undefined;
    relayEnabledAt: number | undefined;
    minerReachable: boolean;
    minerSeenAt: number | undefined;
    now: number;
    maxAgeMs: number;
    startupDelayMs: number;
}

/** Fail closed if relay feedback, boot delay or miner communication is uncertain. */
export function isPvStartReady(values: PvStartReadiness): boolean {
    const fresh = (timestamp: number | undefined): boolean =>
        timestamp !== undefined &&
        Number.isFinite(timestamp) &&
        timestamp <= values.now &&
        values.now - timestamp <= values.maxAgeMs;

    return (
        values.relayOn &&
        values.minerReachable &&
        fresh(values.relayTimestamp) &&
        fresh(values.minerSeenAt) &&
        values.relayEnabledAt !== undefined &&
        Number.isFinite(values.relayEnabledAt) &&
        values.relayEnabledAt <= values.now &&
        values.minerSeenAt !== undefined &&
        values.minerSeenAt > values.relayEnabledAt &&
        Number.isFinite(values.startupDelayMs) &&
        values.startupDelayMs >= 0 &&
        values.now - values.relayEnabledAt >= values.startupDelayMs
    );
}

/** Injectable hardware operations for a separately enabled PV startup controller. */
export interface PvStartupOperations {
    /** Recheck PV eligibility immediately before relay power-on. */
    mayPowerOn: () => Promise<boolean>;
    /** Request relay power-on; does not imply confirmed power. */
    powerOnRelay: () => Promise<void>;
    /** Wait for startup delay and return fresh relay/miner readiness evidence. */
    awaitReadiness: () => Promise<PvStartReadiness>;
    /** Recheck PV eligibility immediately before starting mining. */
    mayStartMining: () => Promise<boolean>;
    /** Issue the miner start command only after all checks. */
    startMining: () => Promise<void>;
}

/**
 * Coordinate a PV startup without automatically powering off on failure.
 * Caller must serialize this sequence with other miner commands and persist
 * relay/stop state across adapter restarts before enabling hardware writes.
 *
 * @param operations - injected hardware operations and safety checks
 */
export async function executePvStartup(operations: PvStartupOperations): Promise<void> {
    if (!(await operations.mayPowerOn())) {
        throw new Error('PV startup blocked: insufficient or invalid PV conditions');
    }
    await operations.powerOnRelay();
    const readiness = await operations.awaitReadiness();
    if (!isPvStartReady(readiness)) {
        throw new Error('PV startup blocked: relay or miner not confirmed ready');
    }
    if (!(await operations.mayStartMining())) {
        throw new Error('PV startup blocked: PV conditions changed before miner start');
    }
    await operations.startMining();
}

/** Persisted PV relay shutdown record; never trust it without live relay feedback. */
export interface PvPersistedStop {
    minerId: string;
    relayStateId: string;
    stoppedAt: number;
    relayOffConfirmed: boolean;
}

/**
 * Validate a persisted stop record before it may contribute to a restart decision.
 * An absent, malformed or mismatched record must keep automatic restart blocked.
 *
 * @param record - untrusted stored data
 * @param minerId - currently configured miner identifier
 * @param relayStateId - currently configured relay state identifier
 * @param now - current time in milliseconds
 */
export function parsePvPersistedStop(
    record: unknown,
    minerId: string,
    relayStateId: string,
    now: number,
): PvPersistedStop | undefined {
    if (typeof record !== 'object' || record === null) {
        return undefined;
    }
    const value = record as Partial<PvPersistedStop>;
    if (
        !minerId ||
        !relayStateId ||
        value.minerId !== minerId ||
        value.relayStateId !== relayStateId ||
        value.relayOffConfirmed !== true ||
        typeof value.stoppedAt !== 'number' ||
        !Number.isFinite(value.stoppedAt) ||
        value.stoppedAt <= 0 ||
        value.stoppedAt > now
    ) {
        return undefined;
    }
    return {
        minerId,
        relayStateId,
        stoppedAt: value.stoppedAt,
        relayOffConfirmed: true,
    };
}

/** Inputs for read-only restoration of a previously confirmed PV stop. */
export interface PvStopRestoration {
    storedRecord: unknown;
    minerId: string;
    relayStateId: string;
    relayOnValue: boolean;
    relayValue: unknown;
    relayTimestamp: number | undefined;
    power: number | undefined;
    powerTimestamp: number | undefined;
    now: number;
    maxAgeMs: number;
}

/**
 * Check persisted history against fresh OFF relay and near-zero power evidence.
 * This is diagnostic only and never authorizes miner restart.
 *
 * @param values - stored history, configuration and current measurements
 */
export function isPvStopRestorationConsistent(values: PvStopRestoration): boolean {
    const fresh = (timestamp: number | undefined): boolean =>
        typeof timestamp === 'number' &&
        Number.isFinite(timestamp) &&
        timestamp <= values.now &&
        timestamp >= 0 &&
        values.now - timestamp <= values.maxAgeMs;
    return (
        Number.isFinite(values.now) &&
        Number.isFinite(values.maxAgeMs) &&
        values.maxAgeMs > 0 &&
        typeof values.relayOnValue === 'boolean' &&
        parsePvPersistedStop(values.storedRecord, values.minerId, values.relayStateId, values.now) !== undefined &&
        fresh(values.relayTimestamp) &&
        values.relayValue === !values.relayOnValue &&
        fresh(values.powerTimestamp) &&
        typeof values.power === 'number' &&
        Number.isFinite(values.power) &&
        values.power >= 0 &&
        values.power <= 5
    );
}

/** Relay OFF feedback must be a fresh acknowledgement newer than the OFF request. */
export function isPvRelayOffConfirmed(
    relayValue: unknown,
    relayTimestamp: number | undefined,
    relayAck: boolean | undefined,
    relayOnValue: boolean,
    requestedAt: number,
    now: number,
    maxAgeMs: number,
): boolean {
    return (
        relayValue === !relayOnValue &&
        relayAck === true &&
        relayTimestamp !== undefined &&
        Number.isFinite(relayTimestamp) &&
        relayTimestamp > requestedAt &&
        relayTimestamp <= now &&
        now - relayTimestamp <= maxAgeMs
    );
}

/**
 * Tracks distinct post-relay-OFF power measurements.
 * A relay acknowledgement alone never confirms that power was removed.
 */
export class PvRelayOffPowerConfirmation {
    private lastPowerTimestamp: number;
    private consecutiveNearZero = 0;

    public constructor(private readonly requestedAt: number) {
        this.lastPowerTimestamp = requestedAt;
    }

    public update(
        power: number | undefined,
        powerTimestamp: number | undefined,
        relayConfirmedOff: boolean,
        now: number,
        maxAgeMs: number,
    ): boolean {
        if (!relayConfirmedOff) {
            this.consecutiveNearZero = 0;
            return false;
        }
        if (
            power === undefined ||
            !Number.isFinite(power) ||
            powerTimestamp === undefined ||
            !Number.isFinite(powerTimestamp) ||
            powerTimestamp <= this.lastPowerTimestamp ||
            powerTimestamp > now ||
            now - powerTimestamp > maxAgeMs
        ) {
            return false;
        }
        this.lastPowerTimestamp = powerTimestamp;
        this.consecutiveNearZero = power >= 0 && power <= 5 ? this.consecutiveNearZero + 1 : 0;
        return this.consecutiveNearZero >= 3;
    }

    public reset(): void {
        this.consecutiveNearZero = 0;
    }
}

/**
 * Fail-closed command policy for PV-controlled miners.
 * A persisted safe-stop record is diagnostic evidence only; it never unlocks commands.
 */
export function isPvMinerCommandAllowed(
    minerId: string,
    activeSafeStops: ReadonlySet<string>,
    relayOffOrRestartLockedMiners: ReadonlySet<string>,
    adapterShuttingDown: boolean,
): boolean {
    return (
        minerId.length > 0 &&
        !adapterShuttingDown &&
        !activeSafeStops.has(minerId) &&
        !relayOffOrRestartLockedMiners.has(minerId)
    );
}
