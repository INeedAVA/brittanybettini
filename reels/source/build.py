"""Crown & Clover reels: edit decision lists rendered with FFmpeg.
Text is set with Pillow (Gelasio = Georgia stand-in, Figtree = Aptos stand-in) and composited as PNG layers."""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

S = os.path.dirname(os.path.abspath(__file__))
A, F, M = f"{S}/assets", f"{S}/fonts", f"{S}/music"
OUT = sys.argv[1]
TMP = f"{S}/build"; os.makedirs(TMP, exist_ok=True); os.makedirs(OUT, exist_ok=True)
W, H, FPS = 1080, 1920, 30

BLACK, IVORY, GOLD, TAUPE = (11, 11, 11), (245, 241, 232), (194, 166, 107), (169, 157, 140)
GRADE = ("scale=1080:1920:flags=lanczos,setsar=1,"
         "eq=contrast=1.05:saturation=1.03:gamma=0.98,"
         "colorbalance=rs=0.015:bs=-0.02:rm=0.01:bm=-0.015,"
         "unsharp=5:5:0.35")


def font(name, size, wght=None):
    f = ImageFont.truetype(f"{F}/{name}.ttf", size)
    if wght:
        try: f.set_variation_by_axes([wght])
        except Exception: pass
    return f


def tracked(draw, xy, text, fnt, fill, tracking=0, anchor_center=True):
    """Draw text with letter-spacing, centred horizontally on xy[0]."""
    widths = [draw.textlength(ch, font=fnt) for ch in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x = xy[0] - total / 2 if anchor_center else xy[0]
    for ch, w in zip(text, widths):
        draw.text((x, xy[1]), ch, font=fnt, fill=fill)
        x += w + tracking
    return total


def layer(name, draw_fn, bg=None):
    im = Image.new("RGBA", (W, H), bg or (0, 0, 0, 0))
    draw_fn(im, ImageDraw.Draw(im))
    path = f"{TMP}/{name}.png"; im.save(path); return path


def shadowed(im, draw_text_fn, blur=10, alpha=150):
    """Soft shadow under text for legibility on bright footage, no hard outline."""
    sh = Image.new("RGBA", im.size, (0, 0, 0, 0))
    draw_text_fn(ImageDraw.Draw(sh), (0, 0, 0, alpha))
    im.alpha_composite(sh.filter(ImageFilter.GaussianBlur(blur)))
    draw_text_fn(ImageDraw.Draw(im), None)


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode: print(r.stderr[-3000:]); sys.exit(1)


def segment(i, clip, ss, dur, speed=1.0, extra="", vol=1.0, tag="seg"):
    """Cut one shot to an intermediate file: graded, 1080x1920, 30fps, with its natural sound."""
    out = f"{TMP}/{tag}{i:02d}.mp4"
    src_dur = dur * speed
    v = f"setpts=(PTS-STARTPTS)/{speed},{extra + ',' if extra else ''}{GRADE},fps={FPS},trim=duration={dur},setpts=PTS-STARTPTS"
    tempo = []
    sp = speed
    while sp > 2.0: tempo.append("atempo=2.0"); sp /= 2
    while sp < 0.5: tempo.append("atempo=0.5"); sp /= 0.5
    tempo.append(f"atempo={sp}")
    a = f"volume={vol},{','.join(tempo)},atrim=duration={dur},asetpts=PTS-STARTPTS,aresample=48000"
    run(["ffmpeg", "-v", "error", "-y", "-ss", str(ss), "-t", str(src_dur + 0.2), "-i", f"{A}/v_{clip}.mp4",
         "-filter_complex", f"[0:v]{v}[v];[0:a]{a},apad[a]", "-map", "[v]", "-map", "[a]", "-t", str(dur),
         "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", out])
    return out


def card(i, dur, png, tag):
    out = f"{TMP}/{tag}{i:02d}.mp4"
    run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-t", str(dur), "-i", png, "-f", "lavfi", "-t", str(dur),
         "-i", "anullsrc=r=48000:cl=stereo", "-vf", f"fps={FPS},format=yuv420p", "-c:v", "libx264", "-crf", "14",
         "-c:a", "pcm_s16le", "-shortest", out])
    return out


