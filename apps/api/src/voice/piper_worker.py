#!/usr/bin/env python3
"""Persistent Piper TTS worker for the voice service (keeps the voice model warm).
Protocol: one JSON line on stdin {"id": n, "text": "...", "out": "/path.pcm"};
writes 16 kHz mono s16le PCM to `out` and replies {"id": n, "ok": true, "samples": N}."""
import json, sys
import numpy as np
from piper import PiperVoice

voice = PiperVoice.load(sys.argv[1])
TARGET = 16000
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
        parts = []
        rate = TARGET
        for chunk in voice.synthesize(req["text"]):
            rate = chunk.sample_rate
            parts.append(chunk.audio_float_array.astype(np.float32))
        audio = np.concatenate(parts) if parts else np.zeros(0, np.float32)
        if rate != TARGET and len(audio):
            n = int(round(len(audio) * TARGET / rate))
            audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio)
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
        with open(req["out"], "wb") as f:
            f.write(pcm.tobytes())
        print(json.dumps({"id": req.get("id"), "ok": True, "samples": int(len(pcm))}), flush=True)
    except Exception as e:  # keep the worker alive
        print(json.dumps({"id": req.get("id") if isinstance(req, dict) else None, "ok": False, "error": str(e)}), flush=True)
