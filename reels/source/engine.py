"""Edit engine v2: beat-aligned shots from 4K landscape (or vertical phone) sources, cropped to 9:16,
joined with real transitions (xfade), punch-ins, speed changes, Ken Burns stills, text layers and a mixed soundtrack."""
import os, subprocess, sys, json
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps

S = os.path.dirname(os.path.abspath(__file__))
TMP = f"{S}/build2"; os.makedirs(TMP, exist_ok=True)
W, H, FPS = 1080, 1920, 30
BLACK, IVORY, GOLD, TAUPE = (11, 11, 11), (245, 241, 232), (194, 166, 107), (169, 157, 140)
# subtle cinematic look: gentle S-curve with lifted blacks, teal shadows / warm highlights,
# slightly restrained saturation, light vignette and fine film grain
GRADE = ("eq=contrast=1.03:saturation=0.98:gamma=0.98,"
         "curves=master='0/0.03 0.25/0.215 0.5/0.5 0.78/0.81 1/0.97',"
         "colorbalance=rs=-0.02:bs=0.03:rm=0.015:bm=-0.01:rh=0.045:gh=0.012:bh=-0.04,"
         "unsharp=5:5:0.25,vignette=angle=0.38,noise=alls=3:allf=t")


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode: print(" ".join(cmd)[:600]); print(r.stderr[-2500:]); sys.exit(1)


def src_url(name):
    if name.startswith("v_"): return f"{S}/assets/{name}.mp4"            # phone clips already on disk
    return f"{S}/new/raw/{name}.MP4"                                      # 4K originals, downloaded once


def shot(tag, name, ss, dur, speed=1.0, x=0.5, zoom=1.0, punch=0.0, push=0.0, vol=1.0, still=False, rot="none"):
    """One shot -> 1080x1920 intermediate.
    x: horizontal centre of the 9:16 crop (0..1) for landscape sources. zoom: static extra zoom.
    punch: beat punch-in amount that decays over 0.35 s. push: slow linear push-in over the shot."""
    out = f"{TMP}/{tag}.mp4"
    if os.path.exists(out) and os.path.getmtime(out) > os.path.getmtime(__file__) and not os.environ.get("FORCE"):
        return out
    z = f"{zoom}*(1+{punch}*exp(-t*9)+{push}*t/{dur})"
    if still:
        img = f"{S}/new/photos_fixed/{name}.jpg"
        if not os.path.exists(img):
            os.makedirs(f"{S}/new/photos_fixed", exist_ok=True)
            ImageOps.exif_transpose(Image.open(f"{S}/new/photos/{name}.JPG")).convert("RGB").save(img, quality=95)
        inp = ["-loop", "1", "-framerate", str(FPS), "-t", str(dur), "-i", img, "-f", "lavfi", "-t", str(dur), "-i", "anullsrc=r=48000:cl=stereo"]
        pre = "scale=-2:2400,"  # keep 4K-ish headroom for the push
    else:
        inp = ["-ss", str(ss), "-t", str(dur * speed + 0.3), "-i", src_url(name)]
        pre = f"setpts=(PTS-STARTPTS)/{speed}," + {"cw": "transpose=1,", "ccw": "transpose=2,", "none": ""}[rot]
    # crop to 9:16 around x, then dynamic zoom via scale(eval=frame)+centre crop
    crop = f"crop='min(iw,ih*9/16)':'ih':'max(0,min(iw-ih*9/16,iw*{x}-ih*9/32))':0"
    v = (f"{pre}{crop},scale=1080:1920:flags=lanczos,setsar=1,fps={FPS},"
         f"scale=w='trunc(1080*{z}/2)*2':h='trunc(1920*{z}/2)*2':eval=frame:flags=bicubic,crop=1080:1920,"
         f"{GRADE},trim=duration={dur},setpts=PTS-STARTPTS,format=yuv420p")
    if still:
        fc = f"[0:v]{v}[v];[1:a]anull[a]"
    else:
        sp, tempo = speed, []
        while sp > 2: tempo.append("atempo=2"); sp /= 2
        while sp < .5: tempo.append("atempo=0.5"); sp /= .5
        tempo.append(f"atempo={sp}")
        fc = f"[0:v]{v}[v];[0:a]volume={vol},{','.join(tempo)},aresample=48000,apad,atrim=duration={dur},asetpts=PTS-STARTPTS[a]"
    for k in range(4):
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", *inp, "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
                            "-t", str(dur), "-c:v", "libx264", "-preset", "fast", "-crf", "15", "-c:a", "pcm_s16le",
                            "-ac", "2", "-ar", "48000", out], capture_output=True, text=True,
                           env={**os.environ, "http_proxy": os.environ.get("HTTPS_PROXY", "")})
        if r.returncode == 0: return out
        import time; time.sleep(5 * (k + 1))
    print(r.stderr[-2000:]); sys.exit(1)


def card(tag, png, dur):
    out = f"{TMP}/{tag}.mp4"
    run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-framerate", str(FPS), "-t", str(dur), "-i", png, "-f", "lavfi",
         "-t", str(dur), "-i", "anullsrc=r=48000:cl=stereo", "-vf", "format=yuv420p", "-c:v", "libx264", "-crf", "15",
         "-c:a", "pcm_s16le", "-shortest", out])
    return out


