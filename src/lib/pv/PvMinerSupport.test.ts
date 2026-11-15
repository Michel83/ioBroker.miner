import { expect } from 'chai';
import { supportsPvSafeStop } from './PvMinerSupport';

describe('PV miner shutdown support', () => {
    it('supports BOSMiner', () => {
        expect(supportsPvSafeStop('bosMiner')).to.equal(true);
    });

    it('supports Braiins BOS', () => {
        expect(supportsPvSafeStop('bos')).to.equal(true);
    });

    it('supports XMRig', () => {
        expect(supportsPvSafeStop('xmRig')).to.equal(true);
    });

    it('supports IceRiver OC', () => {
        expect(supportsPvSafeStop('iceRiverOcMiner')).to.equal(true);
    });

    it('rejects CGMiner', () => {
        expect(supportsPvSafeStop('cgMiner')).to.equal(false);
    });

    it('rejects AvalonMiner', () => {
        expect(supportsPvSafeStop('avalonMiner')).to.equal(false);
    });

    it('rejects unknown miner types', () => {
        expect(supportsPvSafeStop('unknown')).to.equal(false);
    });
});
