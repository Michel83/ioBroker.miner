import * as utils from '@iobroker/adapter-core';
import type {} from './lib/adapter-config';
import { I18n } from '@iobroker/adapter-core';
import MinerAdapterDeviceManagement from './lib/MinerAdapterDeviceManagement';
import { categoryKeys } from './lib/miner/model/Category';
import { MinerManager } from './lib/miner/miner/MinerManager';
import type { IOBrokerDeviceSettings, IOBrokerMinerSettings } from './miner/model/IOBrokerMinerSettings';
import { decryptDeviceSettings, encryptDeviceSettings, isMiner } from './miner/model/IOBrokerMinerSettings';
import { Level } from './lib/miner/model/Level';
import {
    getMinerFeatureFullId,
    MinerFeatureCategory,
    MinerFeatureKey,
    minerFeatures,
} from './lib/miner/model/MinerFeature';
import { createMiner } from './lib/miner/miner/MinerFactory';
import { Logger } from './lib/miner/model/Logger';
import { isWithinPowerTargetConstraints, type Miner } from './lib/miner/miner/Miner';
import type { MinerSettings } from './lib/miner/model/MinerSettings';
import type { MinerStats } from './lib/miner/model/MinerStats';
import { asyncDynamicInterval, setTimerBackend, type AsyncIntervalReturnType } from './lib/utils/delay';
import { PvShutdownConfirmation, isPvShutdownSafe, parsePvPersistedStop } from './lib/pv/PvShutdownSafety';
import { UpdateSources } from './lib/update/UpdateSources';
import { runUpdateChecks, type UpdateCheckSummary } from './lib/update/runUpdateChecks';
import type { UpdateCheckContext, UpdateCheckResult } from './lib/miner/model/UpdateCheckResult';
import {
    CUSTOM_CHANNEL,
    findDynamicCustomChannel,
    resolveCustomFeatures,
    type CustomChannelDefinition,
    type CustomFeatureNotification,
    type DynamicCustomChannelDefinition,
} from './lib/miner/model/CustomFeature';

/** First update check shortly after start, once the miners are initialized and reachable. */
const UPDATE_CHECK_INITIAL_DELAY_MS = 60_000;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 *
 */
export class MinerAdapter extends utils.Adapter {
    private readonly deviceManagement: MinerAdapterDeviceManagement;
    public readonly minerManager: MinerManager = new MinerManager();
    private readonly updateSources = new UpdateSources();
    private updateCheckHandle: AsyncIntervalReturnType | undefined;
    private pvMonitorTimer: ReturnType<typeof setInterval> | undefined;
    private pvMonitorBusy = false;
    private pvMonitorWarning = '';
    private readonly pvSafeStops = new Set<string>();
    private readonly pvRelayOffMiners = new Set<string>();
    private pvShuttingDown = false;

    /**
     * The devices whose miner is reachable, by object id, with names listed in `info.connectedMiners`.
     */
    private readonly onlineDevices = new Map<string, string>();
    /**
     * The custom channels whose objects exist, by device object id. Instances of dynamic channels (see
     * DynamicCustomChannelDefinition) are created when a poll first reports them.
     */
    private readonly customChannelObjects = new Map<string, Set<string>>();

