/**
 * Synthesises the narration for every scene and records how long each one
 * actually runs, so scene timing is driven by measurement rather than guesswork.
 *
 * The TTS engine also reports sentence boundaries, which build-video.mjs turns
 * into caption cues — captions therefore share a clock with the audio instead of
 * being estimated from a word count.
 *
 * Two engines are supported behind one contract (video/scenes.mjs picks one):
 *   edge    edge-tts, no API key — writes .work/audio/<id>.mp3 directly.
 *   gemini  Google AI Studio TTS (GEMINI_API_KEY) — narrate.py writes .wav;
 *           this script converts it to mp3 so build-video.mjs always reads the
 *           same file. Converting is cheap; re-encoding narration is not the
 *           bottleneck, and one audio format downstream keeps the pipeline flat.
 *
 * Writes video/.work/audio/<scene-id>.mp3 and video/.work/timing.json.
 *
 * Usage: node video/synthesize.mjs [--force]
 *        VOICE_ENGINE=gemini node video/synthesize.mjs --force
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { VOICE, RATE, VOICE_ENGINE, GEMINI_MODEL, GEMINI_STYLE, scenes } from './scenes.mjs';
import { ROOT, WORK, AUDIO, ffmpeg, probeDuration, run } from './tools.mjs';

const force = process.argv.includes('--force');
fs.mkdirSync(AUDIO, { recursive: true });

const jobFile = path.join(WORK, 'narration-job.json');
fs.writeFileSync(
  jobFile,
  JSON.stringify(
    {
      engine: VOICE_ENGINE,
      voice: VOICE_ENGINE === 'gemini' ? (process.env.GEMINI_VOICE ?? undefined) : VOICE,
      rate: RATE,
      model: GEMINI_MODEL,
      style: GEMINI_STYLE,
      outDir: AUDIO,
      scenes: scenes.map((s) => {
        // A cache left by the *other* engine must not be served: edge caches an
        // mp3, gemini caches a wav. Force the scene when its own engine's
        // artefact is missing, even without --force.
        const artifact =
          VOICE_ENGINE === 'gemini'
            ? path.join(AUDIO, `${s.id}.wav`)
            : path.join(AUDIO, `${s.id}.mp3`);
        return { id: s.id, text: s.narration.trim(), force: force || !fs.existsSync(artifact) };
      }),
    },
    null,
    2,
  ),
);

if (VOICE_ENGINE === 'gemini' && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
  console.error(
    'VOICE_ENGINE=gemini needs GEMINI_API_KEY (or GOOGLE_API_KEY). ' +
      'Create one in Google AI Studio (https://aistudio.google.com) and re-run:\n' +
      '  GEMINI_API_KEY=... node video/synthesize.mjs --force',
  );
  process.exit(1);
}

const voiceLabel =
  VOICE_ENGINE === 'gemini'
    ? `${GEMINI_MODEL} / ${process.env.GEMINI_VOICE ?? 'Puck'}`
    : `${VOICE} @ ${RATE}`;

console.log(`Synthesising ${scenes.length} scenes with ${VOICE_ENGINE} (${voiceLabel})…`);
const child = spawnSync('python3', [path.join(ROOT, 'video', 'narrate.py'), jobFile], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
if (child.status !== 0) {
  throw new Error(`narrate.py exited with status ${child.status}`);
}
const sentencesByScene = JSON.parse(child.stdout);

// Gemini emits wav; the pipeline standardises on mp3.
if (VOICE_ENGINE === 'gemini') {
  for (const scene of scenes) {
    const wav = path.join(AUDIO, `${scene.id}.wav`);
    const mp3 = path.join(AUDIO, `${scene.id}.mp3`);
    if (!fs.existsSync(wav)) throw new Error(`Missing Gemini narration for ${scene.id}: ${wav}`);
    run(
      ffmpeg(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        wav,
        '-codec:a',
        'libmp3lame',
        '-qscale:a',
        '2',
        mp3,
      ],
      { label: `mp3 conversion ${scene.id}` },
    );
  }
}

const timing = {};
let total = 0;
let totalWords = 0;
for (const scene of scenes) {
  const file = path.join(AUDIO, `${scene.id}.mp3`);
  if (!fs.existsSync(file)) throw new Error(`Missing narration for ${scene.id}: ${file}`);
  const seconds = probeDuration(file);
  const words = scene.narration.trim().split(/\s+/).length;
  const sentences = sentencesByScene[scene.id] ?? [];

  timing[scene.id] = {
    seconds: Number(seconds.toFixed(3)),
    words,
    wpm: Math.round((words / seconds) * 60),
    sentences,
  };
  total += seconds;
  totalWords += words;
  console.log(
    `${scene.id.padEnd(18)} ${seconds.toFixed(2).padStart(6)}s  ${String(words).padStart(3)}w  ` +
      `${String(timing[scene.id].wpm).padStart(3)}wpm  ${sentences.length} sentence cue(s)`,
  );
}

fs.writeFileSync(path.join(WORK, 'timing.json'), JSON.stringify(timing, null, 2));
const mm = Math.floor(total / 60);
const ss = (total % 60).toFixed(1).padStart(4, '0');
console.log(
  `\nNarration total: ${mm}:${ss} (${total.toFixed(1)}s, ${totalWords} words across ${scenes.length} scenes)`,
);
