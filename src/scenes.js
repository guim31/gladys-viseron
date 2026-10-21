// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`, Gladys 5.1+).
//
// What it adds to "Control a device": a manual recording started or stopped
// on one camera by any scene (e.g. when a door opens, or when the alarm goes
// off), with the camera picked in the list. Viseron asks for a user with the
// "write" or "admin" role when authentication is on.
// -----------------------------------------------------------------------------

export const RECORD_COMMANDS = { start: true, stop: false };

async function record(hub, { fields }) {
  const on = RECORD_COMMANDS[fields?.command];
  if (on === undefined) {
    throw new Error(`Unknown command "${fields?.command}": start or stop`);
  }
  if (!fields?.camera) {
    throw new Error('Choose a camera');
  }
  await hub.setRecording(hub.require(fields.camera), on);
}

export const SCENE_ACTIONS = { record };