    /**
     *
     * @param options - adapter options
     */
    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'miner',
        });
        setTimerBackend({
            schedule: (callback, timeout) => this.setTimeout(callback, timeout),
            clear: timer => this.clearTimeout(timer as ioBroker.Timeout | undefined),
            scheduleInterval: (callback, interval) => this.setInterval(callback, interval),
            clearInterval: timer => this.clearInterval(timer as ioBroker.Interval | undefined),
            delay: timeout => this.delay(timeout),
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.minerManager.setCommandGuard(
            id => !this.pvSafeStops.has(id) && !this.pvRelayOffMiners.has(id) && !this.pvShuttingDown,
        );
        this.deviceManagement = new MinerAdapterDeviceManagement(this);
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        this.setupMinerLib();

        // Initialize i18n for device management translations
        await I18n.init(__dirname, this);

        // The adapter is operational even when all PV-controlled miners are offline.
        // Keep the admin connection indicator independent of miner availability.
        await this.extendObject('info.connection', {
            type: 'state',
            common: {
                type: 'boolean',
                role: 'indicator.connected',
                name: 'Adapter connection',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.extendObject('info.connectedMiners', {
            type: 'state',
            common: {
                type: 'string',
                role: 'text',
                name: 'Reachable miners',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setState('info.connection', true, true);
        await this.setState('info.connectedMiners', '', true);

        // Initialize your adapter here
        await this.createBasicObjectStructure();

        // try to connect to already known devices
        await this.tryKnownDevices();

        // this is correct RELATIVE path! actually means "miner.X.miner.<minerid>.control"
        this.subscribeStates('miner.*.control.*');
        this.subscribeStates(`miner.*.${CUSTOM_CHANNEL}.*`);
        this.subscribeStates('miner.*.enabled');

        this.scheduleUpdateChecks();
        await this.initializePvMonitor();
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback - callback to signal completion
     */
    private async onUnload(callback: () => void): Promise<void> {
        this.pvShuttingDown = true;
        try {
            this.updateCheckHandle?.clear();
            if (this.pvMonitorTimer) {
                clearInterval(this.pvMonitorTimer);
                this.pvMonitorTimer = undefined;
            }
            await this.minerManager.closeAll();

            if (this.deviceManagement) {
                await this.deviceManagement.close();
            }

            await this.setState('info.connection', false, true);
            await this.setState('info.connectedMiners', '', true);

            callback();
        } catch {
            callback();
        }
    }

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  */
    // private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
    //     if (obj) {
    //         // The object was changed
    //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    //     } else {
    //         // The object was deleted
    //         this.log.info(`object ${id} deleted`);
    //     }
    // }

    /**
     * Is called if a subscribed state changes
     *
     * @param id - the state id
     * @param state - the new state value
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

            // adapters usually should not process ack=true messages
            if (state.ack) {
                return;
            }

            // example: miner.0.miner.d85ed30e24d3.control.running
            const parts = id.split('.');
            if (parts.length < 5) {
                this.log.error(`invalid state id: ${id}`);
                return;
            }

            const deviceObjectId: string = parts.slice(0, 4).join('.');
            const obj = await this.getObjectAsync(deviceObjectId);
            if (obj === null || obj === undefined) {
                this.log.warn(`Object ${deviceObjectId} not found`);
                return;
            }
            const deviceSettings = decryptDeviceSettings(obj.native as IOBrokerDeviceSettings, value =>
                this.decrypt(value),
            );
            if (!isMiner(deviceSettings)) {
                this.log.warn(`category ${deviceSettings.category} not yet supported`);
                return;
            }
            deviceSettings.enabled = ((await this.getStateAsync(`${deviceObjectId}.enabled`))?.val ?? true) === true;

            // example: control.running or enabled
            const minerObjectId: string = parts.slice(4).join('.');

            switch (minerObjectId) {
                case 'enabled': {
                    const enabled = state.val === true;
                    this.log.info(`${enabled ? 'enable' : 'disable'} requested for device ${deviceSettings.name}`);

                    await this.setDeviceEnabled(deviceObjectId, deviceSettings, enabled);
                    await this.setState(id, { val: enabled, ack: true });
                    break;
                }

                case getMinerFeatureFullId(MinerFeatureKey.running): {
                    this.log.debug(`running state changed to ${state.val}`);

                    if (deviceSettings.settings.id === undefined) {
                        this.log.error(`device ${deviceSettings.name} has no id`);
                        return;
                    }

                    if (state.val) {
                        if (this.pvSafeStops.has(deviceSettings.settings.id)) {
                            this.log.warn(`Cannot start ${deviceSettings.name}: safe stop still in progress`);
                            return;
                        }
                        await this.minerManager.startMiner(deviceSettings.settings.id);
                    } else {
                        // Manual stop only pauses mining.
                        // Never switch the external relay from control.running.
                        await this.minerManager.stopMiner(deviceSettings.settings.id);
                    }
                    await this.setState(id, { val: state.val, ack: true });
                    break;
                }

                case getMinerFeatureFullId(MinerFeatureKey.reboot): {
                    if (!state.val) {
                        return;
                    }
                    this.log.info(`reboot requested for device ${deviceSettings.name}`);

                    if (deviceSettings.settings.id === undefined) {
                        this.log.error(`device ${deviceSettings.name} has no id`);
                        return;
                    }

                    // TODO: implement reboot in MinerManager / Miner base class
                    this.log.warn('reboot is not yet implemented');
                    await this.setState(id, { val: false, ack: true });
                    break;
                }

                case getMinerFeatureFullId(MinerFeatureKey.profile): {
                    const profile = String(state.val);
                    this.log.debug(`profile state changed to ${profile}`);

                    if (deviceSettings.settings.id === undefined) {
                        this.log.error(`device ${deviceSettings.name} has no id`);
                        return;
                    }

                    if (this.pvSafeStops.has(deviceSettings.settings.id) || this.pvShuttingDown) {
                        this.log.warn(
                            `setProfile blocked for ${deviceSettings.name}: PV safe stop or adapter shutdown active`,
                        );
                        return;
                    }

                    await this.minerManager.setProfile(deviceSettings.settings.id, profile);
                    await this.setState(id, { val: profile, ack: true });
                    break;
                }

                case getMinerFeatureFullId(MinerFeatureKey.powerTarget): {
                    const powerTarget = Number(state.val);
                    this.log.debug(`power target state changed to ${powerTarget}`);

                    if (!Number.isFinite(powerTarget) || powerTarget <= 0) {
                        this.log.warn(`invalid power target value for device ${deviceSettings.name}: ${state.val}`);
                        return;
                    }

                    // the range the miner reported (see applyPowerTargetConstraints): don't send what it would reject
                    const range = ((await this.getObjectAsync(id)) as ioBroker.StateObject | null | undefined)?.common;
                    if (!isWithinPowerTargetConstraints(powerTarget, range)) {
                        this.log.warn(
                            `power target ${powerTarget} W for device ${deviceSettings.name} is outside the range the miner accepts (${range?.min ?? '?'}-${range?.max ?? '?'} W)`,
                        );
                        return;
                    }

                    // TODO: why this copy pasta??
                    if (deviceSettings.settings.id === undefined) {
                        this.log.error(`device ${deviceSettings.name} has no id`);
                        return;
                    }

                    if (this.pvSafeStops.has(deviceSettings.settings.id) || this.pvShuttingDown) {
                        this.log.warn(
                            `setPowerTarget blocked for ${deviceSettings.name}: PV safe stop or adapter shutdown active`,
                        );
                        return;
                    }

                    await this.minerManager.setPowerTarget(deviceSettings.settings.id, powerTarget);
                    await this.setState(id, { val: powerTarget, ack: true });
                    break;
                }

                default: {
                    if (minerObjectId.startsWith(`${CUSTOM_CHANNEL}.`)) {
                        await this.setCustomFeature(
                            id,
                            deviceSettings,
                            minerObjectId.slice(CUSTOM_CHANNEL.length + 1),
                            state.val,
                        );
                        break;
                    }
                    this.log.warn(`unknown handling of state ${id}`);
                }
            }
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }

    /**
     * Sends a write to a custom feature state (`custom.<channel>.<feature>`) to the miner. On success the state is
     * acknowledged; the next poll corrects it should the miner have applied something else.
     *
     * @param stateId - the full id of the written state
     * @param deviceSettings - settings of the device the state belongs to
     * @param featureId - `<channel>.<feature>`
     * @param value - the written value
     */
    private async setCustomFeature(
        stateId: string,
        deviceSettings: IOBrokerMinerSettings,
        featureId: string,
        value: ioBroker.StateValue,
    ): Promise<void> {
        const minerId = deviceSettings.settings.id;
        if (!minerId || !this.minerManager.hasMiner(minerId)) {
            this.log.warn(`cannot set ${featureId} on device ${deviceSettings.name}: the device is disabled`);
            return;
        }
        if (this.pvSafeStops.has(minerId) || this.pvShuttingDown) {
            this.log.warn(
                `custom feature ${featureId} blocked for ${deviceSettings.name}: PV safe stop or adapter shutdown active`,
            );
            return;
        }

        try {
            const applied = await this.minerManager.withExclusiveMiner(minerId, miner => {
                if (this.pvSafeStops.has(minerId) || this.pvShuttingDown) {
                    throw new Error('PV safe stop or adapter shutdown active');
                }
                return miner.setCustomFeature(featureId, value);
            });
            await this.setState(stateId, { val: applied, ack: true });
        } catch (e) {
            this.log.warn(`setting ${featureId} on device ${deviceSettings.name} failed: ${String(e)}`);
        }
    }

    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.messagebox" property to be set to true in io-package.json
    //  */
    // private onMessage(obj: ioBroker.Message): void {
    //     if (typeof obj === 'object' && obj.message) {
    //         if (obj.command === 'send') {
    //             // e.g. send email or pushover or whatever
    //             this.log.info('send command');

    //             // Send response in callback if required
    //             if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
    //         }
    //     }
    // }

    private async createBasicObjectStructure(): Promise<void> {
        for (const key of categoryKeys) {
            await this.setObjectNotExistsAsync(key, {
                type: 'folder',
                common: {
                    // TODO: translate(key+"Folder") oda so
                    name: key,
                },
                native: {},
            });
        }
    }

    // Try to initialise and connect to already known devices
    /**
     * Restore PV shutdown history for diagnostics only. Keep miner commands blocked
     * until a separate, fully validated startup state machine is implemented.
     *
     * @param settings - configured miner
     */
    private async restorePvStopDiagnostics(settings: IOBrokerMinerSettings): Promise<void> {
        const minerId = settings.settings.id;
        const relayId = settings.pvControl?.relayStateId;
        if (!minerId || !relayId) {
            this.log.warn(`PV restart locked for ${settings.name}: missing miner or relay ID`);
            return;
        }
        const deviceId = this.getDeviceObjectId(settings);
        const recordState = await this.getStateAsync(`pvControl.miners.${deviceId}.lastSafeStop`);
        let raw: unknown;
        try {
            raw = typeof recordState?.val === 'string' ? JSON.parse(recordState.val) : undefined;
        } catch {
            raw = undefined;
        }
        const record = parsePvPersistedStop(raw, minerId, relayId, Date.now());
        const ageMs = Math.max(10, Number(this.config.pvMaxDataAge) || 180) * 1000;
        const [power, relay] = await Promise.all([
            this.readFreshPvMeasurement(settings.pvControl?.powerStateId || '', ageMs),
            this.getForeignStateAsync(relayId),
        ]);
        const now = Date.now();
        const relayFresh =
            typeof relay?.ts === 'number' &&
            relay.ts <= now &&
            now - relay.ts <= ageMs;
        const relayOff = relayFresh && relay?.val === !settings.pvControl?.relayOnValue;
        const powerOff = power !== undefined && power.value >= 0 && power.value <= 5;
        if (record && relayOff && powerOff) {
            this.log.info(`PV stop history for ${settings.name} matches fresh OFF/zero-power diagnostics; restart remains locked`);
        } else {
            this.log.warn(`PV restart locked for ${settings.name}: stored stop, relay or power diagnostics missing/inconsistent`);
        }
    }

    private async tryKnownDevices(): Promise<void> {
        const knownDevices = await this.getDevicesAsync();

        for (const device of knownDevices) {
            await this.initDevice(device);
        }
    }

    private async configureDeviceObject(settings: IOBrokerDeviceSettings): Promise<ioBroker.DeviceObject | undefined> {
        if (!isMiner(settings)) {
            // TODO: pool support
            this.log.error(`category ${settings.category} is not yet supported.`);
            return;
        }

        // TODO: fill settings.mac using arp request
        const id = this.getDeviceObjectId(settings);

        this.log.debug(`extended object ${id} with: ${JSON.stringify(settings)}`);
        // strip old (<=v1.0.4) enabled prop from native
        const { enabled: _enabled, ...nativeSettings } = settings;

        await this.extendObject(id, {
            type: 'device',
            common: {
                name: settings.name || settings.settings.host,
            },
            native: encryptDeviceSettings(nativeSettings, value => this.encrypt(value)),
        });

        // always add empty state, so that getObjectAsync works
        await this.extendObject(`${id}.empty`, {
            type: 'state',
            common: {
                name: 'empty',
                type: 'string',
                read: true,
                write: true,
                expert: true,
            },
        });

        const obj: ioBroker.DeviceObject = (await this.getObjectAsync(id)) as ioBroker.DeviceObject;
        this.log.debug(`configureDeviceObject: ${JSON.stringify(obj)}`);

        return obj;
    }

    /**
     *
     * @param settings - the device settings to add
     */
    public async addDevice(settings: IOBrokerDeviceSettings): Promise<void> {
        const obj = await this.configureDeviceObject(settings);

        if (obj == null) {
            this.log.error(`could not create device object for ${JSON.stringify(settings)}`);
            return;
        }

        await this.initDevice(obj, isMiner(settings) ? settings.enabled : undefined);
    }

    /**
     *
     * @param settings - the updated device settings
     */
    public async updateDevice(settings: IOBrokerDeviceSettings): Promise<void> {
        // PS: don't just delDevice and addDevice, as this would lose all state history, ...

        if (!isMiner(settings)) {
            // TODO: pool support
            this.log.error(`category ${settings.category} is not yet supported.`);
            return;
        }

        await this.setState(`${this.getDeviceObjectId(settings)}.enabled`, {
            val: settings.enabled,
            ack: true,
        });

        if (!(await this.tryCloseMiner(settings))) {
            this.log.error(`updateDevice could not close miner ${settings.settings.id}`);
            return;
        }

        await this.addDevice(settings);
    }

    /**
     * Deletes a device
     *
     * @param deviceId - The ioBroker-object-id of the device to delete
     */
    public async delDevice(deviceId: string): Promise<boolean> {
        this.log.info(`deleteDevice device ${deviceId}`);
        const obj = await this.getObjectAsync(deviceId);

        if (obj == null) {
            this.log.error(`deleteDevice device ${deviceId} not found`);
            return false;
        }

        const settings: IOBrokerDeviceSettings = decryptDeviceSettings(obj.native as IOBrokerDeviceSettings, value =>
            this.decrypt(value),
        );

        if (!isMiner(settings)) {
            // TODO: pool support
            this.log.error(`deleteDevice category ${obj.native.category} not yet supported`);
            return false;
        }

        if (!(await this.tryCloseMiner(settings))) {
            this.log.error(`delDevice could not close miner ${settings.settings.id}`);
            return false;
        }

        await this.delObjectAsync(deviceId, { recursive: true });
        // deviceId is the full object id here, the set holds the relative one
        this.onlineDevices.delete(this.getDeviceObjectId(settings));
        this.customChannelObjects.delete(this.getDeviceObjectId(settings));
        await this.updateConnectionState();

        this.log.info(`${deviceId} deleted`);
        return true;
    }

    private async tryCloseMiner(settings: IOBrokerMinerSettings): Promise<boolean> {
        if (settings.settings.id === undefined) {
            this.log.error('tryCloseMiner: minerId is undefined');
            return false;
        }

        if (!settings.enabled) {
            this.log.debug(`tryCloseMiner: skipped miner close, because ${settings.settings.id} is disabled`);

            if (this.minerManager.hasMiner(settings.settings.id)) {
                this.log.error(
                    `tryCloseMiner: this should not happen, miner ${settings.settings.id} is disabled but still in minerManager`,
                );
                await this.minerManager.close(settings.settings.id);
            }

            return true;
        }

        await this.minerManager.close(settings.settings.id);
        return true;
    }

    private async initDevice(device: ioBroker.DeviceObject, initialEnabled?: boolean): Promise<void> {
        const settings: IOBrokerDeviceSettings = decryptDeviceSettings(device.native as IOBrokerDeviceSettings, value =>
            this.decrypt(value),
        );
        this.log.info(`initialising device ${JSON.stringify(settings)}`);

        if (!isMiner(settings)) {
            this.log.error(`tryKnownDevices category ${settings.category} not yet supported`);
            return;
        }

        // Fail closed on every adapter restart. Persisted history cannot authorize commands.
        if (settings.pvControl?.enabled === true && settings.settings.id) {
            this.pvRelayOffMiners.add(settings.settings.id);
            await this.restorePvStopDiagnostics(settings);
        }

        await this.createDeviceStateObjects(settings);
        const enabledState = await this.getStateAsync(`${device._id}.enabled`);
        settings.enabled = (enabledState?.val ?? initialEnabled ?? true) as boolean;
        await this.writeStaticInfoStates(settings);

        if (!settings.enabled) {
            this.log.info(`device ${settings.name} is disabled`);
            return;
        }

        try {
            const miner = await this.minerManager.init(settings.settings);

            miner.subscribeToStats(async (stats: MinerStats) => {
                this.log.debug(`received stats: ${JSON.stringify(stats)}`);
                await this.processNewStats(miner, settings, stats);
            });
            miner.subscribeToOnlineStatus(async (online: boolean) => {
                await this.setDeviceOnline(settings, online);
            });
            if (miner.getSupportedFeatures().includes(MinerFeatureKey.powerTarget)) {
                // not awaited: an unreachable miner must not hold up the adapter start
                void this.applyPowerTargetConstraints(miner, settings);
            }
            if (this.config.checkForUpdates !== false) {
                // Devices added or enabled after the daily check need their first result right away.
                // Do not hold up initialization while contacting the miner or its firmware feed.
                void this.checkMinerUpdates([miner]).catch((e: unknown) => {
                    this.log.error(`initial update check failed: ${String(e)}`);
                });
            }
        } catch (e) {
            this.log.error(`could not initialize device ${settings.name || settings.settings.host}: ${String(e)}`);
            await this.setDeviceOnline(settings, false);
        }
    }

    /**
     * Write static info states that come from the device configuration, not from API polling.
     *
     * @param settings - the device settings
     */
    private async writeStaticInfoStates(settings: IOBrokerMinerSettings): Promise<void> {
        const deviceId = this.getDeviceObjectId(settings);
        await this.setState(`${deviceId}.info.minerType`, { val: settings.settings.minerType, ack: true });
        await this.setState(`${deviceId}.info.host`, { val: settings.settings.host, ack: true });
        await this.setState(`${deviceId}.enabled`, { val: settings.enabled, ack: true });
        // Reset online state on startup — will be set to true once the miner responds
        await this.setDeviceOnline(settings, false);
    }

    private async setDeviceEnabled(
        deviceObjectId: string,
        settings: IOBrokerMinerSettings,
        enabled: boolean,
    ): Promise<void> {
        if (settings.settings.id === undefined) {
            this.log.error(`device ${settings.name} has no id`);
            return;
        }

        if (settings.enabled === enabled && this.minerManager.hasMiner(settings.settings.id) === enabled) {
            return;
        }

        if (enabled) {
            if (this.minerManager.hasMiner(settings.settings.id)) {
                return;
            }

            const obj = (await this.getObjectAsync(deviceObjectId)) as ioBroker.DeviceObject | null | undefined;
            if (obj == null) {
                this.log.warn(`Object ${deviceObjectId} not found`);
                return;
            }

            await this.initDevice(obj, enabled);
            return;
        }

        if (this.minerManager.hasMiner(settings.settings.id)) {
            await this.minerManager.close(settings.settings.id);
        }
        await this.setDeviceOnline(settings, false);
    }

    /**
     * Stores the power target range the miner accepts as min/max of the control state, so the UI can enforce it
     * and out-of-range values are rejected before they reach the miner.
     *
     * @param miner - the initialized miner
     * @param settings - the device settings
     */
    private async applyPowerTargetConstraints(
        miner: Miner<MinerSettings>,
        settings: IOBrokerDeviceSettings,
    ): Promise<void> {
        try {
            const range = await miner.getPowerTargetConstraints();
            if (range) {
                await this.extendObject(this.getStateFullObjectId(settings, MinerFeatureKey.powerTarget), {
                    common: { min: range.min, max: range.max },
                });
            }
        } catch (e) {
            this.log.debug(
                `power target constraints of ${this.getDeviceObjectId(settings)} not available: ${String(e)}`,
            );
        }
    }

    /**
     * Writes a device's `info.online` and keeps the instance's `info.connection` in sync with it.
     *
     * @param settings - the device settings
     * @param online - whether the device's miner is reachable
     */
    private async setDeviceOnline(settings: IOBrokerDeviceSettings, online: boolean): Promise<void> {
        const deviceId = this.getDeviceObjectId(settings);
        await this.setState(`${deviceId}.info.online`, { val: online, ack: true });
        if (online) {
            this.onlineDevices.set(deviceId, isMiner(settings) ? settings.name || settings.settings.host : deviceId);
        } else {
            this.onlineDevices.delete(deviceId);
        }
        await this.updateConnectionState();
    }

    /**
     * List the reachable miners separately from the adapter's own connection status.
     * The adapter remains healthy when PV-controlled miners are switched off.
     */
    private async updateConnectionState(): Promise<void> {
        const names = [...this.onlineDevices.values()].sort((a, b) => a.localeCompare(b));
        await this.setStateChangedAsync('info.connectedMiners', { val: names.join(','), ack: true });
    }

    private async processNewStats(
        miner: Miner<MinerSettings>,
        settings: IOBrokerDeviceSettings,
        stats: MinerStats,
    ): Promise<void> {
        // TODO: cleanup, just filter for info features and then directly infer object id from there somehow
        // change MinerStates to Record<MinerFeatureKey, val>?

        const supported = miner.getSupportedFeatures();
        const deviceId = this.getDeviceObjectId(settings);

        // Feature-driven states (version, firmwareVersion, raw)
        if (supported.includes(MinerFeatureKey.version) && stats.version !== undefined) {
            await this.setState(this.getStateFullObjectId(settings, MinerFeatureKey.version), {
                val: stats.version,
                ack: true,
            });
        }
        if (supported.includes(MinerFeatureKey.firmwareVersion) && stats.firmwareVersion !== undefined) {
            await this.setState(this.getStateFullObjectId(settings, MinerFeatureKey.firmwareVersion), {
                val: stats.firmwareVersion,
                ack: true,
            });
        }
        if (supported.includes(MinerFeatureKey.rawStats) && stats.raw !== undefined) {
            await this.setState(this.getStateFullObjectId(settings, MinerFeatureKey.rawStats), {
                val: JSON.stringify(stats.raw),
                ack: true,
            });
        }
        if (supported.includes(MinerFeatureKey.powerTarget) && stats.powerTarget !== undefined) {
            // reflect the configured target, also when it was changed elsewhere (e.g. in the miner's web interface);
            // only on change, so a poll doesn't rewrite the control state every few seconds
            await this.setStateChangedAsync(this.getStateFullObjectId(settings, MinerFeatureKey.powerTarget), {
                val: stats.powerTarget,
                ack: true,
            });
        }
        if (supported.includes(MinerFeatureKey.profile) && stats.profile !== undefined) {
            // like the power target: reflect the active profile, also when it was changed elsewhere, only on change
            await this.setStateChangedAsync(this.getStateFullObjectId(settings, MinerFeatureKey.profile), {
                val: stats.profile,
                ack: true,
            });
        }
        if (supported.includes(MinerFeatureKey.rssi) && stats.rssi !== undefined) {
            await this.setState(this.getStateFullObjectId(settings, MinerFeatureKey.rssi), {
                val: stats.rssi,
                ack: true,
            });
        }
        // Stats sub-states: write whatever the miner provides
        if (supported.includes(MinerFeatureKey.stats)) {
            const statsValues: Record<string, ioBroker.StateValue | undefined> = {
                totalHashrate: stats.totalHashrate,
                power: stats.power,
                dynamicPowerTarget: stats.dynamicPowerTarget,
                efficiency: stats.efficiency,
                acceptedShares: stats.acceptedShares,
                rejectedShares: stats.rejectedShares,
            };
            for (const [key, val] of Object.entries(statsValues)) {
                if (val !== undefined) {
                    await this.setState(`${deviceId}.stats.${key}`, { val, ack: true });
                }
            }
        }

        // Custom features: only the ones the miner declares, only on change (like the power target above)
        if (stats.custom) {
            const channels = miner.getCustomChannels();
            await this.createNewCustomChannels(deviceId, channels);
            const known = new Map(resolveCustomFeatures(channels).map(f => [f.id, f.feature]));
            for (const [id, val] of Object.entries(stats.custom)) {
                const feature = known.get(id);
                if (!feature) {
                    continue;
                }
                const stateId = `${deviceId}.${CUSTOM_CHANNEL}.${id}`;
                if (feature.notification && val === true) {
                    // compare with the stored value, so the notification is raised once when the feature turns true,
                    // not on every poll or adapter restart
                    const wasTrue = (await this.getStateAsync(stateId))?.val === true;
                    if (!wasTrue && isMiner(settings)) {
                        await this.raiseCustomFeatureNotification(settings, feature.notification);
                    }
                }
                await this.setStateChangedAsync(stateId, { val, ack: true });
            }
        }

        // Always update online / lastSeen
        await this.setDeviceOnline(settings, true);
        await this.setState(`${deviceId}.info.lastSeen`, { val: Date.now(), ack: true });
    }

    /**
     * Raises the notification a custom feature declares, and logs it as a warning (for js-controllers without
     * notification support, and for the log).
     *
     * @param settings - the device the feature belongs to
     * @param notification - the notification the feature declares
     */
    private async raiseCustomFeatureNotification(
        settings: IOBrokerMinerSettings,
        notification: CustomFeatureNotification,
    ): Promise<void> {
        const message = `Miner "${settings.name}": ${notification.message}`;
        this.log.warn(message);
        try {
            await this.registerNotification(
                'miner',
                notification.category as ioBroker.NotificationScopes['miner'],
                message,
            );
        } catch (e) {
            this.log.debug(`could not register notification: ${String(e)}`);
        }
    }

    private async createDeviceStateObjects(settings: IOBrokerDeviceSettings): Promise<void> {
        if (!isMiner(settings)) {
            this.log.error(`createDeviceStateObjects category ${settings.category} not yet supported`);
            return;
        }

        const deviceId = this.getDeviceObjectId(settings);

        // Create channels for all feature categories
        const categoryLabels: Record<MinerFeatureCategory, string> = {
            [MinerFeatureCategory.control]: 'device controls',
            [MinerFeatureCategory.info]: 'device information',
            [MinerFeatureCategory.stats]: 'mining statistics',
            [MinerFeatureCategory.raw]: 'raw API data',
        };

        for (const category of Object.values(MinerFeatureCategory)) {
            await this.extendObject(`${deviceId}.${category}`, {
                type: 'channel',
                common: {
                    name: categoryLabels[category],
                },
            });
        }

        // Clean up legacy state paths from pre-restructure versions
        await this.cleanupLegacyStates(deviceId);

        // Always present enabled state
        await this.extendObject(`${deviceId}.enabled`, {
            type: 'state',
            common: {
                name: 'Enabled',
                type: 'boolean',
                role: 'switch.enable',
                read: true,
                write: true,
            },
        });

        // --- Always-present info states (not feature-gated) ---
        const infoStates: Record<string, Partial<ioBroker.StateCommon>> = {
            minerType: { name: 'Miner Type', type: 'string', read: true, write: false },
            host: { name: 'Host', type: 'string', read: true, write: false },
            online: { name: 'Online', type: 'boolean', role: 'indicator.reachable', read: true, write: false },
            lastSeen: { name: 'Last Seen', type: 'number', role: 'date', read: true, write: false },
        };
        for (const [id, common] of Object.entries(infoStates)) {
            await this.extendObject(`${deviceId}.info.${id}`, {
                type: 'state',
                common: common as ioBroker.StateCommon,
            });
        }

        // --- Always-present stats sub-states (created when miner declares MinerFeatureKey.stats) ---
        const dummyMiner = createMiner(settings.settings);
        const supportedFeatures = dummyMiner.getSupportedFeatures();

        if (supportedFeatures.includes(MinerFeatureKey.stats)) {
            const statsStates: Record<string, Partial<ioBroker.StateCommon>> = {
                totalHashrate: { name: 'Total Hashrate', type: 'number', unit: 'h/s', read: true, write: false },
                power: { name: 'Power', type: 'number', unit: 'W', read: true, write: false },
                dynamicPowerTarget: {
                    name: 'Dynamic Power Target',
                    type: 'number',
                    unit: 'W',
                    read: true,
                    write: false,
                },
                efficiency: { name: 'Efficiency', type: 'number', unit: 'H/W', read: true, write: false },
                acceptedShares: { name: 'Accepted Shares', type: 'number', read: true, write: false },
                rejectedShares: { name: 'Rejected Shares', type: 'number', read: true, write: false },
            };
            for (const [id, common] of Object.entries(statsStates)) {
                await this.extendObject(`${deviceId}.stats.${id}`, {
                    type: 'state',
                    common: common as ioBroker.StateCommon,
                });
            }
        }

        // --- Feature-driven states (control, info.version, raw) ---
        for (const featureKey of supportedFeatures) {
            // Skip the 'stats' capability marker — sub-states handled above
            if (featureKey === MinerFeatureKey.stats) {
                continue;
            }
            const feature = minerFeatures[featureKey];
            const common: Partial<ioBroker.StateCommon> = {
                name: `${feature.label} - ${feature.description}`,
                type: feature.type as ioBroker.CommonType,
                role: feature.role,
                read: feature.readable,
                write: feature.writable,
                unit: feature.unit,
                expert: feature.advanced === true ? true : undefined, // false needs to be passed in as undefined
            };

            // Profile feature: populate allowed values from the miner so ioBroker renders a dropdown
            if (featureKey === MinerFeatureKey.profile) {
                const profiles = dummyMiner.getProfiles();
                if (profiles.length > 0) {
                    const states: Record<string, string> = {};
                    for (const p of profiles) {
                        states[p] = p;
                    }
                    common.states = states;
                }
            }

            await this.extendObject(`${this.getStateFullObjectId(settings, featureKey)}`, {
                type: 'state',
                common: common as ioBroker.StateCommon,
            });
        }

        await this.createCustomStateObjects(
            deviceId,
            dummyMiner.getCustomChannels(),
            dummyMiner.getDynamicCustomChannels(),
        );
    }

    /**
     * Creates the `custom` channel with one sub-channel per custom feature channel the miner declares, and removes
     * custom objects the miner no longer declares (another miner type, or a feature promoted to a regular one).
     *
     * Instances of dynamic channels (e.g. one per hashboard) are only known after a poll: their objects are kept
     * here as long as the miner declares their template, and created by {@link createNewCustomChannels}.
     *
     * @param deviceId - the device object id
     * @param channels - the custom feature channels of the miner
     * @param dynamicChannels - the templates of the miner's dynamic custom channels
     */
    private async createCustomStateObjects(
        deviceId: string,
        channels: readonly CustomChannelDefinition[],
        dynamicChannels: readonly DynamicCustomChannelDefinition[] = [],
    ): Promise<void> {
        const customId = `${deviceId}.${CUSTOM_CHANNEL}`;
        const wanted = new Set<string>();
        this.customChannelObjects.set(deviceId, new Set());

        if (channels.length > 0 || dynamicChannels.length > 0) {
            await this.extendObject(customId, {
                type: 'channel',
                common: { name: 'device specific features' },
            });
            wanted.add(customId);
        }
        for (const channel of channels) {
            for (const id of await this.createCustomChannelObjects(deviceId, channel)) {
                wanted.add(id);
            }
        }

        // longest ids first, so states go before their channels
        const existing = Object.keys(await this.getForeignObjectsAsync(`${this.namespace}.${customId}.*`))
            .map(id => id.slice(this.namespace.length + 1))
            .concat((await this.getObjectAsync(customId)) ? [customId] : [])
            .sort((a, b) => b.length - a.length);
        for (const id of existing) {
            if (!wanted.has(id) && !this.isDynamicCustomObject(customId, id, dynamicChannels)) {
                this.log.info(`Removing custom feature object no longer provided by the miner: ${id}`);
                await this.delObjectAsync(id);
            }
        }
    }

    /**
     * Creates the objects of custom channels the miner reports for the first time, e.g. a hashboard it detected.
     * Channels it no longer reports are left alone: a board can be missing from a single poll.
     *
     * @param deviceId - the device object id
     * @param channels - the custom feature channels the miner currently declares
     */
    private async createNewCustomChannels(
        deviceId: string,
        channels: readonly CustomChannelDefinition[],
    ): Promise<void> {
        let created = this.customChannelObjects.get(deviceId);
        if (!created) {
            created = new Set();
            this.customChannelObjects.set(deviceId, created);
        }
        for (const channel of channels) {
            if (!created.has(channel.id)) {
                await this.createCustomChannelObjects(deviceId, channel);
            }
        }
    }

    /**
     * Creates the objects of one custom channel and its features.
     *
     * @param deviceId - the device object id
     * @param channel - the channel
     * @returns the ids of the created objects
     */
    private async createCustomChannelObjects(deviceId: string, channel: CustomChannelDefinition): Promise<string[]> {
        const channelId = `${deviceId}.${CUSTOM_CHANNEL}.${channel.id}`;
        await this.extendObject(channelId, { type: 'channel', common: { name: channel.label } });
        const ids = [channelId];

        for (const feature of channel.features) {
            const common: Partial<ioBroker.StateCommon> = {
                name: `${feature.label} - ${feature.description}`,
                type: feature.type,
                role: feature.role ?? 'state',
                read: feature.readable,
                write: feature.writable,
                unit: feature.unit,
                min: feature.min,
                max: feature.max,
                step: feature.step,
                states: feature.states,
                expert: feature.advanced === true ? true : undefined, // false needs to be passed in as undefined
            };
            const stateId = `${channelId}.${feature.id}`;
            await this.extendObject(stateId, { type: 'state', common: common as ioBroker.StateCommon });
            ids.push(stateId);
        }

        this.customChannelObjects.get(deviceId)?.add(channel.id);
        return ids;
    }

    /**
     * Whether an object below `custom` belongs to an instance of a dynamic channel the miner declares: the channel
     * itself, or one of the template's features.
     *
     * @param customId - the device's custom channel id
     * @param id - the object id
     * @param dynamicChannels - the templates of the miner's dynamic custom channels
     */
    private isDynamicCustomObject(
        customId: string,
        id: string,
        dynamicChannels: readonly DynamicCustomChannelDefinition[],
    ): boolean {
        if (!id.startsWith(`${customId}.`)) {
            return false;
        }
        const [channelId, featureId, ...rest] = id.slice(customId.length + 1).split('.');
        const template = findDynamicCustomChannel(dynamicChannels, channelId);
        if (!template || rest.length > 0) {
            return false;
        }
        return featureId === undefined || template.features.some(feature => feature.id === featureId);
    }

    /**
     * Remove orphaned state objects from legacy object model (before category restructure).
     * Old paths: control.MINER_RUNNING, info.RAW, info.VERSION, info.TOTAL_HASHRATE
     *
     * @param deviceId - the device object id prefix
     */
    private async cleanupLegacyStates(deviceId: string): Promise<void> {
        const legacyPaths = [
            `${deviceId}.control.MINER_RUNNING`,
            `${deviceId}.info.RAW`,
            `${deviceId}.info.VERSION`,
            `${deviceId}.info.TOTAL_HASHRATE`,
        ];

        for (const legacyPath of legacyPaths) {
            try {
                const obj = await this.getObjectAsync(legacyPath);
                if (obj) {
                    this.log.info(`Removing legacy state object: ${legacyPath}`);
                    await this.delObjectAsync(legacyPath);
                }
            } catch {
                // Object doesn't exist or can't be deleted — ignore
            }
        }
    }

    /**
     * Read-only PV diagnostics. Does not start, stop, or power-cycle miners.
     * The controller will only be enabled after a separate safe shutdown implementation.
     */
    private async initializePvMonitor(): Promise<void> {
        await this.extendObject('pvControl', {
            type: 'channel',
            common: { name: 'PV control diagnostics' },
            native: {},
        });
        const states: Record<string, { name: string; type: 'boolean' | 'number' | 'string'; unit?: string }> = {
            enabled: { name: 'PV automation configured', type: 'boolean' },
            valid: { name: 'PV measurements valid', type: 'boolean' },
            gridPower: { name: 'Grid power', type: 'number', unit: 'W' },
            batteryPower: { name: 'Battery power', type: 'number', unit: 'W' },
            surplus: { name: 'PV surplus after reserve and battery discharge', type: 'number', unit: 'W' },
            status: { name: 'PV monitor status', type: 'string' },
        };
        for (const [key, common] of Object.entries(states)) {
            await this.extendObject(`pvControl.${key}`, {
                type: 'state',
                common: { ...common, role: 'value', read: true, write: false },
                native: {},
            });
        }
        // Persistent, read-only diagnostic records. No saved record authorizes relay or miner commands.
        await this.extendObject('pvControl.lastSafeStop', {
            type: 'state',
            common: {
                name: 'Last confirmed PV safe stop (JSON)',
                type: 'string',
                role: 'json',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });
        await this.setState('pvControl.enabled', { val: this.config.pvEnabled === true, ack: true });
        const intervalSeconds = Math.max(30, Number(this.config.pvInterval) || 120);
        this.pvMonitorTimer = setInterval(() => {
            void this.runPvMonitor().catch((error: unknown) => this.log.error(`PV monitor failed: ${String(error)}`));
        }, intervalSeconds * 1000);
        this.pvMonitorTimer.unref();
        await this.runPvMonitor();
        if (this.config.pvEnabled === true) {
            this.log.warn(
                'PV automation is configured ON, but actuator commands are intentionally locked in this diagnostic build',
            );
        }
    }

    private async readFreshPvValue(id: string, maxAgeMs: number): Promise<number | undefined> {
        if (!id) {
            return undefined;
        }
        const state = await this.getForeignStateAsync(id);
        const timestamp = state?.ts;
        if (
            !state ||
            typeof state.val !== 'number' ||
            !Number.isFinite(state.val) ||
            typeof timestamp !== 'number' ||
            timestamp > Date.now() + 10_000 ||
            Date.now() - timestamp > maxAgeMs
        ) {
            return undefined;
        }
        return state.val;
    }

    private async readFreshPvMeasurement(
        id: string,
        maxAgeMs: number,
    ): Promise<{ value: number; timestamp: number } | undefined> {
        if (!id) {
            return undefined;
        }

        const state = await this.getForeignStateAsync(id);
        const now = Date.now();

        if (
            !state ||
            typeof state.val !== 'number' ||
            !Number.isFinite(state.val) ||
            typeof state.ts !== 'number' ||
            !Number.isFinite(state.ts) ||
            state.ts > now ||
            now - state.ts > maxAgeMs
        ) {
            return undefined;
        }

        return {
            value: state.val,
            timestamp: state.ts,
        };
    }

    private async runPvMonitor(): Promise<void> {
        if (this.pvMonitorBusy) {
            return;
        }
        this.pvMonitorBusy = true;
        try {
            const ageMs = Math.max(10, Number(this.config.pvMaxDataAge) || 180) * 1000;
            const grid = await this.readFreshPvValue(this.config.pvGridPowerId || '', ageMs);
            const battery = await this.readFreshPvValue(this.config.pvBatteryPowerId || '', ageMs);
            const valid = grid !== undefined && battery !== undefined;
            await this.setState('pvControl.valid', { val: valid, ack: true });
            await this.setState('pvControl.gridPower', { val: grid ?? null, ack: true });
            await this.setState('pvControl.batteryPower', { val: battery ?? null, ack: true });
            const reserve = Math.max(0, Number(this.config.pvReserve) || 0);
            const surplus = valid ? Math.max(0, -grid - reserve - Math.max(0, battery)) : null;
            await this.setState('pvControl.surplus', { val: surplus, ack: true });
            const status = !valid
                ? 'Missing or stale PV measurements; no commands sent'
                : 'Read-only diagnostics active; miner and relay commands locked';
            await this.setState('pvControl.status', { val: status, ack: true });
            if (status !== this.pvMonitorWarning) {
                this.log.info(`PV: ${status}`);
                this.pvMonitorWarning = status;
            }
        } finally {
            this.pvMonitorBusy = false;
        }
    }

    /**
     * Stop mining and disconnect the relay only after fresh, stable evidence of zero
     * hashrate AND low mains power. A pause command alone is not confirmation.
     * No relay write occurs if any check fails or the adapter is unloading.
     */
    private async safeStopPvMiner(settings: IOBrokerMinerSettings): Promise<void> {
        const id = settings.settings.id;
        if (!id || this.pvSafeStops.has(id) || this.pvShuttingDown) {
            throw new Error('Safe stop already active or miner ID missing');
        }
        const pv = settings.pvControl;
        if (!pv?.relayStateId || !pv.powerStateId) {
            throw new Error(`PV safe stop for ${settings.name}: relayStateId and powerStateId required`);
        }
        if (settings.settings.minerType !== 'bosMiner') {
            throw new Error(`PV safe stop only implemented for BOSMiner: ${settings.name}`);
        }
        this.pvSafeStops.add(id);
        const deviceId = this.getDeviceObjectId(settings);
        const ageMs = Math.max(10, Number(this.config.pvMaxDataAge) || 180) * 1000;
        const maxWaitMs = 5 * 60_000;
        const started = Date.now();
        const confirmation = new PvShutdownConfirmation();
        let pausedAt = 0;
        try {
            this.log.info(`PV safe stop requested for ${settings.name}; relay stays ON until confirmed`);
            await this.minerManager.withExclusiveMiner(id, async miner => {
                await miner.stop();
                pausedAt = Date.now();
                // A successful pause command is not proof of stopped hardware.
                while (Date.now() - started < maxWaitMs) {
                    if (this.config.pvEnabled !== true || this.pvShuttingDown) {
                        throw new Error('PV automation disabled during safe stop');
                    }
                    const [power, hash, seen, relay] = await Promise.all([
                        this.readFreshPvMeasurement(pv.powerStateId, ageMs),
                        this.getStateAsync(`${deviceId}.stats.totalHashrate`),
                        this.getStateAsync(`${deviceId}.info.lastSeen`),
                        this.getForeignStateAsync(pv.relayStateId),
                    ]);
                    const now = Date.now();
                    const relayIsOn =
                        relay?.val === pv.relayOnValue &&
                        typeof relay.ts === 'number' &&
                        relay.ts <= now &&
                        now - relay.ts <= ageMs;

                    if (!relayIsOn) {
                        throw new Error(`Relay state unavailable or not ON for ${settings.name}`);
                    }

                    const confirmed = confirmation.update(
                        {
                            hashrate: typeof hash?.val === 'number' ? hash.val : undefined,
                            hashrateTimestamp: hash?.ts,
                            power: power?.value,
                            powerTimestamp: power?.timestamp,
                            lastSeen: typeof seen?.val === 'number' ? seen.val : undefined,
                        },
                        now,
                        ageMs,
                        pausedAt,
                    );

                    const delayMs = Math.max(0, Number(pv.shutdownDelay) || 0) * 1000;

                    if (confirmed && now - pausedAt >= delayMs) {
                        // Recheck the PV enable flag immediately before the relay command.
                        if (this.config.pvEnabled !== true || this.pvShuttingDown) {
                            throw new Error('PV automation disabled before relay shutdown');
                        }
                        // Final independent check immediately before relay shutdown.
                        const [finalPower, finalHash, finalSeen, finalRelay] = await Promise.all([
                            this.readFreshPvMeasurement(pv.powerStateId, 15_000),
                            this.getStateAsync(`${deviceId}.stats.totalHashrate`),
                            this.getStateAsync(`${deviceId}.info.lastSeen`),
                            this.getForeignStateAsync(pv.relayStateId),
                        ]);

                        const finalNow = Date.now();

                        const finalSafe = isPvShutdownSafe(
                            {
                                hashrate: typeof finalHash?.val === 'number' ? finalHash.val : undefined,
                                hashrateTimestamp: finalHash?.ts,
                                power: finalPower?.value,
                                powerTimestamp: finalPower?.timestamp,
                                lastSeen: typeof finalSeen?.val === 'number' ? finalSeen.val : undefined,
                            },
                            finalNow,
                            15_000,
                            pausedAt,
                        );

                        if (
                            !finalSafe ||
                            finalRelay?.val !== pv.relayOnValue ||
                            typeof finalRelay.ts !== 'number' ||
                            finalRelay.ts > finalNow ||
                            finalNow - finalRelay.ts > ageMs ||
                            this.config.pvEnabled !== true ||
                            this.pvShuttingDown
                        ) {
                            throw new Error(`Final PV shutdown safety check failed for ${settings.name}`);
                        }

                        // Block all further miner commands before requesting relay OFF.
                        // An acknowledgement of the write is not proof of power loss.
                        this.pvRelayOffMiners.add(id);
                        const relayOffRequestedAt = Date.now();
                        await this.setForeignStateAsync(pv.relayStateId, !pv.relayOnValue);
                        let lastPowerTimestamp = relayOffRequestedAt;
                        let zeroPowerSamples = 0;
                        const confirmationDeadline = Date.now() + 90_000;
                        while (Date.now() < confirmationDeadline && !this.pvShuttingDown) {
                            await this.delay(5_000);
                            const sample = await this.readFreshPvMeasurement(pv.powerStateId, ageMs);
                            if (!sample || sample.timestamp <= lastPowerTimestamp) {
                                continue;
                            }
                            lastPowerTimestamp = sample.timestamp;
                            zeroPowerSamples = sample.value >= 0 && sample.value <= 5 ? zeroPowerSamples + 1 : 0;
                            if (zeroPowerSamples >= 3) {
                                const record = {
                                    minerId: id,
                                    relayStateId: pv.relayStateId,
                                    stoppedAt: Date.now(),
                                    relayOffConfirmed: true,
                                };
                                const recordPath = `pvControl.miners.${deviceId}.lastSafeStop`;
                                await this.extendObject('pvControl.miners', {
                                    type: 'channel',
                                    common: { name: 'PV miner shutdown records' },
                                    native: {},
                                });
                                await this.extendObject(`pvControl.miners.${deviceId}`, {
                                    type: 'channel',
                                    common: { name: `PV shutdown record for ${settings.name}` },
                                    native: {},
                                });
                                await this.extendObject(recordPath, {
                                    type: 'state',
                                    common: {
                                        name: 'Last confirmed safe stop (JSON)',
                                        type: 'string',
                                        role: 'json',
                                        read: true,
                                        write: false,
                                        def: '',
                                    },
                                    native: {},
                                });
                                await this.setState(recordPath, {
                                    val: JSON.stringify(record),
                                    ack: true,
                                });
                                this.log.info(
                                    `PV safe stop for ${settings.name}: three fresh near-zero power samples confirmed`,
                                );
                                return;
                            }
                        }
                        throw new Error(
                            `PV relay OFF requested for ${settings.name}, but power loss was not confirmed; miner commands remain blocked`,
                        );
                    }
                    await this.delay(5_000);
                }
                throw new Error(`PV safe stop timed out for ${settings.name}; relay remains ON`);
            });
        } catch (error) {
            this.log.error(`PV safe stop failed for ${settings.name}; relay NOT switched off: ${String(error)}`);
            throw error;
        } finally {
            this.pvSafeStops.delete(id);
        }
    }

    private scheduleUpdateChecks(): void {
        // instances created before the setting existed have no value for it: treat that as the default (on)
        if (this.config.checkForUpdates === false) {
            this.log.info('automatic update checks are turned off in the instance settings');
            return;
        }

        this.updateCheckHandle = asyncDynamicInterval(async () => {
            try {
                await this.checkForUpdates();
            } catch (e) {
                // an error escaping here would end the daily schedule
                this.log.error(`update check failed: ${String(e)}`);
            }
            return UPDATE_CHECK_INTERVAL_MS;
        }, UPDATE_CHECK_INITIAL_DELAY_MS);
    }

    /**
     * Checks running miners and configured BOS/Avalon devices for a newer firmware/software version and updates their
     * `info.latestVersion` / `info.updateAvailable` states. A failed check sets both to null (unknown).
     *
     * @param options - `force` skips the cached upstream lookups, e.g. for a manual check
     * @param options.force - ask the upstream sources again instead of using cached results
     * @returns how many miners were checked, have an update, or failed
     */
    public async checkForUpdates(options: { force?: boolean } = {}): Promise<UpdateCheckSummary> {
        if (options.force) {
            this.updateSources.clearCache();
        }

        const running = this.minerManager.getMiners();
        const inactive: Miner<MinerSettings>[] = [];
        // Firmware feeds can be checked from saved identity data even when a device is disabled.
        for (const device of await this.getDevicesAsync()) {
            const settings = device.native as IOBrokerDeviceSettings;
            if (
                isMiner(settings) &&
                ['bos', 'avalonMiner'].includes(settings.settings.minerType) &&
                !running.some(miner => miner.settings.id === settings.settings.id)
            ) {
                const decrypted = decryptDeviceSettings(settings, value =>
                    this.decrypt(value),
                ) as IOBrokerMinerSettings;
                inactive.push(createMiner(decrypted.settings));
            }
        }
        try {
            return await this.checkMinerUpdates([...running, ...inactive]);
        } finally {
            await Promise.all(inactive.map(miner => miner.close()));
        }
    }

    private async checkMinerUpdates(miners: readonly Miner<MinerSettings>[]): Promise<UpdateCheckSummary> {
        const summary = await runUpdateChecks(
            miners,
            this.updateSources,
            async (miner, result, error) => {
                const deviceId = this.getMinerDeviceObjectId(miner);
                if (error !== undefined) {
                    const reason = error instanceof Error ? error.message : JSON.stringify(error);
                    this.log.warn(`update check for ${deviceId} failed: ${reason}`);
                } else if (result.updateAvailable === true) {
                    this.log.info(
                        `update available for ${deviceId}: ${result.installedVersion ?? '?'} -> ${result.latestVersion ?? '?'}`,
                    );
                }

                try {
                    await this.writeUpdateStates(deviceId, miner, result);
                } catch (e) {
                    // keep checking the remaining miners
                    this.log.error(`could not write update states for ${deviceId}: ${String(e)}`);
                }
            },
            miner => this.getUpdateCheckContext(miner),
        );

        this.log.debug(`update check finished: ${JSON.stringify(summary)}`);
        return summary;
    }

    private async getUpdateCheckContext(miner: Miner<MinerSettings>): Promise<UpdateCheckContext> {
        const deviceId = this.getMinerDeviceObjectId(miner);
        const [raw, installed, online] = await Promise.all([
            this.getStateAsync(`${deviceId}.${getMinerFeatureFullId(MinerFeatureKey.rawStats)}`),
            this.getStateAsync(`${deviceId}.${getMinerFeatureFullId(miner.getInstalledVersionFeature())}`),
            this.getStateAsync(`${deviceId}.info.online`),
        ]);
        let rawStats: object | undefined;
        if (typeof raw?.val === 'string') {
            try {
                const parsed: unknown = JSON.parse(raw.val);
                if (parsed && typeof parsed === 'object') {
                    rawStats = parsed;
                }
            } catch {
                this.log.debug(`ignoring invalid stored raw stats for ${deviceId}`);
            }
        }
        return {
            online: this.minerManager.getMiners().includes(miner) && online?.val === true,
            lastStats: {
                raw: rawStats,
                firmwareVersion: typeof installed?.val === 'string' ? installed.val : undefined,
            },
        };
    }

    private async writeUpdateStates(
        deviceId: string,
        miner: Miner<MinerSettings>,
        result: UpdateCheckResult,
    ): Promise<void> {
        const supported = miner.getSupportedFeatures();
        const values: [MinerFeatureKey, ioBroker.StateValue][] = [
            [MinerFeatureKey.latestVersion, result.latestVersion ?? null],
            [MinerFeatureKey.updateAvailable, result.updateAvailable ?? null],
            [MinerFeatureKey.autoUpgrade, result.autoUpgrade?.enabled ?? null],
            [MinerFeatureKey.autoUpgradeNextRun, result.autoUpgrade?.nextRun ?? null],
        ];
        for (const [key, val] of values) {
            if (supported.includes(key)) {
                await this.setState(`${deviceId}.${getMinerFeatureFullId(key)}`, { val, ack: true });
            }
        }
    }

    private getMinerDeviceObjectId(miner: Miner<MinerSettings>): string {
        // same id scheme as getDeviceObjectId() for devices of the 'miner' category
        const category: (typeof categoryKeys)[number] = 'miner';
        return `${category}.${miner.settings.id}`;
    }

    private getDeviceObjectId(settings: IOBrokerDeviceSettings): string {
        if (!isMiner(settings)) {
            // TODO: pool support
            this.log.error(`category ${settings.category} is not yet supported.`);
            return '<unsupported>';
        }

        // TODO: cleanup?. don't use mac, use id. allows to use multiple miners with same mac (f.e. running trm && xmrig on same device)
        // return `${settings.category}.${settings.mac.replace(/:/g, '')}`;
        return `${settings.category}.${settings.settings.id}`;
    }

    private getStateFullObjectId(settings: IOBrokerDeviceSettings, featureKey: MinerFeatureKey): string {
        return `${this.getDeviceObjectId(settings)}.${getMinerFeatureFullId(featureKey)}`;
    }

    private setupMinerLib(): void {
        Logger.setLogger({
            log: (level, message) => {
                switch (level) {
                    case Level.DEBUG:
                        this.log.debug(message);
                        break;
                    case Level.INFO:
                        this.log.info(message);
                        break;
                    case Level.NOTICE:
                        this.log.info(message);
                        break;
                    case Level.WARN:
                        this.log.warn(message);
                        break;
                    case Level.ERROR:
                        this.log.error(message);
                        break;
                    case Level.FATAL:
                        this.log.error(message);
                        break;
                }
            },
        });
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new MinerAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new MinerAdapter())();
}
