import { expect } from 'chai';
import { isPvShutdownSafe, PvShutdownConfirmation, type PvShutdownMeasurements } from './PvShutdownSafety';

describe('PV shutdown safety', () => {
    const now = 1_800_000_000_000;
    const maxAgeMs = 180_000;
    const pausedAt = now - 1000;

    const valid = (): PvShutdownMeasurements => ({
        hashrate: 0,
        hashrateTimestamp: now,
        power: 75,
        powerTimestamp: now,
        lastSeen: now,
    });

    it('accepts fresh zero hashrate and low power', () => {
        expect(isPvShutdownSafe(valid(), now, maxAgeMs, now - 1000)).to.equal(true);
    });

    it('rejects a miner that is still hashing', () => {
        expect(isPvShutdownSafe({ ...valid(), hashrate: 1000 }, now, maxAgeMs, pausedAt)).to.equal(false);
    });

    it('rejects power above 100 W', () => {
        expect(isPvShutdownSafe({ ...valid(), power: 150 }, now, maxAgeMs, pausedAt)).to.equal(false);
    });

    it('rejects stale hashrate', () => {
        expect(isPvShutdownSafe({
            ...valid(),
            hashrateTimestamp: now - maxAgeMs - 1,
        }, now, maxAgeMs, pausedAt)).to.equal(false);
    });

    it('rejects stale Sonoff power', () => {
        expect(isPvShutdownSafe({
            ...valid(),
            powerTimestamp: now - maxAgeMs - 1,
        }, now, maxAgeMs, pausedAt)).to.equal(false);
    });

    it('rejects stale miner communication', () => {
        expect(isPvShutdownSafe({
            ...valid(),
            lastSeen: now - maxAgeMs - 1,
        }, now, maxAgeMs, pausedAt)).to.equal(false);
    });

    it('rejects missing measurements', () => {
        expect(isPvShutdownSafe({
            ...valid(),
            hashrate: undefined,
        }, now, maxAgeMs, pausedAt)).to.equal(false);
    });

    it('rejects negative power', () => {
        expect(isPvShutdownSafe({
            ...valid(),
            power: -10,
        }, now, maxAgeMs, pausedAt)).to.equal(false);
    });

    it('rejects hashrate measured before pause completed', () => {
        const values = {
            ...valid(),
            hashrateTimestamp: pausedAt - 1000,
        };

        expect(isPvShutdownSafe(values, now, maxAgeMs, pausedAt)).to.equal(false);
    });

    it('rejects power measured before pause completed', () => {
        const values = {
            ...valid(),
            powerTimestamp: pausedAt - 1000,
        };

        expect(isPvShutdownSafe(values, now, maxAgeMs, pausedAt)).to.equal(false);
    });

});

describe('PV shutdown confirmation', () => {
    const now = 1_800_000_000_000;
    const pausedAt = now - 1000;
    const maxAgeMs = 180_000;

    const valid = (timestamp: number): PvShutdownMeasurements => ({
        hashrate: 0,
        hashrateTimestamp: timestamp,
        power: 75,
        powerTimestamp: timestamp,
        lastSeen: timestamp,
    });

    it('does not confirm immediately', () => {
        const check = new PvShutdownConfirmation();
        expect(check.update(valid(now), now, maxAgeMs, pausedAt)).to.equal(false);
    });

    it('does not confirm before 30 seconds', () => {
        const check = new PvShutdownConfirmation();
        check.update(valid(now), now, maxAgeMs, pausedAt);

        expect(check.update(valid(now + 20_000), now + 20_000, maxAgeMs, pausedAt)).to.equal(false);
    });

    it('confirms after 30 seconds with regular new measurements', () => {
        const check = new PvShutdownConfirmation();

        expect(check.update(valid(now), now, maxAgeMs, pausedAt)).to.equal(false);

        for (let seconds = 5; seconds <= 25; seconds += 5) {
            const timestamp = now + seconds * 1000;
            expect(check.update(valid(timestamp), timestamp, maxAgeMs, pausedAt)).to.equal(false);
        }

        const finalTimestamp = now + 30_000;
        expect(check.update(valid(finalTimestamp), finalTimestamp, maxAgeMs, pausedAt)).to.equal(true);
    });

    it('rejects unchanged measurements', () => {
        const check = new PvShutdownConfirmation();
        check.update(valid(now), now, maxAgeMs, pausedAt);

        expect(check.update(valid(now), now + 30_000, maxAgeMs, pausedAt)).to.equal(false);
    });

    it('resets confirmation when power rises', () => {
        const check = new PvShutdownConfirmation();
        check.update(valid(now), now, maxAgeMs, pausedAt);

        check.update(
            { ...valid(now + 10_000), power: 150 },
            now + 10_000,
            maxAgeMs,
            pausedAt,
        );

        expect(check.update(valid(now + 30_000), now + 30_000, maxAgeMs, pausedAt)).to.equal(false);
    });
});


