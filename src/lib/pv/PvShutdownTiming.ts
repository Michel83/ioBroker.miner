/**
 * Compute per-miner shutdown observation budgets from its configured power telemetry gap.
 * Pure calculation only: does not send miner or relay commands.
 */
export interface PvShutdownTiming {
    powerSampleGapMs: number;
    preRelayTimeoutMs: number;
    postRelayTimeoutMs: number;
}

export function getPvShutdownTiming(
    powerSampleMaxGapSeconds: number | undefined,
    relayOffConfirmationTimeoutSeconds: number | undefined,
): PvShutdownTiming {
    const powerSampleGapMs = Math.min(180, Math.max(15,
        Number.isFinite(powerSampleMaxGapSeconds) && powerSampleMaxGapSeconds! > 0
            ? powerSampleMaxGapSeconds!
            : 15)) * 1000;
    const configuredPostMs = Number.isFinite(relayOffConfirmationTimeoutSeconds) &&
        relayOffConfirmationTimeoutSeconds! > 0
        ? relayOffConfirmationTimeoutSeconds! * 1000
        : 90_000;
    return {
        powerSampleGapMs,
        preRelayTimeoutMs: Math.max(300_000, 3 * powerSampleGapMs + 60_000),
        postRelayTimeoutMs: Math.max(90_000, configuredPostMs, 3 * powerSampleGapMs + 30_000),
    };
}
