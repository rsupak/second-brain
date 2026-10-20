# Bailey voice service (xiaozhi-esp32 compatible)

A local voice front end for the AIPI-Lite. It runs as its own process, separate from the API, and has no launchd agent yet.
It speaks the xiaozhi-esp32 WebSocket protocol v1 and serves the boot-time OTA/config endpoint.

Protocol source: github.com/78/xiaozhi-esp32 at commit `aab98abdb3866f16662d448efc656b67275f57e9`:
`docs/websocket.md`, `main/protocols/websocket_protocol.cc`, `main/ota.cc`, `main/application.cc`,
`main/audio/audio_service.h` (OPUS_FRAME_DURATION_MS = 60).

## Pipeline
1. Device Opus frames (16 kHz, mono, 60 ms) are decoded with `opusscript`.
2. Audio is buffered until `listen stop`. In `auto`/`realtime` mode, an energy VAD ends the utterance after 800 ms of silence.
3. Speech-to-text runs on `whisper-server` (small.en-q5_1), kept warm on 127.0.0.1:8178 as a child process.
4. If the transcript starts with "new idea" or "capture/save/add an idea", it's sent as `POST /ideas` to `VOICE_API_URL` with no Origin header. Anything else gets a short answer from `generateResponse` (qwen3:4b, through the inference lock).
5. The reply is spoken with a warm Piper worker (`piper_worker.py`) at 16 kHz and sent as 60 ms Opus frames, wrapped in `tts start`, `sentence_start` and `stop`.

## Env vars
| var | default | |
|---|---|---|
| `VOICE_TOKEN` | (required, >=16 chars) | Shared token. OTA hands it to the device, and the WS checks `Authorization: Bearer <token>` |
| `VOICE_ALLOWED_DEVICES` | (required) | Comma-separated device MACs (the `Device-Id` header). The AIPI is `d0:cf:13:05:43:f8` |
| `VOICE_HOST` | first `en*` IPv4 | Bind address |
| `VOICE_PORT` | 8000 | HTTP (OTA, /health) and WS share this port |
| `VOICE_PUBLIC_WS_URL` | `ws://HOST:PORT/xiaozhi/v1/` | URL returned by OTA |
| `VOICE_API_URL` | `http://127.0.0.1:3333` | Second Brain API used for idea capture |
| `BRAIN_DB` | `./data/brain.sqlite` | Used only for the inference lock |
| `WHISPER_MODEL` / `WHISPER_PORT` / `WHISPER_SERVER_URL` / `WHISPER_SERVER_BIN` | voice-tools small.en-q5_1 / 8178 / spawn / `whisper-server` | |
| `PIPER_PYTHON` / `PIPER_VOICE` / `VOICE_TOOLS_DIR` | `~/Projects/voice-tools/...` | |

## Run
    VOICE_TOKEN=$(openssl rand -hex 24) VOICE_ALLOWED_DEVICES=d0:cf:13:05:43:f8 npm run voice

Endpoints for the firmware (Mac LAN IP at the time of writing: **192.168.50.27** on en0 (Ethernet). Wi-Fi en1 was 192.168.50.229.
Give the Mac a DHCP reservation so this address doesn't change):
- OTA URL: `http://192.168.50.27:8000/xiaozhi/ota/`
- WebSocket: `ws://192.168.50.27:8000/xiaozhi/v1/`. The device gets this from OTA.

## Test (simulated device, no hardware)
Run the service with `VOICE_API_URL` pointing at an API instance that uses a database **copy**:

    sqlite3 data/brain.sqlite ".backup /tmp/voice-test-brain.sqlite"
    BRAIN_DB=/tmp/voice-test-brain.sqlite PORT=3334 AUTO_EVALUATE=0 AUTO_RESEARCH=0 npx tsx apps/api/src/server.ts &
    VOICE_TOKEN=... VOICE_ALLOWED_DEVICES=d0:cf:13:05:43:f8 VOICE_API_URL=http://127.0.0.1:3334 npm run voice &
    VOICE_TOKEN=... VOICE_SIM_URL=http://192.168.50.27:8000 npx tsx apps/api/src/test-voice-sim.ts

## Known gaps vs real firmware
- Only binary protocol v1 (raw Opus frames) is implemented. Protocol-Version 2 or 3 is rejected with 400.
- No MCP tool calls, no `activation` challenge, no MQTT/UDP transport, no server-side AEC, no voice-print check.
- The VAD is a simple energy threshold. Manual mode (button/`listen stop`) is the reliable path.
- The OTA endpoint never offers firmware (it echoes the device's version with an empty url).
- Plain ws:// on the LAN with a shared token. The OTA endpoint gives the token to any allowlisted MAC, and MACs can be spoofed.
