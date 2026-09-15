"""Build a crisp multi-resolution Windows icon from the checked-in MailAI logo."""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "app" / "web" / "static" / "assets" / "mailai-icon-256.png"
TARGET = ROOT / "build" / "mailai.ico"


def main():
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    image = Image.open(SOURCE).convert("RGBA")
    if image.size != (256, 256):
        raise ValueError(f"MailAI icon must be 256x256, got {image.size[0]}x{image.size[1]}")
    image.save(
        TARGET,
        format="ICO",
        sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40),
               (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"Generated {TARGET}")


if __name__ == "__main__":
    main()