def concat(files, out):
    lst = f"{out}.txt"
    open(lst, "w").write("".join(f"file '{f}'\n" for f in files))
    run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out])
    return out


def finish(base, overlays, music, out, amb_gain, music_gain=1.0, total=None, fade_out=0.0):
    """overlays: list of (png, t_in, t_out, fade). Mix natural sound under the music, master to about -14 LUFS."""
    inputs = ["-i", base, "-i", music]
    for png, *_ in overlays: inputs += ["-loop", "1", "-i", png]
    fc, last = [], "0:v"
    for k, (png, t0, t1, fd) in enumerate(overlays):
        idx = k + 2
        fc.append(f"[{idx}:v]format=rgba,fade=t=in:st={t0}:d={fd}:alpha=1,fade=t=out:st={t1 - fd}:d={fd}:alpha=1[o{k}]")
        fc.append(f"[{last}][o{k}]overlay=0:0:enable='between(t,{t0},{t1})'[v{k}]"); last = f"v{k}"
    if fade_out:
        fc.append(f"[{last}]fade=t=out:st={total - fade_out}:d={fade_out}[vf]"); last = "vf"
    fc.append(f"[0:a]volume={amb_gain}[amb];[1:a]volume={music_gain}[mus];"
              f"[amb][mus]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=9[a]")
    cmd = ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(fc), "-map", f"[{last}]", "-map", "[a]"]
    if total: cmd += ["-t", str(total)]
    cmd += ["-c:v", "libx264", "-preset", "slow", "-crf", "17", "-profile:v", "high", "-pix_fmt", "yuv420p",
            "-r", str(FPS), "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-movflags", "+faststart", out]
    run(cmd)


# =============================== REEL 1: POV, the bar (reach) ===============================
def reel1():
    edl = [  # clip, src in, output duration, speed, extra filter   (120 BPM: every cut lands on a downbeat)
        ("113635_237", 3.0, 2.0, 1.0, ""),           # hook: cocktail arrives on the tray
        ("113633_304", 1.0, 1.0, 1.0, ""),           # whiskey orbit
        ("113643_410", 0.3, 1.0, 1.0, ""),           # cappuccino, sugar tongs
        ("113631_115", 0.3, 1.0, 1.0, ""),           # coupe, mirror selfie
        ("113631_687", 5.0, 1.0, 1.0, ""),           # chandeliers, the floor
        ("113635_237", 7.2, 1.0, 1.0, ""),           # first sip
        ("113642_367", 0.0, 1.0, 1.0, ""),           # Artisan laughing mid-section
        ("113631_695", 0.0, 2.0, 1.0, ""),  # the laugh; levels a tilted frame
    ]
    segs = [segment(i, *e, tag="r1_") for i, e in enumerate(edl)]
    base = concat(segs, f"{TMP}/r1_base.mp4")

    def pov(im, d):
        f = font("Figtree", 64, 600)
        txt = "POV: your new salon has a bar."
        shadowed(im, lambda dd, col: tracked(dd, (W / 2, 300), txt, f, col or IVORY, 0), blur=14, alpha=170)
    finish(base, [(layer("r1_pov", pov), 0.0, 10.0, 0.01)], f"{M}/reel1_music.wav",
           f"{OUT}/Reel1_POV-The-Bar.mp4", amb_gain=0.0, total=10.0)


