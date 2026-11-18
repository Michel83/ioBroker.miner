import { expect } from 'chai';
import { getPvShutdownTiming } from './PvShutdownTiming';

describe('PV per-miner shutdown timing (pure calculation)', () => {
    it('keeps the existing 15-second defaults for fast S19 telemetry', () => {
        expect(getPvShutdownTiming(undefined, undefined)).to.deep.equal({
            powerSampleGapMs: 15_000,
            preRelayTimeoutMs: 300_000,
            postRelayTimeoutMs: 90_000,
        });
    });

    it('allows a separately configured 180-second S9 telemetry gap', () => {
        expect(getPvShutdownTiming(180, 90)).to.deep.equal({
            powerSampleGapMs: 180_000,
            preRelayTimeoutMs: 600_000,
            postRelayTimeoutMs: 570_000,
        });
    });

    it('keeps a longer explicit relay confirmation timeout', () => {
        expect(getPvShutdownTiming(130, 800).postRelayTimeoutMs).to.equal(800_000);
    });

    it('caps unusually large gaps at 180 seconds', () => {
        expect(getPvShutdownTiming(999, undefined).powerSampleGapMs).to.equal(180_000);
    });

    it('falls back to safe existing defaults for invalid input', () => {
        for (const value of [0, -1, NaN, Infinity]) {
            expect(getPvShutdownTiming(value, value)).to.deep.equal(getPvShutdownTiming(undefined, undefined));
        }
    });
});