describe('PV shutdown measurement gaps', () => {
    it('rejects a 30-second gap without intermediate measurements', () => {
        const check = new PvShutdownConfirmation();
        const now = 1_800_000_000_000;
        const pausedAt = now - 1000;
        const maxAgeMs = 180_000;

        const values = (timestamp: number): PvShutdownMeasurements => ({
            hashrate: 0,
            hashrateTimestamp: timestamp,
            power: 75,
            powerTimestamp: timestamp,
            lastSeen: timestamp,
        });

        expect(check.update(values(now), now, maxAgeMs, pausedAt)).to.equal(false);

        expect(
            check.update(values(now + 30_000), now + 30_000, maxAgeMs, pausedAt),
        ).to.equal(false);
    });
});

describe('PV shutdown unchanged measurements', () => {
    it('rejects repeated reads without new measurements', () => {
        const check = new PvShutdownConfirmation();
        const now = 1_800_000_000_000;
        const pausedAt = now - 1000;
        const maxAgeMs = 180_000;

        const values: PvShutdownMeasurements = {
            hashrate: 0,
            hashrateTimestamp: now,
            power: 75,
            powerTimestamp: now,
            lastSeen: now,
        };

        expect(check.update(values, now, maxAgeMs, pausedAt)).to.equal(false);

        for (let seconds = 5; seconds <= 30; seconds += 5) {
            expect(
                check.update(values, now + seconds * 1000, maxAgeMs, pausedAt),
            ).to.equal(false);
        }
    });
});

describe('PV shutdown independent measurements', () => {
    const now = 1_800_000_000_000;
    const pausedAt = now - 1000;
    const maxAgeMs = 180_000;

    const valid = (): PvShutdownMeasurements => ({
        hashrate: 0,
        hashrateTimestamp: now,
        power: 75,
        powerTimestamp: now,
        lastSeen: now,
    });

    it('rejects updates of hashrate only', () => {
        const check = new PvShutdownConfirmation();

        expect(check.update(valid(), now, maxAgeMs, pausedAt)).to.equal(false);

        for (let seconds = 5; seconds <= 30; seconds += 5) {
            const timestamp = now + seconds * 1000;

            expect(check.update({
                ...valid(),
                hashrateTimestamp: timestamp,
                lastSeen: timestamp,
            }, timestamp, maxAgeMs, pausedAt)).to.equal(false);
        }
    });

    it('rejects updates of Sonoff power only', () => {
        const check = new PvShutdownConfirmation();

        expect(check.update(valid(), now, maxAgeMs, pausedAt)).to.equal(false);

        for (let seconds = 5; seconds <= 30; seconds += 5) {
            const timestamp = now + seconds * 1000;

            expect(check.update({
                ...valid(),
                powerTimestamp: timestamp,
            }, timestamp, maxAgeMs, pausedAt)).to.equal(false);
        }
    });
});

