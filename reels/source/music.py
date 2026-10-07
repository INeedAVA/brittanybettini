"""Compose original royalty-free beds for the three Crown & Clover reels.
MIDI (mido) -> FluidSynth (FluidR3_GM) per stem -> numpy mix with sidechain/fades."""
import subprocess, sys, os
import numpy as np, mido
from scipy.io import wavfile
from scipy.signal import fftconvolve

OUT = sys.argv[1]
SF = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
SR = 48000
TPB = 480
os.makedirs(OUT, exist_ok=True)


def midi_file(path, bpm, tracks):
    """tracks: list of (channel, program, bank, notes) where notes = [(beat, dur_beats, pitch, vel)]"""
    mf = mido.MidiFile(ticks_per_beat=TPB)
    meta = mido.MidiTrack(); mf.tracks.append(meta)
    meta.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(bpm)))
    for ch, prog, bank, notes in tracks:
        tr = mido.MidiTrack(); mf.tracks.append(tr)
        tr.append(mido.Message('control_change', channel=ch, control=0, value=0 if bank == 128 else bank))
        tr.append(mido.Message('program_change', channel=ch, program=prog))
        tr.append(mido.Message('control_change', channel=ch, control=91, value=30))
        ev = []
        for b, d, p, v in notes:
            ev.append((int(b * TPB), 1, p, v)); ev.append((int((b + d) * TPB), 0, p, 0))
        ev.sort(key=lambda e: (e[0], e[1]))
        t = 0
        for tick, on, p, v in ev:
            tr.append(mido.Message('note_on' if on else 'note_off', channel=ch, note=p, velocity=v, time=tick - t)); t = tick
    mf.save(path)


