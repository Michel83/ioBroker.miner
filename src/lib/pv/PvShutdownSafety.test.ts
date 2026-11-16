import { expect } from 'chai';
import {
    executePvStartup,
    isPvRestartAllowed,
    isPvStartReady,
    isPvStopRestorationConsistent,
    parsePvPersistedStop,
    isPvShutdownSafe,
    PvShutdownConfirmation,
    type PvPersistedStop,
    type PvStopRestoration,
    type PvRestartMeasurements,
    type PvStartReadiness,
    type PvShutdownMeasurements,
} from './PvShutdownSafety';

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
        expect(
            isPvShutdownSafe(
                {
                    ...valid(),
                    hashrateTimestamp: now - maxAgeMs - 1,
                },
                now,
                maxAgeMs,
                pausedAt,
            ),
        ).to.equal(false);
    });

    it('rejects stale Sonoff power', () => {
        expect(
            isPvShutdownSafe(
                {
                    ...valid(),
                    powerTimestamp: now - maxAgeMs - 1,
                },
                now,
                maxAgeMs,
                pausedAt,
            ),
        ).to.equal(false);
    });

    it('rejects stale miner communication', () => {
        expect(
            isPvShutdownSafe(
                {
                    ...valid(),
                    lastSeen: now - maxAgeMs - 1,
                },
                now,
                maxAgeMs,
                pausedAt,
            ),
        ).to.equal(false);
    });

    it('rejects missing measurements', () => {
        expect(
            isPvShutdownSafe(
                {
                    ...valid(),
                    hashrate: undefined,
                },
                now,
                maxAgeMs,
                pausedAt,
            ),
        ).to.equal(false);
    });

    it('rejects negative power', () => {
        expect(
            isPvShutdownSafe(
                {
                    ...valid(),
                    power: -10,
                },
                now,
                maxAgeMs,
                pausedAt,
            ),
        ).to.equal(false);
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

        check.update({ ...valid(now + 10_000), power: 150 }, now + 10_000, maxAgeMs, pausedAt);

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

        expect(check.update(values(now + 30_000), now + 30_000, maxAgeMs, pausedAt)).to.equal(false);
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
            expect(check.update(values, now + seconds * 1000, maxAgeMs, pausedAt)).to.equal(false);
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

            expect(
                check.update(
                    {
                        ...valid(),
                        hashrateTimestamp: timestamp,
                        lastSeen: timestamp,
                    },
                    timestamp,
                    maxAgeMs,
                    pausedAt,
                ),
            ).to.equal(false);
        }
    });

    it('rejects updates of Sonoff power only', () => {
        const check = new PvShutdownConfirmation();

        expect(check.update(valid(), now, maxAgeMs, pausedAt)).to.equal(false);

        for (let seconds = 5; seconds <= 30; seconds += 5) {
            const timestamp = now + seconds * 1000;

            expect(
                check.update(
                    {
                        ...valid(),
                        powerTimestamp: timestamp,
                    },
                    timestamp,
                    maxAgeMs,
                    pausedAt,
                ),
            ).to.equal(false);
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

            expect(check.update(values, timestamp, maxAgeMs, pausedAt)).to.equal(false);
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

        expect(isPvShutdownSafe(values, now, 180_000, pausedAt)).to.equal(false);
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

        expect(isPvShutdownSafe(values, now, 180_000, pausedAt)).to.equal(false);
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

        expect(check.update(sample(start), start, 180_000, pausedAt)).to.equal(false);

        expect(
            check.update(sample(start + 30_000), start + 30_000, 180_000, pausedAt, 30_000, 35_000, 35_000),
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

            const measurementTime = seconds === 0 ? start : seconds < 30 ? start + 5000 : now;

            expect(check.update(sample(measurementTime), now, 180_000, pausedAt)).to.equal(false);
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
                powerTimestamp: seconds < 30 ? start : now,
                lastSeen: now,
            };

            expect(check.update(values, now, 180_000, pausedAt)).to.equal(false);
        }
    });
});

