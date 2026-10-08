"""Crown & Clover reels v2: 4K footage, upbeat original music, designed transitions + matching sound effects."""
import sys, json, subprocess
from engine import *

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/unused"; os.makedirs(OUT, exist_ok=True)
SFX_FOR = {"slideleft": "swish", "smoothright": "whoosh", "circleopen": "swish", "hblur": "whoosh", "zoomin": "whoosh", "smoothleft": "whoosh", "smoothup": "swish", "slideup": "swish",
           "slideleft": "swish", "fadewhite": "impact", "fade": None, "fadeblack": None, "cut": None}


def cut_times(edl):
    t, out = 0.0, []
    for e in edl[:-1]:
        t += e["L"]; out.append((round(t, 3), e.get("tr", "cut")))
    return out


def make_music(which, bpm, bars, events):
    d = f"{S}/m2/{which}"
    subprocess.run(["python3", f"{S}/music2.py", d, which, str(bpm), str(bars), json.dumps(events)], check=True,
                   stdout=subprocess.DEVNULL)
    return f"{d}/{which}_music.wav"


def sfx_events(edl, extra=()):
    ev = [[t, SFX_FOR[tr]] for t, tr in cut_times(edl) if SFX_FOR.get(tr)]
    return ev + [list(x) for x in extra]


def build(prefix, edl, which, bpm, bars, extra_sfx, overlays, out, amb):
    shots = edl_to_shots(prefix, edl)
    base = assemble(shots, f"{TMP}/{prefix}base.mp4")
    music = make_music(which, bpm, bars, sfx_events(edl, extra_sfx))
    total = round(sum(e["L"] for e in edl), 3)
    finish(base, overlays, music, out, amb, total)
    return total


# =========================== REEL 1: POV: your new salon has a bar (reach) ===========================
def reel1():
    b = 60 / 124; B = 4 * b; h = 2 * b                     # beat, bar, half-bar
    W_ = dict(tr="hblur", td=0.16)                           # whip, used only twice
    q = b
    edl = [
        dict(name="JV3A6846", ss=0.3, L=B, speed=1.6, x=0.5),                         # door opens, Artisan waves
        dict(name="v_113635_237", ss=3.6, L=h, punch=0.10),                          # DROP: cocktail arrives (clean cut on the drop)
        dict(name="JV3A7256", ss=3.0, L=h, rot="cw", push=0.08, **W_),               # whip into the bar
        dict(name="JV3A7284", L=h, still=True, punch=0.06),                          # guest raises a glass
        dict(name="JV3A6924", ss=1.0, L=h, rot="ccw", push=0.05),                    # hot towel steam
        dict(name="JV3A7317", L=h, still=True, punch=0.06),                          # blonde sips wine
        dict(name="v_113643_410", ss=0.3, L=h, push=0.05),                           # cappuccino, sugar tongs
        dict(name="JV3A7253", ss=0.5, L=h, rot="cw", push=0.06),                     # chandeliers
        dict(name="JV3A7063", ss=2.3, L=h, rot="ccw", punch=0.05),                   # curly guest laughing
        dict(name="JV3A7100", ss=11.0, L=h, rot="ccw", push=0.05),                   # steam at the bowl (match on steam)
        dict(name="JV3A7054", ss=2.4, L=q, rot="ccw", speed=2.4, **W_),              # whip + speed ramp: chair spins fast...
        dict(name="JV3A7054", ss=3.56, L=q, rot="ccw", speed=0.7),                   # ...and lands in slow motion on her smile
        dict(name="JV3A7053", ss=6.3, L=h, rot="ccw", push=0.05),                    # laughing with her Artisan
        dict(name="v_113631_695", ss=0.0, L=h, punch=0.05),                          # the laugh, loops to the door
    ]
    # whips sit on the cut INTO the next shot: move tr/td to the preceding row
    edl = shift_transitions(edl)

    def pov(im, d):
        f = font("Figtree", 66, 650)
        shadowed(im, lambda dd, c: tracked(dd, (W / 2, 290), "POV: your new salon has a bar.", f, c or IVORY), 16, 190)
    return build("r1_", edl, "reel1", 124, 7, [[B, "impact"], [B, "riser"]],
                 [(layer("r1_pov", pov), 0.0, round(7 * B, 3), 0.01)], f"{OUT}/Reel1_POV-The-Bar.mp4", amb=0.0)


