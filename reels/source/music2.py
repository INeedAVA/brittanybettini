"""Upbeat original music + transition sound design for the Crown & Clover reels (v2).
usage: python3 music2.py OUTDIR reel1|reel2|reel3 BPM BARS [sfx-json]
sfx-json: list of [time_s, kind] with kind in whoosh|impact|riser|swish."""
import subprocess, sys, os, json
import numpy as np, mido
from scipy.io import wavfile
from scipy.signal import fftconvolve, butter, sosfilt

SF = "/usr/share/sounds/sf2/FluidR3_GM.sf2"; SR = 48000; TPB = 480


def midi_file(path, bpm, tracks):
    mf = mido.MidiFile(ticks_per_beat=TPB); meta = mido.MidiTrack(); mf.tracks.append(meta)
    meta.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(bpm)))
    for ch, prog, notes in tracks:
        tr = mido.MidiTrack(); mf.tracks.append(tr)
        tr.append(mido.Message('program_change', channel=ch, program=prog))
        tr.append(mido.Message('control_change', channel=ch, control=91, value=20))
        ev = []
        for b, d, p, v in notes:
            ev.append((int(b * TPB), 1, p, min(127, v))); ev.append((int((b + d) * TPB), 0, p, 0))
        ev.sort(key=lambda e: (e[0], e[1])); t = 0
        for tick, on, p, v in ev:
            tr.append(mido.Message('note_on' if on else 'note_off', channel=ch, note=p, velocity=v, time=tick - t)); t = tick
    mf.save(path)


