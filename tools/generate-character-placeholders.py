"""Generate deterministic solid-colour WebP sprite sheets for the default character contract."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1] / "assets" / "character"
BASE_COLORS = {
    "idle": (70, 108, 151),
    "scanning": (55, 196, 207),
    "found": (255, 198, 73),
    "downloading": (113, 99, 227),
    "done": (67, 201, 130),
    "error": (239, 93, 104),
}


def frame_color(base: tuple[int, int, int], frame: int, frames: int) -> tuple[int, int, int, int]:
    offset = round(24 * frame / max(1, frames - 1)) - 12
    return tuple(max(0, min(255, channel + offset)) for channel in base) + (255,)


def main() -> None:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    width, height = manifest["width"], manifest["height"]
    for state_name, state in manifest["states"].items():
        frames = state["frames"]
        sheet = Image.new("RGBA", (width * frames, height))
        for frame in range(frames):
            block = Image.new("RGBA", (width, height), frame_color(BASE_COLORS[state_name], frame, frames))
            sheet.paste(block, (frame * width, 0))
        sheet.save(ROOT / state["sheet"], "WEBP", lossless=True, method=6)


if __name__ == "__main__":
    main()
