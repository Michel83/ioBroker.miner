import { expect } from 'chai';
import { confirmedPvRelayOn } from './PvRelayFeedbackDiagnostic';
import { pvRestartCountdownSeconds } from './PvRestartCountdown';
import { pvRestartSafetyReason } from './PvRestartSafetyReason';
import type { PvStopRestoration } from './PvShutdownSafety';

/**
 * Two-miner scenario test using only pure read-only diagnostic helpers.
 * Neither the real adapter nor hardware/command paths are instantiated.
 */
describe('PV dual-miner restart scenarios (simulation only)', () => {
    const now = 1_800_000_000_000;
    const maxAgeMs = 15_000;
    const makeMiner = (minerId: string, stoppedAgoMs: number, minimumStartWatts: number) => {
        const relayStateId = `sonoff.0.${minerId}.POWER`;
        const measurements: PvStopRestoration = {
            storedRecord: { minerId, relayStateId, stoppedAt: now - stoppedAgoMs, relayOffConfirmed: true },
            minerId,
            relayStateId,
            relayOnValue: true,
            relayValue: false,
            relayTimestamp: now,
            power: 0,
            powerTimestamp: now,
            now,
            maxAgeMs,
        };
        return { measurements, minimumStartWatts, locked: true };
    };
    const evaluate = (miner: ReturnType<typeof makeMiner>, relayAck: boolean, gridPower = -4500, batteryPower = 0) => {
        const m = miner.measurements;
        const relayOn = confirmedPvRelayOn(m.relayValue, relayAck, m.relayTimestamp, m.relayOnValue, m.now, maxAgeMs);
        const countdown = pvRestartCountdownSeconds({ ...m, relayValue: relayAck ? m.relayValue : undefined }, 180);
        const reason = pvRestartSafetyReason({
            locked: miner.locked,
            shuttingDown: false,
            relayOn,
            countdown,
            gridPower,
            batteryPower,
            reserveWatts: 200,
            minimumStartWatts: miner.minimumStartWatts,
        });
        return { relayOn, countdown, reason, locked: miner.locked };
    };

    it('keeps S9 waiting while S19 loses acknowledged relay feedback', () => {
        const s9 = makeMiner('s9', 60_000, 500);
        const s19 = makeMiner('s19', 60_000, 1800);
        const s9Result = evaluate(s9, true);
        const s19Result = evaluate(s19, false);
        expect(s9Result).to.deep.equal({
            relayOn: false,
            countdown: 120,
            reason: 'restart_delay_running',
            locked: true,
        });
        expect(s19Result).to.deep.equal({
            relayOn: null,
            countdown: null,
            reason: 'relay_feedback_missing_or_stale',
            locked: true,
        });
    });

    it('does not carry S19 failure over to S9 when relay feedback recovers', () => {
        const s9 = makeMiner('s9', 60_000, 500);
        const s19 = makeMiner('s19', 60_000, 1800);
        s19.measurements.relayTimestamp = now - maxAgeMs - 1;
        expect(evaluate(s19, true).reason).to.equal('relay_feedback_missing_or_stale');
        s19.measurements.relayTimestamp = now;
        expect(evaluate(s19, true).reason).to.equal('restart_delay_running');
        expect(evaluate(s9, true).reason).to.equal('restart_delay_running');
        expect(s9.locked).to.equal(true);
        expect(s19.locked).to.equal(true);
    });

    it('keeps both miners locked even after both countdowns reach zero', () => {
        const s9 = makeMiner('s9', 200_000, 500);
        const s19 = makeMiner('s19', 200_000, 1800);
        for (const miner of [s9, s19]) {
            const result = evaluate(miner, true);
            expect(result.countdown).to.equal(0);
            expect(result.reason).to.equal('restart_locked_requires_fresh_validation');
            expect(result.locked).to.equal(true);
        }
    });

    it('reports shared PV loss without erasing each miner countdown', () => {
        const s9 = makeMiner('s9', 60_000, 500);
        const s19 = makeMiner('s19', 60_000, 1800);
        for (const miner of [s9, s19]) {
            const result = evaluate(miner, true, -100, 0);
            expect(result.countdown).to.equal(120);
            expect(result.reason).to.equal('pv_surplus_insufficient');
            expect(result.locked).to.equal(true);
        }
    });

    it('keeps one miner unknown after its power telemetry goes stale', () => {
        const s9 = makeMiner('s9', 60_000, 500);
        const s19 = makeMiner('s19', 60_000, 1800);
        s19.measurements.powerTimestamp = now - maxAgeMs - 1;
        const s19Result = evaluate(s19, true);
        expect(s19Result.countdown).to.equal(null);
        expect(s19Result.reason).to.equal('restart_stop_evidence_unavailable');
        expect(evaluate(s9, true).countdown).to.equal(120);
        expect(s9.locked).to.equal(true);
        expect(s19.locked).to.equal(true);
    });
});
