// The info level keeps the life of the integration only (start, server or
// camera lost and back, user actions): nothing per event, per state or per
// image, and a failure tried again and again is one line, then one when it
// ends. Never the password, never a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeViseron, createAll, createWorld, settle } from './helpers/world.js';

/** Capture what the SDK logger writes (console.log / console.error) at `info`. */
function captureLogs(t) {
  const lines = [];
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  const keep = (...args) => lines.push(args.join(' '));
  t.mock.method(console, 'log', keep);
  t.mock.method(console, 'error', keep);
  t.mock.method(console, 'warn', keep);
  const restore = () => {
    process.env.LOG_LEVEL = previous;
    t.mock.restoreAll();
  };
  t.after(restore);
  return { lines, restore };
}

const count = (lines, text) => lines.filter((line) => line.includes(text)).length;

test('a normal cycle (events, objects, images, camera list) writes nothing at info', async (t) => {
  const world = await createWorld({ config: { url: '192.0.2.10', snapshot_interval: '10' } });
  t.after(() => world.app.stop());
  await createAll(world);
  const { lines, restore } = captureLogs(t);
  for (let round = 0; round < 3; round += 1) {
    const on = round % 2 === 0 ? 'on' : 'off';
    world.server.setState('binary_sensor.garage_motion_detected', on);
    world.server.setState('binary_sensor.front_door_object_detected_person', on, {
      objects: [{ label: 'person', confidence: 0.8 }],
    });
    await settle(world);
    await world.hub.refresh();
    await world.hub.imageTick();
  }
  await world.fake.widgetGet('camera', {
    settings: { camera: world.fake.discoveredDevices[0].external_id },
  });
  await settle(world);
  restore();
  assert.deepEqual(lines, []);
});

test('a server down is one line, then one when it is back; never the password', async (t) => {
  const world = await createWorld({
    server: new FakeViseron({ auth: 'gladys:secret' }),
    config: { url: '192.0.2.10', username: 'gladys', password: 'secret' },
  });
  t.after(() => world.app.stop());
  await createAll(world);
  const { lines, restore } = captureLogs(t);
  world.server.down = true;
  world.server.dropSockets();
  for (let round = 0; round < 5; round += 1) {
    await world.hub.refresh();
    await settle(world);
  }
  world.server.down = false;
  await world.hub.refresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await settle(world);
  restore();
  assert.equal(count(lines, 'does not answer'), 1, lines.join('\n'));
  assert.equal(count(lines, 'answers again'), 1, lines.join('\n'));
  assert.equal(count(lines, 'live events unavailable'), 1, lines.join('\n'));
  assert.equal(count(lines, 'live events are back'), 1, lines.join('\n'));
  assert.ok(
    lines.every((line) => !/secret|Bearer|h\d+\.p\d+|s\d+;|access_token/.test(line)),
    lines.join('\n'),
  );
});

test('a user action is one line', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  const { lines, restore } = captureLogs(t);
  await world.fake.sceneAction('record', {
    camera: world.fake.discoveredDevices[1].external_id,
    command: 'start',
  });
  await settle(world);
  restore();
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /Recording started on camera garage/);
});
