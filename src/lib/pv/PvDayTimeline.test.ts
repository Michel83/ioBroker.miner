import { expect } from 'chai';
import { confirmedPvRelayOn } from './PvRelayFeedbackDiagnostic';
import { pvRestartCountdownSeconds } from './PvRestartCountdown';
import { pvRestartSafetyReason } from './PvRestartSafetyReason';
import type { PvStopRestoration } from './PvShutdownSafety';

/**
 * Synthetic PV day. Read-only diagnostic functions only: no adapter instance,
 * miner commands, relay writes, or restart permission transitions.
 */
describe('PV full-day S9/S19 safety simulation (no hardware)', () => {
    const start = 1_800_000_000_000;
    const maxAgeMs = 15_000;
    const reserveWatts = 200;
    const miners = [
        { id: 's9', minimumStartWatts: 500 },
        { id: 's19', minimumStartWatts: 1800 },
    ] as const;
    type Snapshot = {
        minute: number;
        gridPower: number | undefined;
        batteryPower: number | undefined;
        relayAck?: boolean;
        relayAgeMs?: number;
        stopAgeMs?: number;
    };
    const observe = (miner: (typeof miners)[number], input: Snapshot) => {
        const now = start + input.minute * 60_000;
        const relayStateId = `sonoff.0.${miner.id}.POWER`;
        const relayTimestamp = now - (input.relayAgeMs ?? 0);
        const relayAck = input.relayAck ?? true;
        const stopAgeMs = input.stopAgeMs ?? 240_000;
        const restoration: PvStopRestoration = {
            storedRecord: {
                minerId: miner.id,
                relayStateId,
                stoppedAt: now - stopAgeMs,
                relayOffConfirmed: true,
            },
            minerId: miner.id,
            relayStateId,
            relayOnValue: true,
            relayValue: relayAck ? false : undefined,
            relayTimestamp,
            power: 0,
            powerTimestamp: now,
            now,
            maxAgeMs,
        };
        const relayOn = confirmedPvRelayOn(false, relayAck, relayTimestamp, true, now, maxAgeMs);
        const countdown = pvRestartCountdownSeconds(restoration, 180);
        const locked = true; // command guard remains locked throughout the synthetic day
        const reason = pvRestartSafetyReason({
            locked,
            shuttingDown: false,
            relayOn,
            countdown,
            gridPower: input.gridPower,
            batteryPower: input.batteryPower,
            reserveWatts,
            minimumStartWatts: miner.minimumStartWatts,
        });
        return { locked, relayOn, countdown, reason };
    };
    const timeline: Array<{
        phase: string;
        snapshot: Snapshot;
        s9: string;
        s19: string;
    }> = [
        {
            phase: 'morning: no PV export',
            snapshot: { minute: 0, gridPower: 200, batteryPower: 0 },
            s9: 'pv_surplus_insufficient',
            s19: 'pv_surplus_insufficient',
        },
        {
            phase: 'late morning: enough export for S9 only',
            snapshot: { minute: 120, gridPower: -1000, batteryPower: 0 },
            s9: 'restart_locked_requires_fresh_validation',
            s19: 'pv_surplus_insufficient',
        },
        {
            phase: 'midday: enough export for both',
            snapshot: { minute: 240, gridPower: -4500, batteryPower: 0 },
            s9: 'restart_locked_requires_fresh_validation',
            s19: 'restart_locked_requires_fresh_validation',
        },
        {
            phase: 'afternoon: battery begins discharging',
            snapshot: { minute: 360, gridPower: -2800, batteryPower: 150 },
            s9: 'battery_discharging',
            s19: 'battery_discharging',
        },
        {
            phase: 'late afternoon: falling PV',
            snapshot: { minute: 480, gridPower: -300, batteryPower: 0 },
            s9: 'pv_surplus_insufficient',
            s19: 'pv_surplus_insufficient',
        },
        {
            phase: 'evening: no export',
            snapshot: { minute: 600, gridPower: 500, batteryPower: 0 },
            s9: 'pv_surplus_insufficient',
            s19: 'pv_surplus_insufficient',
        },
    ];
    it('keeps both miners locked across the complete changing PV day', () => {
        for (const step of timeline) {
            for (const miner of miners) {
                const result = observe(miner, step.snapshot);
                expect(result.locked, `${step.phase}: ${miner.id}`).to.equal(true);
                expect(result.relayOn, `${step.phase}: ${miner.id}`).to.equal(false);
                expect(result.countdown, `${step.phase}: ${miner.id}`).to.equal(0);
                expect(result.reason, `${step.phase}: ${miner.id}`).to.equal(miner.id === 's9' ? step.s9 : step.s19);
            }
        }
    });
    it('isolates an S19 Sonoff acknowledgement outage from S9', () => {
        const step: Snapshot = { minute: 270, gridPower: -4500, batteryPower: 0, relayAck: false };
        const s19 = observe(miners[1], step);
        expect(s19).to.deep.equal({
            locked: true,
            relayOn: null,
            countdown: null,
            reason: 'relay_feedback_missing_or_stale',
        });
        const s9 = observe(miners[0], { ...step, relayAck: true });
        expect(s9.reason).to.equal('restart_locked_requires_fresh_validation');
        expect(s9.locked).to.equal(true);
    });
    it('requires fresh Sonoff feedback again after communication recovers', () => {
        const step: Snapshot = { minute: 275, gridPower: -4500, batteryPower: 0 };
        const stale = observe(miners[1], { ...step, relayAgeMs: maxAgeMs + 1 });
        expect(stale.relayOn).to.equal(null);
        expect(stale.countdown).to.equal(null);
        expect(stale.reason).to.equal('relay_feedback_missing_or_stale');
        const recovered = observe(miners[1], { ...step, relayAgeMs: 0 });
        expect(recovered.relayOn).to.equal(false);
        expect(recovered.countdown).to.equal(0);
        expect(recovered.reason).to.equal('restart_locked_requires_fresh_validation');
        expect(recovered.locked).to.equal(true);
    });
    it('invalidates both miner diagnostics on missing PV measurements', () => {
        const step: Snapshot = { minute: 420, gridPower: undefined, batteryPower: 0 };
        for (const miner of miners) {
            const result = observe(miner, step);
            expect(result.reason).to.equal('pv_measurements_missing_or_stale');
            expect(result.locked).to.equal(true);
        }
    });
    it('does not interpret an unexpired restart countdown as permission', () => {
        const step: Snapshot = { minute: 300, gridPower: -4500, batteryPower: 0, stopAgeMs: 60_000 };
        for (const miner of miners) {
            const result = observe(miner, step);
            expect(result.countdown).to.equal(120);
            expect(result.reason).to.equal('restart_delay_running');
            expect(result.locked).to.equal(true);
        }
    });
});
