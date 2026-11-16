/** Read-only explanation of current PV restart blockers; never grants permission. */
export function pvRestartSafetyReason(values: {
    locked: boolean;
    shuttingDown: boolean;
    relayOn: boolean | null;
    countdown: number | null;
    gridPower: number | undefined;
    batteryPower: number | undefined;
    reserveWatts: number;
    minimumStartWatts: number;
}): string {
    if (values.shuttingDown) return 'adapter_shutting_down';
    if (values.relayOn === null) return 'relay_feedback_missing_or_stale';
    if (values.relayOn) return 'relay_still_on';
    if (values.gridPower === undefined || values.batteryPower === undefined) return 'pv_measurements_missing_or_stale';
    if (values.batteryPower > 0) return 'battery_discharging';
    if (-values.gridPower - values.reserveWatts - Math.max(0, values.batteryPower) < values.minimumStartWatts) {
        return 'pv_surplus_insufficient';
    }
    if (values.countdown === null) return 'restart_stop_evidence_unavailable';
    if (values.countdown > 0) return 'restart_delay_running';
    return values.locked ? 'restart_locked_requires_fresh_validation' : 'no_observed_blocker';
}
