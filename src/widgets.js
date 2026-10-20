// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `camera`.
//
// The Gladys camera box shows the image only. This widget adds what Viseron
// knows: motion, the objects in view (by label), recording, online, and
// buttons to start or stop a recording and bring a new image.
//
// Budget (8 components, 2 texts, 4 buttons): a caption, the image, one status
// list, two buttons.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { deviceName, labelName, namesFor } from './devices.js';
import { WIDGET_KEY } from './hub.js';

// Numbered: the core drops a button whose action key is already taken.
export const ACTIONS = {
  RECORD: 'record_start_1',
  STOP: 'record_stop_1',
  REFRESH: 'refresh_1',
};
// How long `get` waits for a first image before showing the caption alone.
const FIRST_IMAGE_WAIT_MS = 8000;
// A status value holds 40 characters at most.
const MAX_VALUE = 40;

export const TEXT = {
  pick: {
    en: 'Choose a camera in the settings of this widget.',
    fr: 'Choisissez une caméra dans les réglages de ce widget.',
    de: 'Wähle in den Einstellungen dieses Widgets eine Kamera aus.',
    es: 'Elija una cámara en la configuración de este widget.',
  },
  unknown: {
    en: 'This camera is no longer in Viseron, or Viseron does not answer.',
    fr: 'Cette caméra n’est plus dans Viseron, ou Viseron ne répond pas.',
    de: 'Diese Kamera ist nicht mehr in Viseron, oder Viseron antwortet nicht.',
    es: 'Esta cámara ya no está en Viseron, o Viseron no responde.',
  },
  imageAt: { en: 'Image', fr: 'Image', de: 'Bild', es: 'Imagen' },
  noImage: {
    en: 'No image yet',
    fr: 'Pas encore d’image',
    de: 'Noch kein Bild',
    es: 'Aún no hay imagen',
  },
  offline: { en: 'offline', fr: 'hors ligne', de: 'offline', es: 'sin conexión' },
  stopped: {
    en: 'stopped in Viseron',
    fr: 'arrêtée dans Viseron',
    de: 'in Viseron gestoppt',
    es: 'detenida en Viseron',
  },
  objects: { en: 'Objects', fr: 'Objets', de: 'Objekte', es: 'Objetos' },
  yes: { en: 'Yes', fr: 'Oui', de: 'Ja', es: 'Sí' },
  no: { en: 'No', fr: 'Non', de: 'Nein', es: 'No' },
  detected: { en: 'Detected', fr: 'Détecté', de: 'Erkannt', es: 'Detectado' },
  none: { en: 'None', fr: 'Aucun', de: 'Keine', es: 'Ninguno' },
  record: { en: 'Record', fr: 'Enregistrer', de: 'Aufnehmen', es: 'Grabar' },
  stop: {
    en: 'Stop recording',
    fr: 'Arrêter l’enregistrement',
    de: 'Aufnahme beenden',
    es: 'Detener la grabación',
  },
  refresh: { en: 'New image', fr: 'Nouvelle image', de: 'Neues Bild', es: 'Nueva imagen' },
  recordingStarted: {
    en: 'Recording started',
    fr: 'Enregistrement démarré',
    de: 'Aufnahme gestartet',
    es: 'Grabación iniciada',
  },
  recordingStopped: {
    en: 'Recording stopped',
    fr: 'Enregistrement arrêté',
    de: 'Aufnahme beendet',
    es: 'Grabación detenida',
  },
  refused: {
    en: 'Viseron refuses: the camera must be on and connected, and the user needs the write role.',
    fr: 'Viseron refuse : la caméra doit être en ligne, et l’utilisateur avoir le rôle écriture.',
    de: 'Viseron lehnt ab: Die Kamera muss online sein und der Benutzer die Schreibrolle haben.',
    es: 'Viseron lo rechaza: la cámara debe estar en línea y el usuario tener el rol de escritura.',
  },
};

const t = (text, language) => text[language] ?? text.en;

// Image keys are `[a-z0-9-]`: a camera identifier (`Front_Door`) is not.
const tagOf = (camera) => createHash('sha1').update(String(camera.id)).digest('hex').slice(0, 12);

export const imageKey = (camera) => `cam-${tagOf(camera)}-${camera.imageSeq.toString(36)}`;

