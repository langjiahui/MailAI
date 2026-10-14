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


if __name__ == '__main__':
    unittest.main()
