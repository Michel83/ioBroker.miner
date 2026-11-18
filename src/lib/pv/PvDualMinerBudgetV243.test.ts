import { expect } from 'chai';
import { coordinatePvTargetsV243 } from './PvDualMinerBudgetV243';
import type { PvTargetInputsV243 } from './PvTargetRegulationV243';

describe('V2.43 read-only shared S9/S19 PV budget', () => {
    const s9: PvTargetInputsV243 = {
        miner: 'S9',
        currentTargetWatts: 1000,
        effectiveGridWatts: -800,
        batteryPowerWatts: 0,
        now: 700000,
    };
    const s19: PvTargetInputsV243 = {
        miner: 'S19',
        currentTargetWatts: 1500,
        effectiveGridWatts: -800,
        batteryPowerWatts: 0,
        now: 700000,
        increaseCandidateWatts: 1900,
        increaseCandidateSince: 500000,
    };
    it('does not double-spend the same 600 W export budget', () => {
        const result = coordinatePvTargetsV243({
            s9,
            s19,
            gridPowerWatts: -800,
            batteryPowerWatts: 0,
            reserveWatts: 200,
        });
        expect(result.s19).to.include({ action: 'set-target', targetWatts: 1900 });
        expect(result.s9).to.include({ action: 'hold', reason: 'shared-budget-insufficient' });
    });
    it('allows both increases when the shared budget covers both increments', () => {
        const result = coordinatePvTargetsV243({
            s9: { ...s9, effectiveGridWatts: -1200 },
            s19: { ...s19, effectiveGridWatts: -1200, increaseCandidateWatts: 2300 },
            gridPowerWatts: -1200,
            batteryPowerWatts: 0,
            reserveWatts: 200,
        });
        // S19 requests 800 W and S9 requests 800 W: 1000 W cannot cover both.
        expect(result.s19.action).to.equal('set-target');
        expect(result.s9.reason).to.equal('shared-budget-insufficient');
    });
    it('blocks all increases during battery discharge and on inconsistent sensor snapshots', () => {
        const discharging = coordinatePvTargetsV243({
            s9: { ...s9, batteryPowerWatts: 120 },
            s19: { ...s19, batteryPowerWatts: 120 },
            gridPowerWatts: -800,
            batteryPowerWatts: 120,
            reserveWatts: 200,
        });
        expect(discharging.s9.action).to.equal('hold');
        expect(discharging.s19.action).to.equal('hold');
        const inconsistent = coordinatePvTargetsV243({
            s9,
            s19,
            gridPowerWatts: -900,
            batteryPowerWatts: 0,
            reserveWatts: 200,
        });
        expect(inconsistent.s9.reason).to.equal('shared-budget-unavailable');
        expect(inconsistent.s19.reason).to.equal('shared-budget-unavailable');
    });
    it('retains reductions during grid import instead of consuming export budget', () => {
        const result = coordinatePvTargetsV243({
            s9: { ...s9, effectiveGridWatts: 300 },
            s19: { ...s19, currentTargetWatts: 2100, effectiveGridWatts: 300, increaseCandidateWatts: undefined },
            gridPowerWatts: 300,
            batteryPowerWatts: 0,
            reserveWatts: 200,
        });
        expect(result.s9.action).to.equal('set-target');
        expect(result.s19.action).to.equal('set-target');
    });
    it('coordinates already-stabilized monitor proposals without double spending', () => {
        const result = coordinatePvTargetsV243({
            s9,
            s19,
            gridPowerWatts: -800,
            batteryPowerWatts: 0,
            reserveWatts: 200,
            proposals: {
                s9: { action: 'set-target', targetWatts: 1400, reason: 'increase-surplus' },
                s19: { action: 'set-target', targetWatts: 1900, reason: 'increase-surplus' },
            },
        });
        expect(result.s19.targetWatts).to.equal(1900);
        expect(result.s9).to.include({ action: 'hold', reason: 'shared-budget-insufficient' });
    });
});