# =============================== REEL 2: The House (brand) ===============================
def reel2():
    edl = [  # 72 BPM: 1 bar = 3.333 s, cuts on bars and half-bars
        ("113632_584", 0.2, 3.333, 0.5, "", 0.0),    # hook: coupe sip, half-speed
        ("113631_687", 2.0, 3.333, 1.0, ""),    # the floor, chandeliers
        ("113634_508", 1.0, 1.667, 1.0, ""),    # wall of colour
        ("113637_005", 2.5, 1.667, 1.0, ""),    # colour bar
        ("113629_402", 1.0, 3.333, 0.5, ""),    # blowout, half-speed
        ("113637_288", 2.0, 3.333, 1.0, ""),    # back bar, warm shelf light
        ("113638_269", 0.0, 3.333, 1.0, ""),    # the House's own menu
        ("113644_437", 3.5, 3.333, 1.0, ""),    # cappuccino, Artisan at work beyond
    ]
    segs = [segment(i, *e, tag="r2_") for i, e in enumerate(edl)]

    # end card: approved logo artwork on Crown Black, generous space
    def endcard(im, d):
        logo = Image.open(f"{A}/logo.png").convert("RGB")
        lw, lh = logo.size
        crop = logo.crop((int(lw * .06), int(lh * .14), int(lw * .94), int(lh * .80)))  # keep the full lockup
        cw = 900; crop = crop.resize((cw, int(crop.size[1] * cw / crop.size[0])), Image.LANCZOS)
        # set the render's textured black field to the black point so it sits seamlessly on Crown Black
        import numpy as np
        a = np.asarray(crop).astype(np.float32)
        bp = np.percentile(a, 75) + 6
        a = np.clip((a - bp) / (255 - bp), 0, 1) * (255 - 11) + 11
        im.paste(Image.fromarray(a.astype(np.uint8)), ((W - cw) // 2, 610))
        f2 = font("Gelasio", 50, 400); f3 = font("Figtree", 34, 500)
        tracked(d, (W / 2, 1270), "Wear the Crown. Carry the Clover.", f2, IVORY, 0)
        d.line((W / 2 - 60, 1370, W / 2 + 60, 1370), fill=GOLD, width=2)
        tracked(d, (W / 2, 1405), "Book your experience  ·  828-407-1750", f3, TAUPE, 1)
    end_png = layer("r2_end", endcard, bg=BLACK + (255,))
    segs.append(card(8, 4.2, end_png, "r2_"))
    base = concat(segs, f"{TMP}/r2_base.mp4")

    def eyebrow(im, d):
        f = font("Gelasio", 30, 500)
        shadowed(im, lambda dd, col: tracked(dd, (W / 2, 1330), "HOUSE NO. 1  ·  ASHEVILLE", f, col or GOLD, 7), blur=12, alpha=230)

    def menu_line(im, d):
        f = font("Gelasio-Italic", 58, 400)
        shadowed(im, lambda dd, col: tracked(dd, (W / 2, 190), "Come as you are.", f, col or IVORY, 0), blur=14, alpha=190)
        shadowed(im, lambda dd, col: tracked(dd, (W / 2, 270), "Leave more yourself.", f, col or IVORY, 0), blur=14, alpha=190)

    t_menu = 3.333 * 2 + 1.667 * 2 + 3.333 * 2
    total = sum(e[2] for e in edl) + 4.2
    finish(base, [(layer("r2_menu", menu_line), t_menu + 0.5, t_menu + 3.2, 0.5)],
           f"{M}/reel2_music.wav", f"{OUT}/Reel2_The-House.mp4", amb_gain=0.35, total=round(total, 3))


# =============================== REEL 3: Your first visit (conversion) ===============================
def reel3():
    edl = [  # 96 BPM: 1 bar = 2.5 s
        ("113643_410", 0.3, 5.0, 2.0, ""),      # hook + step 1: cappuccino, pull back to the floor
        ("113633_304", 2.5, 2.5, 1.0, ""),      # step 1 cont.: or a whiskey
        ("113642_367", 0.0, 5.0, 1.0, ""),      # step 2: Artisan plans and sections
        ("121018", 7.5, 2.5, 1.0, "scale=iw*1.12:ih*1.12,crop=720:1280"),   # step 3: precision
        ("121018", 15.0, 2.5, 1.0, "scale=iw*1.12:ih*1.12,crop=720:1280"),
        ("113629_769", 0.0, 5.0, 0.88, ""),     # step 4: barbering under the same roof
        ("113631_695", 0.0, 5.0, 0.82, ""),  # step 5
    ]
    segs = [segment(i, *e, tag="r3_") for i, e in enumerate(edl)]

    def endcard(im, d):
        f1 = font("Gelasio", 86, 400); f2 = font("Figtree", 62, 600); f3 = font("Figtree", 38, 500); f4 = font("Gelasio", 32, 500)
        tracked(d, (W / 2, 700), "CROWN & CLOVER", f4, (150, 125, 75), 8)
        d.line((W / 2 - 50, 765, W / 2 + 50, 765), fill=GOLD, width=2)
        tracked(d, (W / 2, 840), "Book your experience.", f1, BLACK, 0)
        tracked(d, (W / 2, 990), "828-407-1750", f2, BLACK, 2)
        tracked(d, (W / 2, 1105), "582 Hendersonville Road  ·  South Asheville", f3, (90, 84, 76), 0)
        tracked(d, (W / 2, 1165), "Salon and barber under one roof", f3, (90, 84, 76), 0)
    segs.append(card(7, 4.0, layer("r3_end", endcard, bg=IVORY + (255,)), "r3_"))
    base = concat(segs, f"{TMP}/r3_base.mp4")

    def hook(im, d):
        g = Image.new("L", (1, 900)); g.putdata([int(170 * (1 - y / 900) ** 1.4) for y in range(900)])
        im.paste(Image.new("RGBA", (W, 900), BLACK + (255,)), (0, 0), g.resize((W, 900)))
        f1 = font("Gelasio", 76, 500); f2 = font("Figtree", 46, 500)
        shadowed(im, lambda dd, col: tracked(dd, (W / 2, 330), "First visit to", f1, col or IVORY, 0), blur=16, alpha=200)
        shadowed(im, lambda dd, col: tracked(dd, (W / 2, 418), "Crown & Clover?", f1, col or IVORY, 0), blur=16, alpha=200)
        shadowed(im, lambda dd, col: tracked(dd, (W / 2, 525), "Here is exactly what happens.", f2, col or IVORY, 0), blur=14, alpha=200)

    def step(n, line1, line2=""):
        def fn(im, d):
            f_num = font("Gelasio", 34, 500); f = font("Figtree", 46, 500)
            lines = [l for l in (line1, line2) if l]
            widths = [d.textlength(l, font=f) for l in lines]
            bw = max(widths) + 110; bh = 112 + 64 * len(lines)
            y0 = 1180
            panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            ImageDraw.Draw(panel).rounded_rectangle(((W - bw) / 2, y0, (W + bw) / 2, y0 + bh), 26, fill=BLACK + (200,))
            im.alpha_composite(panel)
            tracked(d, (W / 2, y0 + 30), f"{n:02d}", f_num, GOLD, 6)
            for k, l in enumerate(lines): tracked(d, (W / 2, y0 + 86 + 62 * k), l, f, IVORY, 0)
        return layer(f"r3_step{n}", fn)

    t = [0, 2.6, 7.5, 12.5, 17.5, 22.5, 27.5]
    ov = [(layer("r3_hook", hook), 0.0, 2.5, 0.01),
          (step(1, "Coffee, a cocktail or a whiskey.", "Your call."), 2.6, 7.4, 0.3),
          (step(2, "Your Artisan maps it out", "before anything is cut."), 7.6, 12.4, 0.3),
          (step(3, "Precision, section by section."), 12.6, 17.4, 0.3),
          (step(4, "Salon and barbering", "under one roof."), 17.6, 22.4, 0.3),
          (step(5, "You leave more yourself."), 22.6, 27.4, 0.3)]
    finish(base, ov, f"{M}/reel3_music.wav", f"{OUT}/Reel3_Your-First-Visit.mp4", amb_gain=0.3, total=31.5)


for name in (sys.argv[2:] or ["reel1", "reel2", "reel3"]):
    globals()[name](); print("built", name)
