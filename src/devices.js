// -----------------------------------------------------------------------------
// What Viseron becomes in Gladys: one camera device per Viseron camera, with
//   - its image (`camera/image`), pushed by the integration;
//   - `motion`: Viseron's motion detector sees motion now
//     (`motion-sensor/binary`), when the camera has one;
//   - `object`: an object Viseron tracks is in view (`motion-sensor/binary`),
//     when the camera has an object detector;
//   - `object-<label>`: one per label Viseron tracks on the camera (person,
//     car…): `presence-sensor/binary` for a person, `motion-sensor/binary`
//     for the others;
//   - `recording`: the camera records (`switch/binary`), which the dashboard
//     can start or stop: a manual recording, harmless either way;
//   - `online`: the camera is on in Viseron and its stream connected
//     (`camera/enabled`, read only: stopping a surveillance camera is never a
//     toggle a voice assistant flips).
// What the camera has comes from the Viseron entities (`binary_sensor.<camera>_…`).
//
// Feature keys are forever: they are part of the external ids.
// -----------------------------------------------------------------------------

export const DEVICE_TYPE = 'camera';

export const FEATURE_KEYS = {
  IMAGE: 'image',
  MOTION: 'motion',
  OBJECT: 'object',
  RECORDING: 'recording',
  ONLINE: 'online',
};
export const OBJECT_PREFIX = 'object-';
// The labels of a camera, at most (Viseron users rarely track more than a few).
export const MAX_LABELS = 12;

// Feature names, frozen when the user adds the device.
export const NAMES = {
  en: {
    image: 'Image',
    motion: 'Motion',
    object: 'Object detected',
    labelled: (label) => `${label} detected`,
    recording: 'Recording',
    online: 'Online',
  },
  fr: {
    image: 'Image',
    motion: 'Mouvement',
    object: 'Objet détecté',
    labelled: (label) => `Détection ${label.toLowerCase()}`,
    recording: 'Enregistrement',
    online: 'En ligne',
  },
  de: {
    image: 'Bild',
    motion: 'Bewegung',
    object: 'Objekt erkannt',
    labelled: (label) => `${label} erkannt`,
    recording: 'Aufnahme',
    online: 'Online',
  },
  es: {
    image: 'Imagen',
    motion: 'Movimiento',
    object: 'Objeto detectado',
    labelled: (label) => `Detección de ${label.toLowerCase()}`,
    recording: 'Grabación',
    online: 'En línea',
  },
};

// The labels of Viseron's default models (COCO) the users track most, named
// in each language; any other label keeps Viseron's own word.
export const LABELS = {
  person: { en: 'Person', fr: 'Personne', de: 'Person', es: 'Persona' },
  car: { en: 'Car', fr: 'Voiture', de: 'Auto', es: 'Coche' },
  truck: { en: 'Truck', fr: 'Camion', de: 'Lkw', es: 'Camión' },
  bicycle: { en: 'Bicycle', fr: 'Vélo', de: 'Fahrrad', es: 'Bicicleta' },
  motorcycle: { en: 'Motorcycle', fr: 'Moto', de: 'Motorrad', es: 'Moto' },
  bus: { en: 'Bus', fr: 'Bus', de: 'Bus', es: 'Autobús' },
  dog: { en: 'Dog', fr: 'Chien', de: 'Hund', es: 'Perro' },
  cat: { en: 'Cat', fr: 'Chat', de: 'Katze', es: 'Gato' },
  bird: { en: 'Bird', fr: 'Oiseau', de: 'Vogel', es: 'Pájaro' },
  face: { en: 'Face', fr: 'Visage', de: 'Gesicht', es: 'Cara' },
};

export const namesFor = (language) => NAMES[language] ?? NAMES.en;

export function labelName(label, language) {
  const known = LABELS[label];
  if (known) {
    return known[language] ?? known.en;
  }
  const text = String(label).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A label as a feature key: lower case, `[a-z0-9_]`. */
export const labelKey = (label) =>
  `${OBJECT_PREFIX}${String(label)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')}`;

/** The ids of one camera: its Viseron identifier, unique on the server. */
export function deviceIds(gladys, cameraId) {
  return gladys.externalIds(DEVICE_TYPE, String(cameraId));
}

/** The feature key behind a feature external id (`…:recording`). */
export function featureKeyOf(externalId) {
  return (
    String(externalId ?? '')
      .split(':')
      .pop() || null
  );
}

const binary = (key, category, name, readOnly = true) => ({
  key,
  category,
  type: 'binary',
  name,
  min: 0,
  max: 1,
  read_only: readOnly,
  has_feedback: true,
  keep_history: true,
});

/**
 * The features of a camera, after what Viseron says it has:
 * `{ motion: bool, object: bool, labels: [] }`.
 */
export function featureSpecs(camera, language) {
  const names = namesFor(language);
  const specs = [
    {
      key: FEATURE_KEYS.IMAGE,
      category: 'camera',
      type: 'image',
      name: names.image,
      min: 0,
      max: 0,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
  ];
  if (camera.hasMotion) {
    specs.push(binary(FEATURE_KEYS.MOTION, 'motion-sensor', names.motion));
  }
  if (camera.hasObject) {
    specs.push(binary(FEATURE_KEYS.OBJECT, 'motion-sensor', names.object));
  }
  for (const label of camera.labels ?? []) {
    specs.push(
      binary(
        labelKey(label),
        label === 'person' ? 'presence-sensor' : 'motion-sensor',
        names.labelled(labelName(label, language)),
      ),
    );
  }
  specs.push(binary(FEATURE_KEYS.RECORDING, 'switch', names.recording, false));
  specs.push({
    ...binary(FEATURE_KEYS.ONLINE, 'camera', names.online),
    type: 'enabled',
  });
  return specs;
}

/** The camera name in Viseron, or its identifier. */
export function deviceName(camera) {
  const name = String(camera.name ?? '').trim();
  return (name || String(camera.id)).slice(0, 80);
}

export function buildDevice(gladys, camera, language) {
  const ids = deviceIds(gladys, camera.id);
  return {
    name: deviceName(camera),
    external_id: ids.device,
    model: 'Viseron',
    // Live events come through the WebSocket: the Gladys scheduler has no use here.
    should_poll: false,
    params: [{ name: 'VISERON_CAMERA', value: String(camera.id) }],
    features: featureSpecs(camera, language).map(({ key, ...spec }) => ({
      ...spec,
      external_id: ids.feature(key),
    })),
  };
}
