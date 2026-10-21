// The integration end to end, against the SDK's fake Gladys and a simulated
// Viseron (answers recorded from 3.7.0): discovery, states, images, live
// events and their triggers, offline cameras, a server down, the WebSocket
// lost, authentication, recording, the manifest action.
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRIGGERS, parseEntity, scoreOf } from '../src/hub.js';
import { DEFAULT_CONFIG, FakeViseron, createAll, createWorld, settle } from './helpers/world.js';

function idOf(world, camera, feature) {
  const ids = world.hub.ids({ id: camera });
  return feature ? ids.feature(feature) : ids.device;
}

const lastState = (world, camera, feature) => world.fake.lastState(idOf(world, camera, feature));
const events = (world, key) => world.fake.sceneEvents.filter((event) => event.key === key);
const featureKeys = (device) =>
  device.features.map((feature) => feature.external_id.split(':').pop());

async function change(world, entity, state, attributes) {
  world.server.setState(entity, state, attributes);
  await settle(world);
}

test('one device per camera, with what Viseron detects on it, without the scheduler', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const devices = world.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((device) => [device.name, device.should_poll]),
    [
      ['Front door', false],
      ['Garage', false],
    ],
  );
  assert.deepEqual(featureKeys(devices[0]), [
    'image',
    'motion',
    'object',
    'object-dog',
    'object-person',
    'recording',
    'online',
  ]);
  assert.deepEqual(featureKeys(devices[1]), [
    'image',
    'motion',
    'object',
    'object-bicycle',
    'object-truck',
    'recording',
    'online',
  ]);
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.equal(world.hub.live, true);
});

test('adding the devices publishes every state, the badge and an image', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  for (const camera of ['front_door', 'garage']) {
    for (const feature of ['motion', 'object', 'recording', 'online']) {
      assert.notEqual(lastState(world, camera, feature), undefined, `${camera} ${feature}`);
    }
  }
  assert.equal(lastState(world, 'front_door', 'online'), 1);
  const transports = Object.fromEntries(
    world.fake.transports.map((entry) => [entry.device_external_id, entry.transport]),
  );
  assert.equal(transports[idOf(world, 'front_door')], 'local');
  // The image goes with the DEVICE external id (the core answers 404 to a feature's).
  const images = new Set(world.fake.cameraImages.map((image) => image.device_external_id));
  assert.ok(images.has(idOf(world, 'front_door')) && images.has(idOf(world, 'garage')));
  assert.match(world.fake.cameraImages[0].image, /^image\/jpg;base64,\/9j\//);
  assert.ok(world.fake.widgetRefreshes.includes('camera'));
});

test('the container sends the images on its own: no onPoll needed', async (t) => {
  const world = await createWorld({ config: { ...DEFAULT_CONFIG, snapshot_interval: '10' } });
  t.after(() => world.app.stop());
  await createAll(world);
  const before = world.fake.cameraImages.length;
  for (const camera of world.hub.cameras.values()) {
    camera.lastPublishAt -= 10000;
  }
  await world.hub.imageTick();
  assert.equal(world.fake.cameraImages.length, before + 2);
  await world.hub.imageTick();
  assert.equal(world.fake.cameraImages.length, before + 2, 'not before the interval');
});

test('motion starting: the state, an image, the trigger once; and back to none', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  const before = world.fake.cameraImages.length;
  await change(world, 'binary_sensor.garage_motion_detected', 'on');
  await change(world, 'binary_sensor.garage_motion_detected', 'on');
  assert.equal(lastState(world, 'garage', 'motion'), 1);
  assert.equal(world.fake.cameraImages.length, before + 1);
  assert.deepEqual(
    events(world, TRIGGERS.MOTION).map((event) => event.data),
    [{ camera: idOf(world, 'garage'), camera_name: 'Garage' }],
  );
  await change(world, 'binary_sensor.garage_motion_detected', 'off');
  assert.equal(lastState(world, 'garage', 'motion'), 0);
  assert.equal(events(world, TRIGGERS.MOTION).length, 1);
});

test('an object appearing fires its label, its zone and its score', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  const objects = [
    { label: 'person', confidence: 0.912, rel_x1: 0.1 },
    { label: 'person', confidence: 0.64, rel_x1: 0.5 },
  ];
  await change(world, 'binary_sensor.front_door_object_detected', 'on', { objects });
  await change(world, 'binary_sensor.front_door_object_detected_person', 'on', {
    count: 2,
    objects,
  });
  await change(world, 'binary_sensor.front_door_zone_porch_object_detected_person', 'on', {
    count: 1,
    objects: objects.slice(1),
  });
  assert.equal(lastState(world, 'front_door', 'object'), 1);
  assert.equal(lastState(world, 'front_door', 'object-person'), 1);
  assert.equal(lastState(world, 'front_door', 'object-dog'), 0);
  const camera = idOf(world, 'front_door');
  assert.deepEqual(
    events(world, TRIGGERS.OBJECT).map((event) => event.data),
    [
      { camera, camera_name: 'Front door', label: 'person', zone: '', score: 91 },
      { camera, camera_name: 'Front door', label: 'person', zone: 'porch', score: 64 },
    ],
  );
  // Still in view: no new trigger; gone then back: one more.
  await change(world, 'binary_sensor.front_door_object_detected_person', 'on', { objects });
  await change(world, 'binary_sensor.front_door_object_detected_person', 'off', { objects: [] });
  assert.equal(lastState(world, 'front_door', 'object-person'), 0);
  await change(world, 'binary_sensor.front_door_object_detected_person', 'on', { objects });
  assert.equal(events(world, TRIGGERS.OBJECT).length, 3);
});

