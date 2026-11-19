#!/usr/bin/env python3
"""
Render docs/demo.gif from the real output of `undogen verify` against the demo API.

    npm run build && python3 scripts/render_demo_gif.py

Requires Pillow. Nothing in the GIF is hand-written: the output is captured
from the CLI and replayed line by line in a terminal-style frame.
"""
import os
import re
import socket
import subprocess
import time

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLE = os.path.join(ROOT, 'examples', 'todo-api')
OUT = os.path.join(ROOT, 'docs', 'demo.gif')
PORT = 4010
SHOWN_CMD = f'npx undogen verify openapi.yaml --base-url http://localhost:{PORT} --fixtures fixtures.json'

FONT_DIR = '/usr/share/fonts/truetype'
FONT = os.environ.get('DEMO_FONT', f'{FONT_DIR}/jetbrains-mono/JetBrainsMono-Regular.ttf')
FONT_BOLD = os.environ.get('DEMO_FONT_BOLD', f'{FONT_DIR}/jetbrains-mono/JetBrainsMono-Bold.ttf')
FALLBACK = f'{FONT_DIR}/dejavu/DejaVuSans.ttf'
SIZE = 15
LINE_H = 22
PAD_X, PAD_Y, TITLE_H = 22, 18, 36

BG = (13, 17, 23)
WINDOW = (22, 27, 34)
FG = (201, 209, 217)
COLORS = {
    '1': (240, 246, 252),   # bold
    '2': (125, 133, 144),   # dim
    '31': (248, 81, 73),    # red
    '32': (63, 185, 80),    # green
    '33': (210, 153, 34),   # yellow
    '34': (88, 166, 255),   # blue
    '35': (188, 140, 255),  # magenta
    '36': (57, 197, 207),   # cyan
}


def wait_for_port(port, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as s:
            if s.connect_ex(('127.0.0.1', port)) == 0:
                return
        time.sleep(0.1)
    raise RuntimeError(f'demo server did not start on :{port}')


def capture():
    server = subprocess.Popen(
        ['npx', 'tsx', 'examples/todo-api/server.ts', str(PORT)],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        wait_for_port(PORT)
        out = subprocess.run(
            ['node', os.path.join(ROOT, 'dist', 'cli.js'), 'verify', 'openapi.yaml',
             '--base-url', f'http://localhost:{PORT}', '--fixtures', 'fixtures.json'],
            cwd=EXAMPLE, capture_output=True, text=True, env={**os.environ, 'FORCE_COLOR': '1'},
        )
        if not out.stdout.strip():
            raise RuntimeError(out.stderr)
        return out.stdout.rstrip('\n').split('\n')
    finally:
        server.terminate()
        server.wait()


ANSI = re.compile(r'\x1b\[(\d+)m')


def parse(line):
    """Split a line into (text, code) spans; code is an SGR code string or None."""
    spans, code, pos = [], None, 0
    for m in ANSI.finditer(line):
        if m.start() > pos:
            spans.append((line[pos:m.start()], code))
        code = None if m.group(1) == '0' else m.group(1)
        pos = m.end()
    if pos < len(line):
        spans.append((line[pos:], code))
    return spans


def visible_len(line):
    return len(ANSI.sub('', line))


class Renderer:
    def __init__(self, cols, rows):
        self.font = ImageFont.truetype(FONT, SIZE)
        self.bold = ImageFont.truetype(FONT_BOLD, SIZE)
        self.fallback = ImageFont.truetype(FALLBACK, SIZE)
        self.cell = self.font.getlength('M')
        self.w = int(PAD_X * 2 + cols * self.cell)
        self.h = int(TITLE_H + PAD_Y * 2 + rows * LINE_H)
        self.glyphs = {}
        self.notdef = self.glyph_sig(chr(0xE000))  # private-use char: renders as the missing-glyph box

    def glyph_sig(self, ch):
        img = Image.new('L', (SIZE * 2, SIZE * 2))
        ImageDraw.Draw(img).text((2, 2), ch, font=self.font, fill=255)
        return img.tobytes()

    def has_glyph(self, ch):
        if ch not in self.glyphs:
            self.glyphs[ch] = ch.isspace() or self.glyph_sig(ch) != self.notdef
        return self.glyphs[ch]

    def draw_char(self, d, x, y, ch, color, font):
        if ch == '⛔':  # no-entry sign: draw it, emoji fonts don't rasterise in Pillow
            r = SIZE * 0.42
            cx, cy = x + self.cell / 2 + 1, y + LINE_H / 2 - 1
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=COLORS['31'])
            d.rectangle([cx - r * 0.6, cy - r * 0.18, cx + r * 0.6, cy + r * 0.18], fill=(255, 255, 255))
            return
        f = font if self.has_glyph(ch) else self.fallback
        d.text((x, y + 2), ch, font=f, fill=color)

    def frame(self, lines, cursor=None):
        img = Image.new('RGB', (self.w, self.h), BG)
        d = ImageDraw.Draw(img)
        d.rounded_rectangle([0, 0, self.w - 1, self.h - 1], radius=10, fill=WINDOW)
        for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
            d.ellipse([16 + i * 20, 13, 28 + i * 20, 25], fill=c)
        title = 'undogen — verify'
        tw = self.font.getlength(title)
        d.text(((self.w - tw) / 2, 10), title, font=self.font, fill=COLORS['2'])
        y = TITLE_H + PAD_Y
        for line in lines:
            x = PAD_X
            for text, code in parse(line):
                color = COLORS.get(code, FG)
                font = self.bold if code == '1' else self.font
                for ch in text:
                    self.draw_char(d, x, y, ch, color, font)
                    x += self.cell
            y += LINE_H
        if cursor is not None:
            row, col = cursor
            cx = PAD_X + col * self.cell
            cy = TITLE_H + PAD_Y + row * LINE_H
            d.rectangle([cx, cy + 3, cx + self.cell - 2, cy + LINE_H - 2], fill=FG)
        return img


def main():
    output = capture()
    while output and not output[0].strip():
        output.pop(0)
    prompt = '\x1b[32m$\x1b[0m '
    cols = max(visible_len(l) for l in output + [prompt + SHOWN_CMD]) + 2
    rows = len(output) + 2
    r = Renderer(cols, rows)

    frames, durations = [], []

    def add(lines, ms, cursor=None):
        frames.append(r.frame(lines, cursor))
        durations.append(ms)

    # Idle prompt, then type the command.
    for blink in range(2):
        add([prompt], 350, (0, 2))
        add([prompt], 350)
    for i in range(0, len(SHOWN_CMD) + 1, 3):
        add([prompt + SHOWN_CMD[:i]], 45, (0, 2 + i))
    add([prompt + SHOWN_CMD], 500, (0, 2 + len(SHOWN_CMD)))

    # Replay the real output line by line.
    shown = [prompt + SHOWN_CMD, '']
    for line in output:
        shown.append(line)
        plain = ANSI.sub('', line)
        if not plain.strip():
            continue
        is_detail = plain.startswith('      ')
        add(list(shown), 70 if is_detail else 260)
    durations[-1] = 7000

    # One shared palette keeps colours stable and the file small.
    palette = frames[-1].quantize(colors=256, method=Image.Quantize.MAXCOVERAGE)
    gif = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    gif[0].save(OUT, save_all=True, append_images=gif[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f'{OUT}: {len(gif)} frames, {r.w}x{r.h}, {os.path.getsize(OUT) / 1024:.0f} KB')


if __name__ == '__main__':
    main()
