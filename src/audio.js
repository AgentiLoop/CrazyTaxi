// The game's sound, played from what its code requests (src/dc-car.js captures the
// calls the Dreamcast's sound driver would get) with Web Audio over the WAVs
// tools/extract_audio.py wrote into local-assets/audio/ (its manifest describes them).
//
// Three sources, as on the Dreamcast:
// - Sound effects: Sound_Request(word, channel) queues a driver request; the word's
//   bytes are 0xA9, the request id's low byte and the sequence index (the driver sees
//   0xA9iiss00). The manifest's `requests` give each sequence's events: note-ons
//   (playback definition -> sample and rate, velocity) and note-offs. The packs
//   (SNDDCn.BIN) the game loads: 0, 1, 8 at boot, the city's (6 Arcade, 7 Original,
//   5 Crazy Box) and the cab's (3 for cabs 0-3, 2 for the others); request ids are
//   unique across packs. A sample whose loop spans more than a few samples really
//   loops until its note-off (horns, the train, skids); the 28-sample loops at the
//   end of one-shots are the AICA's held tail and play once.
// - The cab's engine and tyres: nlsndIcsControl(slot, command, value) - 0xA5 assigns
//   a program (value = bank << 8 | program; bank 4 = SNDDC3, 3 = SNDDC2, 1 = SNDDC1,
//   the header's word 4), 0x10A5 sets the slot's volume (0-127), 0xA6 the key
//   (0 = off). A program's splits (key ranges) each play their sample looped at the
//   pitch of the split's curve: pitch = base + (slope * (key - segment start) >> 8),
//   rate = 44100 * 2 ^ (pitch / 384 - 8) (the driver's register 0x5FB0). exec_CarSound
//   drives slot 0 (engine: key from the rpm) and slots 1, 2 (the tyres).
// - Streams: the voices (VOICE01.AFS, file n = VOICE01/nnnn.wav) on four channels
//   through Voice_ExecuteChannel's adxStartAfs2 / volume / pan / status / play time /
//   stop, and the songs (SONG01.AFS) through gdc_PlayStreamSongDisk's adxStartAfs1,
//   gdc_StopStreamSongAll, gdc_GetStreamSongRemainTime (frames left; 0x58764 while
//   not playing) and ADXT_SetOutVol (tenths of a decibel; -999 = silence).
//
// Browsers only start audio after a gesture: start() (on the first key or click)
// resumes the context; a song cued before that starts then, from where it would be.

const BANKS = { 0: 'SNDDC0.BIN', 1: 'SNDDC1.BIN', 3: 'SNDDC2.BIN', 4: 'SNDDC3.BIN' };
const NOT_PLAYING = 0x58764;
const LOOP_MIN = 100;   // samples: shorter loops are a one-shot's held tail

export class GameAudio {
  constructor(assets) {
    this.assets = assets;
    this.ctx = null;
    this.master = null;
    this.buffers = new Map();     // wav path -> Promise<AudioBuffer>
    this.requests = new Map();    // "0xA9iiss00" -> { pack, sequence }
    this.packs = new Map();       // "SNDDCn.BIN" -> manifest record
    this.held = new Map();        // "pack/playback" -> looping source
    this.voices = [null, null, null, null];   // { source, gain, start, file }
    this.voiceLevel = [75, 75, 75, 75];
    this.song = null;             // { file, start (ctx time), buffer, source, gain, db, cued }
    this.ics = [0, 1, 2, 3].map(() => ({ bank: -1, program: -1, volume: 127, key: 0, gain: null, splits: new Map() }));
    this.started = false;
  }

  async load() {
    const r = await fetch(`${this.assets}audio/manifest.json`);
    if (!r.ok) throw new Error(`audio/manifest.json: HTTP ${r.status}`);
    const manifest = await r.json();
    for (const f of manifest.files) {
      this.packs.set(f.source, f);
      for (const group of f.requests || []) {
        for (const sequence of group.sequences) this.requests.set(sequence.request, { pack: f, sequence });
      }
    }
    this.songs = this.packs.get('SONG01.AFS').sounds;
    this.voiceFiles = this.packs.get('VOICE01.AFS').sounds;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    for (const slot of this.ics) { slot.gain = this.ctx.createGain(); slot.gain.connect(this.master); }
  }

  /** The first user gesture: run the context; a song cued meanwhile starts at its position. */
  start() {
    if (!this.ctx || this.started) return;
    this.started = true;
    this.ctx.resume();
    if (this.song && this.song.cued) this.playSong(this.song.file, this.song.cuedFrames / 60);
  }

  // Not ctx.state === 'running': resume() only flips the state later, and the START that
  // ends the title asks for the menu loop and the voice in the same frame as the gesture.
  // Sources started on a resuming context play once it runs.
  get running() { return this.started && this.ctx && this.ctx.state !== 'closed'; }

