"""Float32, tiled adaptation of Colour's Malvar (2004) Bayer demosaicer.

Copyright 2015 Colour Developers. BSD-3-Clause; see
vendor/COLOUR-DEMOSAICING-LICENSE.txt. Source: colour-demosaicing v0.2.6,
colour_demosaicing/bayer/demosaicing/malvar2004.py.
Changes: parity slices replace full-frame masks; 128-row tiles with a two-pixel
halo bound convolution memory. No integer conversion or clipping.
"""
import numpy as np
from scipy.ndimage import convolve


def demosaic(cfa, pattern, cancelled=lambda: False):
    green = np.array([[0,0,-1,0,0],[0,0,2,0,0],[-1,2,4,2,-1],
                      [0,0,2,0,0],[0,0,-1,0,0]], dtype=np.float32)/8
    cross = np.array([[0,0,.5,0,0],[0,-1,0,-1,0],[-1,4,5,4,-1],
                      [0,-1,0,-1,0],[0,0,.5,0,0]], dtype=np.float32)/8
    opposite = np.array([[0,0,-1.5,0,0],[0,2,0,2,0],[-1.5,0,6,0,-1.5],
                         [0,2,0,2,0],[0,0,-1.5,0,0]], dtype=np.float32)/8
    rgb = np.empty((*cfa.shape,3), dtype=np.float32)
    red = divmod(pattern.index('R'),2)
    blue = divmod(pattern.index('B'),2)
    for y in range(0,cfa.shape[0],128):
        if cancelled():
            raise ValueError('堆栈已取消。')
        start, end = max(0,y-2), min(cfa.shape[0],y+130)
        source = cfa[start:end]
        rows = min(128,cfa.shape[0]-y)
        crop = slice(y-start,y-start+rows)
        g = convolve(source,green)[crop]
        horizontal = convolve(source,cross)[crop]
        vertical = convolve(source,cross.T)[crop]
        diagonal = convolve(source,opposite)[crop]
        block = rgb[y:y+rows]
        for ry in range(2):
            for cx in range(2):
                sl = (slice((ry-y)%2,None,2),slice(cx,None,2))
                color = pattern[ry*2+cx]
                block[sl+(1,)] = cfa[y:y+rows][sl] if color == 'G' else g[sl]
                for channel, site in [(0,red),(2,blue)]:
                    value = cfa[y:y+rows] if (ry,cx) == site else diagonal if color != 'G' else horizontal if ry == site[0] else vertical
                    block[sl+(channel,)] = value[sl]
    return rgb
