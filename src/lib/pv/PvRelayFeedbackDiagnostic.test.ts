import { expect } from 'chai';
import { confirmedPvRelayOn } from './PvRelayFeedbackDiagnostic';

describe('PV relay feedback for VIS (read-only)', () => {
    const now = 1_800_000_000_000;
    it('reports fresh acknowledged ON and OFF for either relay polarity', () => {
        expect(confirmedPvRelayOn(true, true, now, true, now, 15_000)).to.equal(true);
        expect(confirmedPvRelayOn(false, true, now, true, now, 15_000)).to.equal(false);
        expect(confirmedPvRelayOn(false, true, now, false, now, 15_000)).to.equal(true);
    });
    it('reports unknown for unacknowledged or missing feedback', () => {
        expect(confirmedPvRelayOn(true, false, now, true, now, 15_000)).to.equal(null);
        expect(confirmedPvRelayOn(undefined, true, now, true, now, 15_000)).to.equal(null);
    });
    it('reports unknown for stale or future feedback', () => {
        expect(confirmedPvRelayOn(true, true, now - 15_001, true, now, 15_000)).to.equal(null);
        expect(confirmedPvRelayOn(true, true, now + 1, true, now, 15_000)).to.equal(null);
    });
});
