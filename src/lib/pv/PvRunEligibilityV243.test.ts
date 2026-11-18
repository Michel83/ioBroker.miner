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
        expect(
            evaluatePvRunEligibilityV243({ ...s9, now: 219999, s9LowPowerSince: first.s9LowPowerSince }).s9,
        ).to.equal('low-power-wait');
        expect(
            evaluatePvRunEligibilityV243({ ...s9, now: 220000, s9LowPowerSince: first.s9LowPowerSince }).s9,
        ).to.equal('low-power-stop-threshold-met');
        expect(
            evaluatePvRunEligibilityV243({ ...s9, availableWatts: 500, s9LowPowerSince: first.s9LowPowerSince })
                .s9LowPowerSince,
        ).to.equal(undefined);
        const s19 = evaluatePvRunEligibilityV243({ ...base, s19Running: true, availableWatts: 1449 });
        expect(s19.s19).to.equal('low-power-wait');
        expect(
            evaluatePvRunEligibilityV243({
                ...base,
                s19Running: true,
                availableWatts: 1449,
                now: 220000,
                s19LowPowerSince: s19.s19LowPowerSince,
            }).s19,
        ).to.equal('low-power-stop-threshold-met');
    });

    it('requires sustained S9 to S19 switch conditions', () => {
        const s9 = { ...base, s9Running: true };
        const first = evaluatePvRunEligibilityV243(s9);
        expect(first.s19).to.equal('switch-stabilizing');
        expect(
            evaluatePvRunEligibilityV243({ ...s9, now: 220000, s9ToS19CandidateSince: first.s9ToS19CandidateSince })
                .s19,
        ).to.equal('switch-threshold-met');
        expect(
            evaluatePvRunEligibilityV243({
                ...s9,
                gridPowerWatts: -299,
                s9ToS19CandidateSince: first.s9ToS19CandidateSince,
            }).s9ToS19CandidateSince,
        ).to.equal(undefined);
    });
    it('resets S9 low-power timer when telemetry is missing', () => {
        const input = { ...base, s9Running: true, availableWatts: 499 };
        const first = evaluatePvRunEligibilityV243(input);
        const missing = evaluatePvRunEligibilityV243({
            ...input,
            now: 180000,
            availableWatts: undefined,
            s9LowPowerSince: first.s9LowPowerSince,
        });
        expect(missing.s9).to.equal('unavailable');
        expect(missing.s9LowPowerSince).to.equal(undefined);
        const resumed = evaluatePvRunEligibilityV243({
            ...input,
            now: 220000,
            s9LowPowerSince: missing.s9LowPowerSince,
        });
        expect(resumed.s9).to.equal('low-power-wait');
        expect(resumed.s9LowPowerSince).to.equal(220000);
    });

    it('resets S19 low-power timer when threshold recovers', () => {
        const input = { ...base, s19Running: true, availableWatts: 1449 };
        const first = evaluatePvRunEligibilityV243(input);
        const recovered = evaluatePvRunEligibilityV243({
            ...input,
            now: 180000,
            availableWatts: 1450,
            s19LowPowerSince: first.s19LowPowerSince,
        });
        expect(recovered.s19LowPowerSince).to.equal(undefined);
        const resumed = evaluatePvRunEligibilityV243({
            ...input,
            now: 220000,
            s19LowPowerSince: recovered.s19LowPowerSince,
        });
        expect(resumed.s19).to.equal('low-power-wait');
    });

    it('does not reuse a switch timer after export drops below threshold', () => {
        const input = { ...base, s9Running: true };
        const first = evaluatePvRunEligibilityV243(input);
        const interrupted = evaluatePvRunEligibilityV243({
            ...input,
            now: 180000,
            gridPowerWatts: -299,
            s9ToS19CandidateSince: first.s9ToS19CandidateSince,
        });
        expect(interrupted.s9ToS19CandidateSince).to.equal(undefined);
        const resumed = evaluatePvRunEligibilityV243({
            ...input,
            now: 220000,
            s9ToS19CandidateSince: interrupted.s9ToS19CandidateSince,
        });
        expect(resumed.s19).to.equal('switch-stabilizing');
    });

    it('starts fresh timers after diagnostic restart without prior history', () => {
        const input = { ...base, s9Running: true, availableWatts: 499, now: 900000 };
        const afterRestart = evaluatePvRunEligibilityV243(input);
        expect(afterRestart.s9).to.equal('low-power-wait');
        expect(afterRestart.s9LowPowerSince).to.equal(900000);
        expect(afterRestart.s19).to.equal('switch-stabilizing');
        expect(afterRestart.s9ToS19CandidateSince).to.equal(900000);
    });
    it('simulates a full PV day with both miners, fluctuations, recovery and evening lockout', () => {
        let history: ReturnType<typeof evaluatePvRunEligibilityV243> | undefined;
        const step = (
            minute: number,
            hour: number,
            availableWatts: number | undefined,
            s9Running: boolean,
            s19Running: boolean,
            gridPowerWatts: number,
            s9TargetWatts = 1800,
            s9ActualWatts = 1300,
        ) => {
            const result = evaluatePvRunEligibilityV243({
                now: minute * 60_000,
                hour,
                availableWatts,
                s9Running,
                s19Running,
                gridPowerWatts,
                s9TargetWatts,
                s9ActualWatts,
                s9ToS19CandidateSince: history?.s9ToS19CandidateSince,
                s9LowPowerSince: history?.s9LowPowerSince,
                s19LowPowerSince: history?.s19LowPowerSince,
            });
            history = result;
            return result;
        };
        // Morning: even abundant power must not authorize a start before noon.
        expect(step(600, 10, 3000, false, false, -3200).s19).to.equal('outside-window');
        expect(step(720, 12, 400, false, false, -500).s9).to.equal('insufficient-surplus');
        expect(step(722, 12, 700, false, false, -900).s9).to.equal('start-threshold-met');
        // S9 is only observed as running; the diagnostic never starts it.
        expect(step(724, 12, 2200, true, false, -400).s19).to.equal('switch-stabilizing');
        // A brief export dip resets the entire switch stabilization window.
        expect(step(725, 12, 2200, true, false, -250).s19).to.equal('hold');
        expect(step(726, 12, 2200, true, false, -400).s19).to.equal('switch-stabilizing');
        expect(step(727, 12, 2200, true, false, -400).s19).to.equal('switch-stabilizing');
        expect(step(728, 12, 2200, true, false, -400).s19).to.equal('switch-threshold-met');
        // Both miners running: falling surplus must persist for 120 seconds.
        expect(step(900, 15, 400, true, true, 200).s9).to.equal('low-power-wait');
        expect(step(901, 15, 1600, true, true, -1800).s9).to.equal('hold');
        expect(step(902, 15, 400, true, true, 200).s9).to.equal('low-power-wait');
        expect(step(903, 15, 400, true, true, 200).s9).to.equal('low-power-wait');
        const low = step(904, 15, 400, true, true, 200);
        expect(low.s9).to.equal('low-power-stop-threshold-met');
        expect(low.s19).to.equal('low-power-stop-threshold-met');
        // Missing data discards both stop timers; recovery must begin from zero.
        expect(step(905, 15, undefined, true, true, 200).s19).to.equal('unavailable');
        expect(step(906, 15, 400, true, true, 200).s19).to.equal('low-power-wait');
        expect(step(1200, 20, 3500, false, false, -3700).s9).to.equal('outside-window');
    });
});
