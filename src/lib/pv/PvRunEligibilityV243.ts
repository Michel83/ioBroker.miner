/**
 * Read-only V2.43 start/stop eligibility. These observations NEVER authorize
 * a miner command, a stop request, or a relay write.
 */
export interface PvRunEligibilityInputV243 {
    now: number;
    hour: number;
    availableWatts: number | undefined;
    s9Running: boolean | undefined;
    s19Running: boolean | undefined;
    s9TargetWatts: number | undefined;
    s9ActualWatts: number | undefined;
    gridPowerWatts: number | undefined;
    s9ToS19CandidateSince?: number;
    s9LowPowerSince?: number;
    s19LowPowerSince?: number;
}

export interface PvRunEligibilityV243 {
    s9: string;
    s19: string;
    s9ToS19CandidateSince?: number;
    s9LowPowerSince?: number;
    s19LowPowerSince?: number;
}

const validTime = (value: number | undefined, now: number): value is number =>
    value !== undefined && Number.isFinite(value) && value >= 0 && value <= now;

/**
 * Calculate V2.43 start/stop observations using fresh caller-validated telemetry.
 * Missing inputs fail closed and reset all pending stability timers.
 *
 * @param input - current observations and prior consecutive eligibility timestamps
 */
export function evaluatePvRunEligibilityV243(input: PvRunEligibilityInputV243): PvRunEligibilityV243 {
    const { now, hour, availableWatts: available, s9Running, s19Running, s9TargetWatts, s9ActualWatts, gridPowerWatts } = input;
    if (
        !Number.isFinite(now) ||
        now < 0 ||
        !Number.isInteger(hour) ||
        hour < 0 ||
        hour > 23 ||
        available === undefined ||
        !Number.isFinite(available) ||
        available < 0 ||
        typeof s9Running !== 'boolean' ||
        typeof s19Running !== 'boolean' ||
        s9TargetWatts === undefined ||
        !Number.isFinite(s9TargetWatts) ||
        s9ActualWatts === undefined ||
        !Number.isFinite(s9ActualWatts) ||
        gridPowerWatts === undefined ||
        !Number.isFinite(gridPowerWatts)
    ) {
        return { s9: 'unavailable', s19: 'unavailable' };
    }
    if (hour < 12 || hour >= 20) {
        return { s9: 'outside-window', s19: 'outside-window' };
    }

    const result: PvRunEligibilityV243 = { s9: 'hold', s19: 'hold' };
    if (!s9Running && !s19Running) {
        result.s9 = available >= 600 ? 'start-threshold-met' : 'insufficient-surplus';
        result.s19 = available >= 1600 ? 'start-threshold-met' : 'insufficient-surplus';
        return result;
    }

    if (s9Running) {
        const lowSince = available < 500
            ? (validTime(input.s9LowPowerSince, now) ? input.s9LowPowerSince : now)
            : undefined;
        result.s9LowPowerSince = lowSince;
        if (lowSince !== undefined) {
            result.s9 = now - lowSince >= 120_000 ? 'low-power-stop-threshold-met' : 'low-power-wait';
        }
    }
    if (s19Running) {
        const lowSince = available < 1450
            ? (validTime(input.s19LowPowerSince, now) ? input.s19LowPowerSince : now)
            : undefined;
        result.s19LowPowerSince = lowSince;
        if (lowSince !== undefined) {
            result.s19 = now - lowSince >= 120_000 ? 'low-power-stop-threshold-met' : 'low-power-wait';
        }
    }
    if (s9Running && !s19Running) {
        const eligible = s9TargetWatts >= 1800 && s9ActualWatts >= 1200 && gridPowerWatts <= -300;
        const since = eligible
            ? (validTime(input.s9ToS19CandidateSince, now) ? input.s9ToS19CandidateSince : now)
            : undefined;
        result.s9ToS19CandidateSince = since;
        if (since !== undefined) {
            result.s19 = now - since >= 120_000 ? 'switch-threshold-met' : 'switch-stabilizing';
        }
    }
    return result;
}
