import { expect } from 'chai';
import {
    isPvShutdownSafe,
    PvShutdownConfirmation,
    isPvRelayOffConfirmed,
    PvRelayOffPowerConfirmation,
    isPvMinerCommandAllowed,
    type PvShutdownMeasurements,
} from './PvShutdownSafety';

/** Pure simulations of the existing BOSMiner shutdown evidence sequence; no hardware writes. */
describe('PV shutdown sequence after sudden export loss (simulation only)', () => {
    const start = 1_800_000_000_000;
    const pausedAt = start - 1000;
    const ageMs = 180_000;
    const sample = (at: number, hashrate = 0, power = 75): PvShutdownMeasurements => ({
        hashrate,
        hashrateTimestamp: at,
        power,
        powerTimestamp: at,
        lastSeen: at,
    });

    const confirmStopped = (change?: (seconds: number) => PvShutdownMeasurements): boolean => {
        const confirmation = new PvShutdownConfirmation();
        let confirmed = false;
        for (let seconds = 0; seconds <= 30; seconds += 5) {
            const at = start + seconds * 1000;
            confirmed = confirmation.update(
                change ? change(seconds) : sample(at),
                at,
                ageMs,
                pausedAt,
                30_000,
                10_000,
                15_000,
            );
        }
        return confirmed;
    };

    it('confirms stable zero hashrate and low power before simulated relay OFF', () => {
        expect(confirmStopped()).to.equal(true);
        expect(isPvShutdownSafe(sample(start + 30_000), start + 30_000, 15_000, pausedAt)).to.equal(true);
    });

    it('blocks relay OFF if miner continues hashing', () => {
        expect(confirmStopped(seconds => sample(start + seconds * 1000, 1000))).to.equal(false);
    });

    it('blocks relay OFF if power remains high', () => {
        expect(confirmStopped(seconds => sample(start + seconds * 1000, 0, 900))).to.equal(false);
    });

    it('blocks relay OFF when power telemetry stops updating', () => {
        expect(
            confirmStopped(seconds => ({
                ...sample(start + seconds * 1000),
                powerTimestamp: start,
            })),
        ).to.equal(false);
    });

    it('blocks relay OFF when a final independent stop check fails', () => {
        expect(confirmStopped()).to.equal(true);
        expect(isPvShutdownSafe(sample(start + 31_000, 500), start + 31_000, 15_000, pausedAt)).to.equal(false);
    });

    it('requires fresh acknowledged relay OFF feedback newer than the request', () => {
        const requestedAt = start + 35_000;
        expect(
            isPvRelayOffConfirmed(false, requestedAt + 1000, true, true, requestedAt, requestedAt + 2000, ageMs),
        ).to.equal(true);
        expect(isPvRelayOffConfirmed(false, requestedAt, true, true, requestedAt, requestedAt + 2000, ageMs)).to.equal(
            false,
        );
        expect(
            isPvRelayOffConfirmed(false, requestedAt + 1000, false, true, requestedAt, requestedAt + 2000, ageMs),
        ).to.equal(false);
    });

    it('confirms relay power loss only after three distinct near-zero samples', () => {
        const requestedAt = start + 35_000;
        const check = new PvRelayOffPowerConfirmation(requestedAt);
        for (let i = 1; i <= 2; i++) {
            expect(check.update(0, requestedAt + i * 5000, true, requestedAt + i * 5000, ageMs)).to.equal(false);
        }
        expect(check.update(0, requestedAt + 15_000, true, requestedAt + 15_000, ageMs)).to.equal(true);
    });

    it('does not count stale repeated power samples as three confirmations', () => {
        const requestedAt = start + 35_000;
        const check = new PvRelayOffPowerConfirmation(requestedAt);
        expect(check.update(0, requestedAt + 5000, true, requestedAt + 5000, ageMs)).to.equal(false);
        expect(check.update(0, requestedAt + 5000, true, requestedAt + 10_000, ageMs)).to.equal(false);
        expect(check.update(0, requestedAt + 5000, true, requestedAt + 15_000, ageMs)).to.equal(false);
    });

    it('resets near-zero confirmation when relay feedback is lost', () => {
        const requestedAt = start + 35_000;
        const check = new PvRelayOffPowerConfirmation(requestedAt);
        expect(check.update(0, requestedAt + 5000, true, requestedAt + 5000, ageMs)).to.equal(false);
        expect(check.update(0, requestedAt + 10_000, false, requestedAt + 10_000, ageMs)).to.equal(false);
        expect(check.update(0, requestedAt + 15_000, true, requestedAt + 15_000, ageMs)).to.equal(false);
        expect(check.update(0, requestedAt + 20_000, true, requestedAt + 20_000, ageMs)).to.equal(false);
        expect(check.update(0, requestedAt + 25_000, true, requestedAt + 25_000, ageMs)).to.equal(true);
    });

    it('keeps both miner command locks active during simultaneous simulated PV loss', () => {
        const locks = new Set(['s9', 's19']);
        const stops = new Set(['s9', 's19']);
        for (const id of locks) {
            expect(isPvMinerCommandAllowed(id, stops, locks, false)).to.equal(false);
        }
        expect(locks.size).to.equal(2);
    });
});
