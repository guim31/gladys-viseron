// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys and a simulated Viseron
// (test/helpers/fakeViseron.js), with the integration wired on top through
// registerHandlers. No periodic timer runs: the tests call the hub's cycles.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { FakeViseron } from './fakeViseron.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const DEFAULT_CONFIG = { url: '192.0.2.10', language: 'en' };

export const FAST = {
  minImageSpacingMs: 0,
  offlineAfterMs: 0,
};

/** Let the fake's queued messages and the hub's background tasks run out. */
export async function settle(world) {
  for (let round = 0; round < 20; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await world.hub.idle();
  }
}

/**
 * @param {object} [options]
 * @param {FakeViseron} [options.server]
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.created] devices already created in Gladys
 */
export async function createWorld({
  server = new FakeViseron(),
  config = DEFAULT_CONFIG,
  created = [],
  connect = true,
  timings = FAST,
} = {}) {
  const gladys = createFakeGladys({ config, devices: created });
  const app = registerHandlers(gladys, {
    fetch: server.fetch,
    WebSocket: server.WebSocket,
    timers: false,
    timings,
    socketTimings: { retryMinMs: 1, retryMaxMs: 5 },
  });
  const world = { gladys, fake: gladys.fake, server, app, hub: app.hub };
  if (connect) {
    await gladys.connect();
    await app.ready;
    await settle(world);
  }
  return world;
}

/** Add every discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
  await settle(world);
}

export { FakeViseron };
