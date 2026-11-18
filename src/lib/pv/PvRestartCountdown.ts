import { isPvStopRestorationConsistent, parsePvPersistedStop, type PvStopRestoration } from './PvShutdownSafety';

/**
 * Read-only countdown; never authorizes a restart.
 *
 * @param values
 * @param restartDelaySeconds
 */
export function pvRestartCountdownSeconds(values: PvStopRestoration, restartDelaySeconds: unknown): number | null {
    if (
        typeof restartDelaySeconds !== 'number' ||
        !Number.isFinite(restartDelaySeconds) ||
        restartDelaySeconds < 0 ||
        !isPvStopRestorationConsistent(values)
    ) {
        return null;
    }
    const record = parsePvPersistedStop(values.storedRecord, values.minerId, values.relayStateId, values.now);
    if (!record) {
        return null;
    }
    return Math.max(0, Math.ceil((record.stoppedAt + restartDelaySeconds * 1000 - values.now) / 1000));
}