test('what is going on when the integration starts is not news', async (t) => {
  const server = new FakeViseron();
  server.entities['binary_sensor.front_door_object_detected_person'].state = 'on';
  server.entities['binary_sensor.front_door_motion_detected'].state = 'on';
  const world = await createWorld({ server });
  t.after(() => world.app.stop());
  await createAll(world);
  assert.equal(lastState(world, 'front_door', 'object-person'), 1);
  assert.equal(lastState(world, 'front_door', 'motion'), 1);
  assert.deepEqual(world.fake.sceneEvents, []);
});

test('a camera losing its stream: offline after the delay, the trigger, then back', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  await change(world, 'binary_sensor.garage_connected', 'off');
  assert.equal(lastState(world, 'garage', 'online'), 0);
  assert.deepEqual(
    events(world, TRIGGERS.OFFLINE).map((event) => event.data),
    [{ camera: idOf(world, 'garage'), camera_name: 'Garage' }],
  );
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  await change(world, 'binary_sensor.garage_connected', 'on');
  assert.equal(lastState(world, 'garage', 'online'), 1);
  assert.equal(world.fake.transports.at(-1).transport, 'local');
});

test('a camera stopped in Viseron is offline without alarm', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.cameras.garage.is_on = false;
  world.server.cameras.garage.connected = false;
  await world.hub.refresh();
  assert.equal(lastState(world, 'garage', 'online'), 0);
  assert.deepEqual(events(world, TRIGGERS.OFFLINE), []);
});

test('Viseron down: one lost answer is not an outage, two are; then back', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.down = true;
  world.server.dropSockets();
  await settle(world);
  assert.equal(world.hub.live, false);
  await world.hub.refresh();
  assert.equal(world.hub.server, 'ok');
  await world.hub.refresh();
  assert.equal(world.hub.server, 'unreachable');
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.equal(events(world, TRIGGERS.OFFLINE).length, 2);
  assert.equal(lastState(world, 'front_door', 'online'), 0);
  world.server.down = false;
  await world.hub.refresh();
  await settle(world);
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.equal(lastState(world, 'front_door', 'online'), 1);
  // The WebSocket is open again and followed: live events flow.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await settle(world);
  assert.equal(world.hub.live, true);
  await change(world, 'binary_sensor.garage_motion_detected', 'on');
  assert.equal(events(world, TRIGGERS.MOTION).length, 1);
});

test('the WebSocket lost alone is opened again, without a trigger for what it missed', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.socketDown = true;
  world.server.dropSockets();
  await settle(world);
  assert.equal(world.hub.live, false);
  world.server.entities['binary_sensor.garage_motion_detected'].state = 'on';
  world.server.socketDown = false;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await settle(world);
  assert.equal(world.hub.live, true);
  assert.equal(lastState(world, 'garage', 'motion'), 1);
  assert.deepEqual(events(world, TRIGGERS.MOTION), []);
});

test('with authentication: a login, the session on REST and WebSocket, the camera token', async (t) => {
  const server = new FakeViseron({ auth: 'gladys:secret' });
  const world = await createWorld({
    server,
    config: { ...DEFAULT_CONFIG, username: 'gladys', password: 'secret' },
  });
  t.after(() => world.app.stop());
  await createAll(world);
  assert.equal(server.count('/auth/login'), 1);
  assert.equal(world.hub.live, true);
  assert.equal(world.fake.discoveredDevices.length, 2);
  assert.ok(world.fake.cameraImages.length >= 2, 'snapshots with the camera token');
  // A manual recording: a POST, with the XSRF double submit.
  await world.fake.sceneAction('record', { camera: idOf(world, 'garage'), command: 'start' });
  assert.equal(server.cameras.garage.is_recording, true);
  await settle(world);
  assert.equal(lastState(world, 'garage', 'recording'), 1);
  // The session revoked on the server: a new login, once.
  server.tokens.clear();
  await world.hub.refresh();
  assert.equal(server.count('/auth/login'), 2);
  assert.equal(world.hub.server, 'ok');
});

