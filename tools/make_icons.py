"""Draw Star Studio's original star/stack emblem at UXP icon scales."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'plugin'
for name, size, color, tile in [('icon-dark',23,'#eeeeee',False),('icon-light',23,'#30303a',False),('icon',48,'#ffffff',True)]:
    for scale in (1,2):
        s = size*scale
        image = Image.new('RGBA',(s*4,s*4))
        draw = ImageDraw.Draw(image)
        def pts(values):
            return [(x*s*4,y*s*4) for x,y in values]
        if tile:
            draw.rounded_rectangle((0,0,s*4-1,s*4-1),radius=s*.8,fill='#15304a')
        draw.line(pts([(.16,.64),(.5,.82),(.84,.64)]),fill=color,width=max(2,round(s*.21)),joint='curve')
        draw.line(pts([(.16,.77),(.5,.95),(.84,.77)]),fill=color,width=max(2,round(s*.21)),joint='curve')
        draw.polygon(pts([(.50,.08),(.58,.32),(.82,.40),(.58,.48),(.50,.72),(.42,.48),(.18,.40),(.42,.32)]),fill=color)
        draw.ellipse((s*3.12,s*.44,s*3.56,s*.88),fill='#8acff0' if tile else color)
        icon=image.resize((s,s),Image.Resampling.LANCZOS)
        icon.save(root/(name+f'@{scale}x.png'))
        if scale==1:
            icon.save(root/(name+'.png'))
