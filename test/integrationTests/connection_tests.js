
/**
 * Connection indicator (#231):
 * info.connection indicates whether the adapter is running.
 * info.connectedMiners lists the reachable miners.
 *
 * The adapter remains connected even when all miners are offline,
 * for example when PV-controlled miners are switched off.
 */

const net = require('net');

const summaryVersionFixture = require('../../src/lib/miner/fixture/nano3s-summary+version.json');

/**
 * A miner speaking the CGMiner API: answers every request with
 * the summary+version fixture.
 * stop() makes it unreachable, like a miner that was switched off.
 */
async function startFakeMiner() {
    const sockets = new Set();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('data', () => socket.end(JSON.stringify(summaryVersionFixture)));
    });

    await new Promise(resolve =>
        server.listen(0, '127.0.0.1', () => resolve(undefined)),
    );

    return {
        port: /** @type {net.AddressInfo} */ (server.address()).port,
        stop: () =>
            new Promise(resolve => {
                sockets.forEach(socket => socket.destroy());
                server.close(() => resolve(undefined));
            }),
    };
}

/**
 * Waits until a state has the expected value.
 *
 * @param harness - the test harness
 * @param id - full state id
 * @param expected - the value to wait for
 * @param timeoutMs - how long to wait at most
 */
async function waitForState(harness, id, expected, timeoutMs) {
    const until = Date.now() + timeoutMs;
    let state;

    while (Date.now() < until) {
        state = await harness.states.getStateAsync(id);

        if (state && state.val === expected) {
            return;
        }

        await new Promise(resolve => setTimeout(resolve, 200));
    }

    throw new Error(
        `${id} did not become ${expected} within ${timeoutMs}ms (last value: ${state && state.val})`,
    );
}

exports.runTests = function (suite) {
    suite('connection indicator (#231)', getHarness => {
        let harness;
        let miner;

        before(async () => {
            harness = getHarness();
            miner = await startFakeMiner();

            // A device as the device manager stores it
            await harness.objects.setObjectAsync('miner.0.miner.it-cgminer', {
                type: 'device',
                common: { name: 'integration test miner' },
                native: {
                    category: 'miner',
                    name: 'integration test miner',
                    mac: '',
                    settings: {
                        id: 'it-cgminer',
                        minerType: 'cgMiner',
                        host: '127.0.0.1',
                        port: miner.port,
                        pollInterval: 500,
                    },
                },
            });
        });

        after(async () => {
            await miner.stop();
        });

        it('keeps adapter connected when a miner is reachable', async () => {
            await harness.startAdapterAndWait();

            // Adapter must be connected
            await waitForState(
                harness,
                'miner.0.info.connection',
                true,
                10_000,
            );

            // Miner must be online
            await waitForState(
                harness,
                'miner.0.miner.it-cgminer.info.online',
                true,
                10_000,
            );

            // Reachable miner must appear in the separate list
            await waitForState(
                harness,
                'miner.0.info.connectedMiners',
                'integration test miner',
                5_000,
            );
        }).timeout(30_000);

        it('keeps adapter connected when all miners are offline', async () => {
            // Simulate switching off the miner
            await miner.stop();

            // Miner should become offline after failed polls
            await waitForState(
                harness,
                'miner.0.miner.it-cgminer.info.online',
                false,
                20_000,
            );

            // Reachable miner list must become empty
            await waitForState(
                harness,
                'miner.0.info.connectedMiners',
                '',
                5_000,
            );

            // Adapter must remain connected despite offline miner
            await waitForState(
                harness,
                'miner.0.info.connection',
                true,
                5_000,
            );
        }).timeout(30_000);
    });
};
