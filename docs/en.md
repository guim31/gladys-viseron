# Viseron

Brings the cameras of a [Viseron](https://viseron.netlify.app/) server (the self-hosted network video
recorder with object detection) into Gladys: their image, the motion detected, the objects Viseron
tracks (person, car, dog…), the recording going on, and whether they are online. Viseron's live
events start scenes, with the image of the moment, which a scene can send you. Scenes can also start
or stop a recording.

Tested against a real Viseron server in Docker (3.7.0, CPU, darknet object detection) with simulated
network cameras, not yet on an installation in service with real cameras: feedback welcome on
[GitHub](https://github.com/guim31/gladys-viseron/issues) or on the Gladys forum.

## What you need

- Gladys 5.1 or later.
- Viseron 3.7 or later, reachable from Gladys on its web port (8888 by default).
- The cameras already configured in Viseron (`ffmpeg` or `gstreamer` component), with a motion
  detector and an object detector if you want those features.
- If authentication is on in Viseron (`webserver: auth:`), a Viseron user for Gladys. The **read**
  role is enough to follow the cameras; the **write** role also lets Gladys start recordings.

## Installation

1. In Gladys, open **Integrations**, find **Viseron** and install it.
2. In its **Configuration** tab, fill in:
   - **Viseron address**: the address of the computer running Viseron, e.g. `192.168.1.20`. Without
     a port, 8888 is used; add `:port` if it was changed, or `https://` behind a reverse proxy.
   - **User name** and **Password**: only if authentication is on in Viseron. Leave them empty
     otherwise.
   - **Image refresh**: how often each camera image is sent to Gladys (from 10 seconds to 15 minutes,
     1 minute by default). Motion or an object detected also sends one at once.
   - **Language of the names**: the language of the feature names given when a camera is added.
3. Save, then open the **Discovery** tab: one device per camera. Add the ones you want.
4. **Check the connection** shows what the integration reads: the Viseron version, whether live
   events are received, each camera, whether it is online, records, and the objects it tracks.

## The Gladys devices

Each Viseron camera becomes a Gladys camera, named as in Viseron, with:

| Feature                | What it is                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------- |
| **Image**              | The camera image, sent at the chosen pace and at once on motion or an object.      |
| **Motion**             | 1 while Viseron's motion detector sees motion, else 0. If the camera has one.      |
| **Object detected**    | 1 while an object Viseron tracks is in view, else 0. If it has an object detector. |
| **Person detected**, … | One per label Viseron tracks on the camera (person, car, dog…): 1 while in view.   |
| **Recording**          | 1 during a recording. A switch: starts or stops a manual recording.                |

The features follow the Viseron configuration: a camera without a motion detector has no
**Motion**. A label added later in Viseron appears after **Update** in the Discovery tab. A camera
whose stream is lost, or stopped in Viseron, shows as unreachable in Gladys.

**Cameras added with version 1.0.x**: they had an **Online** feature of the Gladys type "camera
enabled", which Gladys 5.2 uses as the privacy mode of the camera (at 0, Gladys refuses its images).
Open the Discovery tab of the integration and click **Update** on each camera: the feature goes away.
Until then, the integration sets it to 1 once at startup, so the images keep flowing.

## Dashboard widget

**Viseron camera** shows the image of a camera, motion, the objects in view now (e.g. "Person,
Dog"), recording and online, and two buttons: **Record** (or **Stop recording**) and **New image**.

## Scenes

### Triggers

- **Viseron: object detected**: Viseron starts seeing an object it tracks. Filters: the camera (empty
  = all), the object (label, e.g. `person`) and the zone (empty = all), written as in the Viseron
  configuration. Variables: the camera name, the object, the zone (empty for the whole image) and
  the confidence in %. The image of the moment is sent to Gladys first. An object tracked both on
  the whole image and in a zone fires once for each: filter on the zone to keep one.
- **Viseron: motion detected**: the motion detector of a camera starts seeing motion. Filter: the
  camera. Variable: the camera name. The image of the moment is sent first.
- **Viseron: camera offline**: a camera on in Viseron loses its stream for 30 seconds, or Viseron
  itself stops answering. Not fired for a camera stopped in Viseron.

### Actions

- **Viseron: record**: **Start** starts a manual recording on a camera, **Stop** stops it. Viseron
  refuses it for a camera offline, and when authentication is on, for a user without the write role.

The core's **Send a camera image** action sends the last image of a camera: right after **Viseron:
object detected** or **Viseron: motion detected**, it is the image of that moment.

### Scene ideas

- **Someone at the door**: **Viseron: object detected**, camera "Entrance", object `person` → **Send
  a camera image** of that camera to your phone, with `{{triggerEvent.data.score}}` % in the text.
- **Car in the driveway at night**: **Viseron: object detected**, object `car`, zone `driveway` →
  switch the outdoor light on for five minutes.
- **Door opened while away**: an opening sensor opens and nobody is home → **Viseron: record**,
  Start, on the hall camera; Stop two minutes later.
- **Camera lost**: **Viseron: camera offline** → send a message with the camera name.

## Troubleshooting

- **"Viseron does not answer at this address"**: open `http://<address>:8888` in a browser. Check
  the port and that no firewall blocks Gladys.
- **"Something answers, but not like Viseron"**: the address or the port leads to another service.
  Enter the address of Viseron, without a page path.
- **"Viseron asks for a login, or refuses the user name or password"**: authentication is on in
  Viseron. Enter a Viseron user (not a personal access token), or check the password.
- **No object or motion feature**: the camera has no object or motion detector in the Viseron
  configuration, or Viseron did not start it (see the Viseron logs).
- **"No live events" in Check the connection**: the WebSocket of Viseron cannot be opened (a reverse
  proxy must let WebSockets through on `/websocket`). States are then read once a minute only, and
  no trigger fires except **camera offline**.
- **More details**: the integration logs (Integrations → Viseron → Logs); set `LOG_LEVEL` to `debug`
  to see each request.

## Limits

- No live video: Gladys shows images, sent at the chosen pace (Gladys keeps 12 images a minute per
  camera at most). The live stream and recordings are watched in Viseron.
- Labels and zones are filtered as written in Viseron: the scene filters only compare text.
- At most 12 labels per camera become features.
- Past recordings, face and license plate recognition, PTZ and starting or stopping cameras are not
  covered.
- One Viseron server per integration.
- Tested with Viseron 3.7.0 in Docker and simulated cameras, without a real installation: feedback
  welcome.

This integration is not affiliated with Viseron nor its authors.
