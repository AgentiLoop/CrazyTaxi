// Build the shippable asset set from local-assets/ into asset-release/ (its own git repo,
// kept out of this one): lowres/ is what the game loads by default, hires/ the texture pack.
// Only what the game fetches is copied (no disc image, no 7z dump, no pages for people).
//   - audio: the songs and voices (SONG01/VOICE01, ~150 MB of WAV) become Opus (.ogg) and
//     AAC (.m4a, for browsers without Ogg Opus); their manifest records get `opus` / `aac`.
//     The sound-effect samples stay WAV: their loops are a few hundred samples long.
// Usage: node tools/build_asset_release.mjs [--only audio,...]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { cpus } from 'node:os';

const run = promisify(execFile);
const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
const SRC = join(ROOT, 'local-assets');
const OUT = join(ROOT, 'asset-release');
const LOW = join(OUT, 'lowres');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const stage = (name) => !only || only.has(name);

// The directories the game fetches from (src/*.js) and the disc files it reads itself.
const DIRS = ['audio', 'characters', 'collision', 'courses', 'customers', 'fcv_motions', 'fonts',
  'landmarks', 'models', 'props', 'sprites', 'textures', 'vehicles'];
const DISC = ['1ST_READ.BIN', 'MOTDC.BIN', 'POLDC0.BIN', 'COLDC1.BIN', 'COLDC2.BIN', 'COLDC3.BIN',
  'SPLDC1.BIN', 'SPLDC2.BIN', 'SPLDC3.BIN', 'OBJDC1.BIN', 'OBJDC2.BIN', 'OBJDC3.BIN'];
const SKIP = (name) => name === '.DS_Store' || name.endsWith('.html');
const STREAMS = { 'SONG01.AFS': { opus: '112k', aac: '128k' }, 'VOICE01.AFS': { opus: '40k', aac: '48k' } };

async function pool(items, fn, n = cpus().length) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

function copyTree(from, to, keep = () => true) {
  for (const name of readdirSync(from)) {
    if (SKIP(name)) continue;
    const a = join(from, name), b = join(to, name);
    if (statSync(a).isDirectory()) copyTree(a, b, keep);
    else if (keep(a)) { mkdirSync(to, { recursive: true }); cpSync(a, b); }
  }
}

function copyStage() {
  for (const d of DIRS) {
    // the streams' WAVs are replaced by the audio stage
    copyTree(join(SRC, d), join(LOW, d), (p) => !/\/audio\/(SONG01|VOICE01)\//.test(p));
  }
  cpSync(join(SRC, 'crazy-taxi.svg'), join(LOW, 'crazy-taxi.svg'));   // the title's logo
  mkdirSync(join(LOW, 'disc'), { recursive: true });
  for (const f of DISC) cpSync(join(SRC, 'disc', f), join(LOW, 'disc', f));
}

async function audioStage() {
  const manifest = JSON.parse(readFileSync(join(SRC, 'audio/manifest.json'), 'utf8'));
  const jobs = [];
  for (const file of manifest.files) {
    const rate = STREAMS[file.source];
    if (!rate) continue;
    for (const s of file.sounds) {
      if (!s.wav) continue;
      s.opus = s.wav.replace(/\.wav$/, '.ogg');
      s.aac = s.wav.replace(/\.wav$/, '.m4a');
      jobs.push({ s, rate });
    }
  }
  let done = 0;
  await pool(jobs, async ({ s, rate }) => {
    const wav = join(SRC, 'audio', s.wav);
    mkdirSync(dirname(join(LOW, 'audio', s.opus)), { recursive: true });
    await run('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-c:a', 'libopus', '-b:a', rate.opus, '-vbr', 'on', join(LOW, 'audio', s.opus)]);
    await run('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-c:a', 'aac_at', '-b:a', rate.aac, join(LOW, 'audio', s.aac)]);
    if (++done % 100 === 0) console.log(`audio ${done}/${jobs.length}`);
  });
  writeFileSync(join(LOW, 'audio/manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(`audio: ${jobs.length} streams -> Opus + AAC`);
}

function size(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), st = statSync(p);
    n += st.isDirectory() ? size(p) : st.size;
  }
  return n;
}

mkdirSync(LOW, { recursive: true });
if (stage('copy')) copyStage();
if (stage('audio')) await audioStage();
for (const d of readdirSync(OUT)) {
  if (statSync(join(OUT, d)).isDirectory() && !d.startsWith('.')) console.log(`${relative(ROOT, join(OUT, d))}: ${(size(join(OUT, d)) / 1e6).toFixed(1)} MB`);
}
