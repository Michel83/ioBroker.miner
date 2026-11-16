import { expect } from 'chai';
import { decidePvTargetV243 } from './PvTargetRegulationV243';
import type { PvTargetInputsV243 } from './PvTargetRegulationV243';

describe('V2.43 pure power target regulation', () => {
    const base: PvTargetInputsV243 = {
        miner: 'S9',
        currentTargetWatts: 1000,
        effectiveGridWatts: 0,
        batteryPowerWatts: 0,
        now: 500000,
    };
    it('holds the -200 to 0 W deadband', () => {
        for (const grid of [-200, -100, 0]) {
            expect(decidePvTargetV243({ ...base, effectiveGridWatts: grid }).action).to.equal('hold');
        }
    });
    it('reduces S9 in 100 W steps and clamps to minimum', () => {
        expect(decidePvTargetV243({ ...base, effectiveGridWatts: 150 })).to.include({
            action: 'set-target', targetWatts: 700,
        });
        expect(decidePvTargetV243({ ...base, effectiveGridWatts: 4000 }).targetWatts).to.equal(500);
    });
    it('increases S9 only with sufficient surplus and clamps to 1800 W', () => {
        expect(decidePvTargetV243({ ...base, effectiveGridWatts: -399 }).action).to.equal('hold');
        expect(decidePvTargetV243({ ...base, effectiveGridWatts: -500 }).targetWatts).to.equal(1100);
        expect(decidePvTargetV243({ ...base, effectiveGridWatts: -4000 }).targetWatts).to.equal(1800);
    });
    it('enforces two minute regulation interval', () => {
        expect(decidePvTargetV243({ ...base, effectiveGridWatts: 500, lastRegulationAt: 400001 }).reason).to.equal('regulation-interval');
        expect(decidePvTargetV243({ ...base, effectiveGridWatts: 500, lastRegulationAt: 380000 }).action).to.equal('set-target');
    });
    it('requests S9 stop at minimum when battery discharges', () => {
        expect(decidePvTargetV243({ ...base, currentTargetWatts: 500, batteryPowerWatts: 101 }).action).to.equal('request-stop');
        expect(decidePvTargetV243({ ...base, currentTargetWatts: 500, batteryPowerWatts: 10, effectiveGridWatts: 50 }).action).to.equal('request-stop');
    });
    it('reduces S19 immediately after restart protection and rounds 200 W steps', () => {
        const s19 = { ...base, miner: 'S19' as const, currentTargetWatts: 2100, effectiveGridWatts: 350 };
        expect(decidePvTargetV243({ ...s19, lastTargetChangeAt: 320001 }).reason).to.equal('s19-restart-protection');
        expect(decidePvTargetV243({ ...s19, lastTargetChangeAt: 320000 })).to.include({
            action: 'set-target', targetWatts: 1500,
        });
    });
    it('requires three minutes of the same S19 increase target', () => {
        const s19 = { ...base, miner: 'S19' as const, currentTargetWatts: 1500, effectiveGridWatts: -800 };
        const first = decidePvTargetV243(s19);
        expect(first).to.include({ action: 'hold', increaseCandidateWatts: 1900, increaseCandidateSince: 500000 });
        expect(decidePvTargetV243({ ...s19, now: 679999, increaseCandidateWatts: 1900, increaseCandidateSince: 500000 }).action).to.equal('hold');
        expect(decidePvTargetV243({ ...s19, now: 680000, increaseCandidateWatts: 1900, increaseCandidateSince: 500000 })).to.include({
            action: 'set-target', targetWatts: 1900,
        });
        expect(decidePvTargetV243({ ...s19, now: 680000, effectiveGridWatts: -1000, increaseCandidateWatts: 1900, increaseCandidateSince: 500000 }).reason).to.equal('s19-increase-stabilization');
    });
    it('rejects invalid or missing measurements without a target command', () => {
        expect(decidePvTargetV243({ ...base, effectiveGridWatts: NaN }).action).to.equal('hold');
        expect(decidePvTargetV243({ ...base, currentTargetWatts: 1050 }).action).to.equal('hold');
    });
});