def assemble(shots, out):
    """shots: list of (file, length, transition_into_next, tdur). Every nominal cut lands at sum(lengths);
    each shot file must be length + tdur_in/2 + tdur_out/2 long and start tdur_in/2 early."""
    inputs, fc = [], []
    for f, *_ in shots: inputs += ["-i", f]
    for i, sh in enumerate(shots):
        fc.append(f"[{i}:a]atrim=duration={sh[4]:.4f},asetpts=PTS-STARTPTS[ta{i}]")
    vlast, alast, acc = "0:v", "ta0", 0.0
    for i in range(1, len(shots)):
        _, L_prev, tr, td, _d = shots[i - 1]
        acc += L_prev
        hard = td <= 1.01 / FPS
        off = acc if hard else acc - td / 2       # soft transitions are centred on the nominal cut
        # xfade offset is measured on the accumulated output stream
        fc.append(f"[{vlast}][{i}:v]xfade=transition={tr}:duration={td:.3f}:offset={off - (0):.3f}[v{i}]")
        fc.append(f"[{alast}][ta{i}]acrossfade=d={td:.4f}:c1=tri:c2=tri[a{i}]")
        vlast, alast = f"v{i}", f"a{i}"
    run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(fc), "-map", f"[{vlast}]", "-map", f"[{alast}]",
         "-c:v", "libx264", "-preset", "fast", "-crf", "15", "-c:a", "pcm_s16le", out])
    return out


def edl_to_shots(prefix, edl):
    """edl rows: dict(name|card, ss, L, tr='cut'|xfade-name, td) - tr/td describe the transition OUT of the row.
    Transition centres land exactly on the nominal cuts (sum of L). A hard cut is a 1-frame fade."""
    def out_td(e): return e.get("td", 0) if e.get("tr", "cut") != "cut" else 1 / FPS
    shots = []
    for i, e in enumerate(edl):
        e = dict(e); last = i == len(edl) - 1
        prev = edl[i - 1] if i else None
        td_in = (prev.get("td", 0) if prev.get("tr", "cut") != "cut" else 0) if prev else 0
        td_out = 0 if last else out_td(e)
        hard_out = (not last) and e.get("tr", "cut") == "cut"
        L = e.pop("L"); tr = e.pop("tr", "cut"); e.pop("td", None)
        dur = L + td_in / 2 + (td_out if hard_out else td_out / 2)
        pad = 0 if last else 3 / FPS             # frame-rounding headroom; xfade drops the unused tail
        if e.get("card"):
            f = card(f"{prefix}{i:02d}", e["card"], round(dur + pad, 3))
        else:
            e.pop("card", None)
            name = e.pop("name"); ss = max(0, e.pop("ss", 0) - td_in / 2 * e.get("speed", 1.0))
            f = shot(f"{prefix}{i:02d}", name, round(ss, 3), round(dur + pad, 3), **e)
        shots.append((f, L, "fade" if hard_out else tr, td_out, dur))
    return shots


# ---------------- text ----------------
F = f"{S}/fonts"


def font(name, size, wght=None):
    f = ImageFont.truetype(f"{F}/{name}.ttf", size)
    if wght: f.set_variation_by_axes([wght])
    return f


def tracked(d, xy, text, fnt, fill, tracking=0):
    ws = [d.textlength(c, font=fnt) for c in text]; x = xy[0] - (sum(ws) + tracking * (len(text) - 1)) / 2
    for c, w in zip(text, ws): d.text((x, xy[1]), c, font=fnt, fill=fill); x += w + tracking


def layer(name, fn, bg=None):
    im = Image.new("RGBA", (W, H), bg or (0, 0, 0, 0)); fn(im, ImageDraw.Draw(im))
    p = f"{TMP}/{name}.png"; im.save(p); return p


def shadowed(im, fn, blur=12, alpha=180):
    sh = Image.new("RGBA", im.size, (0, 0, 0, 0)); fn(ImageDraw.Draw(sh), (0, 0, 0, alpha))
    im.alpha_composite(sh.filter(ImageFilter.GaussianBlur(blur))); fn(ImageDraw.Draw(im), None)


def logo_block(im, y, width=880):
    import numpy as np
    logo = Image.open(f"{S}/assets/logo.png").convert("RGB"); lw, lh = logo.size
    c = logo.crop((int(lw * .06), int(lh * .14), int(lw * .94), int(lh * .80)))
    c = c.resize((width, int(c.size[1] * width / c.size[0])), Image.LANCZOS)
    a = np.asarray(c).astype(np.float32); bp = np.percentile(a, 75) + 6
    a = np.clip((a - bp) / (255 - bp), 0, 1) * (255 - 11) + 11
    im.paste(Image.fromarray(a.astype(np.uint8)), ((W - width) // 2, y))


def finish(base, overlays, music, out, amb_gain, total):
    """overlays: (png, t_in, t_out, fade, motion) motion: '' | 'rise' (text drifts up 30px while fading in)."""
    inputs = ["-i", base, "-i", music]
    for o in overlays: inputs += ["-loop", "1", "-framerate", str(FPS), "-i", o[0]]
    fc, last = [], "0:v"
    for k, (png, t0, t1, fd, *mo) in enumerate(overlays):
        i = k + 2; motion = mo[0] if mo else ""
        fc.append(f"[{i}:v]format=rgba,fade=t=in:st={t0}:d={fd}:alpha=1,fade=t=out:st={t1 - fd}:d={fd}:alpha=1[o{k}]")
        y = f"'if(lt(t,{t0}+0.45),30*(1-(t-{t0})/0.45),0)'" if motion == "rise" else "0"
        fc.append(f"[{last}][o{k}]overlay=x=0:y={y}:enable='between(t,{t0},{t1})'[v{k}]"); last = f"v{k}"
    fc.append(f"[0:a]volume={amb_gain}[amb];[1:a]volume=1[mus];[amb][mus]amix=inputs=2:duration=longest:normalize=0,"
              f"atrim=duration={total},loudnorm=I=-14:TP=-1.5:LRA=9[a]")
    run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(fc), "-map", f"[{last}]", "-map", "[a]",
         "-t", str(total), "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p",
         "-r", str(FPS), "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-movflags", "+faststart", out])
