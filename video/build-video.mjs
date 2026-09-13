/**
 * Assembles the pitch video from the rendered scenes and the synthesised
 * narration.
 *
 * For every scene it:
 *   1. applies a camera move (the `motion` field in video/scenes.mjs) to the
 *      3200x1800 still, using the single-frame `zoompan` form so the move is
 *      frame-exact and cheap;
 *   2. lays the narration onto a silent pad at the head and tail of the scene.
 *      The pads are longer than the crossfade, so a transition never eats a
 *      word — the two scenes are only ever mixed where both are silent;
 *   3. encodes a segment.
 *
 * It then chains the segments with matching video (xfade) and audio (acrossfade)
 * crossfades, so the two timelines shorten identically and stay in sync, adds a
 * progress bar and the opening/closing fades, and encodes the deliverable.
 *
 * Outputs (all committed, all referenced from the README):
 *   video/stellar-pay-hub-pitch.mp4   — the video, 1080p H.264 + AAC
 *   video/stellar-pay-hub-pitch.srt   — caption track on the video's own clock
 *   video/preview.webp                — silent inline loop for the README
 *
 * Usage: node video/build-video.mjs [--skip-segments] [--music-gain-db N]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scenes } from './scenes.mjs';
import {
  ROOT,
  WORK,
  AUDIO,
  SCENES_OUT,
  SEGMENTS,
  ffmpeg,
  probeDuration,
  probeStreams,
  run,
} from './tools.mjs';

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;

/** Crossfade length. Must stay below LEAD and TAIL (see the header comment). */
const TRANS = 0.5;
/** Silence before the narration, long enough to cover the incoming crossfade. */
const LEAD = 0.6;
/** Silence after the narration, long enough to cover the outgoing crossfade. */
const TAIL = 0.75;
/** Extra hold on the final card so the call to action is readable. */
const END_HOLD = 1.4;
/** The inline README preview: silent, small, looping. */
const PREVIEW = { width: 960, height: 540, fps: 12, fade: 0.4 };
/** How far below the narration the music bed sits, in dB. */
const MUSIC_HEADROOM_DB = 21;
/**
 * Lift applied to the mix before the limiter. The narration is recorded with a
 * lot of headroom (peaks around -8 dBFS), so the finished mix lands too quiet to
 * watch comfortably without it.
 */
const MIX_GAIN_DB = 3;

const VIDEO_DIR = path.join(ROOT, 'video');
const OUT_MP4 = path.join(VIDEO_DIR, 'stellar-pay-hub-pitch.mp4');
const OUT_SRT = path.join(VIDEO_DIR, 'stellar-pay-hub-pitch.srt');
const OUT_PREVIEW = path.join(VIDEO_DIR, 'preview.webp');
// CRF 25 keeps a five-minute 1080p deliverable under GitHub's 50 MB file
// guidance (~35 MB here) while staying visually transparent for UI stills with
// slow camera moves. CRF 23 landed at ~51 MB and tripped the warning.
const CRF = process.env.VIDEO_CRF ?? '25';

const timing = JSON.parse(fs.readFileSync(path.join(WORK, 'timing.json'), 'utf8'));
const skipSegments = process.argv.includes('--skip-segments');

// ---------------------------------------------------------------- scheduling

/** Per-scene durations: narration plus the silent pads that carry the crossfades. */
const schedule = scenes.map((scene, i) => {
  const entry = timing[scene.id];
  if (!entry)
    throw new Error(`No narration timing for ${scene.id} — run video/synthesize.mjs first`);
  const lead = i === 0 ? 0 : LEAD;
  const tail = i === scenes.length - 1 ? TAIL + END_HOLD : TAIL;
  const duration = lead + entry.seconds + tail;
  return { scene, index: i, lead, tail, narration: entry.seconds, duration };
});

const startOf = (index) => {
  // Each crossfade consumes TRANS from the combined timeline.
  let start = 0;
  for (let i = 0; i < index; i += 1) start += schedule[i].duration;
  return start - index * TRANS;
};

const TOTAL = schedule.reduce((sum, s) => sum + s.duration, 0) - (scenes.length - 1) * TRANS;

// ------------------------------------------------------------------- camera

