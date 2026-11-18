import { expect } from 'chai';
import { PvTargetDiagnosticV243 } from './PvTargetDiagnosticV243';
import { coordinatePvTargetsV243 } from './PvDualMinerBudgetV243';

/** A new adapter process owns fresh in-memory diagnostic history. No hardware IO. */
describe('V2.43 dual-miner PV monitor restart isolation', () => {
    const now = 1_800_000_000_000;
    const input = (miner: 'S9' | 'S19', timestamp: number) => ({
        miner, currentTargetWatts: miner === 'S9' ? 1000 : 1500,
        effectiveGridWatts: -800, batteryPowerWatts: 0, now: timestamp,
    });
    it('does not inherit a prior process S19 increase candidate', () => {
        const oldProcess = new PvTargetDiagnosticV243();
        expect(oldProcess.evaluate(input('S19', now)).reason).to.equal('s19-initial-observation');
        expect(oldProcess.evaluate(input('S19', now + 180_000)).reason).to.equal('s19-increase-stabilization');
        expect(oldProcess.evaluate(input('S19', now + 359_999)).reason).to.equal('s19-increase-stabilization');
        expect(oldProcess.evaluate(input('S19', now + 360_000))).to.include({
            action: 'set-target', reason: 'increase-surplus',
        });
        const freshProcess = new PvTargetDiagnosticV243();
        expect(freshProcess.evaluate(input('S19', now + 360_000))).to.include({
            action: 'hold', reason: 's19-initial-observation',
        });
        expect(freshProcess.evaluate(input('S19', now + 540_000))).to.include({
            action: 'hold', reason: 's19-increase-stabilization',
        });
    });
    it('holds shared S19 increase immediately after restart despite previously sufficient export', () => {
        const diagnostic = new PvTargetDiagnosticV243();
        const s9 = input('S9', now);
        const s19 = input('S19', now);
        const proposals = { s9: diagnostic.evaluate(s9), s19: diagnostic.evaluate(s19) };
        const result = coordinatePvTargetsV243({
            s9, s19, gridPowerWatts: -800, batteryPowerWatts: 0, reserveWatts: 200,
            proposals,
        });
        expect(result.s19).to.include({ action: 'hold', reason: 's19-initial-observation' });
    });
    it('resets both miners after invalid measurements and starts S19 observation anew', () => {
        const diagnostic = new PvTargetDiagnosticV243();
        diagnostic.evaluate(input('S9', now));
        diagnostic.evaluate(input('S19', now));
        diagnostic.reset('S9');
        diagnostic.reset('S19');
        const restored = diagnostic.evaluate(input('S19', now + 600_000));
        expect(restored).to.include({ action: 'hold', reason: 's19-initial-observation' });
    });
});
