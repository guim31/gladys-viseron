// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or the SDK's fake) and
// returns the hub, so index.js stays a few lines and the tests drive the very
// same wiring.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { ViseronHub } from './hub.js';
import { SCENE_ACTIONS } from './scenes.js';
import { INIT_FAILED, checkMessage } from './texts.js';
import { WIDGETS, widgetImage } from './widgets.js';

const logger = createLogger({ name: 'viseron-app' });

/**
 * @param {object} gladys GladysIntegration instance
 * @param {object} [options] test seams: fetch, WebSocket, timers, timings
 */
export function registerHandlers(gladys, options = {}) {
  const hub = new ViseronHub({
    gladys,
    fetch: options.fetch,
    WebSocket: options.WebSocket,
    timers: options.timers ?? true,
    timings: options.timings,
    socketTimings: options.socketTimings,
  });

  // Resolved once the hub has started; every handler waits for it, so a
  // command arriving during the first reading is not lost.
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let started = false;
  const whenReady =
    (fn) =>
    async (...args) => {
      await ready;
      return fn(...args);
    };

  gladys.on('connected', async () => {
    try {
      const config = normalizeConfig(await gladys.getConfig());
      if (started) {
        // A reconnection (Gladys restarted): re-sync what Gladys may have lost.
        await hub.resync(config);
        return;
      }
      await hub.start(config);
      started = true;
    } catch (err) {
      logger.error('Initialization failed', err);
      await gladys.setConnectionStatus(false, INIT_FAILED).catch(() => {});
    } finally {
      resolveReady();
    }
  });

  gladys.onScanRequest(whenReady(() => hub.refresh()));

  gladys.onSetValue(whenReady((device, feature, value) => hub.setValue(device, feature, value)));

  // A fresh image: dashboard, chat ("show me the camera"), the core's "Send a
  // camera image" scene action. Awaited under 15 s by Gladys.
  gladys.onGetImage(whenReady((device) => hub.imageFor(device?.external_id)));

  // The devices are published with should_poll: false (live events through
  // the WebSocket); this only serves a Gladys that would poll anyway.
  gladys.onPoll(whenReady(async () => {}));

  gladys.onDeviceCreated(whenReady((device) => hub.onDeviceCreated(device)));

  gladys.onConfigUpdated(
    whenReady(async (newConfig) => {
      await hub.reconfigure(normalizeConfig(newConfig));
    }),
  );

  gladys.onAction(
    'check',
    whenReady(async () => {
      await hub.refresh();
      await hub.readEntities();
      return checkMessage(hub.summary());
    }),
  );

  for (const [key, handler] of Object.entries(SCENE_ACTIONS)) {
    gladys.onSceneAction(
      key,
      whenReady((fields) => handler(hub, { fields })),
    );
  }

  for (const [key, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(
      key,
      whenReady((request) => widget.get(hub, request)),
    );
    gladys.onWidgetAction(
      key,
      whenReady((actionKey, params, context = {}) =>
        widget.action(hub, { actionKey, params, ...context }),
      ),
    );
  }
  gladys.onWidgetGetImage(whenReady((key) => widgetImage(hub, key)));

  return {
    hub,
    ready,
    stop: () => hub.stop(),
  };
}
