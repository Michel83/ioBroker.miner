import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { resetTimerBackend } from './lib/utils/delay';
import { MinerFeatureKey } from './lib/miner/model/MinerFeature';
import type { MinerAdapter } from './main';
import type { IOBrokerMinerSettings } from './miner/model/IOBrokerMinerSettings';
import type { ConfigItemAny, DeviceControl } from '@iobroker/dm-utils';
import { BOS } from './lib/miner/miner/BOS';
import { UpdateSources } from './lib/update/UpdateSources';
import { AvalonMiner } from './lib/miner/miner/AvalonMiner';
import type { CustomChannelDefinition, DynamicCustomChannelDefinition } from './lib/miner/model/CustomFeature';

/** Only the adapter dependencies used by initialization and update checks. */
class AdapterMock extends EventEmitter {
    config = { checkForUpdates: true };
    log = { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
    decrypt(value: string): string {
        return value;
    }
    getDevicesAsync(): Promise<ioBroker.DeviceObject[]> {
        return Promise.resolve([]);
    }
}

interface TestAdapter {
    config: { checkForUpdates: boolean };
    minerManager: { init: () => Promise<object>; getMiners: () => object[] };
    createDeviceStateObjects: () => Promise<void>;
    writeStaticInfoStates: () => Promise<void>;
    getStateAsync: (id: string) => Promise<{ val: unknown }>;
    setState: (id: string, state: { val: unknown }) => Promise<void>;
    initDevice: (device: ioBroker.DeviceObject) => Promise<void>;
    checkForUpdates: MinerAdapter['checkForUpdates'];
    updateSources: UpdateSources;
    getDevicesAsync: () => Promise<ioBroker.DeviceObject[]>;
    getForeignStateAsync: (id: string) => Promise<{ val: unknown } | null>;
    deviceManagement: {
        getUpdateInfoItems: (
            id: string,
            installedFeature: MinerFeatureKey,
            features: MinerFeatureKey[],
        ) => Promise<Record<string, ConfigItemAny>>;
    };
}

/** Load the real adapter with a controller-free base class. */
function loadTestAdapterFactory(): () => TestAdapter {
    const corePath = require.resolve('@iobroker/adapter-core');
    const mainPath = require.resolve('./main');
    const savedCore = require.cache[corePath];
    const savedMain = require.cache[mainPath];
    require.cache[corePath] = {
        id: corePath,
        filename: corePath,
        loaded: true,
        exports: {
            Adapter: AdapterMock,
            I18n: { init: () => Promise.resolve(), getTranslatedObject: (key: string) => ({ en: key }) },
        },
    } as NodeModule;
    delete require.cache[mainPath];
    try {
        const load = createRequire(__filename);
        return load('./main') as () => TestAdapter;
    } finally {
        if (savedCore) {
            require.cache[corePath] = savedCore;
        } else {
            delete require.cache[corePath];
        }
        if (savedMain) {
            require.cache[mainPath] = savedMain;
        } else {
            delete require.cache[mainPath];
        }
    }
}

let testAdapterFactory: () => TestAdapter;

before(function () {
    // Cold TypeScript compilation (plus coverage instrumentation) can exceed Mocha's 2s test timeout on CI.
    this.timeout(30_000);
    testAdapterFactory = loadTestAdapterFactory();
});

/** Create an isolated adapter without replacing the timers used by other unit tests. */
function createTestAdapter(): TestAdapter {
    try {
        return testAdapterFactory();
    } finally {
        resetTimerBackend();
    }
}

describe('initial device update check', () => {
    for (const minerType of ['bos', 'avalonMiner']) {
        it(`checks ${minerType} enabled after an empty daily check without blocking initialization`, async () => {
            const adapter = createTestAdapter();
            const writes = new Map<string, unknown>();
            let finishLookup!: (result: { latestVersion: string; updateAvailable: boolean }) => void;
            let checked = false;
            const miner = {
                settings: { id: 'new-device' },
                getSupportedFeatures: () => [MinerFeatureKey.latestVersion, MinerFeatureKey.updateAvailable],
                getInstalledVersionFeature: () => MinerFeatureKey.firmwareVersion,
                subscribeToStats: () => {},
                subscribeToOnlineStatus: () => {},
                checkForUpdate: () => {
                    checked = true;
                    return new Promise(resolve => {
                        finishLookup = resolve;
                    });
                },
            };
            adapter.minerManager = { init: () => Promise.resolve(miner), getMiners: () => [] };
            adapter.createDeviceStateObjects = () => Promise.resolve();
            adapter.writeStaticInfoStates = () => Promise.resolve();
            adapter.getStateAsync = () => Promise.resolve({ val: true });
            adapter.setState = (id, state) => {
                writes.set(id, state.val);
                return Promise.resolve();
            };
            expect((await adapter.checkForUpdates()).checked).to.equal(0);

            const device = {
                _id: 'miner.0.miner.new-device',
                native: { category: 'miner', settings: { id: 'new-device', minerType, host: 'localhost' } },
            } as unknown as ioBroker.DeviceObject;
            await adapter.initDevice(device);
            await new Promise(resolve => setImmediate(resolve));
            expect(checked).to.equal(true);
            finishLookup({ latestVersion: 'new-build', updateAvailable: true });
            // Let the background check finish writing the states.
            await new Promise(resolve => setImmediate(resolve));
            expect(writes.get('miner.new-device.info.latestVersion')).to.equal('new-build');
            expect(writes.get('miner.new-device.info.updateAvailable')).to.equal(true);

            checked = false;
            adapter.config.checkForUpdates = false;
            await adapter.initDevice(device);
            expect(checked).to.equal(false);
        });
    }
});

describe('PV adapter initialization restart interlock', () => {
    for (const minerId of ['s9', 's19']) {
        it(`locks ${minerId} before diagnostics and miner initialization, even if diagnostics fail`, async () => {
            const adapter = createTestAdapter();
            const events: string[] = [];
            const internal = adapter as unknown as {
                pvRelayOffMiners: Set<string>;
                restorePvStopDiagnostics: () => Promise<void>;
            };
            internal.restorePvStopDiagnostics = () => {
                events.push('diagnostics');
                expect(internal.pvRelayOffMiners.has(minerId)).to.equal(true);
                return Promise.reject(new Error('simulated missing PV diagnostics'));
            };
            adapter.minerManager = {
                init: () => {
                    events.push('init');
                    expect(internal.pvRelayOffMiners.has(minerId)).to.equal(true);
                    return Promise.reject(new Error('simulated offline miner'));
                },
                getMiners: () => [],
            };
            adapter.createDeviceStateObjects = () => Promise.resolve();
            adapter.writeStaticInfoStates = () => Promise.resolve();
            adapter.getStateAsync = () => Promise.resolve({ val: true });
            adapter.setState = () => Promise.resolve();
            (adapter as unknown as { setStateChangedAsync: () => Promise<void> }).setStateChangedAsync = () =>
                Promise.resolve();
            adapter.config.checkForUpdates = false;

            await adapter.initDevice({
                _id: `miner.0.miner.${minerId}`,
                native: {
                    category: 'miner',
                    name: minerId,
                    enabled: true,
                    pvControl: { enabled: true },
                    settings: { id: minerId, minerType: 'bos', host: 'localhost' },
                },
            } as unknown as ioBroker.DeviceObject);

            expect(events).to.deep.equal(['diagnostics', 'init']);
            expect(internal.pvRelayOffMiners.has(minerId)).to.equal(true);
        });
    }
});

describe('PV restart lock ignores persisted permission (no hardware)', () => {
    for (const minerId of ['s9', 's19']) {
        it(`keeps ${minerId} locked even if a saved state claims restart is allowed`, async () => {
            const adapter = createTestAdapter();
            const internal = adapter as unknown as {
                pvRelayOffMiners: Set<string>;
                restorePvStopDiagnostics: () => Promise<void>;
            };
            internal.restorePvStopDiagnostics = () => {
                expect(internal.pvRelayOffMiners.has(minerId)).to.equal(true);
                return Promise.resolve();
            };
            adapter.minerManager = {
                init: () => Promise.reject(new Error('simulated miner offline')),
                getMiners: () => [],
            };
            adapter.createDeviceStateObjects = () => Promise.resolve();
            adapter.writeStaticInfoStates = () => Promise.resolve();
            adapter.getStateAsync = () => Promise.resolve({ val: false });
            adapter.setState = () => Promise.resolve();
            (adapter as unknown as { setStateChangedAsync: () => Promise<void> }).setStateChangedAsync = () =>
                Promise.resolve();
            adapter.config.checkForUpdates = false;

            await adapter.initDevice({
                _id: `miner.0.miner.${minerId}`,
                native: {
                    category: 'miner',
                    name: minerId,
                    enabled: true,
                    pvControl: { enabled: true },
                    settings: { id: minerId, minerType: 'bos', host: 'localhost' },
                },
            } as unknown as ioBroker.DeviceObject);

            expect(internal.pvRelayOffMiners.has(minerId)).to.equal(true);
        });
    }
});

describe('PV restart lock persistent diagnostics (no hardware)', () => {
    for (const minerId of ['s9', 's19']) {
        it(`records a locked state for ${minerId} without releasing the command guard`, async () => {
            const adapter = createTestAdapter();
            const records = new Map<string, unknown>();
            const internal = adapter as unknown as {
                pvRelayOffMiners: Set<string>;
                restorePvStopDiagnostics: () => Promise<void>;
                extendObject: () => Promise<void>;
            };
            internal.restorePvStopDiagnostics = () => Promise.resolve();
            internal.extendObject = () => Promise.resolve();
            adapter.minerManager = {
                init: () => Promise.reject(new Error('simulated miner offline')),
                getMiners: () => [],
            };
            adapter.createDeviceStateObjects = () => Promise.resolve();
            adapter.writeStaticInfoStates = () => Promise.resolve();
            adapter.getStateAsync = () => Promise.resolve({ val: true });
            adapter.setState = (id, state) => {
                records.set(id, state.val);
                return Promise.resolve();
            };
            (adapter as unknown as { setStateChangedAsync: () => Promise<void> }).setStateChangedAsync = () =>
                Promise.resolve();
            adapter.config.checkForUpdates = false;

            await adapter.initDevice({
                _id: `miner.0.miner.${minerId}`,
                native: {
                    category: 'miner',
                    name: minerId,
                    enabled: true,
                    pvControl: { enabled: true },
                    settings: { id: minerId, minerType: 'bos', host: 'localhost' },
                },
            } as unknown as ioBroker.DeviceObject);

            expect(internal.pvRelayOffMiners.has(minerId)).to.equal(true);
            const value = records.get(`pvControl.miners.miner.${minerId}.restartLockDiagnostic`);
            expect(value).to.be.a('string');
            const diagnostic = JSON.parse(value as string) as Record<string, unknown>;
            expect(diagnostic.minerId).to.equal(minerId);
            expect(diagnostic.locked).to.equal(true);
            expect(diagnostic.safetyStatus).to.equal('not_authorized');
            expect(diagnostic.reason).to.equal('adapter_restart_requires_fresh_safety_validation');
            expect(diagnostic.recordedAt).to.be.a('number');
        });
    }
});

describe('PV restart remains locked after interrupted diagnostic persistence (no hardware)', () => {
    for (const minerId of ['s9', 's19']) {
        it(`keeps ${minerId} locked when restoration and diagnostic writes fail`, async () => {
            const adapter = createTestAdapter();
            const internal = adapter as unknown as {
                pvRelayOffMiners: Set<string>;
                restorePvStopDiagnostics: () => Promise<void>;
                extendObject: () => Promise<void>;
            };
            internal.restorePvStopDiagnostics = () => Promise.reject(new Error('simulated interrupted restore'));
            internal.extendObject = () => Promise.reject(new Error('simulated disk write failure'));
            adapter.minerManager = {
                init: () => Promise.reject(new Error('simulated miner offline')),
                getMiners: () => [],
            };
            adapter.createDeviceStateObjects = () => Promise.resolve();
            adapter.writeStaticInfoStates = () => Promise.resolve();
            adapter.getStateAsync = () => Promise.resolve({ val: true });
            adapter.setState = () => Promise.resolve();
            (adapter as unknown as { setStateChangedAsync: () => Promise<void> }).setStateChangedAsync = () =>
                Promise.resolve();
            adapter.config.checkForUpdates = false;

            await adapter.initDevice({
                _id: `miner.0.miner.${minerId}`,
                native: {
                    category: 'miner',
                    name: minerId,
                    enabled: true,
                    pvControl: { enabled: true },
                    settings: { id: minerId, minerType: 'bos', host: 'localhost' },
                },
            } as unknown as ioBroker.DeviceObject);

            expect(internal.pvRelayOffMiners.has(minerId)).to.equal(true);
        });
    }
});

describe('offline BOS update check after restart', () => {
    for (const enabled of [true, false]) {
        it(`uses persisted identity for an offline device (enabled=${enabled})`, async () => {
            const adapter = createTestAdapter();
            const bos = new BOS({
                minerType: 'bos',
                id: 'saved-bos',
                host: 'offline',
                port: 50051,
                pollInterval: 1000,
                username: 'root',
                password: '',
            });
            const installed = '2023-05-29-0-1daef48b-23.03.2-plus';
            const latest = '2026-10-19-0-46be68fe-26.10-plus';
            const writes = new Map<string, unknown>();
            adapter.minerManager = { init: () => Promise.resolve(bos), getMiners: () => (enabled ? [bos] : []) };
            adapter.getDevicesAsync = () =>
                Promise.resolve([
                    {
                        _id: 'miner.0.miner.saved-bos',
                        native: { category: 'miner', enabled, settings: bos.settings },
                    } as unknown as ioBroker.DeviceObject,
                ]);
            adapter.getStateAsync = id =>
                Promise.resolve({
                    val: id.endsWith('.raw.stats')
                        ? JSON.stringify({ details: { platform: 7, bosVersion: { current: installed } } })
                        : id.endsWith('.info.online')
                          ? false
                          : installed,
                });
            adapter.setState = (id, state) => {
                writes.set(id, state.val);
                return Promise.resolve();
            };
            adapter.updateSources = new UpdateSources({
                fetch: url => {
                    expect(url).to.equal('https://feeds.braiins-os.com/zynq-bm3-am2/');
                    return Promise.resolve(new Response(`<a href="firmware_${latest}_arm.tar">firmware</a>`));
                },
            });

            const result = await adapter.checkForUpdates();
            expect(result).to.deep.equal({ checked: 1, updatesAvailable: 1, failed: 0 });
            expect(writes.get('miner.saved-bos.info.latestVersion')).to.equal(latest);
            expect(writes.get('miner.saved-bos.info.updateAvailable')).to.equal(true);
        });
    }
});

describe('device manager latest version', () => {
    it('shows Unknown for an unavailable version instead of null or a stale update', async () => {
        const adapter = createTestAdapter();
        for (const value of [null, undefined, '']) {
            adapter.getForeignStateAsync = () => Promise.resolve({ val: value });
            const items = await adapter.deviceManagement.getUpdateInfoItems(
                'miner.0.miner.test',
                MinerFeatureKey.firmwareVersion,
                [],
            );
            expect(items.latestVersion.type).to.equal('staticInfo');
            expect(items.latestVersion.data).to.deep.equal({ en: 'Unknown' });
            expect(items.updateStatus.data).to.deep.equal({ en: 'Unknown' });
        }
    });

    it('keeps a known latest version bound to its state', async () => {
        const adapter = createTestAdapter();
        adapter.getForeignStateAsync = () => Promise.resolve({ val: '26.10' });
        const items = await adapter.deviceManagement.getUpdateInfoItems(
            'miner.0.miner.test',
            MinerFeatureKey.firmwareVersion,
            [],
        );
        expect(items.latestVersion.type).to.equal('state');
        expect(Reflect.get(items.latestVersion, 'oid')).to.equal('miner.0.miner.test.info.latestVersion');
    });
});

/** The adapter parts the custom feature handling uses. */
interface CustomFeatureTestAdapter {
    namespace: string;
    log: { info: (msg: string) => void; warn: (msg: string) => void };
    minerManager: {
        getMiner: (id: string) => object | undefined;
        hasMiner: (id: string) => boolean;
        withExclusiveMinerCommand: (
            id: string,
            operation: (miner: {
                setCustomFeature: (id: string, value: unknown) => Promise<unknown>;
            }) => Promise<unknown>,
        ) => Promise<unknown>;
    };
    extendObject: (id: string, obj: { type: string; common: Partial<ioBroker.StateCommon> }) => Promise<void>;
    getObjectAsync: (id: string) => Promise<object | null>;
    getForeignObjectsAsync: (pattern: string) => Promise<Record<string, object>>;
    delObjectAsync: (id: string) => Promise<void>;
    getStateAsync: (id: string) => Promise<{ val: unknown } | null>;
    setState: (id: string, state: { val: unknown; ack: boolean }) => Promise<void>;
    createCustomStateObjects: (
        deviceId: string,
        channels: CustomChannelDefinition[],
        dynamicChannels?: DynamicCustomChannelDefinition[],
    ) => Promise<void>;
    createNewCustomChannels: (deviceId: string, channels: CustomChannelDefinition[]) => Promise<void>;
    onStateChange: (id: string, state: { val: unknown; ack: boolean }) => Promise<void>;
    deviceManagement: {
        getControls: (deviceId: string, miner: object, features: MinerFeatureKey[]) => Promise<DeviceControl<string>[]>;
    };
}

describe('custom features', () => {
    const avalon = new AvalonMiner({
        minerType: 'avalonMiner',
        id: 'dev',
        host: 'localhost',
        port: 4028,
        pollInterval: 1000,
    });

    it('creates one sub-channel per custom channel under custom and removes what is no longer declared', async () => {
        const adapter = createTestAdapter() as unknown as CustomFeatureTestAdapter;
        const created = new Map<string, { type: string; common: Partial<ioBroker.StateCommon> }>();
        const deleted: string[] = [];
        adapter.namespace = 'miner.0';
        adapter.extendObject = (id, obj) => {
            created.set(id, obj);
            return Promise.resolve();
        };
        adapter.getObjectAsync = () => Promise.resolve({});
        adapter.getForeignObjectsAsync = pattern => {
            expect(pattern).to.equal('miner.0.miner.dev.custom.*');
            return Promise.resolve({
                'miner.0.miner.dev.custom.light': {},
                'miner.0.miner.dev.custom.light.on': {},
                'miner.0.miner.dev.custom.old': {},
                'miner.0.miner.dev.custom.old.feature': {},
            });
        };
        adapter.delObjectAsync = id => {
            deleted.push(id);
            return Promise.resolve();
        };

        await adapter.createCustomStateObjects('miner.dev', avalon.getCustomChannels());

        expect(created.get('miner.dev.custom')?.type).to.equal('channel');
        expect(created.get('miner.dev.custom.light')?.type).to.equal('channel');
        expect(created.get('miner.dev.custom.lcd')?.type).to.equal('channel');
        expect(created.get('miner.dev.custom.light.brightness')?.common).to.include({
            type: 'number',
            role: 'level.dimmer',
            min: 0,
            max: 100,
            write: true,
        });
        expect(created.get('miner.dev.custom.light.effect')?.common.states).to.deep.equal({
            1: 'Static',
            2: 'Flash',
            3: 'Breath',
            4: 'Loop',
        });
        // nothing directly under the device root
        expect([...created.keys()].every(id => id.startsWith('miner.dev.custom'))).to.equal(true);
        // states before their channel
        expect(deleted).to.deep.equal(['miner.dev.custom.old.feature', 'miner.dev.custom.old']);

        // a miner without custom features: the whole custom channel goes
        deleted.length = 0;
        created.clear();
        await adapter.createCustomStateObjects('miner.dev', []);
        expect(created.size).to.equal(0);
        expect(deleted).to.deep.equal([
            'miner.dev.custom.old.feature',
            'miner.dev.custom.light.on',
            'miner.dev.custom.light',
            'miner.dev.custom.old',
            'miner.dev.custom',
        ]);
    });

    it('keeps the objects of dynamic channels before the first poll and creates new ones when a poll reports them', async () => {
        const adapter = createTestAdapter() as unknown as CustomFeatureTestAdapter;
        const created: string[] = [];
        const deleted: string[] = [];
        adapter.namespace = 'miner.0';
        adapter.extendObject = id => {
            created.push(id);
            return Promise.resolve();
        };
        adapter.getObjectAsync = () => Promise.resolve({});
        adapter.getForeignObjectsAsync = () =>
            Promise.resolve({
                // from an earlier run: may carry e.g. history settings
                'miner.0.miner.dev.custom.hashboard1': {},
                'miner.0.miner.dev.custom.hashboard1.highestChipTemp': {},
                // a feature the template no longer has
                'miner.0.miner.dev.custom.hashboard1.removed': {},
                'miner.0.miner.dev.custom.old': {},
            });
        adapter.delObjectAsync = id => {
            deleted.push(id);
            return Promise.resolve();
        };
        const bos = new BOS({
            minerType: 'bos',
            id: 'dev',
            host: 'localhost',
            port: 50051,
            username: 'root',
            password: 'root',
            pollInterval: 1000,
        });

        await adapter.createCustomStateObjects('miner.dev', bos.getCustomChannels(), bos.getDynamicCustomChannels());

        expect(created).to.deep.equal(['miner.dev.custom']);
        expect(deleted).to.deep.equal(['miner.dev.custom.hashboard1.removed', 'miner.dev.custom.old']);

        // the first poll reports two boards
        created.length = 0;
        const [template] = bos.getDynamicCustomChannels();
        const boards = ['1', '2'].map(id => ({ ...template, id: `hashboard${id}`, label: `Hashboard ${id}` }));
        await adapter.createNewCustomChannels('miner.dev', boards);

        expect(created).to.include.members([
            'miner.dev.custom.hashboard1',
            'miner.dev.custom.hashboard1.highestChipTemp',
            'miner.dev.custom.hashboard2',
            'miner.dev.custom.hashboard2.chipsCount',
        ]);
        expect(created).to.have.length(2 * (template.features.length + 1));

        // later polls: nothing to create
        created.length = 0;
        await adapter.createNewCustomChannels('miner.dev', boards);
        expect(created).to.deep.equal([]);
    });

    /**
     * An adapter whose only device is a running miner with the given custom feature setter.
     *
     * @param setCustomFeature - the miner's custom feature setter
     */
    function adapterWithMiner(setCustomFeature: (id: string, value: unknown) => Promise<unknown>): {
        adapter: CustomFeatureTestAdapter;
        writes: { id: string; val: unknown; ack: boolean }[];
        warnings: string[];
    } {
        const adapter = createTestAdapter() as unknown as CustomFeatureTestAdapter;
        const writes: { id: string; val: unknown; ack: boolean }[] = [];
        const warnings: string[] = [];
        adapter.log = { info: () => {}, warn: msg => warnings.push(msg) };
        adapter.getObjectAsync = () =>
            Promise.resolve({
                native: { category: 'miner', name: 'Nano', settings: { id: 'dev', minerType: 'avalonMiner' } },
            });
        adapter.getStateAsync = () => Promise.resolve({ val: true });
        adapter.setState = (id, state) => {
            writes.push({ id, ...state });
            return Promise.resolve();
        };
        adapter.minerManager = {
            getMiner: id => (id === 'dev' ? { setCustomFeature } : undefined),
            hasMiner: id => id === 'dev',
            withExclusiveMinerCommand: (id, operation) => {
                if (id !== 'dev') {
                    throw new Error('Miner not found');
                }
                return operation({ setCustomFeature });
            },
        };
        return { adapter, writes, warnings };
    }

    it('sends a written custom state to the miner and acknowledges the value it took', async () => {
        const sent: [string, unknown][] = [];
        const { adapter, writes } = adapterWithMiner((id, value) => {
            sent.push([id, value]);
            return Promise.resolve(Number(value));
        });

        await adapter.onStateChange('miner.0.miner.dev.custom.light.brightness', { val: '40', ack: false });

        expect(sent).to.deep.equal([['light.brightness', '40']]);
        expect(writes).to.deep.equal([{ id: 'miner.0.miner.dev.custom.light.brightness', val: 40, ack: true }]);
    });

    it('leaves the state unacknowledged and warns when the miner rejects it', async () => {
        const { adapter, writes, warnings } = adapterWithMiner(() => Promise.reject(new Error('Invalid ascset')));

        await adapter.onStateChange('miner.0.miner.dev.custom.lcd.on', { val: true, ack: false });

        expect(writes).to.deep.equal([]);
        expect(warnings.join()).to.contain('Invalid ascset');
    });

    it('offers the writable custom features as device manager controls, grouped per channel', async () => {
        const adapter = createTestAdapter() as unknown as CustomFeatureTestAdapter & {
            getForeignStateAsync: (id: string) => Promise<{ val: unknown; ts: number } | null>;
        };
        adapter.getForeignStateAsync = id =>
            Promise.resolve(id.endsWith('.custom.light.brightness') ? { val: 40, ts: 1 } : null);
        const controls = await adapter.deviceManagement.getControls(
            'miner.0.miner.dev',
            avalon,
            avalon.getSupportedFeatures(),
        );

        expect(controls.map(c => [c.id, c.type])).to.deep.equal([
            ['control.profile', 'select'],
            ['custom.light', 'header'],
            ['custom.light.on', 'switch'],
            ['custom.light.effect', 'select'],
            ['custom.light.brightness', 'slider'],
            ['custom.light.colorTemperature', 'slider'],
            ['custom.light.color', 'color'],
            ['custom.lcd', 'header'],
            ['custom.lcd.on', 'switch'],
            // read-only filter.runtime / filter.cleanDue are card rows, not controls
            ['custom.filter', 'header'],
            ['custom.filter.reset', 'button'],
        ]);
        const brightness = controls.find(c => c.id === 'custom.light.brightness');
        expect(brightness?.stateId).to.equal('miner.0.miner.dev.custom.light.brightness');
        expect(brightness?.handler).to.be.a('function');
        // the GUI takes the value from getStateHandler on each change, and the initial one from state
        expect(brightness?.getStateHandler).to.be.a('function');
        expect(brightness?.state?.val).to.equal(40);
        expect(controls.find(c => c.id === 'custom.light.effect')?.options?.[0]).to.deep.equal({
            label: 'Static',
            value: 1,
        });
    });

    it('presses a button feature by writing true, as a button press carries no value', async () => {
        const adapter = createTestAdapter() as unknown as CustomFeatureTestAdapter & {
            getForeignStateAsync: () => Promise<null>;
            setForeignStateAsync: (id: string, state: { val: unknown; ack: boolean }) => Promise<void>;
        };
        const written: { id: string; val: unknown; ack: boolean }[] = [];
        adapter.getForeignStateAsync = () => Promise.resolve(null);
        adapter.setForeignStateAsync = (id, state) => {
            written.push({ id, ...state });
            return Promise.resolve();
        };
        const controls = await adapter.deviceManagement.getControls(
            'miner.0.miner.dev',
            avalon,
            avalon.getSupportedFeatures(),
        );
        const reset = controls.find(c => c.id === 'custom.filter.reset');

        await (reset?.handler as (deviceId: string, controlId: string, state: unknown) => Promise<unknown>)(
            'miner.0.miner.dev',
            'custom.filter.reset',
            null,
        );

        expect(written).to.deep.equal([{ id: 'miner.0.miner.dev.custom.filter.reset', val: true, ack: false }]);
    });
});

describe('state subscriptions', () => {
    it('subscribes to every writable state the adapter handles, custom features included', async () => {
        const adapter = createTestAdapter() as unknown as {
            config: { checkForUpdates: boolean };
            extendObject: () => Promise<void>;
            setState: () => Promise<void>;
            setObjectNotExistsAsync: () => Promise<void>;
            subscribeStates: (pattern: string) => void;
            onReady: () => Promise<void>;
        };
        const patterns: string[] = [];
        adapter.config.checkForUpdates = false;
        adapter.extendObject = () => Promise.resolve();
        adapter.setState = () => Promise.resolve();
        adapter.setObjectNotExistsAsync = () => Promise.resolve();
        adapter.subscribeStates = pattern => patterns.push(pattern);

        await adapter.onReady();

        const subscribed = (id: string): boolean =>
            patterns.some(p => new RegExp(`^${p.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`).test(id));
        for (const id of [
            'miner.dev.enabled',
            'miner.dev.control.profile',
            'miner.dev.custom.light.brightness',
            'miner.dev.custom.lcd.on',
        ]) {
            expect(subscribed(id), id).to.equal(true);
        }
    });
});

describe('profile read-back', () => {
    it('reflects the profile the miner reports in control.profile, only on change', async () => {
        const adapter = createTestAdapter() as unknown as {
            setState: () => Promise<void>;
            setStateChangedAsync: (id: string, state: { val: unknown; ack: boolean }) => Promise<void>;
            processNewStats: (miner: object, settings: object, stats: object) => Promise<void>;
        };
        const changed: { id: string; val: unknown; ack: boolean }[] = [];
        adapter.setState = () => Promise.resolve();
        adapter.setStateChangedAsync = (id, state) => {
            changed.push({ id, ...state });
            return Promise.resolve();
        };
        const miner = { getSupportedFeatures: () => [MinerFeatureKey.profile], getCustomChannels: () => [] };
        const settings = { category: 'miner', name: 'Nano', settings: { id: 'dev' } };

        await adapter.processNewStats(miner, settings, { profile: 'high' });
        await adapter.processNewStats(miner, settings, {});

        expect(changed.filter(c => c.id.endsWith('.profile'))).to.deep.equal([
            { id: 'miner.dev.control.profile', val: 'high', ack: true },
        ]);
    });
});

describe('custom feature notifications', () => {
    it('raises the notification once when a feature with one turns true', async () => {
        const adapter = createTestAdapter() as unknown as {
            log: { warn: (msg: string) => void; debug: () => void };
            setState: () => Promise<void>;
            getStateAsync: (id: string) => Promise<{ val: unknown } | null>;
            setStateChangedAsync: (id: string, state: { val: unknown; ack: boolean }) => Promise<void>;
            registerNotification: (scope: string, category: string, message: string) => Promise<void>;
            extendObject: () => Promise<void>;
            processNewStats: (miner: object, settings: object, stats: object) => Promise<void>;
        };
        const stored = new Map<string, unknown>();
        // processNewStats creates the objects of custom channels it sees for the first time
        adapter.extendObject = () => Promise.resolve();
        const notifications: [string, string, string][] = [];
        adapter.log = { warn: () => {}, debug: () => {} };
        adapter.setState = () => Promise.resolve();
        adapter.getStateAsync = id => Promise.resolve(stored.has(id) ? { val: stored.get(id) } : null);
        adapter.setStateChangedAsync = (id, state) => {
            stored.set(id, state.val);
            return Promise.resolve();
        };
        adapter.registerNotification = (scope, category, message) => {
            notifications.push([scope, category, message]);
            return Promise.resolve();
        };
        const miner = new AvalonMiner({
            minerType: 'avalonMiner',
            id: 'dev',
            host: 'localhost',
            port: 4028,
            pollInterval: 1000,
        });
        const settings = { category: 'miner', name: 'Nano', settings: { id: 'dev' } };

        await adapter.processNewStats(miner, settings, { custom: { 'filter.cleanDue': false } });
        await adapter.processNewStats(miner, settings, { custom: { 'filter.cleanDue': true } });
        await adapter.processNewStats(miner, settings, { custom: { 'filter.cleanDue': true } });

        expect(notifications).to.have.length(1);
        expect(notifications[0][0]).to.equal('miner');
        expect(notifications[0][1]).to.equal('filterClean');
        expect(notifications[0][2]).to.match(/^Miner "Nano": The dust filter should be cleaned/);

        // cleaned and reset, due again later: notified again
        await adapter.processNewStats(miner, settings, { custom: { 'filter.cleanDue': false } });
        await adapter.processNewStats(miner, settings, { custom: { 'filter.cleanDue': true } });
        expect(notifications).to.have.length(2);
    });
});

describe('PV VIS integration: two miners and lost relay feedback (no hardware)', () => {
    it('updates both miners through real monitor cycles, fails closed on S19 loss, and never unlocks', async () => {
        const adapter = createTestAdapter() as unknown as {
            config: Record<string, unknown>;
            getDevicesAsync: () => Promise<ioBroker.DeviceObject[]>;
            getForeignStateAsync: (id: string) => Promise<{
                val: number | boolean;
                ack: boolean;
                ts: number;
            } | null>;
            getStateAsync: (id: string) => Promise<{ val: unknown } | null>;
            setState: (id: string, state: { val: unknown; ack: boolean }) => Promise<void>;
            runPvMonitor: () => Promise<void>;
            pvRelayOffMiners: Set<string>;
            pvSafeStops: Set<string>;
        };
        const now = Date.now();
        const foreign = new Map<string, { val: number | boolean; ack: boolean; ts: number }>([
            ['relay.s9', { val: false, ack: true, ts: now }],
            ['relay.s19', { val: false, ack: true, ts: now }],
            ['power.s9', { val: 0, ack: true, ts: now }],
            ['power.s19', { val: 0, ack: true, ts: now }],
            ['pv.grid', { val: -4500, ack: true, ts: now }],
            ['pv.battery', { val: 0, ack: true, ts: now }],
        ]);
        const writes = new Map<string, unknown>();
        const devices = (['s9', 's19'] as const).map(id => ({
            _id: `miner.0.miner.${id}`,
            native: {
                category: 'miner',
                name: id,
                settings: { id, minerType: 'bosMiner' },
                pvControl: {
                    enabled: true,
                    relayStateId: `relay.${id}`,
                    relayOnValue: true,
                    powerStateId: `power.${id}`,
                    restartDelay: 180,
                    minPower: id === 's9' ? 500 : 1800,
                },
            },
        })) as unknown as ioBroker.DeviceObject[];
        adapter.config = {
            checkForUpdates: false,
            pvMaxDataAge: 15,
            pvGridPowerId: 'pv.grid',
            pvBatteryPowerId: 'pv.battery',
            pvReserve: 200,
        };
        adapter.getDevicesAsync = () => Promise.resolve(devices);
        adapter.getForeignStateAsync = id => Promise.resolve(foreign.get(id) ?? null);
        adapter.getStateAsync = async id => {
            if (!id.endsWith('.lastSafeStop')) {
                return null;
            }
            const minerId = id.includes('miner.s9.') ? 's9' : 's19';
            return {
                val: JSON.stringify({
                    minerId,
                    relayStateId: `relay.${minerId}`,
                    stoppedAt: now - 60_000,
                    relayOffConfirmed: true,
                }),
            };
        };
        adapter.setState = async (id, state) => {
            writes.set(id, state.val);
        };
        adapter.pvRelayOffMiners.add('s9');
        adapter.pvRelayOffMiners.add('s19');

        await adapter.runPvMonitor();
        for (const id of ['s9', 's19']) {
            const prefix = `pvControl.miners.miner.${id}`;
            expect(writes.get(`${prefix}.relayOn`)).to.equal(false);
            expect(writes.get(`${prefix}.restartCountdown`)).to.be.a('number');
            expect(writes.get(`${prefix}.restartLocked`)).to.equal(true);
            expect(writes.get(`${prefix}.safetyReason`)).to.equal('restart_delay_running');
        }

        // S19 loses its acknowledgement while S9 continues normally.
        foreign.set('relay.s19', { val: false, ack: false, ts: now });
        await adapter.runPvMonitor();
        expect(writes.get('pvControl.miners.miner.s19.relayOn')).to.equal(null);
        expect(writes.get('pvControl.miners.miner.s19.restartCountdown')).to.equal(null);
        expect(writes.get('pvControl.miners.miner.s19.safetyReason')).to.equal('relay_feedback_missing_or_stale');
        expect(writes.get('pvControl.miners.miner.s19.restartLocked')).to.equal(true);
        expect(writes.get('pvControl.miners.miner.s9.relayOn')).to.equal(false);
        expect(writes.get('pvControl.miners.miner.s9.safetyReason')).to.equal('restart_delay_running');

        // Recovery restores diagnostics, but never removes either command lock.
        foreign.set('relay.s19', { val: false, ack: true, ts: Date.now() });
        await adapter.runPvMonitor();
        expect(writes.get('pvControl.miners.miner.s19.relayOn')).to.equal(false);
        expect(writes.get('pvControl.miners.miner.s19.safetyReason')).to.equal('restart_delay_running');
        expect(adapter.pvRelayOffMiners.has('s9')).to.equal(true);
        expect(adapter.pvRelayOffMiners.has('s19')).to.equal(true);
        expect(adapter.pvSafeStops.size).to.equal(0);
    });
});

describe('PV diagnostics after adapter restart and interrupted monitoring (no hardware)', () => {
    it('reinitializes S9 and S19 VIS diagnostics as locked, without trusting old displayed values', async () => {
        const adapter = createTestAdapter() as unknown as {
            config: { checkForUpdates: boolean };
            pvRelayOffMiners: Set<string>;
            minerManager: { init: () => Promise<object>; getMiners: () => object[] };
            restorePvStopDiagnostics: () => Promise<void>;
            createDeviceStateObjects: () => Promise<void>;
            writeStaticInfoStates: () => Promise<void>;
            extendObject: () => Promise<void>;
            getStateAsync: (id: string) => Promise<{ val: unknown } | null>;
            setState: (id: string, state: { val: unknown }) => Promise<void>;
            setStateChangedAsync: () => Promise<void>;
            initDevice: (device: ioBroker.DeviceObject) => Promise<void>;
        };
        const writes = new Map<string, unknown>();
        adapter.config.checkForUpdates = false;
        adapter.restorePvStopDiagnostics = async () => {};
        adapter.minerManager = {
            init: async () => {
                throw new Error('simulated offline miner');
            },
            getMiners: () => [],
        };
        adapter.createDeviceStateObjects = async () => {};
        adapter.writeStaticInfoStates = async () => {};
        adapter.extendObject = async () => {};
        adapter.getStateAsync = async () => null;
        adapter.setStateChangedAsync = async () => {};
        adapter.setState = async (id, state) => {
            writes.set(id, state.val);
        };
        for (const id of ['s9', 's19']) {
            const prefix = `pvControl.miners.miner.${id}`;
            // Simulate VIS values persisted from the previous adapter process.
            writes.set(`${prefix}.restartLocked`, false);
            writes.set(`${prefix}.relayOn`, true);
            writes.set(`${prefix}.restartCountdown`, 0);
            writes.set(`${prefix}.safetyReason`, 'no_observed_blocker');
            await adapter.initDevice({
                _id: `miner.0.miner.${id}`,
                native: {
                    category: 'miner',
                    name: id,
                    enabled: true,
                    settings: { id, minerType: 'bos', host: 'localhost' },
                    pvControl: { enabled: true },
                },
            } as unknown as ioBroker.DeviceObject);
            expect(adapter.pvRelayOffMiners.has(id)).to.equal(true);
            expect(writes.get(`${prefix}.restartLocked`)).to.equal(true);
            expect(writes.get(`${prefix}.relayOn`)).to.equal(null);
            expect(writes.get(`${prefix}.restartCountdown`)).to.equal(null);
            expect(writes.get(`${prefix}.safetyReason`)).to.equal('adapter_restart_requires_fresh_safety_validation');
        }
    });

    it('invalidates stale relay/countdown after a feedback read fails mid-monitor, keeping the lock', async () => {
        const adapter = createTestAdapter() as unknown as {
            config: Record<string, unknown>;
            getDevicesAsync: () => Promise<ioBroker.DeviceObject[]>;
            getForeignStateAsync: (id: string) => Promise<{ val: number | boolean; ack: boolean; ts: number } | null>;
            getStateAsync: (id: string) => Promise<{ val: unknown } | null>;
            setState: (id: string, state: { val: unknown }) => Promise<void>;
            runPvMonitor: () => Promise<void>;
            pvRelayOffMiners: Set<string>;
        };
        const now = Date.now();
        const prefix = 'pvControl.miners.miner.s19';
        const writes = new Map<string, unknown>();
        let failFeedback = false;
        adapter.config = {
            pvMaxDataAge: 15,
            pvGridPowerId: 'pv.grid',
            pvBatteryPowerId: 'pv.battery',
            pvReserve: 200,
        };
        adapter.getDevicesAsync = async () => [
            {
                _id: 'miner.0.miner.s19',
                native: {
                    category: 'miner',
                    name: 's19',
                    settings: { id: 's19', minerType: 'bosMiner' },
                    pvControl: {
                        enabled: true,
                        relayStateId: 'relay.s19',
                        relayOnValue: true,
                        powerStateId: 'power.s19',
                        restartDelay: 180,
                        minPower: 1800,
                    },
                },
            } as unknown as ioBroker.DeviceObject,
        ];
        adapter.getForeignStateAsync = async id => {
            if (id === 'relay.s19') {
                if (failFeedback) {
                    throw new Error('simulated Sonoff timeout');
                }
                return { val: false, ack: true, ts: now };
            }
            if (id === 'power.s19') {
                return { val: 0, ack: true, ts: now };
            }
            if (id === 'pv.grid') {
                return { val: -4500, ack: true, ts: now };
            }
            if (id === 'pv.battery') {
                return { val: 0, ack: true, ts: now };
            }
            return null;
        };
        adapter.getStateAsync = async id =>
            id === `${prefix}.lastSafeStop`
                ? {
                      val: JSON.stringify({
                          minerId: 's19',
                          relayStateId: 'relay.s19',
                          stoppedAt: now - 60_000,
                          relayOffConfirmed: true,
                      }),
                  }
                : null;
        adapter.setState = async (id, state) => {
            writes.set(id, state.val);
        };
        adapter.pvRelayOffMiners.add('s19');

        await adapter.runPvMonitor();
        expect(writes.get(`${prefix}.relayOn`)).to.equal(false);
        expect(writes.get(`${prefix}.restartCountdown`)).to.be.a('number');

        failFeedback = true;
        await adapter.runPvMonitor();
        expect(writes.get(`${prefix}.relayOn`)).to.equal(null);
        expect(writes.get(`${prefix}.restartCountdown`)).to.equal(null);
        expect(writes.get(`${prefix}.restartLocked`)).to.equal(true);
        expect(writes.get(`${prefix}.safetyReason`)).to.equal('relay_feedback_missing_or_stale');
        expect(adapter.pvRelayOffMiners.has('s19')).to.equal(true);
    });
});

describe('PV S9/S19 real MinerManager command interlock (mocked miners)', () => {
    it('blocks start, profile and power commands for both locked miners independently', async () => {
        const adapter = createTestAdapter() as unknown as {
            pvRelayOffMiners: Set<string>;
            minerManager: {
                getMiners: () => Array<{ settings: { id: string } }>;
                startMiner: (id: string) => Promise<void>;
                setProfile: (id: string, profile: string) => Promise<void>;
                setPowerTarget: (id: string, watts: number) => Promise<void>;
            };
        };
        const calls: string[] = [];
        const miners = adapter.minerManager.getMiners();
        for (const id of ['s9', 's19', 'other']) {
            miners.push({
                settings: { id },
                start: async () => {
                    calls.push(`${id}.start`);
                },
                setProfile: async () => {
                    calls.push(`${id}.profile`);
                },
                setPowerTarget: async () => {
                    calls.push(`${id}.power`);
                },
            } as unknown as { settings: { id: string } });
        }
        // Install fake miners in the real manager's private collection.
        const manager = adapter.minerManager as unknown as {
            miners: typeof miners;
        };
        manager.miners.push(...miners);

        adapter.pvRelayOffMiners.add('s9');
        adapter.pvRelayOffMiners.add('s19');
        for (const id of ['s9', 's19']) {
            for (const operation of [
                () => adapter.minerManager.startMiner(id),
                () => adapter.minerManager.setProfile(id, 'normal'),
                () => adapter.minerManager.setPowerTarget(id, 800),
            ]) {
                let rejected = false;
                try {
                    await operation();
                } catch (error) {
                    rejected = true;
                    expect(String(error)).to.include('command blocked by PV safe stop');
                }
                expect(rejected, `${id} command must be blocked`).to.equal(true);
            }
        }
        expect(calls).to.deep.equal([]);

        // A separate miner is unaffected by the two locked miners.
        await adapter.minerManager.startMiner('other');
        await adapter.minerManager.setProfile('other', 'normal');
        await adapter.minerManager.setPowerTarget('other', 800);
        expect(calls).to.deep.equal(['other.start', 'other.profile', 'other.power']);

        // Recovering S19 feedback alone must not remove either lock.
        expect(adapter.pvRelayOffMiners.has('s9')).to.equal(true);
        expect(adapter.pvRelayOffMiners.has('s19')).to.equal(true);
    });
});

describe('PV ioBroker stateChange command interlock (mocked IO)', () => {
    it('blocks queued S9 and S19 start/profile/power commands after their locks activate', async () => {
        const adapter = createTestAdapter() as unknown as {
            pvRelayOffMiners: Set<string>;
            minerManager: {
                miners: Array<unknown>;
                startMiner: (id: string) => Promise<void>;
                setProfile: (id: string, profile: string) => Promise<void>;
                setPowerTarget: (id: string, power: number) => Promise<void>;
            };
        };
        const calls: string[] = [];
        for (const id of ['s9', 's19']) {
            adapter.minerManager.miners.push({
                settings: { id },
                start: async () => {
                    calls.push(`${id}.start`);
                },
                setProfile: async () => {
                    calls.push(`${id}.profile`);
                },
                setPowerTarget: async () => {
                    calls.push(`${id}.power`);
                },
            });
        }
        // A command waiting behind a previous operation must check the guard
        // when it reaches the queue, not only when it is first requested.
        let release!: () => void;
        const blocker = new Promise<void>(resolve => {
            release = resolve;
        });
        const manager = adapter.minerManager as typeof adapter.minerManager & {
            withExclusiveMiner: (id: string, fn: () => Promise<void>) => Promise<void>;
        };
        const active = manager.withExclusiveMiner('s9', async () => {
            await blocker;
        });
        const queued = [
            adapter.minerManager.startMiner('s9'),
            adapter.minerManager.setProfile('s9', 'normal'),
            adapter.minerManager.setPowerTarget('s9', 800),
        ];
        adapter.pvRelayOffMiners.add('s9');
        adapter.pvRelayOffMiners.add('s19');
        release();
        await active;
        for (const promise of queued) {
            let failure: unknown;
            try {
                await promise;
            } catch (error) {
                failure = error;
            }
            expect(String(failure)).to.include('command blocked by PV safe stop');
        }
        for (const operation of [
            () => adapter.minerManager.startMiner('s19'),
            () => adapter.minerManager.setProfile('s19', 'normal'),
            () => adapter.minerManager.setPowerTarget('s19', 1800),
        ]) {
            let failure: unknown;
            try {
                await operation();
            } catch (error) {
                failure = error;
            }
            expect(String(failure)).to.include('command blocked by PV safe stop');
        }
        expect(calls).to.deep.equal([]);
    });
});

describe('PV direct ioBroker control state interlock (mocked IO)', () => {
    for (const minerId of ['s9', 's19']) {
        it(`blocks unacknowledged running/profile/powerTarget writes for locked ${minerId}`, async () => {
            const adapter = createTestAdapter() as unknown as {
                pvRelayOffMiners: Set<string>;
                onStateChange: (id: string, state: ioBroker.State) => Promise<void>;
                getObjectAsync: (id: string) => Promise<unknown>;
                getStateAsync: (id: string) => Promise<{ val: boolean }>;
                setState: (id: string, state: unknown) => Promise<void>;
                minerManager: {
                    miners: Array<unknown>;
                };
            };
            const calls: string[] = [];
            adapter.minerManager.miners.push({
                settings: { id: minerId },
                start: async () => {
                    calls.push('start');
                },
                setProfile: async () => {
                    calls.push('profile');
                },
                setPowerTarget: async () => {
                    calls.push('powerTarget');
                },
            });
            adapter.pvRelayOffMiners.add(minerId);
            adapter.getObjectAsync = async id =>
                id.endsWith('.control.powerTarget')
                    ? { common: { min: 100, max: 3000 } }
                    : {
                          native: {
                              category: 'miner',
                              name: minerId,
                              settings: { id: minerId, minerType: 'bosMiner' },
                          },
                      };
            adapter.getStateAsync = async () => ({ val: true });
            const acknowledgements: string[] = [];
            adapter.setState = async id => {
                acknowledgements.push(id);
            };
            for (const [feature, value] of [
                ['running', true],
                ['profile', 'normal'],
                ['powerTarget', 800],
            ] as const) {
                const stateId = `miner.0.miner.${minerId}.control.${feature}`;
                let failure: unknown;
                try {
                    await adapter.onStateChange(stateId, {
                        val: value,
                        ack: false,
                        ts: Date.now(),
                    } as ioBroker.State);
                } catch (error) {
                    failure = error;
                }
                if (feature === 'profile' || feature === 'powerTarget') {
                    // Both are rejected directly by the adapter before reaching the manager.
                    expect(failure).to.equal(undefined);
                } else {
                    // Running is rejected by the real manager guard.
                    expect(String(failure)).to.include('command blocked by PV safe stop');
                }
            }
            expect(calls).to.deep.equal([]);
            expect(acknowledgements).to.deep.equal([]);
            expect(adapter.pvRelayOffMiners.has(minerId)).to.equal(true);
        });
    }
});

describe('PV direct powerTarget guard before manager dispatch (mocked IO)', () => {
    it('never calls the manager for a locked S9 even when the manager is replaced', async () => {
        const adapter = createTestAdapter() as unknown as {
            pvRelayOffMiners: Set<string>;
            onStateChange: (id: string, state: ioBroker.State) => Promise<void>;
            getObjectAsync: (id: string) => Promise<unknown>;
            getStateAsync: (id: string) => Promise<{ val: boolean }>;
            setState: (id: string, state: unknown) => Promise<void>;
            minerManager: { setPowerTarget: (id: string, watts: number) => Promise<void> };
        };
        let dispatched = 0;
        adapter.pvRelayOffMiners.add('s9');
        adapter.getObjectAsync = async id =>
            id.endsWith('.control.powerTarget')
                ? { common: { min: 100, max: 3000 } }
                : {
                      native: {
                          category: 'miner',
                          name: 'S9',
                          settings: { id: 's9', minerType: 'bosMiner' },
                      },
                  };
        adapter.getStateAsync = async () => ({ val: true });
        adapter.setState = async () => {
            throw new Error('blocked command must not be acknowledged');
        };
        adapter.minerManager.setPowerTarget = async () => {
            dispatched++;
        };
        await adapter.onStateChange('miner.0.miner.s9.control.powerTarget', {
            val: 800,
            ack: false,
            ts: Date.now(),
        } as ioBroker.State);
        expect(dispatched).to.equal(0);
        expect(adapter.pvRelayOffMiners.has('s9')).to.equal(true);
    });
});

describe('PV dual-miner changing-surplus monitor (read-only mocked IO)', () => {
    it('updates S9/S19 diagnostics across export, battery charging, import and stale telemetry without actuator writes', async () => {
        const adapter = createTestAdapter() as unknown as {
            config: Record<string, unknown>;
            getDevicesAsync: () => Promise<ioBroker.DeviceObject[]>;
            getForeignStateAsync: (id: string) => Promise<{ val: number | boolean; ts: number; ack: boolean } | null>;
            getStateAsync: (id: string) => Promise<{ val: unknown } | null>;
            setState: (id: string, state: { val: unknown; ack: boolean }) => Promise<void>;
            setForeignStateAsync: (id: string, value: unknown) => Promise<void>;
            runPvMonitor: () => Promise<void>;
            pvRelayOffMiners: Set<string>;
        };
        const writes = new Map<string, unknown>();
        const now = Date.now();
        const sensors = new Map<string, { val: number | boolean; ts: number; ack: boolean }>();
        const put = (id: string, val: number | boolean, ts = now): void => {
            sensors.set(id, { val, ts, ack: true });
        };
        for (const id of ['s9', 's19']) {
            put(`relay.${id}`, false);
            put(`power.${id}`, 0);
            put(`running.${id}`, false);
            put(`target.${id}`, id === 's9' ? 500 : 1800);
        }
        put('grid', -4000);
        put('battery', -1000);
        put('soc', 70);
        adapter.config = {
            pvEnabled: false,
            pvMaxDataAge: 15,
            pvInterval: 120,
            pvGridPowerId: 'grid',
            pvBatteryPowerId: 'battery',
            pvBatterySocId: 'soc',
            pvReserve: 200,
            pvS9TargetStateId: 'target.s9',
            pvS19TargetStateId: 'target.s19',
            pvS9RunningStateId: 'running.s9',
            pvS19RunningStateId: 'running.s19',
            pvS9ActualPowerId: 'power.s9',
            pvS19ActualPowerId: 'power.s19',
        };
        adapter.getDevicesAsync = async () =>
            (['s9', 's19'] as const).map(id => ({
                _id: `miner.0.miner.${id}`,
                native: {
                    category: 'miner',
                    name: id,
                    settings: { id, minerType: 'bosMiner' },
                    pvControl: {
                        enabled: true,
                        relayStateId: `relay.${id}`,
                        powerStateId: `power.${id}`,
                        relayOnValue: true,
                        restartDelay: 180,
                        minPower: id === 's9' ? 500 : 1800,
                    },
                },
            })) as unknown as ioBroker.DeviceObject[];
        adapter.getForeignStateAsync = async id => sensors.get(id) ?? null;
        adapter.getStateAsync = async () => null;
        adapter.setState = async (id, state) => {
            writes.set(id, state.val);
        };
        adapter.setForeignStateAsync = async () => {
            throw new Error('PV monitor must never write an actuator state');
        };
        adapter.pvRelayOffMiners.add('s9');
        adapter.pvRelayOffMiners.add('s19');

        await adapter.runPvMonitor();
        expect(writes.get('pvControl.valid')).to.equal(true);
        expect(writes.get('pvControl.surplus')).to.equal(3800);
        expect(writes.get('pvControl.miners.miner.s9.restartLocked')).to.equal(true);
        expect(writes.get('pvControl.miners.miner.s19.restartLocked')).to.equal(true);

        put('grid', -1500);
        put('battery', -800);
        await adapter.runPvMonitor();
        expect(writes.get('pvControl.surplus')).to.equal(1300);

        // One stale S9 target invalidates the entire shared allocation.
        put('target.s9', 500, now - 130_000);
        await adapter.runPvMonitor();
        expect(writes.get('pvControl.s9SuggestedTarget')).to.equal(null);
        expect(writes.get('pvControl.s19SuggestedTarget')).to.equal(null);
        expect(String(writes.get('pvControl.s19Decision'))).to.include('Unavailable');
        put('target.s9', 500);

        put('grid', 600);
        put('battery', 500);
        await adapter.runPvMonitor();
        expect(writes.get('pvControl.surplus')).to.equal(0);

        // Stale grid data must invalidate both calculations, not reuse previous surplus.
        put('grid', -4000, now - 60_000);
        await adapter.runPvMonitor();
        expect(writes.get('pvControl.valid')).to.equal(false);
        expect(writes.get('pvControl.surplus')).to.equal(null);
        expect(writes.get('pvControl.v243Available')).to.equal(null);
        expect(writes.get('pvControl.s9SuggestedTarget')).to.equal(null);
        expect(writes.get('pvControl.s19SuggestedTarget')).to.equal(null);
        expect(String(writes.get('pvControl.s9Decision'))).to.include('Unavailable');
        expect(String(writes.get('pvControl.s19Decision'))).to.include('Unavailable');
        for (const id of ['s9', 's19']) {
            expect(writes.get(`pvControl.miners.miner.${id}.restartLocked`)).to.equal(true);
            expect(adapter.pvRelayOffMiners.has(id)).to.equal(true);
        }
        expect(writes.get('pvControl.status')).to.equal('Missing or stale PV measurements; no commands sent');
    });
});

/**
 * Direct tests of the actual private safeStopPvMiner method using a controller-free
 * adapter. No real miner, Sonoff relay, or ioBroker instance is contacted.
 */
describe('PV S9 safeStopPvMiner direct integration (mocked IO)', () => {
    type StopSettings = IOBrokerMinerSettings;
    type StopHarness = {
        safeStopPvMiner: (settings: StopSettings) => Promise<void>;
        config: { pvEnabled: boolean; pvMaxDataAge: number };
        minerManager: {
            withExclusiveMiner: (
                id: string,
                fn: (miner: { stop: () => Promise<void> }) => Promise<void>,
            ) => Promise<void>;
        };
        getDeviceObjectId: (settings: StopSettings) => string;
        getForeignStateAsync: (id: string) => Promise<{ val: boolean; ts: number; ack: boolean }>;
        getStateAsync: (id: string) => Promise<{ val: number; ts: number }>;
        readFreshPvMeasurement: (id: string, maxAgeMs: number) => Promise<{ value: number; timestamp: number }>;
        setForeignStateAsync: (id: string, value: boolean) => Promise<void>;
    };

    function setup(): { adapter: StopHarness; settings: StopSettings; commands: string[] } {
        const adapter = createTestAdapter() as unknown as StopHarness;
        const commands: string[] = [];
        adapter.config = { pvEnabled: true, pvMaxDataAge: 180 };
        adapter.getDeviceObjectId = () => 'S9';
        adapter.minerManager = {
            withExclusiveMiner: async (_id, fn) =>
                fn({
                    stop: async () => {
                        commands.push('pause');
                    },
                }),
        };
        adapter.getForeignStateAsync = () => Promise.resolve({ val: true, ts: Date.now(), ack: true });
        adapter.getStateAsync = () => Promise.resolve({ val: 0, ts: Date.now() });
        adapter.readFreshPvMeasurement = () => Promise.resolve({ value: 0, timestamp: Date.now() });
        adapter.setForeignStateAsync = async () => {
            commands.push('relay.off');
        };
        const settings = {
            name: 'S9',
            settings: { id: 'S9', minerType: 'bosMiner' },
            pvControl: {
                relayStateId: 'sonoff.0.Aktor_MinerS9.POWER',
                powerStateId: 'sonoff.0.Aktor_MinerS9.ENERGY_Power',
                relayOnValue: true,
                powerSampleMaxGap: 180,
            },
        } as StopSettings;
        return { adapter, settings, commands };
    }

    it('runs real safeStopPvMiner through three pre-OFF and three post-OFF S9 readings', async () => {
        const { adapter, settings, commands } = setup();
        const harness = adapter as StopHarness & {
            delay: (ms: number) => Promise<void>;
            extendObject: (id: string, object: unknown) => Promise<void>;
            setState: (id: string, state: { val: string; ack: boolean }) => Promise<void>;
            pvRelayOffMiners: Set<string>;
            pvSafeStops: Set<string>;
        };
        const originalNow = Date.now;
        let clock = 1_800_000_000_000;
        const pauseAt = clock;
        let offAt: number | undefined;
        const persisted = new Map<string, string>();
        try {
            Date.now = () => clock;
            harness.delay = async ms => {
                clock += ms;
            };
            harness.getStateAsync = async id => ({
                val: id.endsWith('lastSeen') ? clock : 0,
                ts: clock,
            });
            harness.readFreshPvMeasurement = async (_id, maxAgeMs) => {
                const origin = offAt ?? pauseAt;
                const elapsed = clock - origin;
                const index = Math.floor(elapsed / 130_000);
                const timestamp = index === 0 ? origin - 1 : origin + index * 130_000;
                if (clock - timestamp > maxAgeMs) {
                    throw new Error('Stale S9 telemetry');
                }
                return { value: offAt === undefined ? 50 : 0, timestamp };
            };
            harness.getForeignStateAsync = async () => ({
                val: offAt === undefined,
                ts: clock,
                ack: true,
            });
            harness.setForeignStateAsync = async (_id, value) => {
                expect(value).to.equal(false);
                expect(clock - pauseAt).to.be.at.least(390_000);
                offAt = clock;
                commands.push('relay.off');
            };
            harness.extendObject = async () => {};
            harness.setState = async (id, state) => {
                expect(state.ack).to.equal(true);
                persisted.set(id, state.val);
            };

            await harness.safeStopPvMiner(settings);

            expect(commands).to.deep.equal(['pause', 'relay.off']);
            expect(offAt).to.be.a('number');
            expect(clock - offAt!).to.be.at.least(390_000);
            expect(persisted.size).to.equal(1);
            const record = JSON.parse([...persisted.values()][0]) as {
                minerId: string;
                relayOffConfirmed: boolean;
            };
            expect(record.minerId).to.equal('S9');
            expect(record.relayOffConfirmed).to.equal(true);
            expect(harness.pvRelayOffMiners.has('S9')).to.equal(true);
            expect(harness.pvSafeStops.has('S9')).to.equal(false);
        } finally {
            Date.now = originalNow;
        }
    });

    /**
     * Drives the real adapter method with virtual time. The mock only supplies
     * sensor/relay IO; it does not reproduce the shutdown decision logic.
     *
     * @param scenario
     */
    async function runFailureScenario(
        scenario:
            | 'relay-stays-on'
            | 'high-power-after-off'
            | 'miner-communication-loss'
            | 'adapter-unload'
            | 'pre-off-timeout',
    ): Promise<{ commands: string[]; error: string; locked: boolean; records: number }> {
        const { adapter, settings, commands } = setup();
        const harness = adapter as StopHarness & {
            delay: (ms: number) => Promise<void>;
            pvShuttingDown: boolean;
            pvRelayOffMiners: Set<string>;
            pvSafeStops: Set<string>;
            setState: (id: string, state: { val: string }) => Promise<void>;
            extendObject: (id: string, object: unknown) => Promise<void>;
        };
        const originalNow = Date.now;
        let clock = 1_800_000_000_000;
        const started = clock;
        let offAt: number | undefined;
        let records = 0;
        try {
            Date.now = () => clock;
            harness.delay = async ms => {
                clock += ms;
                if (scenario === 'adapter-unload' && clock - started >= 5_000) {
                    harness.pvShuttingDown = true;
                }
            };
            harness.getStateAsync = async id => {
                if (scenario === 'miner-communication-loss' && clock - started >= 5_000) {
                    throw new Error('S9 communication lost');
                }
                return { val: id.endsWith('lastSeen') ? clock : 0, ts: clock };
            };
            harness.readFreshPvMeasurement = async () => {
                const origin = offAt ?? started;
                const elapsed = clock - origin;
                const index = Math.floor(elapsed / 130_000);
                const timestamp = index === 0 ? origin - 1 : origin + index * 130_000;
                return {
                    value:
                        scenario === 'pre-off-timeout'
                            ? 900
                            : offAt !== undefined && scenario === 'high-power-after-off'
                              ? 900
                              : offAt === undefined
                                ? 50
                                : 0,
                    timestamp,
                };
            };
            harness.getForeignStateAsync = async () => ({
                val: offAt === undefined || scenario === 'relay-stays-on',
                ts: clock,
                ack: true,
            });
            harness.setForeignStateAsync = async (_id, value) => {
                expect(value).to.equal(false);
                commands.push('relay.off');
                offAt = clock;
            };
            harness.setState = async () => {
                records++;
            };
            harness.extendObject = async () => {};

            let error = '';
            try {
                await harness.safeStopPvMiner(settings);
            } catch (caught) {
                error = String(caught);
            }
            return {
                commands,
                error,
                locked: harness.pvRelayOffMiners.has('S9'),
                records,
            };
        } finally {
            Date.now = originalNow;
        }
    }

    it('keeps S9 locked if Sonoff still reports ON after relay OFF request', async () => {
        const result = await runFailureScenario('relay-stays-on');
        expect(result.commands).to.deep.equal(['pause', 'relay.off']);
        expect(result.error).to.include('three near-zero power samples were not confirmed');
        expect(result.locked).to.equal(true);
        expect(result.records).to.equal(0);
    });

    it('keeps S9 locked if power rises after relay OFF request', async () => {
        const result = await runFailureScenario('high-power-after-off');
        expect(result.commands).to.deep.equal(['pause', 'relay.off']);
        expect(result.error).to.include('three near-zero power samples were not confirmed');
        expect(result.locked).to.equal(true);
        expect(result.records).to.equal(0);
    });

    it('does not switch S9 relay OFF after miner communication fails', async () => {
        const result = await runFailureScenario('miner-communication-loss');
        expect(result.commands).to.deep.equal(['pause']);
        expect(result.error).to.include('S9 communication lost');
        expect(result.records).to.equal(0);
    });

    it('does not switch S9 relay OFF when adapter unload begins', async () => {
        const result = await runFailureScenario('adapter-unload');
        expect(result.commands).to.deep.equal(['pause']);
        expect(result.error).to.include('PV automation disabled during safe stop');
        expect(result.records).to.equal(0);
    });

    it('times out safely without relay OFF if S9 never reaches low power', async () => {
        const result = await runFailureScenario('pre-off-timeout');
        expect(result.commands).to.deep.equal(['pause']);
        expect(result.error).to.include('PV safe stop timed out');
        expect(result.records).to.equal(0);
    });

    it('never issues relay OFF when the miner pause command fails', async () => {
        const { adapter, settings, commands } = setup();
        adapter.minerManager.withExclusiveMiner = async (_id, fn) =>
            fn({
                stop: async () => {
                    commands.push('pause');
                    throw new Error('S9 pause rejected');
                },
            });
        try {
            await adapter.safeStopPvMiner(settings);
            expect.fail('Expected safe stop to reject');
        } catch (error) {
            expect(String(error)).to.include('S9 pause rejected');
        }
        expect(commands).to.deep.equal(['pause']);
    });

    it('never issues pause or relay OFF when required Sonoff datapoints are absent', async () => {
        const { adapter, settings, commands } = setup();
        const invalid = {
            ...settings,
            pvControl: { ...settings.pvControl, relayStateId: '' },
        } as StopSettings;
        try {
            await adapter.safeStopPvMiner(invalid);
            expect.fail('Expected safe stop to reject');
        } catch (error) {
            expect(String(error)).to.include('relayStateId and powerStateId required');
        }
        expect(commands).to.deep.equal([]);
    });

    it('never issues pause or relay OFF for a miner other than BOSMiner', async () => {
        const { adapter, settings, commands } = setup();
        const invalid = {
            ...settings,
            settings: { ...settings.settings, minerType: 'cgMiner' },
        };
        try {
            await adapter.safeStopPvMiner(invalid);
            expect.fail('Expected safe stop to reject');
        } catch (error) {
            expect(String(error)).to.include('only implemented for BOSMiner');
        }
        expect(commands).to.deep.equal([]);
    });
});
