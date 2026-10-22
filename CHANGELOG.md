# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.1] - 2026-10-22

### Fixed

- Gladys 5.2 refused the camera images while a camera was offline: the
  **Online** feature was published as `camera/enabled`, which Gladys 5.2 uses
  as the privacy mode of the camera. The feature is removed: whether a camera
  is online stays the unreachable badge and the "Camera offline" scene trigger.
  For the cameras added with 1.0.x, click **Update** in the Discovery tab of the
  integration to drop the feature; until then, it is set to 1 once at startup
  and never written again.

## [1.0.0] - 2026-10-21

### Added

- Viseron servers, reached at the address of the configuration (port 8888 by
  default), with an optional login when authentication is on in Viseron.
- One Gladys camera per Viseron camera: its image, sent at the chosen pace and
  at once on motion or an object, asked narrower when too heavy for Gladys;
  "Motion" and "Object detected" when the camera has the detectors; one feature
  per label Viseron tracks ("Person detected", "Car detected"…); "Recording", a
  switch that starts or stops a manual recording; "Online" (read only).
- Live states and events through the Viseron WebSocket, reopened after a loss.
- Cameras whose stream is lost show as unreachable in Gladys.
- Scene triggers "Viseron: object detected" (camera, label and zone filters;
  label, zone and confidence as variables), "Viseron: motion detected" and
  "Viseron: camera offline"; scene action "Viseron: record"; dashboard widget
  "Viseron camera"; action "Check the connection".

[Unreleased]: https://github.com/guim31/gladys-viseron/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-viseron/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/guim31/gladys-viseron/releases/tag/v1.0.0
