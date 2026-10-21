"""Adapt the existing MailAI icon to Apple's opaque square icon format."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
image = Image.open(ROOT / 'app/web/static/assets/mailai-app-icon-1024.png').convert('RGBA')
image = image.crop(image.getbbox()).resize((1024, 1024), Image.Resampling.LANCZOS)
background = Image.new('RGBA', image.size, '#d9f0ed')
background.alpha_composite(image)
background.convert('RGB').save(ROOT / 'mobile/ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png')
