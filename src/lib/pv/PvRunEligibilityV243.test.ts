import { expect } from 'chai';
import { evaluatePvRunEligibilityV243 } from './PvRunEligibilityV243';

describe('V2.43 read-only start and stop eligibility', () => {
    const base = {
        now: 100000,
        hour: 14,
        availableWatts: 2000,
        s9Running: false,
        s19Running: false,
        s9TargetWatts: 1800,
        s9ActualWatts: 1300,
        gridPowerWatts: -400,
    };

    it('observes start thresholds without issuing commands', () => {
        expect(evaluatePvRunEligibilityV243(base)).to.include({
            s9: 'start-threshold-met',
            s19: 'start-threshold-met',
        });
        expect(evaluatePvRunEligibilityV243({ ...base, availableWatts: 599 })).to.include({
            s9: 'insufficient-surplus',
            s19: 'insufficient-surplus',
        });
        expect(evaluatePvRunEligibilityV243({ ...base, availableWatts: 600 }).s19).to.equal('insufficient-surplus');
    });

    it('fails closed outside 12 to 20 and when measurements are missing', () => {
        expect(evaluatePvRunEligibilityV243({ ...base, hour: 20 }).s9).to.equal('outside-window');
        expect(evaluatePvRunEligibilityV243({ ...base, hour: 11 }).s19).to.equal('outside-window');
        expect(evaluatePvRunEligibilityV243({ ...base, s9Running: undefined }).s9).to.equal('unavailable');
        expect(evaluatePvRunEligibilityV243({ ...base, gridPowerWatts: NaN }).s19).to.equal('unavailable');
    });

    it('requires 120 seconds continuously below S9 and S19 keep thresholds', () => {
        const s9 = { ...base, s9Running: true, availableWatts: 499 };
        const first = evaluatePvRunEligibilityV243(s9);
        expect(first.s9).to.equal('low-power-wait');
        expect(evaluatePvRunEligibilityV243({ ...s9, now: 219999, s9LowPowerSince: first.s9LowPowerSince }).s9).to.equal('low-power-wait');
        expect(evaluatePvRunEligibilityV243({ ...s9, now: 220000, s9LowPowerSince: first.s9LowPowerSince }).s9).to.equal('low-power-stop-threshold-met');
        expect(evaluatePvRunEligibilityV243({ ...s9, availableWatts: 500, s9LowPowerSince: first.s9LowPowerSince }).s9LowPowerSince).to.equal(undefined);
        const s19 = evaluatePvRunEligibilityV243({ ...base, s19Running: true, availableWatts: 1449 });
        expect(s19.s19).to.equal('low-power-wait');
        expect(evaluatePvRunEligibilityV243({ ...base, s19Running: true, availableWatts: 1449, now: 220000, s19LowPowerSince: s19.s19LowPowerSince }).s19).to.equal('low-power-stop-threshold-met');
    });

    it('requires sustained S9 to S19 switch conditions', () => {
        const s9 = { ...base, s9Running: true };
        const first = evaluatePvRunEligibilityV243(s9);
        expect(first.s19).to.equal('switch-stabilizing');
        expect(evaluatePvRunEligibilityV243({ ...s9, now: 220000, s9ToS19CandidateSince: first.s9ToS19CandidateSince }).s19).to.equal('switch-threshold-met');
        expect(evaluatePvRunEligibilityV243({ ...s9, gridPowerWatts: -299, s9ToS19CandidateSince: first.s9ToS19CandidateSince }).s9ToS19CandidateSince).to.equal(undefined);
    });
});