describe('PV automatic restart eligibility', () => {
    const now = 1_800_000_000_000;
    const valid = (): PvRestartMeasurements => ({
        enabled: true,
        relayConfirmedOff: true,
        gridPower: -2500,
        batteryPower: -200,
        gridTimestamp: now,
        batteryTimestamp: now,
        now,
        maxAgeMs: 15_000,
        reserveWatts: 200,
        minimumStartWatts: 1800,
        lastStoppedAt: now - 180_000,
        restartDelayMs: 180_000,
    });

    it('accepts confirmed relay-off with sufficient fresh export', () => {
        expect(isPvRestartAllowed(valid())).to.equal(true);
    });

    it('rejects disabled PV automation and unknown relay state', () => {
        expect(isPvRestartAllowed({ ...valid(), enabled: false })).to.equal(false);
        expect(isPvRestartAllowed({ ...valid(), relayConfirmedOff: false })).to.equal(false);
    });

    it('rejects stale or missing measurements', () => {
        expect(isPvRestartAllowed({ ...valid(), gridTimestamp: now - 20_000 })).to.equal(false);
        expect(isPvRestartAllowed({ ...valid(), batteryTimestamp: undefined })).to.equal(false);
        expect(isPvRestartAllowed({ ...valid(), gridPower: undefined })).to.equal(false);
    });

    it('rejects insufficient export or battery discharge', () => {
        expect(isPvRestartAllowed({ ...valid(), gridPower: -1900 })).to.equal(false);
        expect(isPvRestartAllowed({ ...valid(), batteryPower: 800 })).to.equal(false);
    });

    it('requires a known completed stop and elapsed restart delay', () => {
        expect(isPvRestartAllowed({ ...valid(), lastStoppedAt: undefined })).to.equal(false);
        expect(isPvRestartAllowed({ ...valid(), lastStoppedAt: now - 179_999 })).to.equal(false);
    });
});

describe('PV miner startup readiness', () => {
    const now = 1_800_000_000_000;
    const valid = (): PvStartReadiness => ({
        relayOn: true,
        relayTimestamp: now,
        relayEnabledAt: now - 120_000,
        minerReachable: true,
        minerSeenAt: now,
        now,
        maxAgeMs: 15_000,
        startupDelayMs: 120_000,
    });

    it('permits start after confirmed power-on, boot delay and fresh miner contact', () => {
        expect(isPvStartReady(valid())).to.equal(true);
    });

    it('blocks start while relay is off or its feedback is stale', () => {
        expect(isPvStartReady({ ...valid(), relayOn: false })).to.equal(false);
        expect(isPvStartReady({ ...valid(), relayTimestamp: now - 20_000 })).to.equal(false);
    });

    it('blocks start until boot delay completes', () => {
        expect(isPvStartReady({ ...valid(), relayEnabledAt: now - 119_999 })).to.equal(false);
    });

    it('blocks start when miner is unreachable or its last contact is stale', () => {
        expect(isPvStartReady({ ...valid(), minerReachable: false })).to.equal(false);
        expect(isPvStartReady({ ...valid(), minerSeenAt: now - 20_000 })).to.equal(false);
    });

    it('requires miner contact after relay was enabled', () => {
        expect(isPvStartReady({ ...valid(), minerSeenAt: now - 120_001 })).to.equal(false);
        expect(isPvStartReady({ ...valid(), relayEnabledAt: undefined })).to.equal(false);
    });
});

describe('PV startup command ordering', () => {
    const now = 1_800_000_000_000;
    const ready = (): PvStartReadiness => ({
        relayOn: true,
        relayTimestamp: now,
        relayEnabledAt: now - 120_000,
        minerReachable: true,
        minerSeenAt: now,
        now,
        maxAgeMs: 15_000,
        startupDelayMs: 120_000,
    });

    it('powers on before checking readiness and starting mining', async () => {
        const calls: string[] = [];
        await executePvStartup({
            mayPowerOn: () => {
                calls.push('pv-before-relay');
                return Promise.resolve(true);
            },
            powerOnRelay: () => {
                calls.push('relay-on');
                return Promise.resolve();
            },
            awaitReadiness: () => {
                calls.push('readiness');
                return Promise.resolve(ready());
            },
            mayStartMining: () => {
                calls.push('pv-before-start');
                return Promise.resolve(true);
            },
            startMining: () => {
                calls.push('miner-start');
                return Promise.resolve();
            },
        });
        expect(calls).to.deep.equal(['pv-before-relay', 'relay-on', 'readiness', 'pv-before-start', 'miner-start']);
    });

    it('does not power on without PV eligibility', async () => {
        const calls: string[] = [];
        try {
            await executePvStartup({
                mayPowerOn: () => Promise.resolve(false),
                powerOnRelay: () => {
                    calls.push('relay-on');
                    return Promise.resolve();
                },
                awaitReadiness: () => Promise.resolve(ready()),
                mayStartMining: () => Promise.resolve(true),
                startMining: () => {
                    calls.push('miner-start');
                    return Promise.resolve();
                },
            });
            expect.fail('startup must be blocked');
        } catch (error) {
            expect(String(error)).to.contain('PV startup blocked');
        }
        expect(calls).to.deep.equal([]);
    });

    it('never starts mining or powers off if readiness fails', async () => {
        const calls: string[] = [];
        try {
            await executePvStartup({
                mayPowerOn: () => Promise.resolve(true),
                powerOnRelay: () => {
                    calls.push('relay-on');
                    return Promise.resolve();
                },
                awaitReadiness: () => Promise.resolve({ ...ready(), minerReachable: false }),
                mayStartMining: () => Promise.resolve(true),
                startMining: () => {
                    calls.push('miner-start');
                    return Promise.resolve();
                },
            });
            expect.fail('startup must be blocked');
        } catch (error) {
            expect(String(error)).to.contain('not confirmed ready');
        }
        expect(calls).to.deep.equal(['relay-on']);
    });

    it('does not start if PV eligibility disappears during boot', async () => {
        const calls: string[] = [];
        try {
            await executePvStartup({
                mayPowerOn: () => Promise.resolve(true),
                powerOnRelay: () => {
                    calls.push('relay-on');
                    return Promise.resolve();
                },
                awaitReadiness: () => Promise.resolve(ready()),
                mayStartMining: () => Promise.resolve(false),
                startMining: () => {
                    calls.push('miner-start');
                    return Promise.resolve();
                },
            });
            expect.fail('startup must be blocked');
        } catch (error) {
            expect(String(error)).to.contain('conditions changed');
        }
        expect(calls).to.deep.equal(['relay-on']);
    });
});

