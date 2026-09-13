#!/usr/bin/env python3
"""Synthesises the narration for every scene and reports real timings.

Reads a JSON job from the path given as argv[1]:

    {"engine": "edge" | "gemini",
     "voice": "...", "rate": "+8%",             # edge-tts
     "model": "...", "style": "...",            # gemini
     "outDir": "...",
     "scenes": [{"id": "01-hook", "text": "...", "force": false}]}

Two engines, one contract (see "The narration voice" in video/README.md):

  edge     edge-tts — no API key. Emits `<id>.mp3`; the engine reports *real*
           sentence boundaries (offset + duration in 100 ns ticks).
  gemini   Google AI Studio TTS — needs GEMINI_API_KEY in the environment.
           Emits `<id>.wav` (24 kHz PCM); the model returns audio only, so
           sentence cues are distributed across the measured duration
           proportionally by sentence length. Edge anchors stay real
           measurements; Gemini anchors stay exact at the scene edges and
           proportional in between — the same contract the caption splitter
           already assumes.

Both write `<outDir>/<id>.mp3|.wav` plus a `<id>.mp3|.wav.sentences.json`
sidecar, and print `{ "<id>": [{text, start, end}, ...] }` on stdout.
"""

import asyncio
import base64
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
import wave

ATTEMPTS = 3
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models"


def sentences_from_text(text, duration):
    """Proportional sentence cues over a measured duration (engine: gemini).

    The TTS model returns audio without timing metadata, so each sentence's
    share of the clip is its share of the characters. Boundaries land within a
    fraction of a second as long as sentences are roughly uniform in pace,
    which a style-prompted narrator is.
    """
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", text.strip()) if p.strip()]
    if not parts:
        parts = [text.strip()]
    total_chars = sum(len(p) for p in parts)
    cues = []
    cursor = 0.0
    for part in parts:
        span = (len(part) / total_chars) * duration if total_chars else duration / len(parts)
        cues.append({"text": part, "start": round(cursor, 3), "end": round(cursor + span, 3)})
        cursor += span
    return cues


# --------------------------------------------------------------------- edge


async def synthesise_edge(scene, voice, rate, out_dir):
    import edge_tts

    media = os.path.join(out_dir, f"{scene['id']}.mp3")
    sidecar = media + ".sentences.json"

    if os.path.exists(media) and os.path.exists(sidecar) and not scene.get("force"):
        with open(sidecar) as fh:
            return json.load(fh)

    last_error = None
    for attempt in range(1, ATTEMPTS + 1):
        try:
            communicate = edge_tts.Communicate(scene["text"], voice, rate=rate)
            audio = bytearray()
            sentences = []
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio.extend(chunk["data"])
                elif chunk["type"] in ("SentenceBoundary", "WordBoundary"):
                    sentences.append(
                        {
                            "text": chunk["text"],
                            "start": chunk["offset"] / 1e7,
                            "end": (chunk["offset"] + chunk["duration"]) / 1e7,
                        }
                    )
            if not audio:
                raise RuntimeError("the engine returned no audio")
            with open(media, "wb") as fh:
                fh.write(audio)
            with open(sidecar, "w") as fh:
                json.dump(sentences, fh)
            return sentences
        except Exception as error:  # noqa: BLE001 - retried, then reported
            last_error = error
            print(f"  {scene['id']}: attempt {attempt} failed ({error})", file=sys.stderr)
            await asyncio.sleep(2 * attempt)

    raise RuntimeError(f"Could not synthesise {scene['id']}: {last_error}")


# ------------------------------------------------------------------- gemini


def gemini_api_key():
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        raise RuntimeError(
            "VOICE_ENGINE=gemini needs GEMINI_API_KEY (or GOOGLE_API_KEY) in the "
            "environment. Create one in Google AI Studio (aistudio.google.com), "
            "then: GEMINI_API_KEY=... node video/synthesize.mjs --force"
        )
    return key


def wav_duration(path):
    with wave.open(path) as wf:
        return wf.getnframes() / float(wf.getframerate())


def gemini_generate(model, style, text, voice_name, api_key):
    """One Gemini TTS call. Returns (pcm_bytes, sample_rate)."""
    body = {
        "contents": [{"parts": [{"text": f"{style}\"{text}\""}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice_name}}
            },
        },
    }
    request = urllib.request.Request(
        f"{GEMINI_ENDPOINT}/{model}:generateContent",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"HTTP {error.code} from the Gemini API: {detail}") from error

    try:
        parts = payload["candidates"][0]["content"]["parts"]
    except (KeyError, IndexError) as error:
        raise RuntimeError(f"unexpected Gemini response shape: {json.dumps(payload)[:400]}") from error

    audio = None
    mime = ""
    for part in parts:
        inline = part.get("inlineData")
        if inline and inline.get("data"):
            audio = inline["data"]
            mime = inline.get("mimeType", "")
            break
    if not audio:
        # A refusal or plain text comes back as text parts; surface it verbatim.
        said = " ".join(p.get("text", "") for p in parts).strip()
        raise RuntimeError(f"the model returned no audio (said: {said[:200] or 'nothing'})")

    rate_match = re.search(r"rate=(\d+)", mime)
    rate = int(rate_match.group(1)) if rate_match else 24000
    return base64.b64decode(audio), rate


def synthesise_gemini(scene, job, out_dir):
    """Gemini path. Writes `<id>.wav` + sidecar; synthesize.mjs converts to mp3."""
    media = os.path.join(out_dir, f"{scene['id']}.wav")
    sidecar = media + ".sentences.json"

    if os.path.exists(media) and os.path.exists(sidecar) and not scene.get("force"):
        with open(sidecar) as fh:
            return json.load(fh)

    api_key = gemini_api_key()
    last_error = None
    for attempt in range(1, ATTEMPTS + 1):
        try:
            pcm, rate = gemini_generate(
                job["model"], job.get("style", ""), scene["text"], job["voice"], api_key
            )
            if not pcm:
                raise RuntimeError("the engine returned no audio")
            with open(media, "wb") as fh:
                with wave.open(fh) as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(rate)
                    wf.writeframes(pcm)
            seconds = wav_duration(media)
            if seconds < 0.5:
                raise RuntimeError(f"the clip is implausibly short ({seconds:.2f}s)")
            with open(sidecar, "w") as fh:
                json.dump(sentences_from_text(scene["text"], seconds), fh)
            return json.load(open(sidecar))
        except Exception as error:  # noqa: BLE001 - retried, then reported
            last_error = error
            print(f"  {scene['id']}: attempt {attempt} failed ({error})", file=sys.stderr)
            if os.path.exists(media):
                os.remove(media)  # a partial or bad clip must not be cached
            import time

            time.sleep(2 * attempt)

    raise RuntimeError(f"Could not synthesise {scene['id']}: {last_error}")


# --------------------------------------------------------------------- main


async def main():
    with open(sys.argv[1]) as fh:
        job = json.load(fh)

    out_dir = job["outDir"]
    os.makedirs(out_dir, exist_ok=True)
    engine = job.get("engine", "edge")

    result = {}
    for scene in job["scenes"]:
        if engine == "gemini":
            result[scene["id"]] = await asyncio.to_thread(
                synthesise_gemini, scene, job, out_dir
            )
        else:
            result[scene["id"]] = await synthesise_edge(
                scene, job["voice"], job.get("rate", "+0%"), out_dir
            )
        print(f"  {scene['id']}", file=sys.stderr)

    print(json.dumps(result))


if __name__ == "__main__":
    asyncio.run(main())