function message(text, language) {
  return {
    ttl_seconds: 60,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

function timeOf(at, language) {
  return new Intl.DateTimeFormat(language, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(at));
}

const button = (label, icon, key) => ({
  type: 'button',
  label,
  icon,
  style: 'secondary',
  action: { key },
});

/** The objects in view now, by name ("Person, Car"), or null. */
function objectsInView(camera, language) {
  const labels = camera.labels.filter((label) => camera.labelStates[label]);
  if (labels.length > 0) {
    const text = labels.map((label) => labelName(label, language)).join(', ');
    return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
  }
  return camera.object ? t(TEXT.detected, language) : null;
}

async function get(hub, { settings, language = 'en' }) {
  const camera = settings?.camera ? hub.resolveDevice(settings.camera) : null;
  if (!camera) {
    return message(settings?.camera ? TEXT.unknown : TEXT.pick, language);
  }
  if (!camera.image && camera.online && hub.client && hub.server === 'ok') {
    // The first look at this camera: wait a little for an image.
    await Promise.race([
      hub.grab(camera).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, FIRST_IMAGE_WAIT_MS).unref?.()),
    ]);
  }
  const names = namesFor(language);
  const caption = [
    camera.image
      ? `${t(TEXT.imageAt, language)} ${timeOf(camera.image.at, language)}`
      : t(TEXT.noImage, language),
  ];
  if (!camera.on) {
    caption.push(t(TEXT.stopped, language));
  } else if (camera.online === false) {
    caption.push(t(TEXT.offline, language));
  }
  const components = [{ type: 'text', variant: 'caption', text: caption.join(' · ') }];
  if (camera.image) {
    components.push({
      type: 'image',
      key: imageKey(camera),
      alt: deviceName(camera),
      fit: 'contain',
    });
  }
  const items = [];
  if (camera.hasMotion) {
    items.push({
      label: names.motion,
      icon: 'activity',
      value: t(camera.motion ? TEXT.detected : TEXT.none, language),
      color: camera.motion ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    });
  }
  if (camera.hasObject || camera.labels.length > 0) {
    const objects = objectsInView(camera, language);
    items.push({
      label: t(TEXT.objects, language),
      icon: 'eye',
      value: objects ?? t(TEXT.none, language),
      color: objects ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
    });
  }
  items.push({
    label: names.recording,
    icon: 'video',
    value: camera.recording === null ? '-' : t(camera.recording ? TEXT.yes : TEXT.no, language),
    color: camera.recording ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
  });
  items.push({
    label: names.online,
    icon: 'wifi',
    value: camera.online === null ? '-' : t(camera.online ? TEXT.yes : TEXT.no, language),
    color: camera.online === false ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
  });
  components.push({ type: 'status', items });
  if (camera.recording) {
    components.push(button(t(TEXT.stop, language), 'square', ACTIONS.STOP));
  } else if (camera.online) {
    components.push(button(t(TEXT.record, language), 'circle', ACTIONS.RECORD));
  }
  if (camera.online) {
    components.push(button(t(TEXT.refresh, language), 'refresh-cw', ACTIONS.REFRESH));
  }
  return {
    ttl_seconds: Math.min(Math.max(hub.config.snapshotSeconds, 10), 300),
    components,
  };
}

async function action(hub, { actionKey, settings }) {
  if (!settings?.camera) {
    throw new Error(TEXT.pick.en);
  }
  const camera = hub.require(settings.camera);
  switch (actionKey) {
    case ACTIONS.REFRESH:
      await hub.grab(camera);
      return {};
    case ACTIONS.RECORD:
    case ACTIONS.STOP: {
      const on = actionKey === ACTIONS.RECORD;
      try {
        await hub.setRecording(camera, on);
      } catch (err) {
        if (err.kind === 'refused' || err.kind === 'auth') {
          return { message: TEXT.refused };
        }
        throw err;
      }
      return { message: on ? TEXT.recordingStarted : TEXT.recordingStopped };
    }
    default:
      throw new Error(`Unknown action ${actionKey}`);
  }
}

/** The bytes behind an image key of the widget (raw base64). */
export async function widgetImage(hub, key) {
  const match = /^cam-([0-9a-f]{12})-[0-9a-z]+$/.exec(String(key));
  const camera = match ? [...hub.cameras.values()].find((item) => tagOf(item) === match[1]) : null;
  if (!camera?.image) {
    throw new Error(`Unknown image ${key}`);
  }
  // Already fit for Gladys (150 KB), well under the 300 KB of a widget image.
  return camera.image.jpeg.toString('base64');
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