def shift_transitions(edl):
    """Rows mark the transition that brings them IN; engine wants it on the row going OUT."""
    rows = [{k: v for k, v in e.items() if k not in ("tr", "td")} for e in edl]
    for i in range(1, len(edl)):
        if "tr" in edl[i]:
            rows[i - 1]["tr"], rows[i - 1]["td"] = edl[i]["tr"], edl[i]["td"]
    return rows


# =========================== REEL 2: The House (brand) ===========================
def reel2():
    b = 60 / 116; B = 4 * b; h = 2 * b; q = b
    edl = shift_transitions([
        dict(name="JV3A6847", ss=0.3, L=B, x=0.47, push=0.05),                         # gold barber pole
        dict(name="JV3A7260", ss=8.0, L=B, rot="cw", push=0.07),                       # reception arch (clean cut)
        dict(name="JV3A7253", ss=0.3, L=h, rot="cw", speed=0.75),                      # chandeliers
        dict(name="JV3A6888", ss=1.0, L=h, rot="ccw", push=0.05),                      # crystal pendants
        dict(name="JV3A6924", ss=0.3, L=q, rot="ccw", speed=2.0),                      # speed ramp: towel goes on fast...
        dict(name="JV3A6924", ss=1.33, L=B - q, rot="ccw", speed=0.5),                 # ...then steam in slow motion
        dict(name="JV3A7100", ss=9.0, L=B, rot="ccw", speed=0.7),                      # MATCH CUT: steam to steam
        dict(name="JV3A7004", ss=2.6, L=q, rot="ccw"),                                 # detail burst on the beat:
        dict(name="JV3A7210", ss=1.0, L=q, rot="cw"),                                  #   razor, scissors,
        dict(name="JV3A7017", ss=13.0, L=q, rot="ccw"),                                #   curling iron,
        dict(name="JV3A7210", ss=11.7, L=q, rot="cw"),                                 #   scissors
        dict(name="JV3A7147", ss=5.5, L=B, rot="cw", tr="hblur", td=0.16),             # whip on the hair movement: diffused curls
        dict(name="JV3A7063", ss=2.0, L=B, rot="ccw", push=0.04),                      # the guest, laughing
        dict(name="JV3A7064", ss=5.6, L=B, rot="ccw"),                                 # Artisan walks to camera
        dict(card=None, L=2 * B, tr="fadeblack", td=0.5),                              # end card
    ])

    def endcard(im, d):
        logo_block(im, 620)
        tracked(d, (W / 2, 1260), "Wear the Crown. Carry the Clover.", font("Gelasio", 52, 400), IVORY)
        d.line((W / 2 - 60, 1365, W / 2 + 60, 1365), fill=GOLD, width=2)
        tracked(d, (W / 2, 1400), "Book your experience  ·  828-407-1750", font("Figtree", 36, 500), TAUPE, 1)
    edl[-1]["card"] = layer("r2_end", endcard, bg=BLACK + (255,))

    def line(im, d):
        f = font("Gelasio-Italic", 62, 400)
        shadowed(im, lambda dd, c: tracked(dd, (W / 2, 1180), "Come as you are.", f, c or IVORY), 16, 200)
        shadowed(im, lambda dd, c: tracked(dd, (W / 2, 1265), "Leave more yourself.", f, c or IVORY), 16, 200)
    t_line = sum(e["L"] for e in edl[:12])
    total = sum(e["L"] for e in edl)
    return build("r2_", edl, "reel2", 116, round(total / B), [[4 * B, "riser"]],
                 [(layer("r2_line", line), round(t_line + 0.3, 3), round(t_line + 2 * B - 0.2, 3), 0.4, "rise")],
                 f"{OUT}/Reel2_The-House.mp4", amb=0.25)


