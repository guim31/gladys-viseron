// -----------------------------------------------------------------------------
// The Viseron hub: one server, its cameras, and everything Gladys sees of
// them.
//
// Two sources (the devices are published with should_poll: false, see
// src/devices.js):
//   - the WebSocket, live: the state of the `binary_sensor.<camera>_…`
//     entities (motion, objects by label and zone, recorder, connected).
//     Motion or an object appearing fires its scene trigger and sends the
//     image of the moment;
//   - the camera list (REST), every minute: names, cameras added or removed,
//     on, connected, recording, the snapshot token, and whether the server
//     answers at all. It keeps the states right while the WebSocket is down.
// An image also goes every `snapshot_interval` to each camera added in Gladys.
//
// States go through publishChangedStates (only what changed, a heartbeat
// every 12 h so a quiet value never looks stale).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { connectionKey } from './config.js';
import {
  FEATURE_KEYS,
  LEGACY_ONLINE_KEY,
  MAX_LABELS,
  OBJECT_PREFIX,
  buildDevice,
  deviceIds,
  deviceName,
  featureKeyOf,
  labelKey,
} from './devices.js';
import { ViseronClient, ViseronError } from './viseron/client.js';
import { ViseronSocket } from './viseron/socket.js';
import { CONNECTION_TEXT } from './texts.js';

const logger = createLogger({ name: 'viseron' });

export const WIDGET_KEY = 'camera';
export const TRIGGERS = {
  OBJECT: 'object_detected',
  MOTION: 'motion_detected',
  OFFLINE: 'camera_offline',
};

export const IMAGE_PREFIX = 'image/jpg;base64,';
// The core keeps camera images of 150 KB at most, once written as a data URI.
export const MAX_JPEG_BYTES = Math.floor((150 * 1024 - IMAGE_PREFIX.length) / 4) * 3;
// Widths asked to Viseron when a frame is too heavy (it keeps the ratio).
// Viseron encodes its snapshots at JPEG quality 100: a 768 px frame with a
// person in it already weighs over 150 KB at 640 px (seen on 3.7.0).
export const FIT_WIDTHS = [1280, 960, 640, 480, 320];

