---

name: cameras
description: Find and add barn cameras on the farm network (ONVIF / RTSP). Use when the farmer mentions cameras, video, or watching animals.
---

# Cameras

1. Explain that you will look for cameras on the local network, then call `camera_discover`.
   Scanning only listens for cameras that announce themselves, so it needs no permission.
2. Read back what was found in plain words: maker, model and address. If nothing answered,
   suggest checking power, that the camera is on the same network, and that ONVIF is enabled.
3. Ask where each camera hangs (e.g. "calving pen") and for its login, then `camera_add` with
   name, location, `onvifXaddr` and the login. The password goes to the system keychain.

Rules
- Never show or repeat a camera password. Never put credentials inside an RTSP URL you save.
- Do not change camera settings or firmware.
