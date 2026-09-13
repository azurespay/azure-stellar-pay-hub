# The pitch video

The project's primary presentation: a ~5-minute product pitch covering the
problem, the solution, the product surface, the on-chain layer, the
architecture, security, verification and the value.

| Artifact                                                 | What it is                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`stellar-pay-hub-pitch.mp4`](stellar-pay-hub-pitch.mp4) | The video — 1080p, H.264 + AAC                                                                |
| [`stellar-pay-hub-pitch.srt`](stellar-pay-hub-pitch.srt) | Caption track on the video's own clock (drop it next to the mp4, or upload it with the video) |
| [`thumbnail.jpg`](thumbnail.jpg)                         | The README thumbnail, linking to the video                                                    |
| [`preview.webp`](preview.webp)                           | A short silent loop, embedded in the README so the pitch moves inline                         |

Everything under `video/.work/` — narration audio, rendered stills, encoded
segments, the toolchain — is scratch space and is gitignored.

## How it is built

Each stage is a plain script with no bundler and no framework, so a reviewer can
read the whole pipeline in a few minutes.

```
scenes.mjs        the source of truth: narration text, on-screen copy, camera move
      │
      ├─ narrate.py ─────────► .work/audio/*.mp3 + sentence timings
      │                        (edge-tts or Gemini TTS, real durations)
      │
      ├─ render-scenes.mjs ──► .work/scenes/*.png
      │                        (headless Chromium, HTML/CSS composition at 3200x1800)
      │
      ├─ thumbnail.mjs ──────► thumbnail.jpg
      │
      └─ build-video.mjs ────► stellar-pay-hub-pitch.mp4
                               stellar-pay-hub-pitch.srt
                               preview.webp
```

`capture.mjs` is the odd one out: it drives the **running** application with
Playwright and writes the UI screenshots into `video/assets/`. Those screenshots
are committed, so re-rendering the scenes does not require the stack to be up.

### Why the video is timed the way it is

- **Narration drives timing.** `synthesize.mjs` measures each clip with ffprobe;
  nothing is estimated from a word count.
- **A transition never eats a word.** Each scene carries `LEAD` of silence before
  its narration and `TAIL` after it, and both are longer than the crossfade. The
  visuals are joined with `xfade` and the audio with `acrossfade` at the _same_
  duration, so the two timelines shorten identically and stay in sync. Because
  the joins happen where both scenes are silent, the crossfade is inaudible.
- **Captions share the clock.** The TTS engine reports sentence boundaries, which
  are anchored to the scenes' positions in the final timeline. Long sentences are
  split proportionally by character count, so a cue never drifts more than a
  fraction of a second.
- **The camera move is a function of frame index**, not accumulated state, so it
  cannot drift and a re-render reproduces it exactly.

## Reproducing it

Requirements: Node 20+, `python3` with [`edge-tts`](https://github.com/rany2/edge-tts),
and network access for the first run.

```bash
node video/setup.mjs            # ffmpeg + ffprobe + Playwright into video/.work (gitignored)
python3 -m pip install edge-tts

node video/synthesize.mjs       # narration and timings  (add --force to re-record)
node video/render-scenes.mjs    # 16 scene stills
node video/thumbnail.mjs        # README thumbnail
node video/build-video.mjs      # mp4 + captions + preview, then self-verifies
```

`build-video.mjs` exits non-zero if the deliverable does not match the plan:
video codec and dimensions, audio codec, total duration against the schedule,
every caption cue's ordering and bounds, the progress bar (it samples pixels out
of the finished file to confirm the fill is drawn and that it advances), and the
preview's WebP container (RIFF/WEBP with a `VP8X` header, an `ANIM` chunk and the
expected canvas size — ffprobe cannot read animated WebP, so the bytes are
checked directly).

Re-recording the UI screenshots needs the stack running locally (see the root
[README](../README.md) for `pnpm setup && pnpm docker:up && pnpm db:seed && pnpm dev`),
tokens from `video/get-tokens.mjs`, then:

```bash
node video/capture.mjs
```

### Useful flags and overrides

| Flag                              | Effect                                                                  |
| --------------------------------- | ----------------------------------------------------------------------- |
| `synthesize.mjs --force`          | Re-record every narration clip instead of reusing the cached audio      |
| `build-video.mjs --skip-segments` | Reuse the per-scene segments (each is validated against the plan first) |
| `build-video.mjs --reuse-video`   | Skip the expensive visuals pass when `final-video.mp4` already matches  |

| Variable       | Effect                                                            |
| -------------- | ----------------------------------------------------------------- |
| `FFMPEG`       | Use a specific ffmpeg binary instead of the provisioned one       |
| `FFPROBE`      | Same, for ffprobe                                                 |
| `VIDEO_CRF`    | Final quality (default `23`; lower is larger and better)          |
| `VIDEO_PRESET` | Final x264 preset (default `medium`)                              |
| `VIDEO_LIMIT`  | Encode only the first N seconds — a smoke test of the whole graph |

### Why the deliverable is encoded in three stages

`build-video.mjs` writes the visuals and the mix as two separate files and muxes
them, rather than doing everything in one filtergraph. A single graph that mixed
the 17-input video chain with the audio chain was observed to stall part-way
through with no error from ffmpeg; split apart, each stage is a smaller unit that
can be checked on its own, a failure names the stage that failed, and the audio
(which encodes in seconds) can be rebuilt without re-encoding the video. It is
also what makes `--reuse-video` possible.

## The narration voice

Two engines behind one contract — the pipeline only needs an mp3 plus sentence
timings, so either works and nothing downstream changes. Pick with
`VOICE_ENGINE` (or the `VOICE_ENGINE` constant in `video/scenes.mjs`):

| Engine   | Voice                                                                  | Needs            | Cues                                                        |
| -------- | ---------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------- |
| `edge`   | `en-US-AndrewMultilingualNeural` at `+8%` (default)                    | nothing          | real sentence boundaries from the engine                    |
| `gemini` | `Puck` on `gemini-2.5-flash-preview-tts` — upbeat, launch-day delivery | `GEMINI_API_KEY` | proportional over the measured duration, exact at the edges |

```bash
node video/synthesize.mjs                                  # edge-tts (no key)
GEMINI_API_KEY=… VOICE_ENGINE=gemini node video/synthesize.mjs --force
```

The default is a natural, multilingual neural voice, which is what makes a
16-scene script sound like one continuous take. The Gemini path exists for the
same reason: `Puck` with the style prompt in `scenes.mjs`
(`GEMINI_STYLE` — confident, upbeat, brisk) steers pace and tone in natural
language, which is what the model controls instead of a rate knob. Gemini
returns raw PCM, so `synthesize.mjs` writes its wav and converts it to mp3 with
ffmpeg — `build-video.mjs` reads mp3 either way and never knows the difference.
Each engine caches under its own extension (`<id>.mp3` vs `<id>.wav`), so
switching engines never serves the other's audio.

Sentence timing is the one place the engines differ: edge-tts reports real
sentence boundaries; Gemini returns audio only, so cues are distributed
proportionally by sentence length across the measured duration. Both are exact
at the scene edges — which is where captions are anchored — and the caption
splitter already assumes proportional distribution inside a sentence, so the
caption clock stays honest with either engine.

## Music

The ambient bed is **generated**, not downloaded: four sine-partial chords
(`Am – F – C – G`) are synthesised, low-passed and crossfaded into a loop, so the
repository carries no third-party audio and there is no licence to track. Its
level is not guessed — the build measures the mean volume of the narration and of
the bed, then places the bed a fixed number of dB below the voice.
