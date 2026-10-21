# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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

[Unreleased]: https://github.com/guim31/gladys-viseron/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-viseron/releases/tag/v1.0.0
