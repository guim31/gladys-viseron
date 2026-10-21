// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from the
// camera list and entities RECORDED from a real Viseron server (3.7.0, see
// test/fixtures/viseron) — in every feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeViseron, createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

// The recorded cameras, one of them without a name.
const server = () => {
  const viseron = new FakeViseron();
  viseron.cameras.garage.name = '';
  return viseron;
};

const scenarios = [
  { label: 'default configuration (French names)', config: {} },
  { label: 'English names', config: { language: 'en' } },
  { label: 'German names', config: { language: 'de' } },
  { label: 'Spanish names', config: { language: 'es' } },
];

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async () => {
    const { fake, app } = await createWorld({
      server: server(),
      config: { url: '192.0.2.10', ...scenario.config },
    });
    try {
      const devices = fake.discoveredDevices;
      assert.equal(devices.length, 2, 'one device per camera');

      for (const device of devices) {
        const where = `${device.name} (${device.model})`;

        // should_poll: true if and only if poll_frequency is provided, in ms.
        if (device.poll_frequency === undefined) {
          assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
        } else {
          assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
          assert.ok(
            table.poll_frequencies_ms.includes(device.poll_frequency),
            `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
          );
        }

        assert.ok(device.features.length > 0, `${where}: no feature`);
        const externalIds = new Set();
        const names = new Set();
        for (const feature of device.features) {
          const at = `${where} / ${feature.name}`;
          const pair = table.pairs[`${feature.category}/${feature.type}`];
          assert.ok(
            pair,
            `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`,
          );
          assert.ok(
            pair.label_en && pair.label_fr && pair.icon,
            `${at}: couple without label or icon`,
          );

          assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
          assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
          assert.ok(
            Number.isFinite(feature.min) && Number.isFinite(feature.max),
            `${at}: finite min/max`,
          );
          assert.ok(feature.min <= feature.max, `${at}: min > max`);
          assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
          assert.equal(
            typeof feature.has_feedback,
            'boolean',
            `${at}: has_feedback must be a boolean`,
          );
          if (feature.unit !== undefined) {
            assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
          }
          for (const option of feature.supported_options ?? []) {
            // The core accepts string values on text/select only, integers
            // within the bounds everywhere else.
            if (`${feature.category}/${feature.type}` === 'text/select') {
              assert.ok(
                typeof option.value === 'string' && option.value.trim(),
                `${at}: option value ${option.value}`,
              );
            } else {
              assert.ok(Number.isInteger(option.value), `${at}: option value ${option.value}`);
              assert.ok(
                option.value >= feature.min && option.value <= feature.max,
                `${at}: option out of bounds`,
              );
            }
            assert.ok(
              typeof option.label === 'string' && option.label.trim(),
              `${at}: option label`,
            );
          }
          const values = (feature.supported_options ?? []).map((option) => option.value);
          assert.equal(new Set(values).size, values.length, `${at}: duplicate option values`);

          assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
          externalIds.add(feature.external_id);
          assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
          names.add(feature.name);
        }
      }
    } finally {
      await app.stop();
    }
  });
}

test('detections are 1 when detected; recording is the only command; online read only', async () => {
  const { fake, app } = await createWorld({ server: server() });
  try {
    for (const device of fake.discoveredDevices) {
      const commands = device.features.filter((item) => !item.read_only);
      assert.deepEqual(
        commands.map((item) => `${item.category}/${item.type}`),
        ['switch/binary'],
        'only the recording: nothing that stops a camera',
      );
      assert.match(commands[0].external_id, /:recording$/);
      for (const item of device.features.filter((feature) => feature.type === 'binary')) {
        assert.deepEqual([item.min, item.max], [0, 1]);
      }
      const image = device.features.find((item) => item.type === 'image');
      assert.deepEqual([image.read_only, image.keep_history], [true, false]);
    }
    const person = fake.discoveredDevices[0].features.find((item) =>
      item.external_id.endsWith(':object-person'),
    );
    assert.equal(person.category, 'presence-sensor');
    // A camera without a name in Viseron is named after its identifier.
    assert.equal(fake.discoveredDevices[1].name, 'garage');
  } finally {
    await app.stop();
  }
});
