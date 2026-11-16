import { decidePvTargetV243, type PvMinerKindV243, type PvTargetDecisionV243 } from './PvTargetRegulationV243';

/** In-memory observation only: never authorizes a miner command or relay operation. */
export class PvTargetDiagnosticV243 {
    private readonly history = new Map<PvMinerKindV243, {
        target: number;
        observedAt: number;
        lastChangeAt?: number;
        candidateWatts?: number;
        candidateSince?: number;
    }>();

    public reset(miner: PvMinerKindV243): void {
        this.history.delete(miner);
    }

    public evaluate(input: {
        miner: PvMinerKindV243;
        currentTargetWatts: number;
        effectiveGridWatts: number;
        batteryPowerWatts: number;
        now: number;
    }): PvTargetDecisionV243 {
        const { miner, currentTargetWatts: target, now } = input;
        if (![target, input.effectiveGridWatts, input.batteryPowerWatts, now].every(Number.isFinite) || now < 0) {
            this.reset(miner);
            return { action: 'hold', reason: 'invalid-or-stale-measurement' };
        }
        let history = this.history.get(miner);
        if (!history || now < history.observedAt) {
            history = { target, observedAt: now };
            this.history.set(miner, history);
        } else if (history.target !== target) {
            history.target = target;
            history.lastChangeAt = now;
            history.candidateWatts = undefined;
            history.candidateSince = undefined;
        }

        // No restart timestamp is available. A target change is only a conservative
        // observed proxy; do not present this diagnostic as actual restart protection.
        const decision = decidePvTargetV243({
            ...input,
            lastRegulationAt: history.lastChangeAt,
            lastTargetChangeAt: miner === 'S19' ? history.lastChangeAt : undefined,
            increaseCandidateWatts: history.candidateWatts,
            increaseCandidateSince: history.candidateSince,
        });
        if (decision.reason === 's19-increase-stabilization') {
            history.candidateWatts = decision.increaseCandidateWatts;
            history.candidateSince = decision.increaseCandidateSince;
        } else {
            history.candidateWatts = undefined;
            history.candidateSince = undefined;
        }
        // On first observation we cannot know if the miner was just restarted.
        // Hold S19 target suggestions until 180 seconds of uninterrupted observation.
        if (miner === 'S19' && history.lastChangeAt === undefined && now - history.observedAt < 180_000) {
            return { action: 'hold', reason: 's19-initial-observation' };
        }
        return decision;
    }
}
