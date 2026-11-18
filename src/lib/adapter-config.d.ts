// This file extends the AdapterConfig type from "@types/iobroker"

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            pollInterval: number;

            /** Look up the latest firmware/software versions once a day (default: true). */
            checkForUpdates?: boolean;

            /** Enable automatic PV surplus control (default: false). */
            pvEnabled?: boolean;

            /** Grid power state: positive = import, negative = export. */
            pvGridPowerId?: string;

            /** Battery power state: positive = discharge, negative = charge. */
            pvBatteryPowerId?: string;

            /** Battery SOC state for read-only V2.43 diagnostics (0-100%). */
            pvBatterySocId?: string;

            /** Observed S9 power target state, read-only V2.43 diagnostic input. */
            pvS9TargetStateId?: string;

            /** Observed S19 power target state, read-only V2.43 diagnostic input. */
            pvS19TargetStateId?: string;

            /** S9 running state (read-only). */
            pvS9RunningStateId?: string;

            /** S19 running state (read-only). */
            pvS19RunningStateId?: string;

            /** S9 actual power in watts (read-only). */
            pvS9ActualPowerId?: string;

            /** S19 actual power in watts (read-only). */
            pvS19ActualPowerId?: string;

            /** PV regulation interval in seconds (default: 120). */
            pvInterval?: number;

            /** Grid reserve in watts (default: 200). */
            pvReserve?: number;

            /** PV operation start hour (default: 12). */
            pvStartHour?: number;

            /** PV operation end hour (default: 20). */
            pvEndHour?: number;

            /** Maximum measurement age in seconds (default: 180). */
            pvMaxDataAge?: number;
        }

        // Notification scope of this adapter
        interface NotificationScopes {
            miner: 'filterClean';
        }
    }
}

export {};