export const DEFAULT_TIMINGS = {
  listMs: 60 * 1000,
  // How often the image timer looks for a camera due for an image.
  imageTickMs: 5000,
  // A camera on but without a stream this long is said offline: a camera
  // reconnecting after a network blip does not fire the trigger.
  offlineAfterMs: 30 * 1000,
  // 12 images a minute per camera at most (the core's bound).
  minImageSpacingMs: 5000,
  // How long a trigger waits for the image of the moment.
  imageWaitMs: 3000,
  heartbeatMs: 12 * 60 * 60 * 1000,
  // Camera lists failed in a row before Viseron is said down (and its
  // cameras offline): one lost answer is not an outage.
  outageAfter: 2,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How old the last image may be to stand in for a fresh one.
const STALE_IMAGE_MS = 5 * 60 * 1000;

export const toDataUri = (jpeg) => `${IMAGE_PREFIX}${jpeg.toString('base64')}`;

const isOn = (state) => String(state?.state ?? state).toLowerCase() === 'on';

/** The best confidence of the objects of a state, in percent (0-100), or null. */
export function scoreOf(attributes) {
  const scores = (Array.isArray(attributes?.objects) ? attributes.objects : [])
    .map((object) => Number(object?.confidence))
    .filter((value) => Number.isFinite(value));
  if (scores.length === 0) {
    return null;
  }
  const best = Math.max(...scores);
  return Math.round(best <= 1 ? best * 100 : best);
}

/**
 * What a Viseron entity is about, for the cameras known (longest identifier
 * first: `front` and `front_door` both exist). Null when not one we read.
 *   binary_sensor.<c>_motion_detected                     motion
 *   binary_sensor.<c>_object_detected                     object (whole image)
 *   binary_sensor.<c>_object_detected_<label>             label (whole image)
 *   binary_sensor.<c>_zone_<zone>_object_detected_<label> label in a zone
 *   binary_sensor.<c>_recorder                            recording
 *   binary_sensor.<c>_connected                           connected
 */
export function parseEntity(entityId, cameraIds) {
  const match = /^binary_sensor\.(.+)$/.exec(String(entityId));
  if (!match) {
    return null;
  }
  const rest = match[1];
  const ids = [...cameraIds].sort((a, b) => b.length - a.length);
  for (const camera of ids) {
    if (!rest.startsWith(`${camera}_`)) {
      continue;
    }
    const tail = rest.slice(camera.length + 1);
    if (tail === 'motion_detected') {
      return { camera, kind: 'motion' };
    }
    if (tail === 'object_detected') {
      return { camera, kind: 'object' };
    }
    if (tail === 'recorder') {
      return { camera, kind: 'recording' };
    }
    if (tail === 'connected') {
      return { camera, kind: 'connected' };
    }
    let found = /^object_detected_(.+)$/.exec(tail);
    if (found) {
      return { camera, kind: 'label', label: found[1], zone: '' };
    }
    found = /^zone_(.+)_object_detected_(.+)$/.exec(tail);
    if (found) {
      return { camera, kind: 'label', label: found[2], zone: found[1] };
    }
    found = /^zone_(.+)_object_detected$/.exec(tail);
    if (found) {
      // A zone without labels: covered by the labels of the zone.
      return null;
    }
  }
  return null;
}

export class ViseronHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake)
   * @param {Function} [options.fetch] fetch for the Viseron client (tests)
   * @param {Function} [options.WebSocket] WebSocket class (tests)
   * @param {boolean} [options.timers] run the periodic timers
   * @param {object} [options.timings] overrides of DEFAULT_TIMINGS
   * @param {object} [options.socketTimings] overrides of SOCKET_TIMINGS
   */
  constructor({ gladys, fetch, WebSocket, timers = true, timings = {}, socketTimings }) {
    this.gladys = gladys;
    this.fetch = fetch;
    this.WebSocket = WebSocket;
    this.useTimers = timers;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.socketTimings = socketTimings;
    this.config = null;
    this.client = null;
    this.socket = null;
    this.clientKey = null;
    this.cameras = new Map();
    // Legacy `camera/enabled` features already set to 1 (releaseLegacyOnline).
    this.legacyReleased = new Set();
    // null (not tried yet), 'ok', 'auth', 'unreachable', 'error', 'noUrl'
    this.server = null;
    // Whether the live events flow (the WebSocket is open and subscribed).
    this.live = false;
    this.publishedDevicesKey = null;
    this.pending = new Set();
    this.timers = [];
    this.stopped = false;
    this.generation = 0;
  }

  // --- Lifecycle ---------------------------------------------------------------

  async start(config) {
    this.applyConfig(config);
    logger.info(
      this.client
        ? `Starting with the Viseron server ${this.client.label}`
        : 'No valid Viseron address in the configuration',
    );
    await this.releaseLegacyOnline();
    await this.refresh();
    this.startTimers();
  }

  /** Gladys came back: re-send what it may have lost. */
  async resync(config) {
    this.applyConfig(config);
    this.publishedDevicesKey = null;
    await this.refresh();
    for (const device of this.gladys.devices ?? []) {
      this.gladys.forgetPublishedStates(device.external_id);
    }
    await this.releaseLegacyOnline();
    await this.publishAllStates();
    await this.publishTransports();
  }

  async reconfigure(config) {
    const language = this.config?.language;
    this.applyConfig(config);
    if (language !== config.language) {
      this.publishedDevicesKey = null;
    }
    await this.refresh();
    this.startTimers();
  }

  applyConfig(config) {
    this.config = config;
    const key = connectionKey(config);
    if (key === this.clientKey) {
      return;
    }
    this.clientKey = key;
    this.generation += 1;
    this.socket?.close();
    this.socket = null;
    this.live = false;
    this.clearOfflineTimers();
    this.cameras.clear();
    // The cameras already added in Gladys, known before Viseron answers: they
    // can be said unreachable when it never does.
    for (const device of this.gladys.devices ?? []) {
      const param = (device.params ?? []).find((item) => item.name === 'VISERON_CAMERA');
      if (param?.value) {
        this.cameras.set(param.value, {
          ...this.newCamera(param.value),
          name: String(device.name ?? ''),
        });
      }
    }
    this.server = null;
    this.listFailures = 0;
    this.publishedDevicesKey = null;
    this.client = config.validUrl
      ? new ViseronClient({
          url: config.url,
          username: config.username,
          password: config.password,
          fetch: this.fetch,
        })
      : null;
  }

  startTimers() {
    this.clearTimers();
    if (!this.useTimers || this.stopped) {
      return;
    }
    this.timers.push(
      setInterval(() => this.track(this.refresh()), this.timings.listMs),
      setInterval(() => this.track(this.imageTick()), this.timings.imageTickMs),
    );
    for (const timer of this.timers) {
      timer.unref?.();
    }
  }

  clearTimers() {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
  }

  clearOfflineTimers() {
    for (const camera of this.cameras.values()) {
      clearTimeout(camera.offlineTimer);
      camera.offlineTimer = null;
    }
  }

  /** Keep a background task, so stop() and the tests can wait for it. */
  track(promise) {
    const task = Promise.resolve(promise).catch((err) => logger.debug(err.message));
    this.pending.add(task);
    task.finally(() => this.pending.delete(task));
    return task;
  }

  async idle() {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  async stop() {
    this.stopped = true;
    this.clearTimers();
    this.clearOfflineTimers();
    this.socket?.close();
    await this.idle();
  }

  // --- WebSocket -------------------------------------------------------------------

  /** Open the WebSocket once the server answers (and again after a change). */
  ensureSocket() {
    if (this.socket || !this.client || this.stopped) {
      return;
    }
    const generation = this.generation;
    this.socket = new ViseronSocket({
      client: this.client,
      WebSocket: this.WebSocket,
      timings: this.socketTimings,
      onOpen: () => this.socketOpened(generation),
      onState: (data) => {
        if (generation === this.generation) {
          this.track(this.onState(data));
        }
      },
      onClose: (err, { connected }) => {
        if (generation === this.generation) {
          this.socketLost(err, connected);
        }
      },
    });
    this.track(this.socket.connect());
  }

  async socketOpened(generation) {
    if (generation !== this.generation) {
      return;
    }
    if (this.socketFailing) {
      logger.info('The Viseron live events are back');
    }
    this.socketFailing = false;
    try {
      await this.socket.followStates();
    } catch (err) {
      logger.debug(`Cannot follow the Viseron states: ${err.message}`);
      return;
    }
    await this.readEntities({ initial: true });
    // The link may have gone (or the configuration changed) meanwhile.
    if (generation !== this.generation || !this.socket?.ready) {
      return;
    }
    this.live = true;
    this.requestWidgetRefresh();
  }

  socketLost(err, connected) {
    this.live = false;
    // Without live events a detection would stay at 1: back to none.
    for (const camera of this.cameras.values()) {
      if (camera.entitiesRead) {
        this.clearDetections(camera);
        this.track(this.publishStates(camera));
      }
    }
    if (!this.socketFailing) {
      this.socketFailing = true;
      // An auth refusal or a lost link: one line, until it is back.
      const line = `Viseron live events unavailable: ${err.message}`;
      if (connected || err.kind === 'auth') {
        logger.warn(line);
      } else {
        logger.info(line);
      }
    } else {
      logger.debug(err.message);
    }
  }

  /**
   * Read every entity: what each camera has (motion, objects, labels) and
   * their states, then follow the entities we read. `initial`: what is going
   * on now is not news (no trigger).
   */
  async readEntities({ initial = false } = {}) {
    if (!this.socket?.ready) {
      return;
    }
    const generation = this.generation;
    // The states changed live while reading are newer than the snapshot.
    const seenLive = new Set();
    this.seenLive = seenLive;
    let entities;
    try {
      entities = await this.socket.entities();
    } catch (err) {
      logger.debug(`Cannot read the Viseron entities: ${err.message}`);
      return;
    } finally {
      this.seenLive = null;
    }
    if (generation !== this.generation) {
      return;
    }
    const ids = [...this.cameras.keys()];
    const found = new Map(ids.map((id) => [id, { motion: false, object: false, labels: [] }]));
    const states = [];
    for (const [entityId, entity] of Object.entries(entities)) {
      const what = parseEntity(entityId, ids);
      if (!what) {
        continue;
      }
      const has = found.get(what.camera);
      if (what.kind === 'motion') {
        has.motion = true;
      } else if (what.kind === 'object') {
        has.object = true;
      } else if (what.kind === 'label' && !has.labels.includes(what.label)) {
        has.labels.push(what.label);
      }
      if (!seenLive.has(entityId)) {
        states.push({ entity_id: entityId, current_state: entity });
      }
    }
    for (const [id, has] of found) {
      const camera = this.cameras.get(id);
      camera.hasMotion = has.motion;
      camera.hasObject = has.object;
      camera.labels = has.labels.sort().slice(0, MAX_LABELS);
      camera.entitiesRead = true;
    }
    for (const state of states) {
      await this.onState(state, { initial });
    }
    await this.publishDevices();
    await this.publishAllStates();
  }

  /** One `state_changed` (or an entity read at start, `initial`). */
  async onState(data, { initial = false } = {}) {
    if (!initial) {
      this.seenLive?.add(data?.entity_id);
    }
    const what = parseEntity(data?.entity_id, [...this.cameras.keys()]);
    const camera = what ? this.cameras.get(what.camera) : null;
    if (!camera) {
      return;
    }
    const on = isOn(data.current_state);
    const attributes = data.current_state?.attributes ?? {};
    switch (what.kind) {
      case 'motion': {
        const rising = on && camera.motion === false && !initial;
        camera.motion = on;
        await this.publishStates(camera);
        if (rising) {
          await this.fire(camera, TRIGGERS.MOTION, {});
        }
        break;
      }
      case 'object':
        camera.object = on;
        await this.publishStates(camera);
        break;
      case 'label': {
        const key = `${what.zone}|${what.label}`;
        const was = camera.zoneLabels.get(key);
        camera.zoneLabels.set(key, on);
        // In view anywhere: the whole image or a zone (a label may be
        // tracked in zones only).
        camera.labelStates[what.label] = [...camera.zoneLabels].some(
          ([zoneKey, value]) => value && zoneKey.endsWith(`|${what.label}`),
        );
        await this.publishStates(camera);
        if (on && was === false && !initial) {
          await this.fire(camera, TRIGGERS.OBJECT, {
            label: what.label,
            zone: what.zone,
            score: scoreOf(attributes),
          });
        }
        break;
      }
      case 'recording':
        if (camera.recording !== on) {
          camera.recording = on;
          await this.publishStates(camera);
          this.requestWidgetRefresh();
        }
        break;
      case 'connected':
        camera.connected = on;
        await this.checkOnline(camera);
        break;
      default:
        break;
    }
  }

  /** The image of the moment first, then the trigger. */
  async fire(camera, key, data) {
    if (!this.isCreated(camera)) {
      return;
    }
    // The image of the moment first, but the trigger never waits long for it.
    const image = this.track(this.publishImage(camera, { wait: true }));
    await Promise.race([image, sleep(this.timings.imageWaitMs)]);
    this.requestWidgetRefresh();
    this.track(
      this.gladys.publishSceneEvent(key, {
        camera: this.ids(camera).device,
        camera_name: deviceName(camera),
        ...data,
      }),
    );
  }

  // --- Server and camera list ------------------------------------------------------

  /** Read the camera list; publish what changed. */
  refresh() {
    // A refresh started before a change of configuration speaks of the old
    // server: chain a new one rather than share its result.
    if (!this.refreshing || this.refreshing.generation !== this.generation) {
      const previous = this.refreshing ?? Promise.resolve();
      const generation = this.generation;
      const run = previous
        .catch(() => {})
        .then(() => this.doRefresh(generation))
        .finally(() => {
          if (this.refreshing === run) {
            this.refreshing = null;
          }
        });
      run.generation = generation;
      this.refreshing = run;
    }
    return this.refreshing;
  }

  async doRefresh(generation = this.generation) {
    if (!this.client) {
      await this.setServer('noUrl');
      return;
    }
    let list;
    try {
      list = await this.client.listCameras();
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      this.listFailures += 1;
      if (
        this.server === 'ok' &&
        err.kind !== 'auth' &&
        this.listFailures < this.timings.outageAfter
      ) {
        logger.debug(`Cannot read the camera list: ${err.message}`);
        return;
      }
      await this.serverFailed(err);
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    this.listFailures = 0;
    const seen = new Set();
    let added = false;
    for (const item of list) {
      seen.add(item.id);
      let camera = this.cameras.get(item.id);
      if (!camera) {
        camera = this.newCamera(item.id);
        this.cameras.set(item.id, camera);
      }
      if (!camera.listed) {
        // New, or only known from Gladys until now: its entities are to read.
        camera.listed = true;
        added = true;
      }
      this.applyCamera(camera, item);
    }
    for (const [id, camera] of [...this.cameras]) {
      if (!seen.has(id)) {
        logger.info(`Camera ${id} is no longer in Viseron`);
        // Its device stays in Gladys: no "local" badge nor detection left behind.
        this.clearDetections(camera);
        await this.publishStates(camera);
        if (camera.online !== false) {
          camera.online = false;
          await this.publishTransports([camera]);
        }
        this.cameras.delete(id);
      }
    }
    if (generation !== this.generation) {
      return;
    }
    await this.setServer('ok');
    this.ensureSocket();
    if (added && this.socket?.ready) {
      await this.readEntities({ initial: true });
    }
    await this.publishDevices();
    for (const camera of this.cameras.values()) {
      await this.checkOnline(camera);
    }
    await this.publishAllStates();
  }

  newCamera(id) {
    return {
      id,
      name: '',
      listed: false,
      on: true,
      connected: null,
      recording: null,
      accessToken: null,
      hasMotion: false,
      hasObject: false,
      labels: [],
      motion: null,
      object: null,
      labelStates: {},
      zoneLabels: new Map(),
      online: null,
      offlineSince: null,
      image: null,
      imageSeq: 0,
      lastPublishAt: 0,
      fitWidth: undefined,
    };
  }

  /** The camera list: name, token, on; connected and recording when not live. */
  applyCamera(camera, item) {
    camera.name = item.name;
    camera.accessToken = item.accessToken;
    camera.on = item.on;
    camera.width = item.width;
    if (!this.live || camera.connected === null) {
      camera.connected = item.connected;
    }
    if (!this.live || camera.recording === null) {
      camera.recording = item.recording;
    }
  }

  clearDetections(camera) {
    camera.motion = camera.motion === null ? null : false;
    camera.object = camera.object === null ? null : false;
    for (const label of Object.keys(camera.labelStates)) {
      camera.labelStates[label] = false;
    }
    for (const key of camera.zoneLabels.keys()) {
      camera.zoneLabels.set(key, false);
    }
  }

  async serverFailed(err) {
    const state = err.kind === 'auth' ? 'auth' : err.kind === 'network' ? 'unreachable' : 'error';
    if (state !== this.server) {
      const line = `Viseron ${this.client.label}: ${err.message}`;
      if (state === 'unreachable' && this.server === 'ok') {
        logger.warn(line);
      } else {
        logger.error(line);
      }
    } else {
      logger.debug(err.message);
    }
    await this.setServer(state);
  }

  async setServer(state) {
    const previous = this.server;
    this.server = state;
    if (state === 'ok' && previous && previous !== 'ok' && previous !== 'noUrl') {
      logger.info(`Viseron ${this.client.label} answers again`);
    }
    if (state === previous) {
      return;
    }
    if (state !== 'ok') {
      // Nothing can be read any more: no stale detection, no "local" badge.
      const outage = state === 'unreachable' || state === 'error';
      for (const camera of this.cameras.values()) {
        this.clearDetections(camera);
        await this.publishStates(camera);
        // Viseron down: its cameras are lost too ("Camera offline").
        await this.setOnline(camera, false, { quiet: !outage });
      }
    }
    try {
      if (state === 'ok') {
        await this.gladys.setConnectionStatus(true);
      } else {
        await this.gladys.setConnectionStatus(false, CONNECTION_TEXT[state]);
      }
    } catch (err) {
      logger.debug(`Cannot send the connection status: ${err.message}`);
    }
  }

  // --- Devices -------------------------------------------------------------------

  ids(camera) {
    return deviceIds(this.gladys, camera.id);
  }

  async publishDevices() {
    const devices = [...this.cameras.values()].map((camera) =>
      buildDevice(this.gladys, this.withKnownFeatures(camera), this.config.language),
    );
    // Republished when a camera appears, goes, is renamed or gains a
    // feature: an upsert on the devices already added, a new entry in the
    // Discovery tab otherwise.
    const key = JSON.stringify(
      devices.map((device) => [
        device.external_id,
        device.name,
        device.features.map((feature) => feature.external_id),
      ]),
    );
    if (key === this.publishedDevicesKey) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.publishedDevicesKey = key;
      if (this.devicesFailing) {
        this.devicesFailing = false;
        logger.info('The cameras are published to Gladys again');
      }
    } catch (err) {
      // Tried again at the next reading of the list.
      if (!this.devicesFailing) {
        this.devicesFailing = true;
        logger.warn(`Cannot publish the cameras to Gladys: ${err.message}`);
      }
    }
  }

  /**
   * Until the WebSocket told what a camera has, a camera already added keeps
   * the features it has in Gladys: published without them, Discovery would
   * offer an "Update" that deletes them, history and scenes with them.
   */
  withKnownFeatures(camera) {
    if (camera.entitiesRead) {
      return camera;
    }
    const externalId = this.ids(camera).device;
    const device = (this.gladys.devices ?? []).find((item) => item.external_id === externalId);
    if (!device) {
      return camera;
    }
    const keys = (device.features ?? []).map((feature) => featureKeyOf(feature.external_id));
    return {
      ...camera,
      hasMotion: keys.includes(FEATURE_KEYS.MOTION),
      hasObject: keys.includes(FEATURE_KEYS.OBJECT),
      labels: keys
        .filter((key) => key?.startsWith(OBJECT_PREFIX))
        .map((key) => key.slice(OBJECT_PREFIX.length)),
    };
  }

  isCreated(camera) {
    const externalId = this.ids(camera).device;
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  /** The camera behind a Gladys device external id, or null. */
  resolveDevice(externalId) {
    for (const camera of this.cameras.values()) {
      if (this.ids(camera).device === externalId) {
        return camera;
      }
    }
    return null;
  }

  require(externalId) {
    const camera = this.resolveDevice(externalId);
    if (!camera) {
      throw new Error(`Unknown Viseron camera ${externalId}: check the integration`);
    }
    return camera;
  }

  // --- States --------------------------------------------------------------------

  statesOf(camera) {
    const ids = this.ids(camera);
    const states = [];
    const add = (key, value) => {
      if (value !== null && value !== undefined) {
        states.push({ device_feature_external_id: ids.feature(key), state: value ? 1 : 0 });
      }
    };
    if (camera.hasMotion) {
      add(FEATURE_KEYS.MOTION, camera.motion);
    }
    if (camera.hasObject) {
      add(FEATURE_KEYS.OBJECT, camera.object);
    }
    for (const label of camera.labels) {
      add(labelKey(label), camera.labelStates[label]);
    }
    add(FEATURE_KEYS.RECORDING, camera.recording);
    return states;
  }

  /**
   * Up to 1.0.x the camera device carried "Online" as `camera/enabled`, which
   * Gladys 5.2 reads as the user's privacy mode: at 0 the core refuses the
   * camera's images. The feature stays on the devices added before, until the
   * user clicks "Update" in the Discovery tab: set it to 1 once, so the images
   * flow, then never write it again (it is the user's switch now).
   */
  async releaseLegacyOnline() {
    const states = [];
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        const id = feature?.external_id;
        if (
          feature.category === 'camera' &&
          feature.type === 'enabled' &&
          id === `${device.external_id}:${LEGACY_ONLINE_KEY}` &&
          !this.legacyReleased.has(id)
        ) {
          states.push({ device_feature_external_id: id, state: 1 });
        }
      }
    }
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishStates(states);
      for (const state of states) {
        this.legacyReleased.add(state.device_feature_external_id);
      }
      logger.info(
        `${states.length} camera(s) still have the old "Online" feature: click "Update" in the Discovery tab`,
      );
    } catch (err) {
      // Tried again when Gladys comes back.
      logger.warn(`Cannot reset the old "Online" feature: ${err.message}`);
    }
  }

  async publishStates(camera) {
    if (!this.isCreated(camera)) {
      return;
    }
    const states = this.statesOf(camera);
    if (states.length === 0) {
      return;
    }
    try {
      // Only what changed; a value that never changes again every 12 h.
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      if (this.statesFailing) {
        this.statesFailing = false;
        logger.info('States are published to Gladys again');
      }
    } catch (err) {
      if (this.statesFailing) {
        logger.debug(`Cannot publish the states of camera ${camera.id}: ${err.message}`);
      } else {
        this.statesFailing = true;
        logger.warn(`Cannot publish the states of camera ${camera.id}: ${err.message}`);
      }
    }
  }

  async publishAllStates() {
    for (const camera of this.cameras.values()) {
      await this.publishStates(camera);
    }
  }

  async publishTransports(cameras = [...this.cameras.values()]) {
    const entries = cameras
      .filter((camera) => camera.online !== null && this.isCreated(camera))
      .map((camera) => ({
        external_id: this.ids(camera).device,
        transport: camera.online ? 'local' : 'unreachable',
      }));
    if (entries.length > 0) {
      await this.gladys.publishTransports(entries).catch((err) => logger.debug(err.message));
    }
  }

  /**
   * The user added a device: the states sent before were dropped by Gladys,
   * and so was the transport badge. Send them again, with an image.
   */
  async onDeviceCreated(device) {
    const camera = this.resolveDevice(device?.external_id);
    if (!camera) {
      return;
    }
    this.gladys.forgetPublishedStates(device.external_id);
    camera.lastPublishAt = 0;
    await this.publishStates(camera);
    if (camera.online) {
      await this.publishImage(camera);
    }
    await this.publishTransports([camera]);
    this.requestWidgetRefresh();
  }

  requestWidgetRefresh() {
    try {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    } catch (err) {
      logger.debug(`Widget refresh refused: ${err.message}`);
    }
  }

  // --- Online / offline ------------------------------------------------------------

  async checkOnline(camera) {
    if (!camera.on) {
      // Stopped in Viseron: no stream expected, no "offline" alarm.
      camera.offlineSince = null;
      await this.setOnline(camera, false, { quiet: true });
      return;
    }
    if (camera.connected) {
      camera.offlineSince = null;
      await this.setOnline(camera, true);
      return;
    }
    if (camera.connected === null) {
      return;
    }
    const now = Date.now();
    camera.offlineSince ??= now;
    if (camera.online === null || now - camera.offlineSince >= this.timings.offlineAfterMs) {
      await this.setOnline(camera, false);
    } else if (!camera.offlineTimer && this.useTimers) {
      // The WebSocket says "disconnected" once: look again when the delay is over.
      camera.offlineTimer = setTimeout(() => {
        camera.offlineTimer = null;
        this.track(this.checkOnline(camera));
      }, this.timings.offlineAfterMs);
      camera.offlineTimer.unref?.();
    }
  }

  async setOnline(camera, online, { quiet = false } = {}) {
    if (camera.online === online) {
      return;
    }
    const was = camera.online;
    camera.online = online;
    const name = deviceName(camera);
    if (online && was === false) {
      logger.info(`Camera ${name} is online again`);
    } else if (!online && was === true && !quiet) {
      logger.info(`Camera ${name} is offline`);
    }
    await this.publishStates(camera);
    await this.publishTransports([camera]);
    this.requestWidgetRefresh();
    if (!online && was === true && !quiet && this.isCreated(camera)) {
      this.track(
        this.gladys.publishSceneEvent(TRIGGERS.OFFLINE, {
          camera: this.ids(camera).device,
          camera_name: name,
        }),
      );
    }
  }

  // --- Images --------------------------------------------------------------------

  /** Every few seconds: the cameras due for their periodic image. */
  async imageTick() {
    if (!this.client || this.server !== 'ok') {
      return;
    }
    for (const camera of this.cameras.values()) {
      if (
        camera.online &&
        Date.now() - camera.lastPublishAt >= this.config.snapshotSeconds * 1000
      ) {
        await this.publishImage(camera);
      }
    }
  }

  /**
   * A JPEG Gladys keeps (≤ MAX_JPEG_BYTES): at full size, or narrower. The
   * width that fitted last is tried first, then the narrower ones: a frame
   * with more detail (an object came in) weighs more.
   */
  async grab(camera) {
    // Narrower than the camera only: Viseron would scale a frame up.
    const widths = [null, ...FIT_WIDTHS.filter((width) => !camera.width || width < camera.width)];
    const from = camera.fitWidth === undefined ? 0 : Math.max(widths.indexOf(camera.fitWidth), 0);
    for (const width of widths.slice(from)) {
      let jpeg;
      try {
        jpeg = await this.client.snapshot(camera, { width });
      } catch (err) {
        if (err.kind !== 'auth' || !this.client) {
          throw err;
        }
        // The camera token turns every few minutes: read the list, try again.
        await this.refresh();
        jpeg = await this.client.snapshot(camera, { width });
      }
      if (jpeg.length <= MAX_JPEG_BYTES) {
        camera.fitWidth = width;
        camera.image = { jpeg, at: Date.now() };
        camera.imageSeq += 1;
        return jpeg;
      }
    }
    camera.fitWidth = undefined;
    throw new ViseronError(`The frames of camera ${camera.id} stay over 150 KB`);
  }

  /** Send a fresh frame to Gladys, at most one every 5 s per camera. */
  async publishImage(camera, { wait = false } = {}) {
    if (!this.isCreated(camera) || !this.client) {
      return false;
    }
    const left = camera.lastPublishAt + this.timings.minImageSpacingMs - Date.now();
    if (left > 0) {
      if (!wait) {
        return false;
      }
      await sleep(left);
    }
    camera.lastPublishAt = Date.now();
    try {
      const jpeg = await this.grab(camera);
      // The DEVICE external id: the core answers 404 to a feature's.
      await this.gladys.publishCameraImage(this.ids(camera).device, toDataUri(jpeg));
      return true;
    } catch (err) {
      // 404: the camera is turned off in Gladys, or not added; 429: too many.
      logger.debug(`Image of camera ${camera.id} not sent: ${err.message}`);
      return false;
    }
  }

  /** A fresh image for Gladys (dashboard, "show me the camera"): data URI. */
  async imageFor(externalId) {
    const camera = this.require(externalId);
    try {
      return toDataUri(await this.grab(camera));
    } catch (err) {
      logger.debug(`No fresh image of camera ${camera.id}: ${err.message}`);
      if (!camera.image || Date.now() - camera.image.at > STALE_IMAGE_MS) {
        throw new Error(`Camera ${camera.id} has no image right now`, { cause: err });
      }
      return toDataUri(camera.image.jpeg);
    }
  }

  // --- Commands ------------------------------------------------------------------

  /** The recording switch of the dashboard, or a scene's "Control a device". */
  async setValue(device, feature, value) {
    const camera = this.require(device?.external_id);
    if (featureKeyOf(feature?.external_id) !== FEATURE_KEYS.RECORDING) {
      throw new Error(`The feature ${feature?.external_id} cannot be set`);
    }
    await this.setRecording(camera, Number(value) === 1);
  }

  /** Start or stop a manual recording; Viseron waits until it shows. */
  async setRecording(camera, on) {
    if (!this.client) {
      throw new Error('No Viseron address in the configuration');
    }
    await this.client.setRecording(camera.id, on);
    logger.info(`Recording ${on ? 'started' : 'stopped'} on camera ${camera.id}`);
    camera.recording = on;
    await this.publishStates(camera);
    this.requestWidgetRefresh();
  }

  // --- Report --------------------------------------------------------------------

  summary() {
    if (this.server !== 'ok') {
      return { problem: this.server ?? 'unreachable' };
    }
    return {
      url: this.client.label,
      version: this.socket?.version ?? null,
      live: this.live,
      cameras: [...this.cameras.values()].map((camera) => ({
        name: deviceName(camera),
        on: camera.on,
        online: camera.online,
        recording: camera.recording,
        labels: camera.labels,
      })),
    };
  }
}
