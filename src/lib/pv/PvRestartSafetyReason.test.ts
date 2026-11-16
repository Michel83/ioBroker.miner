import { expect } from 'chai';
import { pvRestartSafetyReason } from './PvRestartSafetyReason';

describe('PV restart reason diagnostics (read-only)', () => {
    const ready = () => ({
        locked: true,
        shuttingDown: false,
        relayOn: false as boolean | null,
        countdown: 0 as number | null,
        gridPower: -2500 as number | undefined,
        batteryPower: 0 as number | undefined,
        reserveWatts: 200,
        minimumStartWatts: 1800,
    });
    it('keeps the actual lock distinct from observed conditions', () => {
        expect(pvRestartSafetyReason(ready())).to.equal('restart_locked_requires_fresh_validation');
    });
    it('reports missing relay feedback before other observations', () => {
        const v = ready(); v.relayOn = null;
        expect(pvRestartSafetyReason(v)).to.equal('relay_feedback_missing_or_stale');
    });
    it('reports battery discharge and insufficient export separately', () => {
        const v = ready(); v.batteryPower = 100;
        expect(pvRestartSafetyReason(v)).to.equal('battery_discharging');
        v.batteryPower = 0; v.gridPower = -100;
        expect(pvRestartSafetyReason(v)).to.equal('pv_surplus_insufficient');
    });
    it('reports missing telemetry and running restart delay', () => {
        const v = ready(); v.gridPower = undefined;
        expect(pvRestartSafetyReason(v)).to.equal('pv_measurements_missing_or_stale');
        v.gridPower = -2500; v.countdown = 90;
        expect(pvRestartSafetyReason(v)).to.equal('restart_delay_running');
    });
    it('treats non-finite PV readings as unavailable, never as safe export', () => {
        for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            expect(pvRestartSafetyReason({ ...ready(), gridPower: invalid })).to.equal('pv_measurements_missing_or_stale');
            expect(pvRestartSafetyReason({ ...ready(), batteryPower: invalid })).to.equal('pv_measurements_missing_or_stale');
        }
    });
    it('reports invalid power limits and reserves as invalid configuration', () => {
        for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            expect(pvRestartSafetyReason({ ...ready(), minimumStartWatts: invalid })).to.equal('pv_configuration_invalid');
            expect(pvRestartSafetyReason({ ...ready(), reserveWatts: invalid })).to.equal('pv_configuration_invalid');
        }
        expect(pvRestartSafetyReason({ ...ready(), minimumStartWatts: 0 })).to.equal('pv_configuration_invalid');
        expect(pvRestartSafetyReason({ ...ready(), reserveWatts: -1 })).to.equal('pv_configuration_invalid');
    });
    it('rejects non-finite and negative restart countdown diagnostics', () => {
        for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
            expect(pvRestartSafetyReason({ ...ready(), countdown: invalid })).to.equal('restart_stop_evidence_unavailable');
        }
    });
    it('reports adapter shutdown and missing stop evidence', () => {
        const v = ready(); v.shuttingDown = true;
        expect(pvRestartSafetyReason(v)).to.equal('adapter_shutting_down');
        v.shuttingDown = false; v.countdown = null;
        expect(pvRestartSafetyReason(v)).to.equal('restart_stop_evidence_unavailable');
    });
});
