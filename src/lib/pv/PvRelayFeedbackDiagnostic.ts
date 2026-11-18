/**
 * Read-only relay feedback for VIS. Unknown feedback must never be displayed
 * as a confirmed ON/OFF state or used to authorize commands.
 *
 * @param value
 * @param acknowledged
 * @param timestamp
 * @param relayOnValue
 * @param now
 * @param maxAgeMs
 */
export function confirmedPvRelayOn(
    value: unknown,
    acknowledged: unknown,
    timestamp: unknown,
    relayOnValue: boolean,
    now: number,
    maxAgeMs: number,
): boolean | null {
    if (
        typeof value !== 'boolean' ||
        acknowledged !== true ||
        typeof timestamp !== 'number' ||
        !Number.isFinite(timestamp) ||
        !Number.isFinite(now) ||
        !Number.isFinite(maxAgeMs) ||
        maxAgeMs <= 0 ||
        timestamp > now ||
        now - timestamp > maxAgeMs
    ) {
        return null;
    }
    return value === relayOnValue;
}
