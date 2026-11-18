import { expect } from 'chai';
import { coordinatePvTargetsV243 } from './PvDualMinerBudgetV243';
import { evaluatePvRunEligibilityV243 } from './PvRunEligibilityV243';
import type { PvTargetInputsV243 } from './PvTargetRegulationV243';

/** Simulated telemetry only: no ioBroker adapter, network, relay or miner IO. */
describe('V2.43 full-day PV regulation simulation (read-only)', () => {
    const start = 12 * 60 * 60_000;
    const make = (
        miner: 'S9' | 'S19',
        currentTargetWatts: number,
        grid: number,
        battery: number,
        now: number,
    ): PvTargetInputsV243 => ({
        miner,
        currentTargetWatts,
        effectiveGridWatts: grid,
        batteryPowerWatts: battery,
        now,
    });
    it('observes the day window, start eligibility, low-power stop and evening lockout', () => {
        const at = (
            minute: number,
            hour: number,
            availableWatts: number,
            s9Running: boolean,
            s19Running: boolean,
            previous?: ReturnType<typeof evaluatePvRunEligibilityV243>,
        ) =>
            evaluatePvRunEligibilityV243({
                now: minute * 60_000,
                hour,
                availableWatts,
                s9Running,
                s19Running,
                s9TargetWatts: 1800,
                s9ActualWatts: 1300,
                gridPowerWatts: -400,
                s9LowPowerSince: previous?.s9LowPowerSince,
                s19LowPowerSince: previous?.s19LowPowerSince,
                s9ToS19CandidateSince: previous?.s9ToS19CandidateSince,
            });
        expect(at(660, 11, 3000, false, false).s9).to.equal('outside-window');
        expect(at(720, 12, 700, false, false).s9).to.equal('start-threshold-met');
        expect(at(780, 13, 2000, false, false).s19).to.equal('start-threshold-met');
        const low = at(1080, 18, 400, true, true);
        expect(low.s9).to.equal('low-power-wait');
        expect(low.s19).to.equal('low-power-wait');
        const stop = at(1082, 18, 400, true, true, low);
        expect(stop.s9).to.equal('low-power-stop-threshold-met');
        expect(stop.s19).to.equal('low-power-stop-threshold-met');
        expect(at(1200, 20, 4000, false, false).s19).to.equal('outside-window');
    });
    it('shares midday surplus, reduces on cloud import and blocks battery discharge increases', () => {
        const noon = start + 60_000;
        const s9 = make('S9', 1000, -800, 0, noon);
        const s19 = {
            ...make('S19', 1500, -800, 0, noon),
            increaseCandidateWatts: 1900,
            increaseCandidateSince: noon - 180_000,
        };
        const midday = coordinatePvTargetsV243({
            s9,
            s19,
            gridPowerWatts: -800,
            batteryPowerWatts: 0,
            reserveWatts: 200,
        });
        expect(midday.s19).to.include({ action: 'set-target', targetWatts: 1900 });
        expect(midday.s9.reason).to.equal('shared-budget-insufficient');
        const cloud = coordinatePvTargetsV243({
            s9: make('S9', 1000, 350, 0, noon + 120_000),
            s19: make('S19', 2100, 350, 0, noon + 120_000),
            gridPowerWatts: 350,
            batteryPowerWatts: 0,
            reserveWatts: 200,
        });
        expect(cloud.s9.action).to.equal('set-target');
        expect(cloud.s19.action).to.equal('set-target');
        expect(cloud.s9.targetWatts).to.be.lessThan(1000);
        expect(cloud.s19.targetWatts).to.be.lessThan(2100);
        const discharge = coordinatePvTargetsV243({
            s9: make('S9', 1000, -1200, 180, noon + 240_000),
            s19: make('S19', 1900, -1200, 180, noon + 240_000),
            gridPowerWatts: -1200,
            batteryPowerWatts: 180,
            reserveWatts: 200,
        });
        expect(discharge.s9.action).to.equal('hold');
        expect(discharge.s19.action).to.equal('hold');
    });
    it('fails closed for a 130-second-old S9 measurement and starts fresh after restart', () => {
        const now = start + 600_000;
        const maxAgeMs = 120_000;
        const s9MeasuredAt = now - 130_000;
        const s19MeasuredAt = now - 10_000;
        const fresh = (timestamp: number) => timestamp <= now && now - timestamp <= maxAgeMs;
        const proposal =
            fresh(s9MeasuredAt) && fresh(s19MeasuredAt)
                ? coordinatePvTargetsV243({
                      s9: make('S9', 1000, -800, 0, now),
                      s19: make('S19', 1500, -800, 0, now),
                      gridPowerWatts: -800,
                      batteryPowerWatts: 0,
                      reserveWatts: 200,
                  })
                : undefined;
        expect(proposal).to.equal(undefined);
        // A restarted regulator has no persisted S19 stabilization candidate.
        const restarted = coordinatePvTargetsV243({
            s9: make('S9', 1000, -800, 0, now),
            s19: make('S19', 1500, -800, 0, now),
            gridPowerWatts: -800,
            batteryPowerWatts: 0,
            reserveWatts: 200,
        });
        expect(restarted.s19).to.include({ action: 'hold', reason: 's19-increase-stabilization' });
    });
});