def render(out, name, bpm, tracks, n):
    mid, wav = f"{out}/{name}.mid", f"{out}/{name}.wav"
    midi_file(mid, bpm, tracks)
    subprocess.run(["fluidsynth", "-ni", "-g", "0.8", "-r", str(SR), "-F", wav, SF, mid], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    a = wavfile.read(wav)[1].astype(np.float32) / 32768.0
    return a[:n] if len(a) >= n else np.vstack([a, np.zeros((n - len(a), 2), np.float32)])


def reverb(a, secs=1.5, mix=0.2, seed=1):
    rng = np.random.default_rng(seed); n = int(secs * SR); t = np.arange(n) / SR
    ir = rng.standard_normal((n, 2)).astype(np.float32) * np.exp(-t * 6.9 / secs)[:, None]; ir /= np.sqrt((ir ** 2).sum(0))
    wet = np.stack([fftconvolve(a[:, c], ir[:, c])[:len(a)] for c in range(2)], 1)
    return a * (1 - mix) + wet * mix


def sidechain(a, bpm, beats, depth=0.5, rel=0.2):
    env = np.ones(len(a), np.float32); k = int(rel * SR); curve = 1 - depth * np.exp(-np.linspace(0, 5, k))
    for b in beats:
        s = int(b * 60 / bpm * SR); seg = env[s:s + k]; env[s:s + k] = np.minimum(seg, curve[:len(seg)])
    return a * env[:, None]


def hp(a, f):
    sos = butter(2, f, 'hp', fs=SR, output='sos'); return np.stack([sosfilt(sos, a[:, c]) for c in range(2)], 1).astype(np.float32)


# ---------------- transition sound design ----------------
def sfx(kind, rng):
    if kind in ("whoosh", "swish"):
        d = .45 if kind == "whoosh" else .28; n = int(d * SR); t = np.linspace(0, 1, n)
        noise = rng.standard_normal(n).astype(np.float32); out = np.zeros(n, np.float32)
        # sweep a band-pass up then down by filtering in short blocks
        blk = 512
        for i in range(0, n, blk):
            x = t[i]; fc = 300 + 5200 * np.sin(np.pi * x) ** 2
            sos = butter(2, [fc * .7, min(fc * 1.4, 20000)], 'bp', fs=SR, output='sos')
            out[i:i + blk] = sosfilt(sos, noise[i:i + blk])
        env = np.sin(np.pi * t) ** 1.5; s = out * env
        pan = np.linspace(-.8, .8, n)  # moves across the stereo field like the camera
        return np.stack([s * (1 - pan) / 2 * 2, s * (1 + pan) / 2 * 2], 1) * (0.55 if kind == "whoosh" else .4)
    if kind == "impact":
        n = int(.9 * SR); t = np.arange(n) / SR
        boom = np.sin(2 * np.pi * (55 * t + 40 * (1 - np.exp(-t * 18)) / 18)) * np.exp(-t * 5)
        click = rng.standard_normal(n) * np.exp(-t * 60) * .3
        s = (boom + click).astype(np.float32) * .9; return np.stack([s, s], 1)
    if kind == "riser":
        n = int(1.6 * SR); t = np.linspace(0, 1, n); noise = rng.standard_normal(n).astype(np.float32)
        out = np.zeros(n, np.float32); blk = 512
        for i in range(0, n, blk):
            fc = 400 + 7000 * t[i] ** 2; sos = butter(2, [fc * .8, min(fc * 1.3, 20000)], 'bp', fs=SR, output='sos')
            out[i:i + blk] = sosfilt(sos, noise[i:i + blk])
        s = out * t ** 2 * .5; return np.stack([s, s], 1)
    raise ValueError(kind)


def place_sfx(n, events):
    rng = np.random.default_rng(7); bus = np.zeros((n, 2), np.float32)
    for t0, kind in events:
        s = sfx(kind, rng)
        start = int(t0 * SR) - (len(s) // 2 if kind in ("whoosh", "swish") else (len(s) if kind == "riser" else 0))
        start = max(start, 0); end = min(n, start + len(s)); bus[start:end] += s[:end - start]
    return bus


def master(a, path, target=-14.0, fade_out=0.0):
    if fade_out: k = int(fade_out * SR); a[-k:] *= np.linspace(1, 0, k)[:, None]
    rms = np.sqrt((a ** 2).mean()); a = a * (10 ** (target / 20) / max(rms, 1e-9))
    a = np.tanh(a * 1.3) / np.tanh(1.3); a *= 0.94 / max(np.abs(a).max(), 1e-9)
    wavfile.write(path, SR, (a * 32767).astype(np.int16))


# ---------------- tracks ----------------
def piano_house(bpm, bars, out):
    """Reel 1: bright piano house. Bar 1 = piano + claps only (hook), full groove drops on bar 2."""
    dr, bass, pno, lead = [], [], [], []
    prog = [([57, 60, 64, 69, 72], 45), ([53, 57, 60, 65, 69], 41), ([55, 59, 62, 67, 71], 43), ([52, 55, 60, 64, 67], 40)]
    for bar in range(bars + 1):
        o = bar * 4; ch, root = prog[bar % 4]; full = bar >= 1
        for b in (0, .75, 1.5, 2.5, 3, 3.5):           # classic offbeat piano-house rhythm
            for p in ch: pno.append((o + b, .35, p, (92 if b in (0, 1.5, 3) else 78) + (0 if full else 22)))
        for q in (1, 3): dr.append((o + q, .25, 39, 110))
        if full:
            for q in range(4): dr.append((o + q, .25, 36, 122)); dr.append((o + q + .5, .25, 46, 100))
            for s in range(16): dr.append((o + s * .25, .1, 42, 96 if s % 2 else 66))
            for b, d, dp in ((0, .5, 0), (.5, .25, 12), (1, .5, 0), (1.5, .25, 12), (2, .5, 0), (2.5, .25, 12), (3, .5, 0), (3.5, .25, 12)):
                bass.append((o + b, d, root - 12 + dp, 108))   # octave-bouncing bass
            for b, p in ((0, ch[-1] + 12), (.75, ch[-2] + 12), (1.5, ch[-1] + 12), (2.5, ch[-3] + 12), (3, ch[-2] + 12)):
                lead.append((o + b, .3, p, 70))
        else:
            dr.append((o + 3.5, .5, 49, 70))                 # crash pickup into the drop
    n = int(bars * 4 * 60 / bpm * SR)
    d = render(out, "m_dr", bpm, [(9, 0, dr)], n); b = render(out, "m_bs", bpm, [(0, 38, bass)], n)
    p = render(out, "m_pn", bpm, [(1, 0, pno)], n); l = render(out, "m_ld", bpm, [(2, 80, lead)], n)
    beats = range(4, bars * 4)
    return d + sidechain(b, bpm, beats, .45) * 1.05 + sidechain(reverb(p, 1.2, .18), bpm, beats, .35) * .95 + reverb(l, 1.6, .3) * .28


def nu_disco(bpm, bars, out):
    """Reel 2: polished nu-disco. Strings, muted funk guitar, octave bass, Rhodes."""
    dr, bass, gtr, strg, rh = [], [], [], [], []
    prog = [([62, 65, 69, 72], 38), ([60, 64, 67, 71], 36), ([58, 62, 65, 69], 34), ([57, 60, 64, 67], 33)]   # Dm9 Cmaj7 Bbmaj7 Am7
    last_bar = bars - 1
    for bar in range(bars):
        o = bar * 4; ch, root = prog[bar % 4]
        if bar == last_bar:
            ch, root = [62, 65, 69, 72, 76], 38
            for p in ch: strg.append((o, 4, p, 70)); rh.append((o, 4, p, 60))
            bass.append((o, 2, root, 100)); dr.append((o, 1, 49, 90)); dr.append((o, .25, 36, 118)); continue
        for q in range(4):
            dr.append((o + q, .25, 36, 116)); dr.append((o + q + .5, .25, 46, 92))
        for q in (1, 3): dr.append((o + q, .25, 38, 92)); dr.append((o + q, .25, 39, 80))
        for s in range(16): dr.append((o + s * .25, .1, 42, 80 if s % 2 else 52)); dr.append((o + s * .25, .1, 70, 60 if s % 4 == 2 else 36))
        for e in range(8): bass.append((o + e * .5, .3, root - 12 + (12 if e % 2 else 0), 104))  # disco octaves
        for b in (.5, 1.25, 1.75, 2.5, 3.25, 3.75):
            for p in ch[1:]: gtr.append((o + b, .12, p + 12, 84))
        for p in ch: strg.append((o + (0 if bar % 2 == 0 else 2), 2, p + 12, 66))
        for b in (0, 2): rh.append((o + b, 1.5, ch[0], 56)); rh.append((o + b, 1.5, ch[2], 52))
    n = int(bars * 4 * 60 / bpm * SR + 2.5 * SR)
    d = render(out, "m_dr", bpm, [(9, 0, dr)], n); b = render(out, "m_bs", bpm, [(0, 38, bass)], n)
    g = render(out, "m_gt", bpm, [(1, 28, gtr)], n); s = render(out, "m_st", bpm, [(2, 48, strg)], n)
    r = render(out, "m_rh", bpm, [(3, 4, rh)], n)
    beats = range(0, bars * 4 - 4)
    return d + sidechain(b, bpm, beats, .4) + reverb(g, .9, .15) * .5 + sidechain(reverb(s, 2.0, .3), bpm, beats, .4) * .55 + reverb(r, 1.5, .25) * .5


def feelgood_pop(bpm, bars, out):
    """Reel 3: feel-good pop. Strummed guitar, claps, bass, glockenspiel hook."""
    dr, bass, gtr, glk = [], [], [], []
    prog = [([60, 64, 67, 72], 48), ([55, 59, 62, 67], 43), ([57, 60, 64, 69], 45), ([53, 57, 60, 65], 41)]  # C G Am F
    hook = [(0, 76), (.5, 79), (1, 81), (1.5, 79), (2.5, 76), (3, 74)]
    for bar in range(bars):
        o = bar * 4; ch, root = prog[bar % 4]; last = bar == bars - 1
        if last:
            for p in prog[0][0]: gtr.append((o, 4, p, 90))
            bass.append((o, 3, 36, 100)); dr.append((o, 1, 49, 90)); dr.append((o, .25, 36, 116)); continue
        for b in (0, .5, .75, 1.5, 2, 2.5, 2.75, 3.5):           # down/up strum pattern
            for k, p in enumerate(ch): gtr.append((o + b + k * .012, .4, p, 92 if b in (0, 2) else 72))
        for b in (0, 1.5, 2, 3.5 if bar % 2 else 2.75): dr.append((o + b, .25, 36, 112))
        for q in (1, 3): dr.append((o + q, .25, 39, 112)); dr.append((o + q, .25, 38, 78))
        for s in range(8): dr.append((o + s * .5, .1, 42, 82 if s % 2 else 60)); dr.append((o + s * .5 + .25, .1, 70, 50))
        for b, d in ((0, .75), (.75, .25), (1.5, .5), (2, .75), (2.75, .25), (3.5, .5)):
            bass.append((o + b, d, root - 12 if b != 2.75 else root - 5, 100))
        if bar >= 2:
            for b, p in hook: glk.append((o + b, .4, p + (0 if bar % 2 else 2), 74))
    n = int(bars * 4 * 60 / bpm * SR + 2 * SR)
    d = render(out, "m_dr", bpm, [(9, 0, dr)], n); b = render(out, "m_bs", bpm, [(0, 33, bass)], n)
    g = render(out, "m_gt", bpm, [(1, 25, gtr)], n); k = render(out, "m_gk", bpm, [(2, 9, glk)], n)
    return d + b * .95 + reverb(g, 1.0, .15) * .85 + reverb(k, 1.8, .3) * .35


if __name__ == "__main__":
    out, which, bpm, bars = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4])
    events = json.loads(sys.argv[5]) if len(sys.argv) > 5 else []
    os.makedirs(out, exist_ok=True)
    music = {"reel1": piano_house, "reel2": nu_disco, "reel3": feelgood_pop}[which](bpm, bars, out)
    music = hp(music, 30)
    fx = place_sfx(len(music), events)
    np.save(f"{out}/{which}_music_only.npy", music)
    master(music + fx * 0.38 * (np.sqrt((music ** 2).mean()) / 0.05), f"{out}/{which}_music.wav",
           target=-14, fade_out=1.2 if which != "reel1" else 0)
    print("ok", which, len(music) / SR)
