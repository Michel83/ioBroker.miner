import { expect } from 'chai';
import { calculatePvV243, isS9ToS19ReadyV243 } from './PvRegulationV243';

describe('PV regulation V2.43 read-only calculations', () => {
    it('reserves missing battery charge below 90 percent SOC', () => {
        expect(calculatePvV243({ gridPower: -2000, batteryPower: -700, batterySoc: 80 })).to.deep.equal({
            availableWatts: 1500,
            batteryChargeDeficitWatts: 500,
            effectiveGridWatts: -1500,
        });
    });

    it('does not reserve battery charging capacity at 90 percent SOC', () => {
        expect(calculatePvV243({ gridPower: -2000, batteryPower: -700, batterySoc: 90 })?.availableWatts).to.equal(
            2000,
        );
    });

    it('subtracts battery discharge and rejects missing measurements', () => {
        expect(calculatePvV243({ gridPower: -2000, batteryPower: 200, batterySoc: 95 })?.availableWatts).to.equal(1800);
        expect(calculatePvV243({ gridPower: -2000, batteryPower: undefined, batterySoc: 95 })).to.equal(undefined);
        expect(calculatePvV243({ gridPower: -2000, batteryPower: 0, batterySoc: undefined })).to.equal(undefined);
    });

    it('requires target, real S9 power, export and two minutes stability', () => {
        const values = {
            s9TargetWatts: 1800,
            s9ActualWatts: 1200,
            gridPowerWatts: -300,
            candidateSince: 1000,
            now: 121000,
        };
        expect(isS9ToS19ReadyV243(values)).to.equal(true);
        expect(isS9ToS19ReadyV243({ ...values, now: 120999 })).to.equal(false);
        expect(isS9ToS19ReadyV243({ ...values, s9TargetWatts: 1700 })).to.equal(false);
        expect(isS9ToS19ReadyV243({ ...values, s9ActualWatts: 1199 })).to.equal(false);
        expect(isS9ToS19ReadyV243({ ...values, gridPowerWatts: -299 })).to.equal(false);
        expect(isS9ToS19ReadyV243({ ...values, candidateSince: undefined })).to.equal(false);
    });
});
