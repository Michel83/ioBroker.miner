import { expect } from 'chai';
import {
    PvShutdownConfirmation,
    PvRelayOffPowerConfirmation,
    isPvMinerCommandAllowed,
    isPvRelayOffConfirmed,
    isPvShutdownSafe,
} from './PvShutdownSafety';
import { getPvShutdownTiming } from './PvShutdownTiming';

/**
 * Full two-phase S9 safety simulation with fake miner/relay operations.
 * This exercises the same safety primitives as main.ts, NOT main.ts itself.
 * It never calls ioBroker, BOSMiner, or Sonoff hardware.
 */
describe('PV S9 two-phase shutdown sequence (fake hardware)', () => {
    const start = 1_800_000_000_000;
    const gapMs = 130_000;
    const timing = getPvShutdownTiming(180, 90);
    const ageMs = 180_000;

    function simulate(
        options: {
            missingPreSample?: boolean;
            staleRelayFeedback?: boolean;
            highPrePower?: boolean;
            missingPostSample?: boolean;
            relayFeedbackLostAfterOff?: boolean;
        } = {},
    ): { commands: string[]; stopped: boolean; locked: boolean } {
        const commands: string[] = [];
        const lockedMiners = new Set<string>();
        const activeStops = new Set<string>(['S9']);
        const pausedAt = start;
        commands.push('miner.pause');
        const pre = new PvShutdownConfirmation();
        let offAt: number | undefined;

        // Five-second polling, with independently timestamped Sonoff updates every 130 s.
        for (let elapsed = 0; elapsed <= timing.preRelayTimeoutMs; elapsed += 5_000) {
            const now = start + elapsed;
            const reading = Math.floor(elapsed / gapMs);
            const powerAt = reading === 0 ? pausedAt - 1 : start + reading * gapMs;
            const missing = options.missingPreSample && reading === 2;
            const safe = pre.update(
                {
                    hashrate: 0,
                    hashrateTimestamp: now,
                    power: options.highPrePower ? 800 : missing ? undefined : 50,
                    powerTimestamp: missing ? undefined : powerAt,
                    lastSeen: now,
                },
                now,
                ageMs,
                pausedAt,
                30_000,
                10_000,
                timing.powerSampleGapMs,
            );
            if (!safe) {
                continue;
            }
            // Final check must still use fresh post-pause evidence.
            const finalSafe = isPvShutdownSafe(
                {
                    hashrate: 0,
                    hashrateTimestamp: now,
                    power: options.highPrePower ? 800 : 50,
                    powerTimestamp: powerAt,
                    lastSeen: now,
                },
                now,
                timing.powerSampleGapMs,
                pausedAt,
            );
            if (finalSafe) {
                offAt = now;
                lockedMiners.add('S9');
                commands.push('relay.off');
                break;
            }
        }

        if (offAt === undefined) {
            return {
                commands,
                stopped: false,
                locked: !isPvMinerCommandAllowed('S9', activeStops, lockedMiners, false),
            };
        }

        const post = new PvRelayOffPowerConfirmation(offAt);
        let stopped = false;
        for (let elapsed = 5_000; elapsed <= timing.postRelayTimeoutMs; elapsed += 5_000) {
            const now = offAt + elapsed;
            const reading = Math.floor(elapsed / gapMs);
            const powerAt = reading === 0 ? offAt - 1 : offAt + reading * gapMs;
            const relayAt = options.staleRelayFeedback ? offAt : now;
            const relayOk = isPvRelayOffConfirmed(
                false,
                relayAt,
                !options.relayFeedbackLostAfterOff,
                true,
                offAt,
                now,
                ageMs,
            );
            const power = options.missingPostSample && reading >= 2 ? undefined : 0;
            if (post.update(power, powerAt, relayOk, now, ageMs)) {
                // Revalidate relay feedback immediately before recording stop.
                if (
                    isPvRelayOffConfirmed(false, relayAt, !options.relayFeedbackLostAfterOff, true, offAt, now, ageMs)
                ) {
                    stopped = true;
                    commands.push('stop.confirmed');
                    break;
                }
                post.reset();
            }
        }
        return { commands, stopped, locked: !isPvMinerCommandAllowed('S9', activeStops, lockedMiners, false) };
    }

    it('pauses, waits for three distinct pre-OFF readings, then verifies three post-OFF readings', () => {
        const result = simulate();
        expect(result.commands).to.deep.equal(['miner.pause', 'relay.off', 'stop.confirmed']);
        expect(result.stopped).to.equal(true);
        expect(result.locked).to.equal(true);
    });

    it('never switches relay OFF when an intermediate pre-OFF reading is missing', () => {
        const result = simulate({ missingPreSample: true });
        expect(result.commands).to.deep.equal(['miner.pause']);
        expect(result.locked).to.equal(true);
    });

    it('never switches relay OFF while the miner still draws high power', () => {
        expect(simulate({ highPrePower: true }).commands).to.deep.equal(['miner.pause']);
    });

    it('does not confirm shutdown without new post-OFF power evidence', () => {
        const result = simulate({ missingPostSample: true });
        expect(result.commands).to.deep.equal(['miner.pause', 'relay.off']);
        expect(result.stopped).to.equal(false);
        expect(result.locked).to.equal(true);
    });

    it('does not confirm shutdown from a stale relay acknowledgement', () => {
        const result = simulate({ staleRelayFeedback: true });
        expect(result.commands).to.deep.equal(['miner.pause', 'relay.off']);
        expect(result.stopped).to.equal(false);
        expect(result.locked).to.equal(true);
    });

    it('does not confirm shutdown when relay feedback is lost after OFF', () => {
        const result = simulate({ relayFeedbackLostAfterOff: true });
        expect(result.commands).to.deep.equal(['miner.pause', 'relay.off']);
        expect(result.stopped).to.equal(false);
        expect(result.locked).to.equal(true);
    });
});