  /** A new run (gameState0): everything stops. */
  reset() {
    if (!this.ctx) return;
    for (const token of this.held.values()) this.release(token, 0.02);
    this.held.clear();
    this.voiceStopAll();
    this.songStop();
    for (const slot of this.ics) this.icsKey(slot, 0);
  }

  buffer(path) {
    let p = this.buffers.get(path);
    if (!p) {
      p = fetch(`${this.assets}audio/${path}`).then((r) => {
        if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
        return r.arrayBuffer();
      }).then((bytes) => this.ctx.decodeAudioData(bytes));
      this.buffers.set(path, p);
    }
    return p;
  }

  // --- sound effects ---

  /** Sound_Request's word. */
  sound(word) {
    if (!this.running) return;
    const key = requestKey(word);
    const hit = this.requests.get(key);
    if (!hit) return;
    for (const e of hit.sequence.events || []) {
      if (e.kind === 'note_on') this.noteOn(hit.pack, e.playback, e.velocity);
      else if (e.kind === 'note_off') this.noteOff(hit.pack, e.playback);
    }
  }

  noteOn(pack, playbackIndex, velocity) {
    const playback = pack.playbacks[playbackIndex];
    const sample = pack.sounds[playback.sample];
    const id = `${pack.source}/${playbackIndex}`;
    this.noteOff(pack, playbackIndex);
    const loops = sample.loop && sample.loop_end - sample.loop_start > LOOP_MIN;
    const gain = this.ctx.createGain();
    gain.gain.value = velocity / 127;
    gain.connect(this.master);
    const token = { source: null, gain, stopped: false };
    if (loops) this.held.set(id, token);
    this.buffer(sample.wav).then((buffer) => {
      if (token.stopped) return;
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = playback.rate / sample.rate;
      if (loops) {
        source.loop = true;
        source.loopStart = sample.loop_start / sample.rate;
        source.loopEnd = sample.loop_end / sample.rate;
      }
      source.connect(gain);
      source.start();
      token.source = source;
      if (!loops) source.onended = () => gain.disconnect();
    });
  }

  noteOff(pack, playbackIndex) {
    const id = `${pack.source}/${playbackIndex}`;
    const token = this.held.get(id);
    if (!token) return;
    this.held.delete(id);
    this.release(token, 0.05);
  }

  release(token, seconds) {
    token.stopped = true;
    const t = this.ctx.currentTime;
    token.gain.gain.setValueAtTime(token.gain.gain.value, t);
    token.gain.gain.linearRampToValueAtTime(0, t + seconds);
    if (token.source) token.source.stop(t + seconds);
    setTimeout(() => token.gain.disconnect(), seconds * 1000 + 50);
  }

  // --- the cab's interactive sounds (nlsndIcsControl) ---

  icsControl(slotIndex, command, value) {
    const slot = this.ics[slotIndex & 3];
    if (!slot) return;
    if (command === 0xA5) {
      slot.bank = value >> 8 & 0x7F; slot.program = value & 0x7F;
      this.icsKey(slot, 0);
    } else if (command === 0x10A5) {
      slot.volume = value & 0x7F;
      if (slot.gain) slot.gain.gain.value = slot.volume / 127;
    } else if (command === 0xA6) {
      this.icsKey(slot, value & 0x7F);
    }
  }

  icsKey(slot, key) {
    slot.key = key;
    if (!this.running) key = 0;
    const pack = this.packs.get(BANKS[slot.bank]);
    const program = pack && pack.instruments[slot.program];
    const want = new Set();
    if (program && key) {
      for (const split of program.splits) {
        if (key < split.keys[0] || key > split.keys[1]) continue;
        want.add(split.id);
        const rate = splitRate(split, key);
        let voice = slot.splits.get(split.id);
        if (!voice) {
          voice = { source: null, gain: this.ctx.createGain(), rate, stopped: false };
          voice.gain.connect(slot.gain);
          slot.splits.set(split.id, voice);
          const sample = pack.sounds[split.sample];
          this.buffer(sample.wav).then((buffer) => {
            if (voice.stopped) return;
            const source = this.ctx.createBufferSource();
            source.buffer = buffer;
            source.loop = true;
            source.loopStart = sample.loop_start / sample.rate;
            source.loopEnd = sample.loop_end / sample.rate;
            source.playbackRate.value = voice.rate / sample.rate;
            source.connect(voice.gain);
            source.start();
            voice.source = source;
            voice.sampleRate = sample.rate;
          });
        } else {
          voice.rate = rate;
          if (voice.source) voice.source.playbackRate.setTargetAtTime(rate / voice.sampleRate, this.ctx.currentTime, 0.02);
        }
      }
    }
    for (const [id, voice] of slot.splits) {
      if (want.has(id)) continue;
      slot.splits.delete(id);
      this.release(voice, 0.08);
    }
  }

