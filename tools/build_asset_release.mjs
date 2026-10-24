// Build the shippable asset set from local-assets/ into asset-release/ (its own git repo,
// kept out of this one): lowres/ is what the game loads by default, hires/ the texture pack.
// Only what the game fetches is copied (no disc image, no 7z dump, no pages for people).
//   - audio: the songs and voices (SONG01/VOICE01, ~150 MB of WAV) become Opus (.ogg) and
//     AAC (.m4a, for browsers without Ogg Opus); their manifest records get `opus` / `aac`.
//     The sound-effect samples stay WAV: their loops are a few hundred samples long.
//   - hires: the texture pack (local-assets/texture_pack, tools/match_texture_pack.py and
//     shrink_texture_pack.py) for ?hires=1: the models' textures as KTX2 (Basis Universal
//     ETC1S, tools/ktx2_texture_pack.py; ~5x fewer bytes than the pack's JPEGs, and GPU-
//     compressed), their small WebPs (the traffic cars' paints are baked from those in the
//     browser), the menu / HUD sprites and destination pictures as the pack has them, and
//     three's Basis transcoder (basis/) for KTX2Loader.
//   - brotli: every .glb/.json/.BIN/.svg/.wav gets a <name>.br next to it (quality 11), which
//     vite.config.js's middleware serves with Content-Encoding: br. This is the meshes' shrink:
//     meshopt without quantizing (the geometry must stay exact) makes the glTF larger once
//     Brotli'd (BINC1's BIN: 2.13 MB Brotli alone, 3.04 MB meshopt + Brotli), so it is not used.
// Usage: node tools/build_asset_release.mjs [--only audio,...]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { cpus } from 'node:os';
import { brotliCompress, constants } from 'node:zlib';

const run = promisify(execFile);
const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
const SRC = join(ROOT, 'local-assets');
const OUT = join(ROOT, 'asset-release');
const LOW = join(OUT, 'lowres');
const HIGH = join(OUT, 'hires');
const PACK = join(SRC, 'texture_pack');
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
    else if (keep(a)) { mkdirSync(to, { recursive: true }); copyFileSync(a, b); }   // follows the pack's symlinks
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

async function hiresStage() {
  const manifest = JSON.parse(readFileSync(join(PACK, 'manifest.json'), 'utf8'));
  for (const t of manifest.textures) {
    // the models' textures: KTX2, else (the cars' paints, ?hires=N above the WebPs) the WebP
    if (!t.link || !t.png.startsWith('textures/') || !t.small) continue;
    t.link = t.small;
    t.pack_width = t.small_width;
    t.pack_height = t.small_height;
  }
  mkdirSync(HIGH, { recursive: true });
  writeFileSync(join(HIGH, 'manifest.json'), JSON.stringify(manifest, null, 1));
  for (const d of ['small', 'sprites', 'landmarks']) copyTree(join(PACK, d), join(HIGH, d));
  copyTree(join(ROOT, 'node_modules/three/examples/jsm/libs/basis'), join(HIGH, 'basis'), (p) => !p.endsWith('.md'));
  const { stdout } = await run('python3', [join(ROOT, 'tools/ktx2_texture_pack.py'), '--out', HIGH], { cwd: ROOT, maxBuffer: 1 << 24 });
  process.stdout.write(stdout);
}
const BROTLI = /\.(glb|json|BIN|svg|wav)$/;

async function brotliStage() {
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (BROTLI.test(n)) files.push(p);
    }
  };
  walk(LOW);
  if (existsSync(HIGH)) walk(HIGH);
  const squeeze = promisify(brotliCompress);
  let raw = 0, packed = 0;
  await pool(files, async (f) => {
    const data = readFileSync(f);
    const br = await squeeze(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
    writeFileSync(f + '.br', br);
    raw += data.length;
    packed += br.length;
  });
  console.log(`brotli: ${files.length} files, ${(raw / 1e6).toFixed(1)} -> ${(packed / 1e6).toFixed(1)} MB over the wire`);
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
if (stage('hires')) await hiresStage();
if (stage('brotli')) await brotliStage();
for (const d of readdirSync(OUT)) {
  if (statSync(join(OUT, d)).isDirectory() && !d.startsWith('.')) console.log(`${relative(ROOT, join(OUT, d))}: ${(size(join(OUT, d)) / 1e6).toFixed(1)} MB`);
}