# =========================== REEL 3: Your first visit (conversion) ===========================
def reel3():
    b = 60 / 108; B = 4 * b; h = 2 * b
    edl = shift_transitions([
        dict(name="JV3A6849", L=B, still=True, push=0.10),                                       # exterior
        dict(name="JV3A6852", L=B, still=True, push=0.08),                                       # reception
        dict(name="v_113643_410", ss=0.3, L=B, push=0.05),                                       # 01 coffee
        dict(name="JV3A7306", L=B, still=True, push=0.06),                                       # 01 guest with a drink
        dict(name="JV3A7205", ss=1.5, L=B, rot="cw"),                                            # 02 consultation
        dict(name="JV3A7205", ss=12.0, L=B, rot="cw"),                                           # 02 Artisan explains
        dict(name="JV3A7097", ss=3.0, L=B, rot="ccw"),                                           # 03 wash
        dict(name="JV3A7101", ss=4.0, L=B, rot="ccw"),                                           # 03 steam
        dict(name="JV3A7210", ss=4.5, L=h, rot="cw"),                                            # 04 cutting
        dict(name="JV3A7176", ss=10.0, L=h, rot="cw", tr="hblur", td=0.16),                      # 04 whip on the hand movement into colour
        dict(name="JV3A7017", ss=16.0, L=B, rot="ccw"),                                          # 04 styling
        dict(name="JV3A6895", ss=9.0, L=B, rot="ccw"),                                           # 05 fade
        dict(name="JV3A6921", ss=3.0, L=B, rot="ccw"),                                           # 05 hot towel
        dict(name="JV3A7054", ss=2.4, L=h, rot="ccw", speed=2.4),                                # 06 speed ramp: the chair spins...
        dict(name="JV3A7054", ss=5.07, L=h, rot="ccw", speed=0.7),                               # ...and lands slow on the reveal
        dict(name="JV3A7053", ss=6.3, L=B, rot="ccw"),                                           # 06 laughing
        dict(card=None, L=2 * B, tr="fade", td=0.4),
    ])

    def endcard(im, d):
        tracked(d, (W / 2, 690), "CROWN & CLOVER", font("Gelasio", 34, 500), (150, 125, 75), 8)
        d.line((W / 2 - 50, 760, W / 2 + 50, 760), fill=GOLD, width=2)
        tracked(d, (W / 2, 830), "Book your experience.", font("Gelasio", 88, 400), BLACK)
        tracked(d, (W / 2, 985), "828-407-1750", font("Figtree", 64, 600), BLACK, 2)
        tracked(d, (W / 2, 1100), "582 Hendersonville Road  ·  South Asheville", font("Figtree", 38, 500), (90, 84, 76))
        tracked(d, (W / 2, 1160), "Salon and barber under one roof", font("Figtree", 38, 500), (90, 84, 76))
    edl[-1]["card"] = layer("r3_end", endcard, bg=IVORY + (255,))

    def hook(im, d):
        g = Image.new("L", (1, 900)); g.putdata([int(175 * (1 - y / 900) ** 1.4) for y in range(900)])
        im.paste(Image.new("RGBA", (W, 900), BLACK + (255,)), (0, 0), g.resize((W, 900)))
        f1 = font("Gelasio", 80, 500); f2 = font("Figtree", 48, 500)
        for txt, y, f in (("First visit to", 300, f1), ("Crown & Clover?", 392, f1), ("Here is exactly what happens.", 505, f2)):
            shadowed(im, lambda dd, c, txt=txt, y=y, f=f: tracked(dd, (W / 2, y), txt, f, c or IVORY), 16, 200)

    def step(n, l1, l2=""):
        def fn(im, d):
            f_num = font("Gelasio", 36, 500); f = font("Figtree", 48, 550)
            lines = [l for l in (l1, l2) if l]; bw = max(d.textlength(l, font=f) for l in lines) + 120
            bh = 116 + 66 * len(lines); y0 = 1160
            panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            ImageDraw.Draw(panel).rounded_rectangle(((W - bw) / 2, y0, (W + bw) / 2, y0 + bh), 28, fill=BLACK + (205,))
            im.alpha_composite(panel)
            tracked(d, (W / 2, y0 + 30), f"{n:02d}", f_num, GOLD, 6)
            for k, l in enumerate(lines): tracked(d, (W / 2, y0 + 88 + 64 * k), l, f, IVORY)
        return layer(f"r3_step{n}", fn)

    t = [0]
    for e in edl: t.append(t[-1] + e["L"])
    steps = [(1, "Coffee, a cocktail or a whiskey.", "Your call.", 2, 4), (2, "Your Artisan maps it out", "before anything is cut.", 4, 6),
             (3, "A steam wash and", "a proper scalp massage.", 6, 8), (4, "Precision cutting, colour", "and styling.", 8, 11),
             (5, "Barbering too, right down", "to the hot towel.", 11, 13), (6, "You leave more yourself.", "", 13, 16)]
    ov = [(layer("r3_hook", hook), 0.0, round(t[2] - 0.1, 3), 0.01)]
    for n, l1, l2, a, z in steps:
        ov.append((step(n, l1, l2), round(t[a] + 0.25, 3), round(t[z] - 0.15, 3), 0.25, "rise"))
    return build("r3_", edl, "reel3", 108, round(sum(e["L"] for e in edl) / B), [], ov, f"{OUT}/Reel3_Your-First-Visit.mp4", amb=0.2)


if __name__ == "__main__":
    for name in (sys.argv[2:] or ["reel1", "reel2", "reel3"]):
        print(name, globals()[name]())