describe('PV persisted stop record validation', () => {
    const now = 1_800_000_000_000;
    const valid = (): PvPersistedStop => ({
        minerId: 's19',
        relayStateId: 'sonoff.0.relay.POWER',
        stoppedAt: now - 180_000,
        relayOffConfirmed: true,
    });

    it('accepts a matching confirmed record', () => {
        expect(parsePvPersistedStop(valid(), 's19', 'sonoff.0.relay.POWER', now)).to.deep.equal(valid());
    });

    it('rejects missing and unconfirmed records', () => {
        expect(parsePvPersistedStop(undefined, 's19', 'sonoff.0.relay.POWER', now)).to.equal(undefined);
        expect(
            parsePvPersistedStop({ ...valid(), relayOffConfirmed: false }, 's19', 'sonoff.0.relay.POWER', now),
        ).to.equal(undefined);
    });

    it('rejects records belonging to another miner or relay', () => {
        expect(parsePvPersistedStop(valid(), 's9', 'sonoff.0.relay.POWER', now)).to.equal(undefined);
        expect(parsePvPersistedStop(valid(), 's19', 'sonoff.0.other.POWER', now)).to.equal(undefined);
    });

    it('rejects future, missing and invalid timestamps', () => {
        expect(parsePvPersistedStop({ ...valid(), stoppedAt: now + 1 }, 's19', 'sonoff.0.relay.POWER', now)).to.equal(
            undefined,
        );
        expect(parsePvPersistedStop({ ...valid(), stoppedAt: null }, 's19', 'sonoff.0.relay.POWER', now)).to.equal(
            undefined,
        );
        expect(
            parsePvPersistedStop({ ...valid(), stoppedAt: Number.NaN }, 's19', 'sonoff.0.relay.POWER', now),
        ).to.equal(undefined);
    });
});

describe('PV stop restoration diagnostics', () => {
    const now = 1_800_000_000_000;
    const valid = (): PvStopRestoration => ({
        storedRecord: {
            minerId: 's19',
            relayStateId: 'relay.s19',
            stoppedAt: now - 180_000,
            relayOffConfirmed: true,
        },
        minerId: 's19',
        relayStateId: 'relay.s19',
        relayOnValue: true,
        relayValue: false,
        relayTimestamp: now,
        power: 0,
        powerTimestamp: now,
        now,
        maxAgeMs: 15_000,
    });

    it('recognizes matching stored stop and fresh OFF diagnostics', () => {
        expect(isPvStopRestorationConsistent(valid())).to.equal(true);
    });

    it('rejects missing history and mismatched miner identity', () => {
        expect(isPvStopRestorationConsistent({ ...valid(), storedRecord: undefined })).to.equal(false);
        expect(isPvStopRestorationConsistent({ ...valid(), minerId: 's9' })).to.equal(false);
    });

    it('rejects relay ON and stale relay readings', () => {
        expect(isPvStopRestorationConsistent({ ...valid(), relayValue: true })).to.equal(false);
        expect(isPvStopRestorationConsistent({ ...valid(), relayTimestamp: now - 20_000 })).to.equal(false);
    });

    it('rejects missing, stale and nonzero power', () => {
        expect(isPvStopRestorationConsistent({ ...valid(), power: undefined })).to.equal(false);
        expect(isPvStopRestorationConsistent({ ...valid(), powerTimestamp: now - 20_000 })).to.equal(false);
        expect(isPvStopRestorationConsistent({ ...valid(), power: 100 })).to.equal(false);
    });
});
