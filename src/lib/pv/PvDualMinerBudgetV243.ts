import { decidePvTargetV243, type PvTargetDecisionV243, type PvTargetInputsV243 } from './PvTargetRegulationV243';

/**
 * Read-only coordination of two independently calculated target proposals.
 * Never dispatches commands. An increase is admitted only if the entire
 * requested increment fits the shared, conservative grid-export budget.
 */
export function coordinatePvTargetsV243(input: {
    s9: PvTargetInputsV243;
    s19: PvTargetInputsV243;
    gridPowerWatts: number;
    batteryPowerWatts: number;
    reserveWatts: number;
}): { s9: PvTargetDecisionV243; s19: PvTargetDecisionV243 } {
    const { s9, s19, gridPowerWatts: grid, batteryPowerWatts: battery, reserveWatts: reserve } = input;
    const blocked = { action: 'hold', reason: 'shared-budget-unavailable' } as const;
    if (
        s9.miner !== 'S9' || s19.miner !== 'S19' ||
        ![grid, battery, reserve].every(Number.isFinite) || reserve < 0 ||
        !Number.isFinite(s9.currentTargetWatts) || !Number.isFinite(s19.currentTargetWatts) ||
        s9.effectiveGridWatts !== s19.effectiveGridWatts ||
        s9.batteryPowerWatts !== s19.batteryPowerWatts ||
        s9.effectiveGridWatts !== grid || s9.batteryPowerWatts !== battery
    ) {
        return { s9: blocked, s19: blocked };
    }

    let budget = Math.max(0, -grid - reserve - Math.max(0, battery));
    const s19Decision = decidePvTargetV243(s19);
    const s9Decision = decidePvTargetV243(s9);
    const admit = (decision: PvTargetDecisionV243, current: number): PvTargetDecisionV243 => {
        if (decision.action !== 'set-target' || decision.targetWatts === undefined ||
            decision.targetWatts <= current) {
            return decision;
        }
        const increment = decision.targetWatts - current;
        if (battery > 0 || increment > budget) {
            return { action: 'hold', reason: 'shared-budget-insufficient' };
        }
        budget -= increment;
        return decision;
    };
    // S19 gets first claim, S9 can use only the remaining export budget.
    const acceptedS19 = admit(s19Decision, s19.currentTargetWatts);
    const acceptedS9 = admit(s9Decision, s9.currentTargetWatts);
    return { s9: acceptedS9, s19: acceptedS19 };
}
