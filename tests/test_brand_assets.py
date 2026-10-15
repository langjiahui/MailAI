"""Committed native assets must share geometry, retain alpha and be crisp."""
from pathlib import Path
import unittest
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'app/web/static/assets'


class BrandAssetsTest(unittest.TestCase):
    def test_native_assets_have_real_content_and_transparent_corners(self):
        for name, size in [('mailai-mark.png', 1024), ('mailai-app-icon-1024.png', 1024),
                           ('mailai-icon-256.png', 256), ('mailai-menu-template.png', 64)]:
            with self.subTest(name=name), Image.open(ASSETS / name) as image:
                self.assertEqual(image.size, (size, size))
                self.assertEqual(image.mode, 'RGBA')
                self.assertEqual(image.getpixel((0, 0))[3], 0)
                self.assertIsNotNone(image.getbbox())
        with Image.open(ASSETS / 'mailai-menu-template.png') as image:
            self.assertTrue(all(image.getpixel((x, y))[:3] == (0, 0, 0)
                                for y in range(image.height) for x in range(image.width)
                                if image.getpixel((x, y))[3]))

    def test_regenerated_svg_matches_shared_brand_geometry(self):
        import re
        source = (ROOT / 'app/web/static/brand.js').read_text()
        paths = re.findall(r"\['(?:front|back)', '[a-z]+', '([^']+)'\]", source)
        self.assertEqual(len(paths), 4)
        for name in ['mailai-mark.svg', 'mailai-app-icon.svg']:
            svg = (ASSETS / name).read_text()
            for path in paths:
                self.assertIn(f'd="{path}"', svg)

    def test_native_blue_identity_and_windows_notification_icon(self):
        with Image.open(ASSETS / 'mailai-app-icon-1024.png') as image:
            colors = image.getcolors(1024 * 1024)
            blue = sum(count for count, (r,g,b,a) in colors if a == 255 and b > r + 30 and g > r + 20)
            self.assertGreater(blue, 20000)
        with Image.open(ASSETS / 'mailai-icon-256.ico') as image:
            self.assertIn((16, 16), image.ico.sizes())
            self.assertIn((256, 256), image.ico.sizes())


if __name__ == '__main__':
    unittest.main()
