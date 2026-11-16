import { expect } from 'chai';
import {
    executePvStartup,
    isPvRestartAllowed,
    isPvStartReady,
    isPvMinerCommandAllowed,
    type PvRestartMeasurements,
    type PvStartReadiness,
} from './PvShutdownSafety';

/** Simulated operations only; no ioBroker adapter, Sonoff relay or miner hardware. */
describe('PV complete startup chain (simulation only)', () => {
    const now = 1_800_000_000_000;
    const makeRestart = (minimumStartWatts: number): PvRestartMeasurements => ({
        enabled: true, relayConfirmedOff: true,
        gridPower: -4500, batteryPower: 0,
        gridTimestamp: now, batteryTimestamp: now,
        now, maxAgeMs: 15_000, reserveWatts: 200,
        minimumStartWatts, lastStoppedAt: now - 240_000,
        restartDelayMs: 180_000,
    });
    const makeReadiness = (): PvStartReadiness => ({
        relayOn: true, relayAck: true,
        relayEnabledAt: now - 120_000,
        relayTimestamp: now,
        minerReachable: true, minerSeenAt: now,
        now, maxAgeMs: 15_000, startupDelayMs: 120_000,
    });
    const simulate = async (
        minerId: string,
        minimumStartWatts: number,
        changes: {
            beforeRelay?: Partial<PvRestartMeasurements>;
            beforeMiner?: Partial<PvRestartMeasurements>;
            readiness?: Partial<PvStartReadiness>;
        } = {},
    ): Promise<string[]> => {
        const calls: string[] = [];
        const lockedMiners = new Set([minerId]);
        const restart = makeRestart(minimumStartWatts);
        const mayStart = (overrides: Partial<PvRestartMeasurements>): boolean =>
            isPvRestartAllowed({ ...restart, ...overrides });
        try {
            await executePvStartup({
                mayPowerOn: async () => {
                    calls.push('preflight');
                    return mayStart(changes.beforeRelay ?? {});
                },
                powerOnRelay: async () => {
                    calls.push('relay-on-simulated');
                },
                awaitReadiness: async () => {
                    calls.push('readiness');
                    return { ...makeReadiness(), ...changes.readiness };
                },
                mayStartMining: async () => {
                    calls.push('final-pv-check');
                    return mayStart(changes.beforeMiner ?? {});
                },
                startMining: async () => {
                    calls.push('start-request-simulated');
                    // The existing production command interlock must still reject
                    // the request; this scenario never unlocks the miner.
                    if (!isPvMinerCommandAllowed(minerId, new Set<string>(), lockedMiners, false)) {
                        calls.push('command-guard-blocked');
                        return;
                    }
                    throw new Error('Unsafe: PV command guard unexpectedly open');
                },
            });
        } catch (error) {
            expect(String(error)).to.contain('PV startup blocked');
        }
        expect(lockedMiners.has(minerId)).to.equal(true);
        return calls;
    };

    it('completes all simulated safety stages for S9 but command guard stays locked', async () => {
        expect(await simulate('s9', 500)).to.deep.equal([
            'preflight', 'relay-on-simulated', 'readiness', 'final-pv-check',
            'start-request-simulated', 'command-guard-blocked',
        ]);
    });

    it('completes all simulated safety stages for S19 but command guard stays locked', async () => {
        expect(await simulate('s19', 1800)).to.deep.equal([
            'preflight', 'relay-on-simulated', 'readiness', 'final-pv-check',
            'start-request-simulated', 'command-guard-blocked',
        ]);
    });

    it('blocks both miners when PV export disappears after simulated relay ON', async () => {
        for (const [minerId, minimumStartWatts] of [['s9', 500], ['s19', 1800]] as const) {
            expect(await simulate(minerId, minimumStartWatts, {
                beforeMiner: { gridPower: 400 },
            })).to.deep.equal([
                'preflight', 'relay-on-simulated', 'readiness', 'final-pv-check',
            ]);
        }
    });

    it('blocks both miners when battery starts discharging after simulated relay ON', async () => {
        for (const [minerId, minimumStartWatts] of [['s9', 500], ['s19', 1800]] as const) {
            expect(await simulate(minerId, minimumStartWatts, {
                beforeMiner: { batteryPower: 1 },
            })).to.deep.equal([
                'preflight', 'relay-on-simulated', 'readiness', 'final-pv-check',
            ]);
        }
    });

    it('blocks when fresh relay confirmation or miner communication is missing', async () => {
        expect(await simulate('s19', 1800, {
            readiness: { relayAck: false },
        })).to.deep.equal(['preflight', 'relay-on-simulated', 'readiness']);
        expect(await simulate('s9', 500, {
            readiness: { minerSeenAt: now - 20_000 },
        })).to.deep.equal(['preflight', 'relay-on-simulated', 'readiness']);
    });

    it('never switches a simulated relay ON when the initial PV check fails', async () => {
        expect(await simulate('s19', 1800, {
            beforeRelay: { gridPower: -500 },
        })).to.deep.equal(['preflight']);
    });

    it('requires valid post-relay startup readiness before any final PV check', () => {
        expect(isPvStartReady(makeReadiness())).to.equal(true);
        expect(isPvStartReady({ ...makeReadiness(), relayTimestamp: now - 130_000 })).to.equal(false);
        expect(isPvStartReady({ ...makeReadiness(), minerReachable: false })).to.equal(false);
    });
});
