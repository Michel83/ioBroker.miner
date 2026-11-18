import { expect } from 'chai';
import { PvShutdownConfirmation, PvRelayOffPowerConfirmation, type PvShutdownMeasurements } from './PvShutdownSafety';

/**
 * Read-only timing simulations for S9 telemetry delayed by 130 seconds.
 * No production timers or hardware commands are changed.
 */
describe('PV S9 delayed shutdown timing budget (simulation only)', () => {
    const start = 1_800_000_000_000;
    const pausedAt = start - 1;
    const telemetryIntervalMs = 130_000;
    const pollMs = 5_000;
    const maxAgeMs = 180_000;
    const maxSensorGapMs = 180_000;

    const measurement = (now: number, powerTimestamp: number): PvShutdownMeasurements => ({
        hashrate: 0,
        hashrateTimestamp: now,
        power: 50,
        powerTimestamp,
        lastSeen: now,
    });

    it('needs at least 390 seconds after pause when first low-power reading arrives at 130 seconds', () => {
        const confirmation = new PvShutdownConfirmation();
        let firstConfirmedAt: number | undefined;
        for (let elapsed = 0; elapsed <= 400_000; elapsed += pollMs) {
            const now = start + elapsed;
            const lastReadingIndex = Math.floor(elapsed / telemetryIntervalMs);
            const powerTimestamp = lastReadingIndex === 0 ? pausedAt : start + lastReadingIndex * telemetryIntervalMs;
            if (
                confirmation.update(
                    measurement(now, powerTimestamp),
                    now,
                    maxAgeMs,
                    pausedAt,
                    30_000,
                    10_000,
                    maxSensorGapMs,
                )
            ) {
                firstConfirmedAt ??= elapsed;
            }
        }
        expect(firstConfirmedAt).to.equal(390_000);
        // Existing production formula: max(5 min, 3 * configured sensor gap + 60 s).
        expect(Math.max(300_000, 3 * maxSensorGapMs + 60_000)).to.be.greaterThan(firstConfirmedAt!);
        expect(Math.max(300_000, 3 * 15_000 + 60_000)).to.be.lessThan(firstConfirmedAt!);
    });

    it('requires three distinct post-relay-off readings, not repeated values during polling', () => {
        const offRequestedAt = start;
        const confirmation = new PvRelayOffPowerConfirmation(offRequestedAt);
        let firstConfirmedAt: number | undefined;
        for (let elapsed = 0; elapsed <= 400_000; elapsed += pollMs) {
            const now = start + elapsed;
            const readingIndex = Math.floor(elapsed / telemetryIntervalMs);
            const powerTimestamp = readingIndex === 0 ? start - 1 : start + readingIndex * telemetryIntervalMs;
            if (confirmation.update(0, powerTimestamp, true, now, maxAgeMs)) {
                firstConfirmedAt ??= elapsed;
            }
        }
        expect(firstConfirmedAt).to.equal(390_000);
        // Existing production timeout formula for a configured 180 s sensor gap.
        expect(Math.max(90_000, 3 * maxSensorGapMs + 30_000)).to.be.greaterThan(firstConfirmedAt!);
        expect(Math.max(90_000, 3 * 15_000 + 30_000)).to.be.lessThan(firstConfirmedAt!);
    });

    it('does not count a missing intermediate Sonoff update as a new confirmation', () => {
        const confirmation = new PvRelayOffPowerConfirmation(start);
        let accepted = false;
        for (let elapsed = 0; elapsed <= 400_000; elapsed += pollMs) {
            const now = start + elapsed;
            const powerTimestamp = elapsed < 130_000 ? start - 1 : start + 130_000;
            accepted = confirmation.update(0, powerTimestamp, true, now, maxAgeMs);
            expect(accepted).to.equal(false);
        }
    });
});
