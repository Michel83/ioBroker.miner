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
