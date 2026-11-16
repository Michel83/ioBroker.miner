/**
 * Read-only calculations ported from the user's PV-Miner-Regelung V2.43.
 * No ioBroker state writes, miner commands or relay operations.
 */
export interface PvV243Inputs {
    gridPower: number | undefined;
    batteryPower: number | undefined;
    batterySoc: number | undefined;
}

export interface PvV243Result {
    availableWatts: number;
    batteryChargeDeficitWatts: number;
    effectiveGridWatts: number;
}

/**
 * Calculate surplus and battery charging priority as in V2.43.
 * Missing or invalid measurements fail closed instead of becoming zero.
 *
 * @param values - grid, battery power and battery SOC
 */
export function calculatePvV243(values: PvV243Inputs): PvV243Result | undefined {
    const { gridPower, batteryPower, batterySoc } = values;
    if (
        typeof gridPower !== 'number' ||
        !Number.isFinite(gridPower) ||
        typeof batteryPower !== 'number' ||
        !Number.isFinite(batteryPower) ||
        typeof batterySoc !== 'number' ||
        !Number.isFinite(batterySoc) ||
        batterySoc < 0 ||
        batterySoc > 100
    ) {
        return undefined;
    }

    const batteryChargeDeficitWatts = batterySoc < 90 ? Math.max(0, 1200 - Math.max(0, -batteryPower)) : 0;
    const availableWatts = Math.max(0, -gridPower - Math.max(0, batteryPower) - batteryChargeDeficitWatts);
    return {
        availableWatts,
        batteryChargeDeficitWatts,
        effectiveGridWatts: gridPower + Math.max(0, batteryPower) + batteryChargeDeficitWatts,
    };
}

/**
 * Decide whether the V2.43 S9-to-S19 transition has remained eligible for two minutes.
 * The caller owns the candidate timestamp and resets it when conditions cease to hold.
 *
 * @param values - current target, measured power, export and stability timestamps
 */
export function isS9ToS19ReadyV243(values: {
    s9TargetWatts: number;
    s9ActualWatts: number;
    gridPowerWatts: number;
    candidateSince: number | undefined;
    now: number;
}): boolean {
    return (
        Number.isFinite(values.s9TargetWatts) &&
        values.s9TargetWatts >= 1800 &&
        Number.isFinite(values.s9ActualWatts) &&
        values.s9ActualWatts >= 1200 &&
        Number.isFinite(values.gridPowerWatts) &&
        -values.gridPowerWatts >= 300 &&
        values.candidateSince !== undefined &&
        Number.isFinite(values.candidateSince) &&
        values.candidateSince > 0 &&
        Number.isFinite(values.now) &&
        values.now >= values.candidateSince &&
        values.now - values.candidateSince >= 120_000
    );
}