def render(name, bpm, tracks):
    mid = f"{OUT}/{name}.mid"; wav = f"{OUT}/{name}.wav"
    midi_file(mid, bpm, tracks)
    subprocess.run(["fluidsynth", "-ni", "-g", "0.8", "-r", str(SR), "-F", wav, SF, mid], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sr, a = wavfile.read(wav)
    return a.astype(np.float32) / 32768.0


def fit(a, n):
    if len(a) >= n: return a[:n]
    return np.vstack([a, np.zeros((n - len(a), 2), np.float32)])


def reverb(a, secs=1.8, mix=0.18, seed=1):
    rng = np.random.default_rng(seed)
    n = int(secs * SR); t = np.arange(n) / SR
    ir = rng.standard_normal((n, 2)).astype(np.float32) * np.exp(-t * 6.9 / secs)[:, None]
    ir /= np.sqrt((ir ** 2).sum(0))
    wet = np.stack([fftconvolve(a[:, c], ir[:, c])[:len(a)] for c in range(2)], 1)
    return a * (1 - mix) + wet * mix


def master(a, path, fade_in=0.0, fade_out=0.0, target=-14.0):
    n = len(a)
    if fade_in: k = int(fade_in * SR); a[:k] *= np.linspace(0, 1, k)[:, None]
    if fade_out: k = int(fade_out * SR); a[-k:] *= np.linspace(1, 0, k)[:, None]
    # gentle soft-clip limiter, then RMS normalise
    rms = np.sqrt((a ** 2).mean()); a = a * (10 ** (target / 20) / max(rms, 1e-9))
    a = np.tanh(a * 1.2) / np.tanh(1.2)
    a *= 0.95 / max(np.abs(a).max(), 1e-9)
    wavfile.write(path, SR, (a * 32767).astype(np.int16))


def sidechain(a, bpm, beats, depth=0.55, rel=0.22):
    env = np.ones(len(a), np.float32); spb = 60 / bpm
    k = int(rel * SR); curve = 1 - depth * np.exp(-np.linspace(0, 5, k))
    for b in beats:
        s = int(b * spb * SR)
        if s < len(a): env[s:s + k] = np.minimum(env[s:s + k], curve[:len(env[s:s + k])])
    return a * env[:, None]


# ---------------- Reel 1: afro / deep house vamp, 120 BPM, 5 bars = 10.0 s, loops seamlessly ----------
def reel1():
    bpm, bars = 120, 6
    dr, bass, keys, perc, pad = [], [], [], [], []
    for bar in range(bars):
        o = bar * 4
        for q in range(4):
            dr.append((o + q, .25, 36, 118))                       # four-on-the-floor kick
            dr.append((o + q + .5, .25, 46, 108))                   # open hat on the off-beat
        for q in (1, 3): dr.append((o + q, .25, 39, 96))          # claps on 2 and 4
        for s in range(16):
            dr.append((o + s * .25, .1, 42, 105 if s % 2 else 72))  # closed hats
            perc.append((o + s * .25, .1, 70, 96 if s % 4 == 2 else 64))  # shaker
        for b, p, v in ((.75, 63, 70), (1.5, 64, 62), (2.75, 62, 72), (3.5, 63, 60)):
            perc.append((o + b, .2, p, v))                         # congas, afro-house bounce
        for b, d, p in ((0, .5, 45), (.75, .25, 45), (1.5, .5, 52), (2.5, .25, 48), (2.75, .5, 50), (3.5, .25, 43)):
            bass.append((o + b, d, p, 104))                        # syncopated bass, A minor
        chord = [57, 60, 64, 67, 71]                               # Am9
        pad.append((o, 4, 45 + 12, 70)); pad.append((o, 4, 64, 60)); pad.append((o, 4, 71, 55))
        for b in (.5, 1.75, 2.5, 3.25):
            for p in chord: keys.append((o + b, .3, p, 78))
    n = int(10.0 * SR)
    d = fit(render("r1_drums", bpm, [(9, 0, 128, dr)]), n)
    pc = fit(render("r1_perc", bpm, [(9, 0, 128, perc)]), n)
    bs = fit(render("r1_bass", bpm, [(0, 38, 0, bass)]), n)
    ky = fit(render("r1_keys", bpm, [(1, 4, 0, keys)]), n)
    pd = fit(render("r1_pad", bpm, [(2, 89, 0, pad)]), n)
    kick_beats = [i for i in range(bars * 4)]
    pd = sidechain(reverb(pd, 2.0, .3), bpm, kick_beats, .7, .35)
    bs = sidechain(bs, bpm, kick_beats, .5); ky = sidechain(reverb(ky, 1.2, .25), bpm, kick_beats, .6)
    mix = d * 1.0 + pc * .9 + bs * 1.1 + ky * .75 + pd * .45
    master(mix, f"{OUT}/reel1_music.wav", target=-13)


# ---------------- Reel 2: late-night jazz Rhodes, 72 BPM, 8 bars + tail -----------------------------------
def reel2():
    bpm, bars = 72, 8
    prog = [  # (bass root, voicing)
        (38, [54, 57, 61, 64, 69]),  # Dmaj9
        (35, [50, 54, 57, 61, 64]),  # Bm11-ish
        (43, [54, 59, 62, 66, 69]),  # Gmaj9
        (33, [55, 59, 61, 66, 67]),  # A13sus
    ]
    rh, bs, dr = [], [], []
    for bar in range(bars):
        o = bar * 4; root, v = prog[bar % 4]
        last = bar == bars - 1
        if last: root, v = 38, [54, 57, 61, 64, 69, 73]
        for i, p in enumerate(v): rh.append((o + i * .04, 3.8 if not last else 7.5, p, 64))  # rolled chord
        if not last:
            for i, p in enumerate(v[2:]): rh.append((o + 2.5 + i * .03, 1.3, p + 12 if i == 2 else p, 44))
        bs.append((o, 2, root, 90)); bs.append((o + 2, 2 if not last else 6, root + (7 if not last else 0), 80))
        if bar >= 1 and not last:
            for q in range(4):
                dr.append((o + q, .5, 51, 46 if q % 2 else 54))        # soft ride
                dr.append((o + q + .66, .3, 51, 30))                   # swung skip note
            dr.append((o + 1, .5, 37, 38)); dr.append((o + 3, .5, 37, 42))  # side-stick
    n = int((bars * 4 * 60 / bpm + 2.5) * SR)
    r = fit(render("r2_rhodes", bpm, [(0, 4, 0, rh)]), n)
    b = fit(render("r2_bass", bpm, [(1, 32, 0, bs)]), n)
    d = fit(render("r2_drums", bpm, [(9, 40, 128, dr)]), n)
    mix = reverb(r, 2.4, .3) * 1.0 + b * .9 + reverb(d, 1.5, .2) * .5
    master(mix, f"{OUT}/reel2_music.wav", fade_in=0.15, fade_out=2.0, target=-17)


# ---------------- Reel 3: warm acoustic bed, 96 BPM, 12 bars = 30 s ---------------------------------------
def reel3():
    bpm, bars = 96, 12
    chords = [(48, [60, 64, 67, 71]), (45, [57, 60, 64, 67]), (41, [57, 60, 65, 69]), (43, [55, 59, 62, 64])]
    gt, bs, dr, pn = [], [], [], []
    for bar in range(bars):
        o = bar * 4; root, v = chords[bar % 4]; last = bar == bars - 1
        if last: root, v = 48, [60, 64, 67, 71, 74]
        pat = [root + 12, v[1], v[2], v[3], v[2], v[1], v[3], v[2]]
        if last: pat = [root + 12, v[1], v[2], v[3], v[4]]
        for i, p in enumerate(pat): gt.append((o + i * .5, 1.2 if not last else 4, p, 70 if i % 2 == 0 else 56))
        bs.append((o, 1.5, root - 12 + 12, 86)); bs.append((o + 1.5, .5, root, 70)); bs.append((o + 2, 2, root + 7 - 12 + 12, 78))
        if 1 <= bar < bars - 1:
            dr += [(o, .25, 36, 74), (o + 2, .25, 36, 66), (o + 2.5, .25, 36, 50), (o + 1, .25, 37, 56), (o + 3, .25, 37, 60)]
            for s in range(8): dr.append((o + s * .5, .1, 70, 48 if s % 2 else 30))
        if bar >= 4 and not last:
            pn.append((o + 3.5, .5, v[-1] + 12, 40))  # sparse piano sparkle
    n = int((bars * 4 * 60 / bpm + 1.5) * SR)
    g = fit(render("r3_gtr", bpm, [(0, 24, 0, gt)]), n)
    b = fit(render("r3_bass", bpm, [(1, 33, 0, bs)]), n)
    d = fit(render("r3_drums", bpm, [(9, 0, 128, dr)]), n)
    p = fit(render("r3_pno", bpm, [(2, 0, 0, pn)]), n)
    mix = reverb(g, 1.4, .18) * 1.0 + b * .8 + d * .55 + reverb(p, 2.0, .35) * .6
    master(mix, f"{OUT}/reel3_music.wav", fade_in=0.05, fade_out=1.5, target=-17)


for name in (sys.argv[2:] or ["reel1", "reel2", "reel3"]):
    globals()[name]()
    print("done", name)
