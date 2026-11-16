import { expect } from 'chai';
import {
    isPvPostPowerOnApproved,
    isPvRestartAllowed,
    type PvPostPowerOnApproval,
} from './PvShutdownSafety';

describe('PV restart distinct relay OFF and ON stages (diagnostic only)', () => {
    const now = 1_800_000_000_000;
    const poweredOnAt = now - 120_000;
    const values = (): PvPostPowerOnApproval => ({
        minerId: 's9',
        adapterSessionId: 'session-current',
        prePowerOnEvidence: { minerId: 's9', adapterSessionId: 'session-current', approvedAt: poweredOnAt - 1000, expiresAt: now + 5000 },
        relayPoweredOnAt: poweredOnAt,
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

    it('accepts ON-stage evidence without contradictory live relay OFF feedback', () => {
        const current = values();
        expect(isPvRestartAllowed(current.restart)).to.equal(false);
        expect(isPvPostPowerOnApproved(current)).to.equal(true);
    });

    it('requires prior OFF-stage approval before considering ON-stage evidence', () => {
        expect(isPvPostPowerOnApproved({ ...values(), prePowerOnEvidence: undefined })).to.equal(false);
    });

    it('requires new grid and battery samples after relay ON', () => {
        const grid = values();
        grid.restart.gridTimestamp = poweredOnAt;
        expect(isPvPostPowerOnApproved(grid)).to.equal(false);
        const battery = values();
        battery.restart.batteryTimestamp = poweredOnAt;
        expect(isPvPostPowerOnApproved(battery)).to.equal(false);
    });

    it('rejects relay feedback from before ON and a mismatched ON event', () => {
        const relay = values();
        relay.readiness.relayTimestamp = poweredOnAt;
        expect(isPvPostPowerOnApproved(relay)).to.equal(false);
        const mismatch = values();
        mismatch.readiness.relayEnabledAt = poweredOnAt - 1;
        expect(isPvPostPowerOnApproved(mismatch)).to.equal(false);
    });

    it('rejects miner disconnection or lost PV export after ON', () => {
        const offline = values();
        offline.readiness.minerReachable = false;
        expect(isPvPostPowerOnApproved(offline)).to.equal(false);
        const exportLost = values();
        exportLost.restart.gridPower = -100;
        expect(isPvPostPowerOnApproved(exportLost)).to.equal(false);
    });
});