describe('PV shutdown sensor update gaps', () => {
    it('rejects delayed Sonoff measurements even if the final reading is fresh', () => {
        const check = new PvShutdownConfirmation();
        const now = 1_800_000_000_000;
        const pausedAt = now - 1000;
        const maxAgeMs = 180_000;

        for (let seconds = 0; seconds <= 30; seconds += 5) {
            const timestamp = now + seconds * 1000;

            const values: PvShutdownMeasurements = {
                hashrate: 0,
                hashrateTimestamp: timestamp,
                power: 75,
                powerTimestamp: seconds === 30 ? timestamp : now,
                lastSeen: timestamp,
            };

            expect(
                check.update(values, timestamp, maxAgeMs, pausedAt),
            ).to.equal(false);
        }
    });
});

describe('PV shutdown future timestamps', () => {
    it('rejects measurements with future timestamps', () => {
        const now = 1_800_000_000_000;
        const pausedAt = now - 1000;

        const values: PvShutdownMeasurements = {
            hashrate: 0,
            hashrateTimestamp: now + 5000,
            power: 75,
            powerTimestamp: now + 5000,
            lastSeen: now,
        };

        expect(
            isPvShutdownSafe(values, now, 180_000, pausedAt),
        ).to.equal(false);
    });

    it('rejects future lastSeen timestamps', () => {
        const now = 1_800_000_000_000;
        const pausedAt = now - 1000;

        const values: PvShutdownMeasurements = {
            hashrate: 0,
            hashrateTimestamp: now,
            power: 75,
            powerTimestamp: now,
            lastSeen: now + 5000,
        };

        expect(
            isPvShutdownSafe(values, now, 180_000, pausedAt),
        ).to.equal(false);
    });
});

describe('PV shutdown slow polling', () => {
    it('does not confirm shutdown from only two samples 30 seconds apart', () => {
        const check = new PvShutdownConfirmation();
        const start = 1_800_000_000_000;
        const pausedAt = start - 1000;

        const sample = (timestamp: number): PvShutdownMeasurements => ({
            hashrate: 0,
            hashrateTimestamp: timestamp,
            power: 75,
            powerTimestamp: timestamp,
            lastSeen: timestamp,
        });

        expect(
            check.update(sample(start), start, 180_000, pausedAt),
        ).to.equal(false);

        expect(
            check.update(
                sample(start + 30_000),
                start + 30_000,
                180_000,
                pausedAt,
                30_000,
                35_000,
                35_000,
            ),
        ).to.equal(false);
    });
});

describe('PV shutdown irregular sensor updates', () => {
    it('rejects three samples with a long measurement gap', () => {
        const check = new PvShutdownConfirmation();
        const start = 1_800_000_000_000;
        const pausedAt = start - 1000;

        const sample = (timestamp: number): PvShutdownMeasurements => ({
            hashrate: 0,
            hashrateTimestamp: timestamp,
            power: 75,
            powerTimestamp: timestamp,
            lastSeen: timestamp,
        });

        for (let seconds = 0; seconds <= 30; seconds += 5) {
            const now = start + seconds * 1000;

            const measurementTime =
                seconds === 0 ? start :
                seconds < 30 ? start + 5000 :
                now;

            expect(
                check.update(
                    sample(measurementTime),
                    now,
                    180_000,
                    pausedAt,
                ),
            ).to.equal(false);
        }
    });
});

describe('PV shutdown independent sensor gaps', () => {
    it('rejects delayed power updates despite continuous hashrate updates', () => {
        const check = new PvShutdownConfirmation();
        const start = 1_800_000_000_000;
        const pausedAt = start - 1000;

        for (let seconds = 0; seconds <= 30; seconds += 5) {
            const now = start + seconds * 1000;

            const values: PvShutdownMeasurements = {
                hashrate: 0,
                hashrateTimestamp: now,
                power: 75,
                powerTimestamp:
                    seconds < 30 ? start : now,
                lastSeen: now,
            };

            expect(
                check.update(values, now, 180_000, pausedAt),
            ).to.equal(false);
        }
    });
});
