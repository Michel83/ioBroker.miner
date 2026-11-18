import { expect } from 'chai';
import { isPvShutdownSafe, PvShutdownConfirmation, type PvShutdownMeasurements } from './PvShutdownSafety';

/**
 * S9-specific, read-only shutdown evidence simulations.
 * Does not enable S9 relay control or alter the BOSMiner-only production stop path.
 */
describe('PV S9 shutdown with delayed Sonoff telemetry (simulation only)', () => {
    const start = 1_800_000_000_000;
    const pausedAt = start - 1000;
    const ageMs = 180_000;
    const sample = (at: number, powerAt = at, power = 75): PvShutdownMeasurements => ({
        hashrate: 0,
        hashrateTimestamp: at,
        power,
        powerTimestamp: powerAt,
        lastSeen: at,
    });

    it('does not confirm S9 stopped from stale pre-pause power even if hashrate is zero', () => {
        const check = new PvShutdownConfirmation();
        for (let seconds = 0; seconds <= 150; seconds += 5) {
            const at = start + seconds * 1000;
            expect(check.update(sample(at, pausedAt - 1), at, ageMs, pausedAt, 30_000, 10_000, 180_000)).to.equal(
                false,
            );
        }
    });

    it('does not count a repeated 130-second-old power timestamp as fresh confirmations', () => {
        const check = new PvShutdownConfirmation();
        for (let seconds = 130; seconds <= 165; seconds += 5) {
            const at = start + seconds * 1000;
            expect(check.update(sample(at, start), at, ageMs, pausedAt, 30_000, 10_000, 180_000)).to.equal(false);
        }
    });

    it('accepts S9 stop evidence after three distinct post-pause updates over 30 seconds', () => {
        const check = new PvShutdownConfirmation();
        const delayed = start + 130_000;
        expect(check.update(sample(delayed), delayed, ageMs, pausedAt, 30_000, 20_000, 180_000)).to.equal(false);
        expect(
            check.update(sample(delayed + 15_000), delayed + 15_000, ageMs, pausedAt, 30_000, 20_000, 180_000),
        ).to.equal(false);
        expect(
            check.update(sample(delayed + 30_000), delayed + 30_000, ageMs, pausedAt, 30_000, 20_000, 180_000),
        ).to.equal(true);
    });

    it('fails closed if S9 power updates arrive 130 seconds apart while the current confirmation window is 10 seconds', () => {
        const check = new PvShutdownConfirmation();
        for (let seconds = 130; seconds <= 390; seconds += 130) {
            const at = start + seconds * 1000;
            expect(check.update(sample(at), at, ageMs, pausedAt, 30_000, 10_000, 180_000)).to.equal(false);
        }
    });

    it('does not accept a final power sample older than the configured 15-second confirmation gap', () => {
        const now = start + 160_000;
        expect(isPvShutdownSafe(sample(now, now - 130_000), now, 15_000, pausedAt)).to.equal(false);
    });

    it('confirms three genuinely new S9 power readings spaced 130 seconds apart while polling every 5 seconds', () => {
        const check = new PvShutdownConfirmation();
        let confirmed = false;
        for (let seconds = 0; seconds <= 400; seconds += 5) {
            const now = start + seconds * 1000;
            // The first post-pause measurement is delayed; subsequent Sonoff readings arrive every 130 s.
            const lastPowerSecond = seconds < 130 ? -1 : 130 + Math.floor((seconds - 130) / 130) * 130;
            const powerAt = lastPowerSecond < 0 ? pausedAt - 1 : start + lastPowerSecond * 1000;
            confirmed = check.update(sample(now, powerAt), now, ageMs, pausedAt, 30_000, 10_000, 180_000);
            if (seconds < 390) {
                expect(confirmed, `unexpected confirmation at ${seconds}s`).to.equal(false);
            }
        }
        expect(confirmed).to.equal(true);
    });

    it('rejects S9 telemetry if the next power update exceeds the 180-second sensor freshness limit', () => {
        const check = new PvShutdownConfirmation();
        const first = start + 130_000;
        expect(check.update(sample(first), first, ageMs, pausedAt, 30_000, 10_000, 180_000)).to.equal(false);
        const stale = first + 185_000;
        expect(check.update(sample(stale, first), stale, ageMs, pausedAt, 30_000, 10_000, 180_000)).to.equal(false);
        expect(check.update(sample(stale + 5_000), stale + 5_000, ageMs, pausedAt, 30_000, 10_000, 180_000)).to.equal(
            false,
        );
    });

    it('rejects a final S9 relay-off check if power becomes high again', () => {
        const at = start + 160_000;
        expect(isPvShutdownSafe(sample(at, at, 900), at, 180_000, pausedAt)).to.equal(false);
    });

    it('rejects missing or future S9 power timestamps even when hashrate is zero', () => {
        const at = start + 160_000;
        expect(isPvShutdownSafe({ ...sample(at), powerTimestamp: undefined }, at, ageMs, pausedAt)).to.equal(false);
        expect(isPvShutdownSafe(sample(at, at + 1), at, ageMs, pausedAt)).to.equal(false);
    });
});
