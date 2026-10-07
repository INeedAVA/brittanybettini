"""Strip the music from the v2 reels, keeping the transition sound effects (and the natural room sound
in Reels 2 and 3) at exactly the level they had in the music mix. Video is copied untouched."""
import sys, subprocess, re, numpy as np
from scipy.io import wavfile
sys.argv = [sys.argv[0], "/tmp/unused"] + sys.argv[1:]
import reels2, music2
from engine import S, TMP

OUT = f"{S}/out3"; import os; os.makedirs(OUT, exist_ok=True)
SR = music2.SR
captured = {}


def capture(prefix, edl, which, bpm, bars, extra_sfx, overlays, out, amb):
    captured[which] = dict(edl=edl, extra=extra_sfx, out=out, amb=amb, total=round(sum(e["L"] for e in edl), 3))
    return 0
reels2.build = capture


for which, fn in (("reel1", reels2.reel1), ("reel2", reels2.reel2), ("reel3", reels2.reel3)):
    fn(); c = captured[which]
    events = reels2.sfx_events(c["edl"], c["extra"])
    music = np.load(f"{S}/m2/{which}/{which}_music_only.npy")
    fx = music2.place_sfx(len(music), events) * 0.38 * (np.sqrt((music ** 2).mean()) / 0.05)
    a = music + fx; m = music.copy()
    if which != "reel1":                       # same 1.2 s fade the music master used
        k = int(1.2 * SR); ramp = np.linspace(1, 0, k)[:, None]; a[-k:] *= ramp; m[-k:] *= ramp
    f = 10 ** (-14 / 20) / np.sqrt((a ** 2).mean())
    y = np.tanh(a * f * 1.3) / np.tanh(1.3); P = 0.94 / np.abs(y).max()
    stem = (y - np.tanh(m * f * 1.3) / np.tanh(1.3)) * P          # the effects exactly as they sat in the master
    wavfile.write(f"{S}/m2/{which}/{which}_sfx.wav", SR, (np.clip(stem, -1, 1) * 32767).astype(np.int16))

    # the old final went through loudnorm to -14 LUFS; measure the gain it applied so levels stay identical
    base = f"{TMP}/{ {'reel1': 'r1_', 'reel2': 'r2_', 'reel3': 'r3_'}[which] }base.mp4"
    pre = subprocess.run(["ffmpeg", "-hide_banner", "-i", base, "-i", f"{S}/m2/{which}/{which}_music.wav", "-filter_complex",
                          f"[0:a]volume={c['amb']}[x];[x][1:a]amix=inputs=2:duration=longest:normalize=0,atrim=duration={c['total']},ebur128",
                          "-f", "null", "-"], capture_output=True, text=True).stderr
    L_pre = float(re.findall(r"I:\s+(-?[\d.]+) LUFS", pre)[-1]); G = -14 - L_pre
    src = f"{S}/out2/{os.path.basename(c['out'])}"
    newout = f"{OUT}/{os.path.basename(src).replace('.mp4', '_SFX-only.mp4')}"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-i", base, "-i", f"{S}/m2/{which}/{which}_sfx.wav", "-filter_complex",
                    f"[1:a]volume={c['amb']}[x];[x][2:a]amix=inputs=2:duration=longest:normalize=0,volume={G:.2f}dB,"
                    f"alimiter=limit=0.89:level=false,atrim=duration={c['total']}[a]",
                    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
                    "-t", str(c["total"]), "-movflags", "+faststart", newout], check=True)
    print(which, f"gain {G:.2f} dB, {len(events)} sfx events ->", newout)
