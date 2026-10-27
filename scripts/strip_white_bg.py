#!/usr/bin/env python3
"""把图标四周的白底抠成透明（只处理与边缘连通的白色区域，logo 内部的白色不动）。

用法：
    python scripts/strip_white_bg.py src-tauri/icons/icon.png [输出路径]

依赖：只用 Python 标准库（zlib + collections），不需要装 Pillow。
"""

import sys
import zlib
from collections import deque

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _read_chunks(data):
    assert data[:8] == PNG_SIG, "不是 PNG 文件"
    pos = 8
    chunks = []
    while pos < len(data):
        length = int.from_bytes(data[pos : pos + 4], "big")
        ctype = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        chunks.append((ctype, body))
        pos += 12 + length
        if ctype == b"IEND":
            break
    return chunks


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def decode_png(path):
    """解码 8bit RGB/RGBA 非隔行 PNG，返回 (宽, 高, RGBA bytearray)"""
    with open(path, "rb") as fh:
        chunks = _read_chunks(fh.read())

    ihdr = next(body for ctype, body in chunks if ctype == b"IHDR")
    width = int.from_bytes(ihdr[0:4], "big")
    height = int.from_bytes(ihdr[4:8], "big")
    depth = ihdr[8]
    color_type = ihdr[9]
    interlace = ihdr[12]
    if depth != 8 or interlace != 0 or color_type not in (2, 6):
        raise SystemExit(f"暂不支持这种 PNG：depth={depth} color={color_type} interlace={interlace}")

    channels = 4 if color_type == 6 else 3
    raw = zlib.decompress(b"".join(body for ctype, body in chunks if ctype == b"IDAT"))

    stride = width * channels
    out = bytearray(width * height * 4)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        ftype = raw[pos]
        pos += 1
        line = bytearray(raw[pos : pos + stride])
        pos += stride
        if ftype == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                up_left = prev[i - channels] if i >= channels else 0
                line[i] = (line[i] + _paeth(left, prev[i], up_left)) & 0xFF
        prev = line

        row = y * width * 4
        if channels == 4:
            out[row : row + width * 4] = line
        else:
            for x in range(width):
                src = x * 3
                dst = row + x * 4
                out[dst : dst + 3] = line[src : src + 3]
                out[dst + 3] = 255
    return width, height, out


def encode_png(width, height, rgba, path):
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter: None
        raw += rgba[y * stride : (y + 1) * stride]

    def chunk(ctype, body):
        return (
            len(body).to_bytes(4, "big")
            + ctype
            + body
            + zlib.crc32(ctype + body).to_bytes(4, "big")
        )

    ihdr = width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes([8, 6, 0, 0, 0])
    with open(path, "wb") as fh:
        fh.write(PNG_SIG)
        fh.write(chunk(b"IHDR", ihdr))
        fh.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        fh.write(chunk(b"IEND", b""))


def strip_white(width, height, rgba, solid=236, feather=200):
    """从四角开始泛洪，把与边缘连通的近白像素变透明。

    solid   亮度 >= 这个值的像素视为纯背景，直接透明
    feather 亮度在 [feather, solid) 之间的边缘像素按亮度给半透明，保住抗锯齿
    """
    total = width * height

    def bright(i):
        p = i * 4
        return min(rgba[p], rgba[p + 1], rgba[p + 2])

    def saturated(i):
        p = i * 4
        r, g, b = rgba[p], rgba[p + 1], rgba[p + 2]
        return max(r, g, b) - min(r, g, b) > 26

    visited = bytearray(total)
    queue = deque()
    for x, y in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)):
        idx = y * width + x
        if bright(idx) >= solid and rgba[idx * 4 + 3] > 0:
            visited[idx] = 1
            queue.append(idx)

    removed = 0
    while queue:
        idx = queue.popleft()
        p = idx * 4
        rgba[p + 3] = 0
        removed += 1
        x, y = idx % width, idx // width
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height:
                n = ny * width + nx
                if not visited[n] and rgba[n * 4 + 3] > 0 and bright(n) >= solid and not saturated(n):
                    visited[n] = 1
                    queue.append(n)

    # 边缘羽化：紧贴透明区的浅色像素给半透明，避免锯齿白边
    for idx in range(total):
        if visited[idx] or rgba[idx * 4 + 3] == 0:
            continue
        x, y = idx % width, idx // width
        near_clear = False
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height and visited[ny * width + nx]:
                near_clear = True
                break
        if not near_clear:
            continue
        b = bright(idx)
        if b >= feather and not saturated(idx):
            ratio = (b - feather) / max(1, solid - feather)
            alpha = int(255 * (1 - min(1.0, ratio)))
            p = idx * 4
            if alpha < rgba[p + 3]:
                rgba[p + 3] = alpha

    return removed


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else src

    width, height, rgba = decode_png(src)
    removed = strip_white(width, height, rgba)
    encode_png(width, height, rgba, dst)
    print(f"{src} → {dst}  {width}x{height}  清除 {removed} 个背景像素（{removed / (width * height) * 100:.1f}%）")


if __name__ == "__main__":
    main()
