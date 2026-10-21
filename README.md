# Viseron for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for
[Viseron](https://github.com/roflcoopter/viseron), the self-hosted network video
recorder with object detection. It brings each Viseron camera into Gladys as a
camera with its image, motion, the objects Viseron tracks (person, car, dog…),
recording and whether it is online, with scene triggers fed by Viseron's live
events, a scene action and a dashboard widget. Everything stays on the local
network: no cloud.

Tested against a real Viseron server in Docker (3.7.0, CPU, darknet object
detection) with simulated network cameras, not yet on an installation in
service with real cameras: feedback welcome in the
[issues](https://github.com/guim31/gladys-viseron/issues).

## Features

- **One Gladys camera per Viseron camera**: its image, sent at the chosen pace
  (10 s to 15 min) and at once on motion or an object, asked narrower when too
  heavy for Gladys.
- **Motion** (`motion-sensor`, 1 = detected) and **Object detected**, when the
  camera has a motion or an object detector.
- **One feature per label** Viseron tracks on the camera ("Person detected",
  "Car detected"…): `presence-sensor` for a person, `motion-sensor` otherwise.
- **Recording**: a switch that starts or stops a manual recording.
- **Online** (read only) and an **unreachable badge** on a camera that lost its
  stream.
- **Scene triggers**: "Viseron: object detected" (filters: camera, label, zone;
  variables: label, zone, confidence in %), "Viseron: motion detected" and
  "Viseron: camera offline".
- **Scene action**: "Viseron: record" (start or stop).
- **Dashboard widget** "Viseron camera": image, motion, the objects in view,
  recording, online, and buttons to record and bring a new image.
- **"Check the connection"** action: the version, whether live events flow, the
  cameras, whether they are online, record, and their labels.
- Texts and documentation in English, French, German and Spanish.

## Requirements

- Gladys 5.1.0 or later.
- Viseron 3.7 or later, reachable from Gladys on its web port (8888 by default).
- When authentication is on in Viseron: a Viseron user (role read, or write to
  start recordings).

## Installation

In Gladys: **Integrations → Install from GitHub**, address
`https://github.com/guim31/gladys-viseron`. Then enter the Viseron address in
the **Configuration** tab, and add the cameras from the **Discovery** tab. The
user guide: [English](docs/en.md), [français](docs/fr.md),
[Deutsch](docs/de.md), [español](docs/es.md).

## How it works

- **REST**, every minute: `GET /api/v1/cameras` (names, on, connected,
  recording, the snapshot token); `GET /api/v1/camera/<id>/snapshot` (images,
  with the camera's own token and `width` when too heavy);
  `POST /api/v1/camera/<id>/manual_recording`.
- **WebSocket** `/websocket`, live: `get_entities` tells what each camera has
  (`binary_sensor.<camera>_motion_detected`, `_object_detected`,
  `_object_detected_<label>`, `_zone_<zone>_object_detected_<label>`,
  `_recorder`, `_connected`), then `subscribe_states` follows those entities.
  Reopened after a loss, with a ping every 30 s.
- **Authentication**: a login like the web interface (`/api/v1/auth/login`, the
  JWT header and payload, the session cookies, the token renewed before it
  expires). Personal access tokens are not used: Viseron 3.7.0 refuses them on
  the WebSocket.
- Nothing is stored under `/data`. Devices are published with
  `should_poll: false`: the container runs its own timers.

## Checked, and what was not

- In Docker, against `roflcoopter/viseron:3.7.0` (CPU image, `mog2` motion,
  `darknet` objects), with two RTSP cameras served by `mediamtx` from looped
  photos (a person and a dog, a bicycle and a truck), the integration running in
  its own image under the Gladys sandbox limits (`--cap-drop ALL`, read-only,
  256 MB, about 25 MB used): discovery, states, images, motion and object
  triggers (labels, zone, confidence 93-98 %), manual recording, widget, "Check
  the connection", authentication on (login, WebSocket, XSRF on POST), wrong
  password, Viseron stopped then started again. The test fixtures are answers
  recorded there, anonymised.
- Not checked: real cameras and long-running use, `gstreamer` cameras, other
  object detectors (CodeProject.AI, EdgeTPU, Hailo…), a token expiring after a
  long run (the renewal is tested against the simulated server only), Viseron
  behind a reverse proxy.

## Limits

- No live video: Gladys shows images (12 a minute per camera at most).
- Labels and zones are filtered as written in Viseron.
- Past recordings, face and plate recognition, PTZ and starting or stopping a
  camera are not covered.
- One Viseron server per integration.

## Development

```bash
npm ci
npm test
npm run lint
npm run format:check
npx github:GladysAssistant/integration-store .
```

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules of the code.

## Credits

- [Viseron](https://github.com/roflcoopter/viseron) (MIT, by Jesper Nilsson,
  roflcoopter): its web server and WebSocket code were read to use the API,
  which is not documented yet.
- Logo of the cover: the Viseron logo from its repository (MIT).

This integration is not affiliated with Viseron nor its authors.

## License

[Apache 2.0](LICENSE)
