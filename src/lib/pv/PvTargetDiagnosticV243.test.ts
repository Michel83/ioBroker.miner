import { expect } from 'chai';
import { PvTargetDiagnosticV243 } from './PvTargetDiagnosticV243';

describe('V2.43 read-only target diagnostic history', () => {
    const s19 = {
        miner: 'S19' as const,
        currentTargetWatts: 1500,
        effectiveGridWatts: -800,
        batteryPowerWatts: 0,
    };
    it('holds S19 during initial observation and then requires a stable increase', () => {
        const d = new PvTargetDiagnosticV243();
        expect(d.evaluate({ ...s19, now: 100000 }).reason).to.equal('s19-initial-observation');
        expect(d.evaluate({ ...s19, now: 280000 }).reason).to.equal('s19-increase-stabilization');
        expect(d.evaluate({ ...s19, now: 459999 }).action).to.equal('hold');
        expect(d.evaluate({ ...s19, now: 460000 })).to.include({ action: 'set-target', targetWatts: 1900 });
    });
    it('restarts S19 protection after observing an external target change', () => {
        const d = new PvTargetDiagnosticV243();
        d.evaluate({ ...s19, now: 100000 });
        d.evaluate({ ...s19, now: 280000 });
        expect(d.evaluate({ ...s19, currentTargetWatts: 1700, now: 300000 }).reason).to.equal('regulation-interval');
        expect(d.evaluate({ ...s19, currentTargetWatts: 1700, now: 420000 }).reason).to.equal('s19-restart-protection');
    });
    it('resets candidate on lost measurement and changed surplus', () => {
        const d = new PvTargetDiagnosticV243();
        d.evaluate({ ...s19, now: 100000 });
        d.evaluate({ ...s19, now: 280000 });
        expect(d.evaluate({ ...s19, effectiveGridWatts: NaN, now: 300000 }).reason).to.equal(
            'invalid-or-stale-measurement',
        );
        expect(d.evaluate({ ...s19, now: 480000 }).reason).to.equal('s19-initial-observation');
    });
    it('enforces the 120 second interval after observed S9 target changes', () => {
        const d = new PvTargetDiagnosticV243();
        const s9 = { miner: 'S9' as const, currentTargetWatts: 1000, effectiveGridWatts: 500, batteryPowerWatts: 0 };
        expect(d.evaluate({ ...s9, now: 100000 }).action).to.equal('set-target');
        expect(d.evaluate({ ...s9, currentTargetWatts: 900, now: 110000 }).reason).to.equal('regulation-interval');
        expect(d.evaluate({ ...s9, currentTargetWatts: 900, now: 230000 }).action).to.equal('set-target');
    });
});
