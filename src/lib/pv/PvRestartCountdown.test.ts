import { expect } from 'chai';
import { pvRestartCountdownSeconds } from './PvRestartCountdown';
import type { PvStopRestoration } from './PvShutdownSafety';

describe('PV restart countdown VIS diagnostics (never unlocks)', () => {
    const now = 1_800_000_000_000;
    const values = (): PvStopRestoration => ({
        storedRecord: { minerId: 's9', relayStateId: 'sonoff.0.s9.POWER', stoppedAt: now - 30_000, relayOffConfirmed: true },
        minerId: 's9',
        relayStateId: 'sonoff.0.s9.POWER',
        relayOnValue: true,
        relayValue: false,
        relayTimestamp: now,
        power: 0,
        powerTimestamp: now,
        now,
        maxAgeMs: 15_000,
    });
    it('shows remaining seconds only with consistent fresh OFF and zero power', () => {
        expect(pvRestartCountdownSeconds(values(), 180)).to.equal(150);
        expect(pvRestartCountdownSeconds(values(), 20)).to.equal(0);
    });
    it('shows unknown for missing or mismatched persisted stop', () => {
        const v = values();
        v.storedRecord = undefined;
        expect(pvRestartCountdownSeconds(v, 180)).to.equal(null);
        v.storedRecord = { minerId: 's19', relayStateId: v.relayStateId, stoppedAt: now - 30_000, relayOffConfirmed: true };
        expect(pvRestartCountdownSeconds(v, 180)).to.equal(null);
    });
    it('shows unknown for stale relay or unexpected ON state', () => {
        const v = values();
        v.relayTimestamp = now - 15_001;
        expect(pvRestartCountdownSeconds(v, 180)).to.equal(null);
        v.relayTimestamp = now;
        v.relayValue = true;
        expect(pvRestartCountdownSeconds(v, 180)).to.equal(null);
    });
    it('shows unknown for missing power and invalid delay', () => {
        const v = values();
        v.power = undefined;
        expect(pvRestartCountdownSeconds(v, 180)).to.equal(null);
        expect(pvRestartCountdownSeconds(values(), undefined)).to.equal(null);
    });
});
