// The `camera` widget: content inside the core's vocabulary and budget, the
// image served, the record and refresh buttons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent, validateWidgetImage } from '@gladysassistant/integration-sdk';
import { ACTIONS } from '../src/widgets.js';
import { createAll, createWorld, settle } from './helpers/world.js';

const get = (world, camera, language = 'en') =>
  world.fake.widgetGet('camera', { settings: { camera }, language });
const cameraId = (world, name) =>
  world.fake.discoveredDevices.find((device) => device.name === name).external_id;
const press = (world, name, key) =>
  world.fake.widgetAction('camera', key, {}, { settings: { camera: cameraId(world, name) } });

test('the widget shows the image, motion, objects, recording, online and two buttons', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.setState('binary_sensor.front_door_object_detected_person', 'on', {
    objects: [{ label: 'person', confidence: 0.9 }],
  });
  world.server.setState('binary_sensor.front_door_object_detected_dog', 'on', {
    objects: [{ label: 'dog', confidence: 0.7 }],
  });
  await settle(world);
  for (const language of ['en', 'fr', 'de', 'es']) {
    const ack = await get(world, cameraId(world, 'Front door'), language);
    assert.equal(ack.success, true, ack.error);
    const { content } = ack.data;
    assert.deepEqual(validateWidgetContent(content), [], language);
    assert.deepEqual(
      content.components.map((component) => component.type),
      ['text', 'image', 'status', 'button', 'button'],
    );
    assert.deepEqual(
      content.components.slice(3).map((button) => button.action.key),
      [ACTIONS.RECORD, ACTIONS.REFRESH],
    );
    if (language === 'fr') {
      assert.deepEqual(
        content.components[2].items.map((item) => [item.label, item.value]),
        [
          ['Mouvement', 'Aucun'],
          ['Objets', 'Chien, Personne'],
          ['Enregistrement', 'Non'],
          ['En ligne', 'Oui'],
        ],
      );
    }
    const image = await world.fake.widgetGetImage(content.components[1].key);
    assert.equal(image.success, true, image.error);
    assert.deepEqual(validateWidgetImage(image.data.image), []);
  }
});

test('the buttons record, stop and bring a new image', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  let ack = await press(world, 'Garage', ACTIONS.RECORD);
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.fr, /Enregistrement démarré/);
  assert.equal(world.server.cameras.garage.is_recording, true);
  await settle(world);
  const content = (await get(world, cameraId(world, 'Garage'))).data.content;
  assert.equal(content.components.find((c) => c.type === 'button').action.key, ACTIONS.STOP);
  ack = await press(world, 'Garage', ACTIONS.STOP);
  assert.match(ack.data.message.de, /Aufnahme beendet/);
  const before = world.hub.cameras.get('garage').imageSeq;
  ack = await press(world, 'Garage', ACTIONS.REFRESH);
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.hub.cameras.get('garage').imageSeq, before + 1);
});

test('Viseron refusing a recording (camera disconnected): a sentence, not a crash', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.cameras.garage.connected = false;
  const ack = await press(world, 'Garage', ACTIONS.RECORD);
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.en, /camera must be on and connected/);
});

test('without a camera, or with one Viseron no longer has: a sentence', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  let ack = await world.fake.widgetGet('camera', { settings: {}, language: 'de' });
  assert.match(ack.data.content.components[0].text, /Wähle/);
  ack = await get(world, 'ext:x:camera:nope');
  assert.match(ack.data.content.components[0].text, /no longer in Viseron/);
});
