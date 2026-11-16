import { expect } from 'chai';
import {
    executePvStartup,
    isPvRestartAllowed,
    isPvPrePowerOnEvidenceCurrent,
    isPvRestartUnlockCandidate,
    isPvStartReady,
    isPvStopRestorationConsistent,
    parsePvPersistedStop,
    isPvShutdownSafe,
    isPvRelayOffConfirmed,
    isPvMinerCommandAllowed,
    PvShutdownConfirmation,
    PvRelayOffPowerConfirmation,
    type PvRestartUnlockCandidate,
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

describe('PV restart release remains diagnostic only', () => {
    const now = 1_800_000_000_000;
    const base = (): PvRestartMeasurements => ({
        enabled: true,
        relayConfirmedOff: true,
        gridPower: -2500,
        batteryPower: 0,
        gridTimestamp: now,
        batteryTimestamp: now,
        now,
        maxAgeMs: 15_000,
        reserveWatts: 200,
        minimumStartWatts: 1800,
        lastStoppedAt: now - 180_000,
        restartDelayMs: 180_000,
    });

    it('keeps the command lock even when restart measurements are eligible', () => {
        const locked = new Set(['s9', 's19']);
        expect(isPvRestartAllowed(base())).to.equal(true);
        for (const id of locked) {
            expect(isPvMinerCommandAllowed(id, new Set<string>(), locked, false)).to.equal(false);
        }
    });

    it('rejects export that cannot cover battery discharge and reserve', () => {
        expect(isPvRestartAllowed({ ...base(), batteryPower: 600 })).to.equal(false);
        expect(isPvRestartAllowed({ ...base(), batteryPower: 500 })).to.equal(true);
    });

    it('rejects future, missing and invalid restart evidence', () => {
        expect(isPvRestartAllowed({ ...base(), gridTimestamp: now + 1 })).to.equal(false);
        expect(isPvRestartAllowed({ ...base(), batteryTimestamp: undefined })).to.equal(false);
        expect(isPvRestartAllowed({ ...base(), gridPower: Number.NaN })).to.equal(false);
        expect(isPvRestartAllowed({ ...base(), lastStoppedAt: undefined })).to.equal(false);
        expect(isPvRestartAllowed({ ...base(), lastStoppedAt: now + 1 })).to.equal(false);
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

describe('PV startup lock remains fail-closed', () => {
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

    it('keeps both miner locks after a successful simulated startup sequence', async () => {
        const locks = new Set(['s9', 's19']);
        const calls: string[] = [];
        await executePvStartup({
            mayPowerOn: () => Promise.resolve(true),
            powerOnRelay: () => {
                calls.push('relay-on');
                return Promise.resolve();
            },
            awaitReadiness: () => Promise.resolve(ready()),
            mayStartMining: () => Promise.resolve(true),
            startMining: () => {
                calls.push('simulated-start');
                return Promise.resolve();
            },
        });
        expect(calls).to.deep.equal(['relay-on', 'simulated-start']);
        for (const id of locks) {
            expect(isPvMinerCommandAllowed(id, new Set<string>(), locks, false)).to.equal(false);
        }
    });

    it('does not start with stale relay feedback and retains the restart lock', async () => {
        const locks = new Set(['s19']);
        const calls: string[] = [];
        let rejected = false;
        try {
            await executePvStartup({
                mayPowerOn: () => Promise.resolve(true),
                powerOnRelay: () => {
                    calls.push('relay-on');
                    return Promise.resolve();
                },
                awaitReadiness: () => Promise.resolve({ ...ready(), relayTimestamp: now - 20_000 }),
                mayStartMining: () => Promise.resolve(true),
                startMining: () => {
                    calls.push('simulated-start');
                    return Promise.resolve();
                },
            });
        } catch {
            rejected = true;
        }
        expect(rejected).to.equal(true);
        expect(calls).to.deep.equal(['relay-on']);
        expect(isPvMinerCommandAllowed('s19', new Set<string>(), locks, false)).to.equal(false);
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

describe('PV final relay-off safety regression', () => {
    const pausedAt = 1_800_000_000_000;
    const start = pausedAt + 1000;
    const maxAgeMs = 15_000;
    const reading = (timestamp: number): PvShutdownMeasurements => ({
        hashrate: 0,
        hashrateTimestamp: timestamp,
        power: 75,
        powerTimestamp: timestamp,
        lastSeen: timestamp,
    });

    it('rejects resumed hashing immediately before relay-off', () => {
        const finalReading = { ...reading(start + 30_000), hashrate: 1 };
        expect(isPvShutdownSafe(finalReading, start + 30_000, maxAgeMs, pausedAt)).to.equal(false);
    });

    it('rejects missing or stale power immediately before relay-off', () => {
        const now = start + 30_000;
        expect(isPvShutdownSafe({ ...reading(now), power: undefined }, now, maxAgeMs, pausedAt)).to.equal(false);
        expect(
            isPvShutdownSafe({ ...reading(now), powerTimestamp: now - maxAgeMs - 1 }, now, maxAgeMs, pausedAt),
        ).to.equal(false);
    });

    it('resets 30-second confirmation after a missing hashrate sample', () => {
        const confirmation = new PvShutdownConfirmation();
        expect(confirmation.update(reading(start), start, maxAgeMs, pausedAt)).to.equal(false);
        for (let seconds = 5; seconds <= 15; seconds += 5) {
            const time = start + seconds * 1000;
            expect(confirmation.update(reading(time), time, maxAgeMs, pausedAt)).to.equal(false);
        }
        const interruptedAt = start + 20_000;
        expect(
            confirmation.update({ ...reading(interruptedAt), hashrate: undefined }, interruptedAt, maxAgeMs, pausedAt),
        ).to.equal(false);
        for (let seconds = 25; seconds <= 45; seconds += 5) {
            const time = start + seconds * 1000;
            expect(confirmation.update(reading(time), time, maxAgeMs, pausedAt)).to.equal(false);
        }
        expect(confirmation.update(reading(start + 55_000), start + 55_000, maxAgeMs, pausedAt)).to.equal(true);
    });

    it('does not confirm when hashrate resumes during stability window', () => {
        const confirmation = new PvShutdownConfirmation();
        confirmation.update(reading(start), start, maxAgeMs, pausedAt);
        const interruptedAt = start + 10_000;
        expect(
            confirmation.update({ ...reading(interruptedAt), hashrate: 50 }, interruptedAt, maxAgeMs, pausedAt),
        ).to.equal(false);
        expect(confirmation.update(reading(start + 15_000), start + 15_000, maxAgeMs, pausedAt)).to.equal(false);
        expect(confirmation.update(reading(start + 30_000), start + 30_000, maxAgeMs, pausedAt)).to.equal(false);
    });
});

describe('PV relay OFF acknowledgement', () => {
    const requestedAt = 1_800_000_000_000;
    const now = requestedAt + 5000;
    const confirmed = (value: unknown, timestamp: number | undefined, ack: boolean | undefined): boolean =>
        isPvRelayOffConfirmed(value, timestamp, ack, true, requestedAt, now, 15_000);

    it('accepts a fresh acknowledged OFF state after the request', () => {
        expect(confirmed(false, requestedAt + 1000, true)).to.equal(true);
    });

    it('rejects ON, unacknowledged and missing relay feedback', () => {
        expect(confirmed(true, requestedAt + 1000, true)).to.equal(false);
        expect(confirmed(false, requestedAt + 1000, false)).to.equal(false);
        expect(confirmed(undefined, requestedAt + 1000, true)).to.equal(false);
    });

    it('rejects feedback predating the OFF request', () => {
        expect(confirmed(false, requestedAt, true)).to.equal(false);
        expect(confirmed(false, requestedAt - 1000, true)).to.equal(false);
    });

    it('rejects future and stale feedback', () => {
        expect(confirmed(false, now + 1, true)).to.equal(false);
        expect(
            isPvRelayOffConfirmed(false, requestedAt + 1000, true, true, requestedAt, now + 20_000, 15_000),
        ).to.equal(false);
    });
});

describe('PV shutdown with slow independent power telemetry', () => {
    const base = 1_800_000_000_000;
    const pausedAt = base - 1_000;
    const maxAgeMs = 180_000;

    function simulate(intervalSeconds: number, gapSeconds: number, powerReadings: number[]): boolean[] {
        const confirmation = new PvShutdownConfirmation();
        const results: boolean[] = [];
        const intervalMs = intervalSeconds * 1000;
        // Three distinct samples are necessary, but never sufficient before 30s of stability.
        const end = Math.max(30_000, (powerReadings.length - 1) * intervalMs);
        for (let elapsed = 0; elapsed <= end; elapsed += 5_000) {
            const readingIndex = Math.min(powerReadings.length - 1, Math.floor(elapsed / intervalMs));
            const powerTimestamp = base + readingIndex * intervalMs;
            const timestamp = base + elapsed;
            const measurements: PvShutdownMeasurements = {
                hashrate: 0,
                hashrateTimestamp: timestamp,
                power: powerReadings[readingIndex],
                powerTimestamp,
                lastSeen: timestamp,
            };
            results.push(
                confirmation.update(measurements, timestamp, maxAgeMs, pausedAt, 30_000, 10_000, gapSeconds * 1000),
            );
        }
        return results;
    }

    for (const intervalSeconds of [10, 30, 150]) {
        it(`requires three distinct post-pause power readings at ${intervalSeconds}s telemetry intervals`, () => {
            const results = simulate(intervalSeconds, intervalSeconds + 5, [75, 75, 75]);
            expect(results.slice(0, -1).every(result => result === false)).to.equal(true);
            expect(results[results.length - 1]).to.equal(true);
        });

        it(`does not confirm with only two power readings at ${intervalSeconds}s intervals`, () => {
            expect(simulate(intervalSeconds, intervalSeconds + 5, [75, 75]).every(result => !result)).to.equal(true);
        });

        it(`rejects a power spike at ${intervalSeconds}s intervals`, () => {
            expect(simulate(intervalSeconds, intervalSeconds + 5, [75, 150, 75]).every(result => !result)).to.equal(
                true,
            );
        });
    }

    it('rejects telemetry that becomes older than the configured gap', () => {
        const confirmation = new PvShutdownConfirmation();
        const initial: PvShutdownMeasurements = {
            hashrate: 0,
            hashrateTimestamp: base,
            power: 75,
            powerTimestamp: base,
            lastSeen: base,
        };
        expect(confirmation.update(initial, base, maxAgeMs, pausedAt, 30_000, 10_000, 35_000)).to.equal(false);
        for (let elapsed = 5_000; elapsed <= 40_000; elapsed += 5_000) {
            const current = base + elapsed;
            expect(
                confirmation.update(
                    { ...initial, hashrateTimestamp: current, lastSeen: current },
                    current,
                    maxAgeMs,
                    pausedAt,
                    30_000,
                    10_000,
                    35_000,
                ),
            ).to.equal(false);
        }
    });

    it('rejects measurements recorded before the pause command', () => {
        const confirmation = new PvShutdownConfirmation();
        const beforePause: PvShutdownMeasurements = {
            hashrate: 0,
            hashrateTimestamp: base,
            power: 0,
            powerTimestamp: pausedAt - 1,
            lastSeen: base,
        };
        expect(confirmation.update(beforePause, base, maxAgeMs, pausedAt, 30_000, 10_000, 150_000)).to.equal(false);
    });
});

describe('PV relay OFF: three independent post-command power readings', () => {
    const requestedAt = 1_800_000_000_000;
    const maxAgeMs = 180_000;

    for (const intervalSeconds of [10, 30, 150]) {
        it(`confirms only after three distinct zero-power readings (${intervalSeconds}s interval)`, () => {
            const check = new PvRelayOffPowerConfirmation(requestedAt);
            for (let i = 1; i <= 3; i++) {
                const timestamp = requestedAt + i * intervalSeconds * 1000;
                expect(check.update(0, timestamp, true, timestamp, maxAgeMs)).to.equal(i === 3);
            }
        });
    }

    it('does not count repeated or pre-command timestamps', () => {
        const check = new PvRelayOffPowerConfirmation(requestedAt);
        expect(check.update(0, requestedAt, true, requestedAt + 5000, maxAgeMs)).to.equal(false);
        expect(check.update(0, requestedAt + 5000, true, requestedAt + 5000, maxAgeMs)).to.equal(false);
        expect(check.update(0, requestedAt + 5000, true, requestedAt + 10_000, maxAgeMs)).to.equal(false);
        expect(check.update(0, requestedAt + 10_000, true, requestedAt + 10_000, maxAgeMs)).to.equal(false);
        expect(check.update(0, requestedAt + 15_000, true, requestedAt + 15_000, maxAgeMs)).to.equal(true);
    });

    it('requires relay OFF confirmation and resets the count when feedback disappears', () => {
        const check = new PvRelayOffPowerConfirmation(requestedAt);
        expect(check.update(0, requestedAt + 1000, true, requestedAt + 1000, maxAgeMs)).to.equal(false);
        expect(check.update(0, requestedAt + 2000, false, requestedAt + 2000, maxAgeMs)).to.equal(false);
        expect(check.update(0, requestedAt + 3000, true, requestedAt + 3000, maxAgeMs)).to.equal(false);
        expect(check.update(0, requestedAt + 4000, true, requestedAt + 4000, maxAgeMs)).to.equal(false);
        expect(check.update(0, requestedAt + 5000, true, requestedAt + 5000, maxAgeMs)).to.equal(true);
    });

    it('rejects stale, future, missing, negative and invalid measurements', () => {
        const check = new PvRelayOffPowerConfirmation(requestedAt);
        expect(check.update(undefined, undefined, true, requestedAt + 1000, maxAgeMs)).to.equal(false);
        expect(check.update(0, requestedAt + 1000, true, requestedAt + maxAgeMs + 1002, maxAgeMs)).to.equal(false);
        expect(check.update(0, requestedAt + 10_000, true, requestedAt + 9000, maxAgeMs)).to.equal(false);
        expect(check.update(Number.NaN, requestedAt + 10_000, true, requestedAt + 10_000, maxAgeMs)).to.equal(false);
        expect(check.update(-1, requestedAt + 10_000, true, requestedAt + 10_000, maxAgeMs)).to.equal(false);
        expect(check.update(6, requestedAt + 20_000, true, requestedAt + 20_000, maxAgeMs)).to.equal(false);
        expect(check.update(5, requestedAt + 30_000, true, requestedAt + 30_000, maxAgeMs)).to.equal(false);
        expect(check.update(0, requestedAt + 40_000, true, requestedAt + 40_000, maxAgeMs)).to.equal(false);
        expect(check.update(0, requestedAt + 50_000, true, requestedAt + 50_000, maxAgeMs)).to.equal(true);
    });

    it('does not accept an unacknowledged or stale relay OFF state', () => {
        const check = new PvRelayOffPowerConfirmation(requestedAt);
        for (let i = 1; i <= 3; i++) {
            const timestamp = requestedAt + i * 10_000;
            const relayOff = isPvRelayOffConfirmed(false, timestamp, false, true, requestedAt, timestamp, maxAgeMs);
            expect(check.update(0, timestamp, relayOff, timestamp, maxAgeMs)).to.equal(false);
        }
    });
});

describe('PV relay OFF missing telemetry and restart lock diagnostics', () => {
    const requestedAt = 1_800_000_000_000;
    const maxAgeMs = 180_000;

    it('never confirms a relay shutdown when no new power measurements arrive', () => {
        const confirmation = new PvRelayOffPowerConfirmation(requestedAt);
        for (let elapsed = 5000; elapsed <= 600_000; elapsed += 5000) {
            expect(confirmation.update(0, requestedAt, true, requestedAt + elapsed, maxAgeMs)).to.equal(false);
        }
    });

    it('does not turn one old near-zero reading into three confirmations', () => {
        const confirmation = new PvRelayOffPowerConfirmation(requestedAt);
        const powerTimestamp = requestedAt + 10_000;
        for (let elapsed = 10_000; elapsed <= 600_000; elapsed += 5000) {
            expect(confirmation.update(0, powerTimestamp, true, requestedAt + elapsed, maxAgeMs)).to.equal(false);
        }
    });

    it('does not confirm if relay feedback disappears after two near-zero readings', () => {
        const confirmation = new PvRelayOffPowerConfirmation(requestedAt);
        expect(confirmation.update(0, requestedAt + 10_000, true, requestedAt + 10_000, maxAgeMs)).to.equal(false);
        expect(confirmation.update(0, requestedAt + 20_000, true, requestedAt + 20_000, maxAgeMs)).to.equal(false);
        expect(confirmation.update(undefined, undefined, false, requestedAt + 30_000, maxAgeMs)).to.equal(false);
        expect(confirmation.update(0, requestedAt + 40_000, true, requestedAt + 40_000, maxAgeMs)).to.equal(false);
    });

    it('does not trust a missing safe-stop record after adapter restart', () => {
        expect(
            isPvStopRestorationConsistent({
                storedRecord: undefined,
                minerId: 'miner-1',
                relayStateId: 'relay.command',
                relayOnValue: true,
                relayValue: false,
                relayTimestamp: requestedAt + 1000,
                power: 0,
                powerTimestamp: requestedAt + 1000,
                now: requestedAt + 2000,
                maxAgeMs,
            }),
        ).to.equal(false);
    });

    it('does not trust a stored safe-stop record if power feedback is missing', () => {
        expect(
            isPvStopRestorationConsistent({
                storedRecord: {
                    minerId: 'miner-1',
                    relayStateId: 'relay.command',
                    stoppedAt: requestedAt,
                    relayOffConfirmed: true,
                },
                minerId: 'miner-1',
                relayStateId: 'relay.command',
                relayOnValue: true,
                relayValue: false,
                relayTimestamp: requestedAt + 1000,
                power: undefined,
                powerTimestamp: undefined,
                now: requestedAt + 2000,
                maxAgeMs,
            }),
        ).to.equal(false);
    });
});

describe('PV command lock after simulated adapter restart', () => {
    const minerId = 'pv-miner-1';

    it('blocks commands immediately after restoring a PV-configured miner', () => {
        // Each simulated adapter instance starts with empty in-memory sets.
        const safeStops = new Set<string>();
        const restartLocked = new Set<string>();
        restartLocked.add(minerId);
        expect(isPvMinerCommandAllowed(minerId, safeStops, restartLocked, false)).to.equal(false);
    });

    it('does not unlock commands when persisted shutdown diagnostics are valid', () => {
        const restartLocked = new Set([minerId]);
        const record = {
            minerId,
            relayStateId: 'relay.command',
            stoppedAt: 1_800_000_000_000,
            relayOffConfirmed: true,
        };
        expect(
            isPvStopRestorationConsistent({
                storedRecord: record,
                minerId,
                relayStateId: 'relay.command',
                relayOnValue: true,
                relayValue: false,
                relayTimestamp: record.stoppedAt + 1000,
                power: 0,
                powerTimestamp: record.stoppedAt + 1000,
                now: record.stoppedAt + 2000,
                maxAgeMs: 180_000,
            }),
        ).to.equal(true);
        expect(isPvMinerCommandAllowed(minerId, new Set<string>(), restartLocked, false)).to.equal(false);
    });

    it('keeps the miner locked when relay or power diagnostics are missing', () => {
        const restartLocked = new Set([minerId]);
        expect(isPvMinerCommandAllowed(minerId, new Set<string>(), restartLocked, false)).to.equal(false);
    });

    it('blocks commands during safe stop and adapter shutdown', () => {
        expect(isPvMinerCommandAllowed(minerId, new Set([minerId]), new Set<string>(), false)).to.equal(false);
        expect(isPvMinerCommandAllowed(minerId, new Set<string>(), new Set<string>(), true)).to.equal(false);
    });

    it('does not allow an empty miner identifier', () => {
        expect(isPvMinerCommandAllowed('', new Set<string>(), new Set<string>(), false)).to.equal(false);
    });

    it('simulates a new adapter instance restoring the lock after an unconfirmed relay OFF', () => {
        const firstInstanceLock = new Set([minerId]);
        expect(isPvMinerCommandAllowed(minerId, new Set<string>(), firstInstanceLock, false)).to.equal(false);
        const restartedInstanceLock = new Set<string>();
        restartedInstanceLock.add(minerId);
        expect(isPvMinerCommandAllowed(minerId, new Set<string>(), restartedInstanceLock, false)).to.equal(false);
    });
});

describe('PV command policy for custom features and state controls', () => {
    const minerId = 'pv-miner-1';

    it('rejects all guarded command types while the restart lock is active', () => {
        const safeStops = new Set<string>();
        const restartLocked = new Set([minerId]);
        for (const command of ['start', 'profile', 'powerTarget', 'customFeature']) {
            expect(isPvMinerCommandAllowed(minerId, safeStops, restartLocked, false), command).to.equal(false);
        }
    });

    it('rejects guarded commands during a safe stop even without a restart lock', () => {
        expect(isPvMinerCommandAllowed(minerId, new Set([minerId]), new Set<string>(), false)).to.equal(false);
    });

    it('permits commands only when no safety lock is active', () => {
        expect(isPvMinerCommandAllowed(minerId, new Set<string>(), new Set<string>(), false)).to.equal(true);
    });
});

describe('PV restart unlock candidate remains read-only', () => {
    const now = 1_800_000_000_000;
    const relayPoweredOnAt = now - 120_000;
    const lockedMiners = new Set(['s9', 's19']);
    const candidate = (minerId: string): PvRestartUnlockCandidate => ({
        minerId,
        lockedMiners,
        activeSafeStops: new Set<string>(),
        adapterShuttingDown: false,
        relayPoweredOnAt,
        adapterSessionId: 'session-current',
        prePowerOnEvidence: { minerId, adapterSessionId: 'session-current', approvedAt: relayPoweredOnAt - 1000, expiresAt: now + 5000 },
        restart: {
            enabled: true,
            relayConfirmedOff: false,
            gridPower: -2500,
            batteryPower: 0,
            gridTimestamp: now,
            batteryTimestamp: now,
            now,
            maxAgeMs: 15_000,
            reserveWatts: 200,
            minimumStartWatts: 1800,
            lastStoppedAt: now - 300_000,
            restartDelayMs: 180_000,
        },
        readiness: {
            relayOn: true,
            relayTimestamp: now,
            relayEnabledAt: relayPoweredOnAt,
            minerReachable: true,
            minerSeenAt: now,
            now,
            maxAgeMs: 15_000,
            startupDelayMs: 120_000,
        },
    });

    it('recognizes eligible S9 and S19 independently without unlocking either miner', () => {
        expect(isPvRestartUnlockCandidate(candidate('s9'))).to.equal(true);
        expect(isPvRestartUnlockCandidate(candidate('s19'))).to.equal(true);
        expect(lockedMiners.has('s9')).to.equal(true);
        expect(lockedMiners.has('s19')).to.equal(true);
    });

    it('rejects missing pre-power-on approval without changing locks', () => {
        const values = candidate('s9');
        expect(isPvRestartUnlockCandidate({ ...values, prePowerOnEvidence: undefined })).to.equal(false);
        expect(lockedMiners.has('s9')).to.equal(true);
    });

    it('uses relay ON feedback rather than requiring contradictory live relay OFF', () => {
        const values = candidate('s19');
        expect(values.restart.relayConfirmedOff).to.equal(false);
        expect(isPvRestartUnlockCandidate(values)).to.equal(true);
    });

    it('rejects measurements that predate relay power-on', () => {
        const values = candidate('s9');
        expect(isPvRestartUnlockCandidate({
            ...values,
            restart: { ...values.restart, gridTimestamp: relayPoweredOnAt },
        })).to.equal(false);
        expect(isPvRestartUnlockCandidate({
            ...values,
            restart: { ...values.restart, batteryTimestamp: relayPoweredOnAt },
        })).to.equal(false);
    });

    it('rejects a mismatched relay-on event or stale relay feedback', () => {
        const values = candidate('s19');
        expect(isPvRestartUnlockCandidate({
            ...values,
            readiness: { ...values.readiness, relayEnabledAt: relayPoweredOnAt - 1 },
        })).to.equal(false);
        expect(isPvRestartUnlockCandidate({
            ...values,
            readiness: { ...values.readiness, relayTimestamp: now - 20_000 },
        })).to.equal(false);
    });

    it('rejects shutdown, active safe stop, absent lock and lost PV export', () => {
        const values = candidate('s9');
        expect(isPvRestartUnlockCandidate({ ...values, adapterShuttingDown: true })).to.equal(false);
        expect(isPvRestartUnlockCandidate({ ...values, activeSafeStops: new Set(['s9']) })).to.equal(false);
        expect(isPvRestartUnlockCandidate({ ...values, lockedMiners: new Set(['s19']) })).to.equal(false);
        expect(isPvRestartUnlockCandidate({
            ...values,
            restart: { ...values.restart, gridPower: -100 },
        })).to.equal(false);
    });
});

describe('PV unlock transaction simulation (test-only, no adapter wiring)', () => {
    const now = 1_800_000_000_000;
    const poweredOnAt = now - 120_000;
    const locks = new Set(['s9', 's19']);
    const evidence = (minerId: string): PvRestartUnlockCandidate => ({
        minerId,
        lockedMiners: locks,
        activeSafeStops: new Set<string>(),
        adapterShuttingDown: false,
        relayPoweredOnAt: poweredOnAt,
        adapterSessionId: 'session-current',
        prePowerOnEvidence: { minerId, adapterSessionId: 'session-current', approvedAt: poweredOnAt - 1000, expiresAt: now + 5000 },
        restart: {
            enabled: true,
            relayConfirmedOff: false,
            gridPower: -2500,
            batteryPower: 0,
            gridTimestamp: now,
            batteryTimestamp: now,
            now,
            maxAgeMs: 15_000,
            reserveWatts: 200,
            minimumStartWatts: 1800,
            lastStoppedAt: now - 300_000,
            restartDelayMs: 180_000,
        },
        readiness: {
            relayOn: true,
            relayTimestamp: now,
            relayEnabledAt: poweredOnAt,
            minerReachable: true,
            minerSeenAt: now,
            now,
            maxAgeMs: 15_000,
            startupDelayMs: 120_000,
        },
    });

    // Test-local simulation only. Production lock sets are never passed here.
    const simulateAtomicUnlock = (values: PvRestartUnlockCandidate): boolean => {
        if (!isPvRestartUnlockCandidate(values)) {
            return false;
        }
        return locks.delete(values.minerId);
    };

    beforeEach(() => {
        locks.clear();
        locks.add('s9');
        locks.add('s19');
    });

    it('unlocks only S9 in the simulated transaction, leaving S19 blocked', () => {
        expect(simulateAtomicUnlock(evidence('s9'))).to.equal(true);
        expect(locks.has('s9')).to.equal(false);
        expect(locks.has('s19')).to.equal(true);
        expect(isPvMinerCommandAllowed('s19', new Set<string>(), locks, false)).to.equal(false);
    });

    it('does not unlock when PV export disappears before the simulated commit', () => {
        const first = evidence('s9');
        expect(isPvRestartUnlockCandidate(first)).to.equal(true);
        const changed = evidence('s9');
        changed.restart.gridPower = -100;
        expect(simulateAtomicUnlock(changed)).to.equal(false);
        expect(locks.has('s9')).to.equal(true);
        expect(locks.has('s19')).to.equal(true);
    });

    it('does not unlock during shutdown or a concurrent safe stop', () => {
        expect(simulateAtomicUnlock({ ...evidence('s9'), adapterShuttingDown: true })).to.equal(false);
        expect(simulateAtomicUnlock({ ...evidence('s19'), activeSafeStops: new Set(['s19']) })).to.equal(false);
        expect(locks.has('s9')).to.equal(true);
        expect(locks.has('s19')).to.equal(true);
    });

    it('does not reuse the same simulated authorization twice', () => {
        expect(simulateAtomicUnlock(evidence('s9'))).to.equal(true);
        expect(simulateAtomicUnlock(evidence('s9'))).to.equal(false);
        expect(locks.has('s19')).to.equal(true);
    });
});

describe('PV pre-power-on evidence binding (diagnostic only)', () => {
    const now = 1_800_000_000_000;
    const poweredOnAt = now - 10_000;
    const evidence = {
        minerId: 's9',
        adapterSessionId: 'session-current',
        approvedAt: poweredOnAt - 1000,
        expiresAt: now + 5000,
    };

    it('accepts evidence for the same miner and current adapter session', () => {
        expect(isPvPrePowerOnEvidenceCurrent(evidence, 's9', 'session-current', poweredOnAt, now)).to.equal(true);
    });

    it('rejects another miner and a previous adapter session', () => {
        expect(isPvPrePowerOnEvidenceCurrent(evidence, 's19', 'session-current', poweredOnAt, now)).to.equal(false);
        expect(isPvPrePowerOnEvidenceCurrent(evidence, 's9', 'session-previous', poweredOnAt, now)).to.equal(false);
    });

    it('rejects expired evidence or approval after relay power-on', () => {
        expect(isPvPrePowerOnEvidenceCurrent({ ...evidence, expiresAt: now - 1 }, 's9', 'session-current', poweredOnAt, now)).to.equal(false);
        expect(isPvPrePowerOnEvidenceCurrent({ ...evidence, approvedAt: poweredOnAt + 1 }, 's9', 'session-current', poweredOnAt, now)).to.equal(false);
    });

    it('rejects absent evidence and invalid timestamps', () => {
        expect(isPvPrePowerOnEvidenceCurrent(undefined, 's9', 'session-current', poweredOnAt, now)).to.equal(false);
        expect(isPvPrePowerOnEvidenceCurrent(evidence, 's9', 'session-current', undefined, now)).to.equal(false);
        expect(isPvPrePowerOnEvidenceCurrent({ ...evidence, approvedAt: Number.NaN }, 's9', 'session-current', poweredOnAt, now)).to.equal(false);
    });
});