  // --- the voices (ADX streams, partition 2) ---

  voiceStart(ch, file) {
    this.voiceStop(ch);
    const sound = this.voiceFiles[file];
    if (!sound || !this.running) return;
    const gain = this.ctx.createGain();
    gain.gain.value = this.voiceLevel[ch] / 127;
    gain.connect(this.master);
    const v = { source: null, gain, start: this.ctx.currentTime, duration: sound.samples / sound.rate, file, stopped: false };
    this.voices[ch] = v;
    this.buffer(sound.wav).then((buffer) => {
      if (v.stopped) return;
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start();
      v.source = source;
      v.start = this.ctx.currentTime;
      source.onended = () => { v.stopped = true; gain.disconnect(); };
    });
  }

  voiceVolume(ch, level) {
    this.voiceLevel[ch] = Math.max(0, level);
    const v = this.voices[ch];
    if (v && !v.stopped) v.gain.gain.value = this.voiceLevel[ch] / 127;
  }

  /** 1 while the channel plays (gdc_GetStreamVoiceStat2). */
  voicePlaying(ch) {
    const v = this.voices[ch];
    return v && !v.stopped ? 1 : 0;
  }

  /** Frames played so far (gdc_GetStreamVoicePlayTime). */
  voicePlayTime(ch) {
    const v = this.voices[ch];
    return v && !v.stopped ? Math.floor((this.ctx.currentTime - v.start) * 60) : 0;
  }

  voiceStop(ch) {
    const v = this.voices[ch];
    if (!v) return;
    this.voices[ch] = null;
    if (!v.stopped) this.release(v, 0.02);
  }

  voiceStopAll() { for (let ch = 0; ch < 4; ch++) this.voiceStop(ch); }

  // --- the songs (ADX streams, partition 1) ---

  songStart(file) {
    this.songStop();
    if (!this.running) {
      this.song = { file, cued: true, cuedFrames: 0, db: 0 };
      return;
    }
    this.playSong(file, 0);
  }

  playSong(file, offset) {
    const sound = this.songs[file];
    if (!sound) return;
    const gain = this.ctx.createGain();
    gain.connect(this.master);
    const s = { file, gain, source: null, cued: false, start: this.ctx.currentTime - offset, duration: sound.samples / sound.rate, db: this.song ? this.song.db : 0, stopped: false };
    gain.gain.value = dbGain(s.db);
    this.song = s;
    this.buffer(sound.wav).then((buffer) => {
      if (s.stopped) return;
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      // An ADX with a loop (SONG01 0, the menu loop, and 8) plays on until it is stopped.
      if (sound.loop) {
        source.loop = true;
        source.loopStart = sound.loop.start_sample / sound.rate;
        source.loopEnd = sound.loop.end_sample / sound.rate;
      }
      source.connect(gain);
      const at = Math.min(offset, Math.max(0, buffer.duration - 0.01));
      source.start(0, at);
      s.source = source;
      s.start = this.ctx.currentTime - at;
      source.onended = () => { s.stopped = true; gain.disconnect(); };
    });
  }

  songStop() {
    const s = this.song;
    this.song = null;
    if (s && !s.cued && !s.stopped) this.release(s, 0.02);
  }

  /** Frames left (gdc_GetStreamSongRemainTime); NOT_PLAYING before the stream runs. */
  songRemain() {
    const s = this.song;
    if (!s) return NOT_PLAYING;
    if (s.cued) { s.cuedFrames++; return NOT_PLAYING; }
    if (s.stopped) return 0;
    return Math.max(0, Math.floor((s.duration - (this.ctx.currentTime - s.start)) * 60));
  }

  /** ADXT_SetOutVol on the song's handle: tenths of a decibel (-999 silence). */
  songVolume(db) {
    const s = this.song;
    if (!s) return;
    s.db = db;
    if (s.gain) s.gain.gain.setTargetAtTime(dbGain(db), this.ctx.currentTime, 0.01);
  }
}

/** Sound_Request's word (0x00ssiiA9) as the manifest names the request (0xA9iiss00). */
export function requestKey(word) {
  const v = ((word & 0xFF) << 24 | (word >> 8 & 0xFF) << 16 | (word >> 16 & 0xFF) << 8) >>> 0;
  return `0x${v.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** A split's sample rate at a key: the pitch curve (group 4), then the driver's register. */
export function splitRate(split, key) {
  let start = split.keys[0], point = split.pitch_points[split.pitch_points.length - 1];
  for (const p of split.pitch_points) {
    if (key <= p.last_key) { point = p; break; }
    start = p.last_key + 1;
  }
  const pitch = point.base + ((point.slope * (key - start)) >> 8);
  return 44100 * 2 ** (pitch / 384 - 8);
}

export function dbGain(db) {
  return db <= -999 ? 0 : 10 ** (db / 200);
}
