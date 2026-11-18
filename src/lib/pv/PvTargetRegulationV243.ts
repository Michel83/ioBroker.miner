/**
 * Pure V2.43 power-target decision. No miner commands or relay writes.
 * Caller must enforce fresh telemetry, serialize decisions and persist timing state.
 */
export type PvMinerKindV243 = 'S9' | 'S19';

export interface PvTargetInputsV243 {
    miner: PvMinerKindV243;
    currentTargetWatts: number;
    effectiveGridWatts: number;
    batteryPowerWatts: number;
    now: number;
    lastRegulationAt?: number;
    lastTargetChangeAt?: number;
    increaseCandidateWatts?: number;
    increaseCandidateSince?: number;
}

export interface PvTargetDecisionV243 {
    action: 'hold' | 'set-target' | 'request-stop';
    targetWatts?: number;
    reason: string;
    increaseCandidateWatts?: number;
    increaseCandidateSince?: number;
}

const hold = (reason: string): PvTargetDecisionV243 => ({ action: 'hold', reason });

/**
 * Calculate one V2.43 regulation decision. Candidate fields must be retained
 * between evaluations and cleared when the required target changes.
 *
 * @param input - validated power measurements and previous regulation state
 */
export function decidePvTargetV243(input: PvTargetInputsV243): PvTargetDecisionV243 {
    const { miner, currentTargetWatts: current, effectiveGridWatts: grid, batteryPowerWatts: battery, now } = input;
    if (
        (miner !== 'S9' && miner !== 'S19') ||
        ![current, grid, battery, now].every(Number.isFinite) ||
        now < 0 ||
        (input.lastRegulationAt !== undefined &&
            (!Number.isFinite(input.lastRegulationAt) || input.lastRegulationAt > now)) ||
        (input.lastTargetChangeAt !== undefined &&
            (!Number.isFinite(input.lastTargetChangeAt) || input.lastTargetChangeAt > now))
    ) {
        return hold('invalid-input');
    }
    const min = miner === 'S9' ? 500 : 1500;
    const max = miner === 'S9' ? 1800 : 2500;
    const step = miner === 'S9' ? 100 : 200;
    if (current < min || current > max || (current - min) % step !== 0) {
        return hold('invalid-current-target');
    }
    // V2.43 stops the S9 at minimum power if the battery is discharging.
    if (miner === 'S9' && current <= min && (battery > 100 || (grid > 0 && battery > 0))) {
        return { action: 'request-stop', reason: 's9-battery-protection' };
    }
    if (input.lastRegulationAt !== undefined && now - input.lastRegulationAt < 120_000) {
        return hold('regulation-interval');
    }
    if (miner === 'S19' && input.lastTargetChangeAt !== undefined && now - input.lastTargetChangeAt < 180_000) {
        return hold('s19-restart-protection');
    }
    if (grid >= -200 && grid <= 0) {
        return hold('grid-deadband');
    }

    let raw = current;
    if (grid > 0) {
        raw = current - grid - 200;
    } else {
        const extraSurplus = -grid - 200;
        if (extraSurplus < 200) {
            return hold('surplus-below-step-threshold');
        }
        raw = current + (miner === 'S9' ? Math.max(100, extraSurplus - 200) : extraSurplus - 200);
    }
    const clamped = Math.max(min, Math.min(max, raw));
    const target = Math.max(min, Math.min(max, min + Math.round((clamped - min) / step) * step));
    if (target === current) {
        return hold('unchanged');
    }
    // Battery power is positive when discharging. Never increase either miner's
    // consumption while the battery is supplying energy, even if the grid exports.
    if (target > current && battery > 0) {
        return hold('battery-discharging');
    }
    if (miner === 'S19' && target > current) {
        const validCandidate =
            input.increaseCandidateWatts === target &&
            input.increaseCandidateSince !== undefined &&
            Number.isFinite(input.increaseCandidateSince) &&
            input.increaseCandidateSince >= 0 &&
            input.increaseCandidateSince <= now;
        if (!validCandidate || now - input.increaseCandidateSince! < 180_000) {
            return {
                action: 'hold',
                reason: 's19-increase-stabilization',
                increaseCandidateWatts: target,
                increaseCandidateSince: validCandidate ? input.increaseCandidateSince : now,
            };
        }
    }
    return { action: 'set-target', targetWatts: target, reason: grid > 0 ? 'reduce-import' : 'increase-surplus' };
}