/**
 * The zoompan expression for a scene's camera move. `on` is the output frame
 * index, so the move is a function of position in the scene rather than of
 * accumulated state — no drift, and a re-render reproduces it exactly.
 */
function camera(scene, frames) {
  const { kind = 'zoom-in', amount = 0.08 } = scene.motion ?? {};
  const progress = `min(on/${frames},1)`;
  const centreX = 'iw/2-(iw/zoom/2)';
  const centreY = 'ih/2-(ih/zoom/2)';
  const maxX = '(iw-iw/zoom)';
  const maxY = '(ih-ih/zoom)';
  switch (kind) {
    case 'zoom-out':
      return { z: `1+${amount}*(1-${progress})`, x: centreX, y: centreY };
    case 'pan-left':
      return { z: `1+${amount}`, x: `${maxX}*(1-${progress})`, y: centreY };
    case 'pan-right':
      return { z: `1+${amount}`, x: `${maxX}*${progress}`, y: centreY };
    case 'pan-up':
      return { z: `1+${amount}`, x: centreX, y: `${maxY}*(1-${progress})` };
    case 'pan-down':
      return { z: `1+${amount}`, x: centreX, y: `${maxY}*${progress}` };
    case 'zoom-in':
    default:
      return { z: `1+${amount}*${progress}`, x: centreX, y: centreY };
  }
}

// ---------------------------------------------------------------- segments

fs.mkdirSync(SEGMENTS, { recursive: true });

for (const entry of schedule) {
  const { scene, duration, lead, index } = entry;
  const segment = path.join(SEGMENTS, `${scene.id}.mp4`);
  const still = path.join(SCENES_OUT, `${scene.id}.png`);
  const narration = path.join(AUDIO, `${scene.id}.mp3`);
  if (!fs.existsSync(still))
    throw new Error(`Missing rendered scene: ${still} (run video/render-scenes.mjs)`);
  if (!fs.existsSync(narration)) throw new Error(`Missing narration: ${narration}`);

  // A segment left behind by an interrupted encode is a truncated file, so
  // reuse only counts when the duration matches what this run planned —
  // otherwise the crossfade chain would be built on a broken input.
  if (skipSegments && fs.existsSync(segment)) {
    let reusable = false;
    try {
      reusable = Math.abs(probeDuration(segment) - duration) <= 0.15;
    } catch {
      reusable = false;
    }
    if (reusable) {
      console.log(`${scene.id.padEnd(18)} ${duration.toFixed(2).padStart(6)}s  reused`);
      continue;
    }
    console.warn(`${scene.id.padEnd(18)} stale or truncated segment — re-encoding`);
  }

  const frames = Math.round(duration * FPS);
  const { z, x, y } = camera(scene, frames);
  const delayMs = Math.round(lead * 1000);

  run(
    ffmpeg(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      still,
      '-i',
      narration,
      '-filter_complex',
      [
        `[0:v]zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},format=yuv420p[v]`,
        `[1:a]aresample=48000,aformat=channel_layouts=stereo,` +
          `adelay=${delayMs}|${delayMs},apad,atrim=0:${duration.toFixed(3)}[a]`,
      ].join(';'),
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-t',
      duration.toFixed(3),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '17',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(FPS),
      '-g',
      String(FPS * 2),
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      segment,
    ],
    { label: `segment ${scene.id}` },
  );
  console.log(
    `${scene.id.padEnd(18)} ${duration.toFixed(2).padStart(6)}s  ` +
      `motion ${(scene.motion?.kind ?? 'zoom-in').padEnd(10)} ${frames} frames`,
  );
}

// ------------------------------------------------------------------- music

/**
 * A licence-free ambient pad, synthesised from sine partials. Generated rather
 * than downloaded so the repository carries no third-party audio.
 */
