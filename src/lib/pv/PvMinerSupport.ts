/**
 * Miner types eligible for PV safe-shutdown verification.
 *
 * This is only a preliminary capability check.
 * Actual relay shutdown additionally requires fresh hashrate,
 * fresh power measurements and stable shutdown confirmation.
 */
export function supportsPvSafeStop(minerType: string): boolean {
    return ['bosMiner', 'bos', 'xmRig', 'iceRiverOcMiner'].includes(minerType);
}
