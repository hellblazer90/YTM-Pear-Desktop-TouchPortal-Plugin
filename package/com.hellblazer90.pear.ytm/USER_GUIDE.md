# Pear Desktop YTM TouchPortal User Guide

This plugin controls Pear Desktop (YouTube Music) from TouchPortal using the
local Pear API server.

## Install
1) In Pear Desktop, enable the YouTube Music API Server.
2) Note the API port shown in Pear Desktop (default 9863).
3) Import `PearYTM.tpp` into TouchPortal and restart TouchPortal.

## Quick Start
1) Add the action `Pear Desktop -> Generate Token` once.
2) Add a text state to a button to confirm `Pear Desktop YTM - Connection Status`.
3) Add actions like Play/Pause and Volume, then test.

## Settings (TouchPortal)
- Pear API Port: use the port shown in Pear Desktop (default 9863).
- Pear API Hostname: advanced; usually `127.0.0.1`.
- Auth Client ID: default `touchportal`.
- Poll Interval (ms): song refresh rate (default 500).
- Extended States Enabled: enables extra states (volume, like, repeat, shuffle, url, etc).
- Cover Art Mode:
  - Off: no cover art.
  - Memory: send base64 to TouchPortal.
  - Local: download cover art to a local file and share the path.

## Actions
- Playback: Play/Pause/Toggle.
- Next/Previous: skip tracks.
- Like/Dislike: set the like status.
- Volume: step up/down by a percent.
- Set Volume: set a percent directly.
- Mute: mute/unmute/toggle.
- Seek: forward/rewind by seconds.
- Seek To: jump to a time in seconds.
- Repeat: toggle/off/all/one.
- Shuffle: on/off/toggle.
- Queue: play index, add track to queue.
- Generate Token: re-authenticate with Pear API.
- Refresh States: refresh all states on demand.

## Connectors
- Volume Slider: set volume between 0 and 100.

## States
Basic states: title, artist, album, cover art, play/pause, duration, elapsed.

Extended states (if enabled): volume percent, mute, like state, repeat mode,
shuffle state, url, video id, playlist id, media type, connection status.

## Cover Art in TouchPortal
TouchPortal cannot load remote URLs for icons directly. For cover art buttons,
use state `Pear Desktop YTM - Cover Art Base64 (raw)` with the TouchPortal action:
`Change Icon with value from plugin state`.

## Troubleshooting
- Connection Status shows Disconnected: verify Pear Desktop API server is on
  and the port matches your settings.
- Volume mismatch: disable Pear Desktop plugins that modify volume
  (Exponential Volume or Precise Volume).
- Settings not showing: remove the plugin, re-import the latest `.tpp`,
  and restart TouchPortal.