function buildMusic() {
  const file = path.join(WORK, 'music-loop.wav');
  if (fs.existsSync(file)) return file;

  // Am – F – C – G, each a spread voicing so the pad has some body.
  const chords = [
    [110.0, 164.81, 261.63, 329.63],
    [87.31, 130.81, 174.61, 349.23],
    [130.81, 196.0, 261.63, 392.0],
    [98.0, 146.83, 196.0, 293.66],
  ];
  const CHORD = 8;
  const parts = chords.map((freqs, i) => {
    const file = path.join(WORK, `music-${i}.wav`);
    const inputs = freqs.flatMap((f) => [
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${f}:duration=${CHORD}`,
    ]);
    const mix = freqs.map((_, n) => `[${n}:a]`).join('');
    run(
      ffmpeg(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        ...inputs,
        '-filter_complex',
        `${mix}amix=inputs=${freqs.length}:normalize=1,` +
          `tremolo=f=0.11:d=0.35,lowpass=f=1500,` +
          `afade=t=in:st=0:d=2,afade=t=out:st=${CHORD - 2}:d=2[a]`,
        '-map',
        '[a]',
        '-ar',
        '48000',
        '-ac',
        '2',
        file,
      ],
      { label: `music chord ${i}` },
    );
    return file;
  });

  run(
    ffmpeg(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...parts.flatMap((p) => ['-i', p]),
      '-filter_complex',
      `[0:a][1:a]acrossfade=d=2[ab];[ab][2:a]acrossfade=d=2[abc];[abc][3:a]acrossfade=d=2[out]`,
      '-map',
      '[out]',
      '-ar',
      '48000',
      '-ac',
      '2',
      file,
    ],
    { label: 'music bed' },
  );
  return file;
}

/**
 * Mean level in dBFS. ffmpeg exits non-zero when the output is `-f null -`, so
 * the report on stderr is read whether the call succeeded or not.
 */
function meanVolumeDb(file) {
  // volumedetect reports on stderr and ffmpeg exits 0 for `-f null -`, so the
  // report has to be read from the stream rather than from a thrown error.
  const result = spawnSync(
    ffmpeg(),
    ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const report = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(report);
  if (!match) throw new Error(`Could not measure the loudness of ${file}`);
  return Number(match[1]);
}

// -------------------------------------------------------------- final graph

const music = buildMusic();
const narrationLoudness = meanVolumeDb(path.join(AUDIO, `${scenes[0].id}.mp3`));
const musicLoudness = meanVolumeDb(music);
const musicGainDb = narrationLoudness - MUSIC_HEADROOM_DB - musicLoudness;

console.log(
  `\nMusic bed: narration ${narrationLoudness.toFixed(1)} dB, bed ${musicLoudness.toFixed(1)} dB ` +
    `-> gain ${musicGainDb.toFixed(1)} dB`,
);

const totalStr = TOTAL.toFixed(3);
const segmentInputs = schedule.flatMap((s) => ['-i', path.join(SEGMENTS, `${s.scene.id}.mp4`)]);

// A smoke test of the whole graph: `VIDEO_LIMIT=90` encodes only the first 90s,
// which exercises every transition type in a fraction of the time.
const limit = Number(process.env.VIDEO_LIMIT ?? 0);
const outputDuration = limit > 0 ? Math.min(limit, TOTAL) : TOTAL;

// The visuals and the mix are built as two separate graphs and muxed at the end.
// Combining them into one 35-input graph was observed to stall part-way through
// with no error from ffmpeg; split this way each stage is a smaller, verifiable
// unit, a failure names the stage that failed, and the audio (which encodes in
// seconds) can be rebuilt without re-encoding the video.
const videoGraph = [];
schedule.forEach((_, i) => videoGraph.push(`[${i}:v]fps=${FPS},format=yuv420p[v${i}]`));
let lastV = 'v0';
schedule.forEach((_, i) => {
  if (i === 0) return;
  // xfade's offset is measured against the chain built so far, whose length is
  // startOf(i) + TRANS; the transition therefore begins at startOf(i).
  videoGraph.push(
    `[${lastV}][v${i}]xfade=transition=fade:duration=${TRANS}:offset=${startOf(i).toFixed(3)}[x${i}]`,
  );
  lastV = `x${i}`;
});
// Progress bar: a static track, then the accent fill laid over it as a full-width
// strip that slides in from the right, so the visible part is exactly the
// fraction of the video already played.
//
// The obvious implementation — a drawbox whose width is `1920*min(t/T,1)` — does
// not work: drawbox evaluates `t` to nothing usable here and the bar renders at
// full width for the whole video. overlay evaluates its position per frame
// (`eval=frame`), and `t` is reliable there.
videoGraph.push(
  `[${lastV}]settb=AVTB,drawbox=x=0:y=${HEIGHT - 6}:w=${WIDTH}:h=6:color=0x000000@0.35:t=fill[bar]`,
);
videoGraph.push(
  `[bar][${schedule.length}:v]overlay=` +
    `x='-${WIDTH}+${WIDTH}*min(t/${totalStr},1)':y=${HEIGHT - 6}:eval=frame,` +
    `fade=t=in:st=0:d=0.9,fade=t=out:st=${(TOTAL - 1.2).toFixed(3)}:d=1.2[vid]`,
);

const audioGraph = [];
schedule.forEach((_, i) => {
  audioGraph.push(
    `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`,
  );
});
let lastA = 'a0';
schedule.forEach((_, i) => {
  if (i === 0) return;
  audioGraph.push(`[${lastA}][a${i}]acrossfade=d=${TRANS}:c1=tri:c2=tri[y${i}]`);
  lastA = `y${i}`;
});
audioGraph.push(`[${lastA}]afade=t=in:d=1,afade=t=out:st=${(TOTAL - 1.6).toFixed(3)}:d=1.6[nar]`);
audioGraph.push(
  `[${schedule.length}:a]atrim=0:${totalStr},asetpts=PTS-STARTPTS,` +
    `volume=${musicGainDb.toFixed(2)}dB,afade=t=in:d=3,` +
    `afade=t=out:st=${(TOTAL - 4).toFixed(3)}:d=4[bed]`,
);
audioGraph.push(
  `[nar][bed]amix=inputs=2:weights='1 1':normalize=0:duration=first,` +
    `volume=${MIX_GAIN_DB}dB,alimiter=limit=0.95[aud]`,
);

const silentVideo = path.join(WORK, 'final-video.mp4');
const finalAudio = path.join(WORK, 'final-audio.m4a');

const progressStrip = [
  '-f',
  'lavfi',
  '-i',
  `color=c=0x8B5CF6:s=${WIDTH}x6:r=${FPS}:d=${outputDuration.toFixed(3)}`,
];

const videoArgs = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  ...segmentInputs,
  ...progressStrip,
  '-filter_complex',
  videoGraph.join(';'),
  '-map',
  '[vid]',
  '-t',
  outputDuration.toFixed(3),
  '-an',
  '-c:v',
  'libx264',
  '-preset',
  process.env.VIDEO_PRESET ?? 'medium',
  '-crf',
  CRF,
  '-pix_fmt',
  'yuv420p',
  '-profile:v',
  'high',
  '-level',
  '4.0',
  '-g',
  String(FPS * 2),
  silentVideo,
];

const audioArgs = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  ...segmentInputs,
  '-stream_loop',
  '-1',
  '-i',
  music,
  '-filter_complex',
  audioGraph.join(';'),
  '-map',
  '[aud]',
  '-t',
  outputDuration.toFixed(3),
  '-c:a',
  'aac',
  // 128 kbps is transparent enough for narration over a soft bed and keeps five
  // minutes of audio to about 5 MB instead of 8.
  '-b:a',
  '128k',
  '-ar',
  '48000',
  '-ac',
  '2',
  finalAudio,
];

// Kept on disk so a failed stage can be re-run by hand with more logging.
fs.writeFileSync(
  path.join(WORK, 'last-encode-args.json'),
  `${JSON.stringify({ video: [ffmpeg(), ...videoArgs], audio: [ffmpeg(), ...audioArgs] }, null, 2)}\n`,
);

console.log(
  `\nEncoding ${schedule.length} scenes into ${path.relative(ROOT, OUT_MP4)} (target ${totalStr}s)…`,
);
// Stage 1 is by far the most expensive step. `--reuse-video` keeps an existing
// `final-video.mp4` when its duration matches this run's plan, so captions, the
// preview or a change to the audio mix can be iterated on in seconds. A truncated
// or stale file fails the duration check and is rebuilt.
const reuseVideo = process.argv.includes('--reuse-video');
let videoReady = false;
if (reuseVideo && fs.existsSync(silentVideo)) {
  try {
    videoReady = Math.abs(probeDuration(silentVideo) - outputDuration) <= 0.15;
  } catch {
    videoReady = false;
  }
}

if (videoReady) {
  console.log('  stage 1/3  visuals + progress bar (reused)');
} else {
  console.log('  stage 1/3  visuals + progress bar');
  run(ffmpeg(), videoArgs, { label: 'final encode (video)' });
}
console.log('  stage 2/3  narration + music bed');
run(ffmpeg(), audioArgs, { label: 'final encode (audio)' });
console.log('  stage 3/3  mux');
run(
  ffmpeg(),
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    silentVideo,
    '-i',
    finalAudio,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    OUT_MP4,
  ],
  { label: 'final encode (mux)' },
);

// ------------------------------------------------------------------ captions

/**
 * Caption cues on the video's own clock. Sentence boundaries come from the TTS
 * engine; a sentence too long for two lines is split proportionally by character
 * count, so it never drifts more than a fraction of a second.
 */
function wrap(text, maxChars = 62) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && (line + ' ' + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= 2) return lines.join('\n');
  // Rebalance into two lines rather than truncating.
  const mid = Math.ceil(lines.length / 2);
  return [lines.slice(0, mid).join(' '), lines.slice(mid).join(' ')].join('\n');
}

function chunk(sentence) {
  const words = sentence.text.trim().split(/\s+/);
  if (words.length <= 13) return [sentence];
  const span = sentence.end - sentence.start;
  const totalChars = words.join(' ').length;
  const parts = [];
  let bucket = [];
  let chars = 0;
  for (const word of words) {
    bucket.push(word);
    chars += word.length + 1;
    if (bucket.length >= 7 && chars >= totalChars * 0.4) {
      parts.push({ words: bucket, chars });
      bucket = [];
      chars = 0;
    }
  }
  if (bucket.length) parts.push({ words: bucket, chars });

  const sum = parts.reduce((acc, p) => acc + p.chars, 0);
  let cursor = sentence.start;
  return parts.map((p) => {
    const length = (p.chars / sum) * span;
    const cue = { text: p.words.join(' '), start: cursor, end: cursor + length };
    cursor += length;
    return cue;
  });
}

const stamp = (seconds) => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hh = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
  const mm = String(Math.floor(ms / 60_000) % 60).padStart(2, '0');
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  const mmm = String(ms % 1000).padStart(3, '0');
  return `${hh}:${mm}:${ss},${mmm}`;
};

let cueIndex = 0;
const cues = [];
schedule.forEach((entry) => {
  const { scene, lead, index } = entry;
  const base = startOf(index) + lead;
  const sentences = timing[scene.id].sentences ?? [];
  for (const sentence of sentences) {
    for (const piece of chunk(sentence)) {
      const text = wrap(piece.text);
      if (!text.trim()) continue;
      cueIndex += 1;
      cues.push(
        `${cueIndex}\n${stamp(base + piece.start)} --> ${stamp(base + piece.end)}\n${text}\n`,
      );
    }
  }
});
fs.writeFileSync(OUT_SRT, `${cues.join('\n')}`);
console.log(`Captions: ${cueIndex} cues -> ${path.relative(ROOT, OUT_SRT)}`);

// ------------------------------------------------------------------ chapters

/**
 * Scene start times, so the README can offer a chapter list that is derived from
 * the build rather than typed by hand.
 */
const mmss = (seconds) => {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const chapters = schedule.map((entry, i) => ({
  id: entry.scene.id,
  title: entry.scene.kicker ?? entry.scene.id,
  start: Number(startOf(i).toFixed(2)),
  label: mmss(startOf(i)),
}));
fs.writeFileSync(path.join(WORK, 'chapters.json'), `${JSON.stringify(chapters, null, 2)}\n`);
console.log('\nChapters:');
for (const chapter of chapters) console.log(`  ${chapter.label}  ${chapter.title}`);

// -------------------------------------------------------------------- preview

/**
 * A short, silent, looping clip for the README so the pitch is visible inline.
 * Built from three segments that between them show the promise, the product and
 * the call to action.
 */
function buildPreview() {
  const picks = [
    ['01-hook', 0, 3.6],
    ['08-admin', 0.4, 3.6],
    ['10-escrow', 0.4, 3.0],
    ['16-close', 0, 3.4],
  ];
  const inputs = [];
  const filters = [];
  picks.forEach(([id, from, span], i) => {
    const file = path.join(SEGMENTS, `${id}.mp4`);
    inputs.push('-ss', String(from), '-t', String(span), '-i', file);
    filters.push(
      `[${i}:v]fps=${PREVIEW.fps},scale=${PREVIEW.width}:${PREVIEW.height}:flags=lanczos,format=yuv420p[p${i}]`,
    );
  });
  let last = 'p0';
  let offset = picks[0][2] - PREVIEW.fade;
  for (let i = 1; i < picks.length; i += 1) {
    const out = `q${i}`;
    filters.push(
      `[${last}][p${i}]xfade=transition=fade:duration=${PREVIEW.fade}:offset=${offset.toFixed(2)}[${out}]`,
    );
    last = out;
    offset += picks[i][2] - PREVIEW.fade;
  }
  run(
    ffmpeg(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...inputs,
      '-filter_complex',
      filters.join(';'),
      '-map',
      `[${last}]`,
      '-c:v',
      'libwebp',
      '-lossless',
      '0',
      // The preview loads inline on the README, so it is tuned for weight rather
      // than for pixel-perfection: 960x540 at 12 fps still reads clearly.
      '-quality',
      '46',
      '-compression_level',
      '6',
      '-loop',
      '0',
      '-an',
      OUT_PREVIEW,
    ],
    { label: 'preview' },
  );
}
buildPreview();

// -------------------------------------------------------------- verification

const meta = probeStreams(OUT_MP4);
const video = meta.streams.find((s) => s.codec_type === 'video');
const audio = meta.streams.find((s) => s.codec_type === 'audio');
const duration = Number(meta.format.duration);

const problems = [];
if (video?.codec_name !== 'h264') problems.push(`expected h264 video, got ${video?.codec_name}`);
if (video?.width !== WIDTH || video?.height !== HEIGHT) {
  problems.push(`expected ${WIDTH}x${HEIGHT}, got ${video?.width}x${video?.height}`);
}
if (audio?.codec_name !== 'aac') problems.push(`expected aac audio, got ${audio?.codec_name}`);
if (Math.abs(duration - outputDuration) > 0.5) {
  problems.push(`duration ${duration}s differs from plan ${outputDuration.toFixed(2)}s`);
}
if (limit > 0) {
  console.log(`(smoke test: only the first ${outputDuration}s were encoded)`);
} else if (duration < 280 || duration > 340) {
  problems.push(`duration ${duration.toFixed(1)}s is outside the 4:40–5:40 target`);
}

/**
 * Mean colour of a region, one frame, as raw RGB.
 *
 * Used to prove the progress bar is really there: at a quarter of the way
 * through, the left end of the bar must be the accent colour and the right end
 * must still be the empty track; at three quarters, the bar must have grown past
 * where its edge was before.
 */
function sampleColour(seconds, crop) {
  const result = spawnSync(
    ffmpeg(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      seconds.toFixed(2),
      '-i',
      OUT_MP4,
      '-frames:v',
      '1',
      '-vf',
      `crop=${crop},scale=1:1`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 1024 },
  );
  const bytes = result.stdout;
  if (!bytes || bytes.length < 3) return null;
  return { r: bytes[0], g: bytes[1], b: bytes[2] };
}

// Where the fill's right edge should sit at a given time, in pixels. The bar is
// scaled to the whole pitch, so a smoke-test run only ever fills part of it.
const BAR_Y = HEIGHT - 5;
const barEdge = (seconds) => WIDTH * Math.min(seconds / TOTAL, 1);
const isAccent = (c) => c && c.b > 140 && c.r > 80 && c.b > c.r;
const isTrack = (c) => c && c.r < 110 && c.b < 150;

const early = outputDuration * 0.2;
const late = outputDuration * 0.8;
const inside = Math.max(30, Math.round(barEdge(early) * 0.5));
const middleX = Math.round((barEdge(early) + barEdge(late)) / 2);

const atStart = sampleColour(early, `${inside}:4:0:${BAR_Y}`);
const aheadOfFill = sampleColour(early, `120:4:${middleX}:${BAR_Y}`);
const afterAdvancing = sampleColour(late, `120:4:${middleX}:${BAR_Y}`);

if (!isAccent(atStart)) {
  problems.push(
    `the progress bar is not drawn near the start of the video (sampled ${JSON.stringify(atStart)})`,
  );
}
if (!isTrack(aheadOfFill)) {
  problems.push(
    `the progress bar track is not visible ahead of the fill (sampled ${JSON.stringify(aheadOfFill)})`,
  );
}
if (!isAccent(afterAdvancing)) {
  problems.push(
    `the progress bar did not advance into the space that was empty earlier ` +
      `(sampled ${JSON.stringify(afterAdvancing)})`,
  );
}

const srt = fs.readFileSync(OUT_SRT, 'utf8');
const cueTimes = [...srt.matchAll(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/g)];
const toSeconds = (t) => {
  const [h, m, rest] = t.split(':');
  const [s, ms] = rest.split(',');
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
};
for (let i = 0; i < cueTimes.length; i += 1) {
  const [start, end] = [toSeconds(cueTimes[i][1]), toSeconds(cueTimes[i][2])];
  if (end <= start) problems.push(`caption ${i + 1} has a non-positive duration`);
  // A smoke-test run is legitimately shorter than the captions, so only the
  // real deliverable is checked against the cue bounds.
  if (limit === 0 && end > duration + 0.05) {
    problems.push(`caption ${i + 1} ends after the video (${end.toFixed(2)}s)`);
  }
  if (i > 0 && start < toSeconds(cueTimes[i - 1][2]) - 0.01) {
    problems.push(`caption ${i + 1} starts before caption ${i} ends`);
  }
}
if (cueTimes.length === 0) problems.push('no caption cues were produced');

/**
 * The inline README preview is an animated WebP. ffprobe's WebP demuxer does not
 * read animations, so the container is checked directly: RIFF/WEBP, a VP8X
 * header, an ANIM chunk and a sensible canvas size.
 */
function checkPreview(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, 4).toString() !== 'RIFF' || buffer.subarray(8, 12).toString() !== 'WEBP') {
    return `${path.basename(file)} is not a RIFF/WEBP file`;
  }
  const header = buffer.subarray(12, 16).toString();
  if (header !== 'VP8X') return `${path.basename(file)} has no VP8X header (got ${header})`;
  const width = buffer.readUIntLE(24, 3) + 1;
  const height = buffer.readUIntLE(27, 3) + 1;
  if (!buffer.subarray(12, 4096).includes(Buffer.from('ANIM'))) {
    return `${path.basename(file)} is not animated (no ANIM chunk) — it would render as a still`;
  }
  if (width !== PREVIEW.width || height !== PREVIEW.height) {
    return `${path.basename(file)} canvas is ${width}x${height}, expected ${PREVIEW.width}x${PREVIEW.height}`;
  }
  return null;
}

const previewProblem = checkPreview(OUT_PREVIEW);
if (previewProblem) problems.push(previewProblem);

const size = fs.statSync(OUT_MP4).size;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

console.log('\n' + '─'.repeat(66));
console.log(`${path.relative(ROOT, OUT_MP4)}`);
console.log(
  `  ${video?.codec_name} ${video?.width}x${video?.height} @ ${video?.r_frame_rate}  ` +
    `${audio?.codec_name} ${audio?.channels}ch  ${duration.toFixed(2)}s  ${mb(size)}`,
);
console.log(
  `  ${path.basename(OUT_SRT)}: ${cueTimes.length} cues   ` +
    `${path.basename(OUT_PREVIEW)}: ${mb(fs.statSync(OUT_PREVIEW).size)}`,
);
console.log('─'.repeat(66));

if (problems.length) {
  console.error('\nVerification failed:');
  for (const problem of problems) console.error(`  ! ${problem}`);
  process.exitCode = 1;
} else {
  console.log('Verification passed: streams, duration, captions and artifacts all check out.');
}