test('authentication on, no account or a wrong password: said once, nothing else', async (t) => {
  for (const config of [DEFAULT_CONFIG, { ...DEFAULT_CONFIG, username: 'gladys', password: 'x' }]) {
    const world = await createWorld({ server: new FakeViseron({ auth: 'gladys:secret' }), config });
    t.after(() => world.app.stop());
    assert.equal(world.hub.server, 'auth');
    assert.equal(world.fake.connectionStatus.connected, false);
    assert.match(world.fake.connectionStatus.message.en, /asks for a login/);
    assert.equal(world.fake.discoveredDevices.length, 0);
  }
});

test('the recording switch and the scene action start and stop a manual recording', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  const device = world.fake.discoveredDevices.find((item) => item.name === 'Front door');
  const feature = device.features.find((item) => item.external_id.endsWith(':recording'));
  await world.hub.setValue(device, feature, 1);
  assert.equal(world.server.cameras.front_door.is_recording, true);
  const ack = await world.fake.sceneAction('record', {
    camera: idOf(world, 'front_door'),
    command: 'stop',
  });
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.server.cameras.front_door.is_recording, false);
  await assert.rejects(
    world.hub.setValue(
      device,
      device.features.find((item) => item.external_id.endsWith(':motion')),
      1,
    ),
    /cannot be set/,
  );
});

test('the check action lists the cameras, in four languages', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ack = await world.fake.action('check', {});
  assert.equal(ack.success, true, ack.error);
  const { message } = ack.data;
  assert.match(message.en, /Viseron 3\.7\.0 answers at http:\/\/192\.0\.2\.10:8888: 2 camera/);
  assert.match(message.en, /Live events received/);
  assert.match(message.fr, /- Front door: en ligne, objets dog, person/);
  assert.deepEqual(Object.keys(message), ['en', 'fr', 'de', 'es']);
});

test('without an address: a sentence in the integration status, no request', async (t) => {
  const world = await createWorld({ config: { url: '' } });
  t.after(() => world.app.stop());
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.fr, /Saisissez l'adresse de Viseron/);
  assert.equal(world.server.requests.length, 0);
});

test('a new address forgets the old server; Gladys back resends the states', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  const published = world.fake.states.length;
  await world.fake.reconnect?.();
  await world.hub.resync({ ...world.hub.config });
  await settle(world);
  assert.ok(world.fake.states.length > published, 'the states again after a reconnection');
  await world.fake.configUpdated({ url: '192.0.2.99', language: 'en' });
  await settle(world);
  assert.equal(world.hub.client.label, 'http://192.0.2.99:8888');
});

test('the entity names: cameras with a common prefix, zones, labels; the score', () => {
  const ids = ['front', 'front_door'];
  assert.deepEqual(parseEntity('binary_sensor.front_door_motion_detected', ids), {
    camera: 'front_door',
    kind: 'motion',
  });
  assert.deepEqual(parseEntity('binary_sensor.front_object_detected_car', ids), {
    camera: 'front',
    kind: 'label',
    label: 'car',
    zone: '',
  });
  assert.deepEqual(parseEntity('binary_sensor.front_zone_drive_way_object_detected_car', ids), {
    camera: 'front',
    kind: 'label',
    label: 'car',
    zone: 'drive_way',
  });
  assert.equal(parseEntity('sensor.front_object_detector_fps', ids), null);
  assert.equal(parseEntity('binary_sensor.back_motion_detected', ids), null);
  assert.equal(scoreOf({ objects: [{ confidence: 0.5 }, { confidence: 0.873 }] }), 87);
  assert.equal(scoreOf({}), null);
});

test('a state_changed recorded from Viseron 3.7.0, through the WebSocket', async (t) => {
  const recorded = JSON.parse(
    await readFile(new URL('./fixtures/viseron/state-changed.json', import.meta.url), 'utf8'),
  );
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.hub.socket.dispatch({ ...recorded, command_id: world.hub.socket.stateSubscription });
  await settle(world);
  assert.deepEqual(events(world, TRIGGERS.OBJECT).at(-1).data, {
    camera: idOf(world, 'front_door'),
    camera_name: 'Front door',
    label: 'person',
    zone: '',
    score: 97,
  });
});

test('a heavy frame is asked narrower, never wider than the camera', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  // Quality 100 at 768 px: 250 KB; 640 px 208 KB, 480 px 156 KB, 320 px 104 KB (115 KB fit,
  // once in base64).
  world.server.frame = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(250 * 1024)]);
  world.server.requests.length = 0;
  const camera = world.hub.cameras.get('garage');
  const jpeg = await world.hub.grab(camera);
  assert.ok(jpeg.length <= 150 * 1024);
  assert.deepEqual(
    world.server.requests.map((line) => /width=(\d+)/.exec(line)?.[1] ?? 'full'),
    ['full', '640', '480', '320'],
  );
  // Back to a light frame: the full size again only after a failure, not before.
  world.server.frame = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1000)]);
  world.server.requests.length = 0;
  await world.hub.grab(camera);
  assert.equal(world.server.requests.length, 1);
});
