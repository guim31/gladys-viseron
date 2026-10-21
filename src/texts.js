// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status and the "Check the connection" report. Four languages,
// the four of the Gladys interface; German says "du", Spanish "usted".
// test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

// Shown by Gladys under the integration name when it is not connected.
export const CONNECTION_TEXT = {
  noUrl: {
    en: 'Enter the address of Viseron (e.g. 192.168.1.20, port 8888 by default) in the configuration.',
    fr: "Saisissez l'adresse de Viseron (ex. 192.168.1.20, port 8888 par défaut) dans la configuration.",
    de: 'Gib die Adresse von Viseron (z. B. 192.168.1.20, standardmäßig Port 8888) in der Konfiguration ein.',
    es: 'Introduzca la dirección de Viseron (p. ej. 192.168.1.20, puerto 8888 por defecto) en la configuración.',
  },
  auth: {
    en: 'Viseron asks for a login, or refuses the user name or password.',
    fr: "Viseron demande une connexion, ou refuse l'identifiant ou le mot de passe.",
    de: 'Viseron verlangt eine Anmeldung oder lehnt Benutzername oder Passwort ab.',
    es: 'Viseron pide iniciar sesión, o rechaza el usuario o la contraseña.',
  },
  unreachable: {
    en: 'Viseron does not answer at this address.',
    fr: 'Viseron ne répond pas à cette adresse.',
    de: 'Viseron antwortet unter dieser Adresse nicht.',
    es: 'Viseron no responde en esta dirección.',
  },
  error: {
    en: 'Something answers, but not like Viseron: check the address and port, and the logs.',
    fr: "Quelque chose répond, mais pas comme Viseron : vérifiez l'adresse, le port et les logs.",
    de: 'Etwas antwortet, aber nicht wie Viseron: Prüfe Adresse, Port und die Protokolle.',
    es: 'Algo responde, pero no como Viseron: compruebe la dirección, el puerto y los registros.',
  },
};

const MAX_LISTED = 10;

// The pieces of the "Check the connection" report, one table per language.
export const CHECK_TEXT = {
  en: {
    connected: (url, version, count) =>
      `Viseron ${version ?? ''} answers at ${url}: ${count} camera(s).`,
    live: 'Live events received.',
    notLive: 'No live events (WebSocket closed): states every minute only.',
    online: 'online',
    offline: 'offline',
    stopped: 'stopped in Viseron',
    recording: 'recording',
    objects: 'objects',
  },
  fr: {
    connected: (url, version, count) =>
      `Viseron ${version ?? ''} répond à ${url} : ${count} caméra(s).`,
    live: 'Événements en direct reçus.',
    notLive: 'Pas d’événements en direct (WebSocket fermé) : états chaque minute seulement.',
    online: 'en ligne',
    offline: 'hors ligne',
    stopped: 'arrêtée dans Viseron',
    recording: 'enregistre',
    objects: 'objets',
  },
  de: {
    connected: (url, version, count) =>
      `Viseron ${version ?? ''} antwortet unter ${url}: ${count} Kamera(s).`,
    live: 'Live-Ereignisse werden empfangen.',
    notLive: 'Keine Live-Ereignisse (WebSocket geschlossen): Zustände nur jede Minute.',
    online: 'online',
    offline: 'offline',
    stopped: 'in Viseron gestoppt',
    recording: 'nimmt auf',
    objects: 'Objekte',
  },
  es: {
    connected: (url, version, count) =>
      `Viseron ${version ?? ''} responde en ${url}: ${count} cámara(s).`,
    live: 'Se reciben eventos en directo.',
    notLive: 'Sin eventos en directo (WebSocket cerrado): estados solo cada minuto.',
    online: 'en línea',
    offline: 'sin conexión',
    stopped: 'detenida en Viseron',
    recording: 'grabando',
    objects: 'objetos',
  },
};

/** The report of the "Check the connection" action, in the four languages. */
export function checkMessage(summary) {
  if (summary.problem) {
    return CONNECTION_TEXT[summary.problem];
  }
  const message = {};
  for (const [language, text] of Object.entries(CHECK_TEXT)) {
    const lines = [
      `${text.connected(summary.url, summary.version, summary.cameras.length).replace(/ {2}/, ' ')} ${
        summary.live ? text.live : text.notLive
      }`,
    ];
    for (const camera of summary.cameras.slice(0, MAX_LISTED)) {
      const flags = [
        !camera.on
          ? text.stopped
          : camera.online === false
            ? text.offline
            : camera.online === true
              ? text.online
              : null,
        camera.recording ? text.recording : null,
        camera.labels.length > 0 ? `${text.objects} ${camera.labels.join(', ')}` : null,
      ].filter(Boolean);
      lines.push(flags.length > 0 ? `- ${camera.name}: ${flags.join(', ')}` : `- ${camera.name}`);
    }
    if (summary.cameras.length > MAX_LISTED) {
      lines.push('…');
    }
    message[language] = lines.join('\n');
  }
  return message;
}
