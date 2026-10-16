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
        with Image.open(ASSETS / 'mailai-lockup.png') as image:
            self.assertEqual(image.size, (2057, 764))
            self.assertEqual(image.getpixel((0, 0))[3], 0)

    def test_regenerated_svg_matches_shared_brand_geometry(self):
        import re
        source = (ROOT / 'app/web/static/brand.js').read_text()
        paths = re.findall(r"\['(?:front|back)', '[a-z]+', '([^']+)'\]", source)
        self.assertEqual(len(paths), 4)
        for name in ['mailai-mark.svg', 'mailai-app-icon.svg', 'mailai-lockup.svg']:
            svg = (ASSETS / name).read_text()
            for path in paths:
                self.assertIn(f'd="{path}"', svg)

    def test_glass_native_identity_and_windows_notification_icon(self):
        with Image.open(ASSETS / 'mailai-app-icon-1024.png') as image:
            colors = image.getcolors(1024 * 1024)
            dark_mark = sum(count for count, (r,g,b,a) in colors
                            if a == 255 and max(r,g,b) < 110)
            green = sum(count for count, (r,g,b,a) in colors
                        if a > 200 and g > r + 20 and g > b + 5)
            blue = sum(count for count, (r,g,b,a) in colors
                       if a > 200 and b > r + 20 and b > g + 5)
            self.assertGreater(dark_mark, 20000, 'Dark folded M stays readable')
            self.assertGreater(green, 10000, 'Default theme green remains visible')
            self.assertGreater(blue, 1000, 'Baowu blue remains visible in the reflections')
            self.assertEqual(image.getchannel('A').point(lambda a: 255 if a > 200 else 0).getbbox(),
                             (100, 100, 924, 924), 'Dock body matches neighboring app sizes')
        template = (ROOT / 'scripts/brand-app-icon.svg').read_text()
        self.assertIn('#005eaa', template)
        self.assertIn('#94c7b6', template)
        self.assertNotIn('<path', template, 'M geometry belongs to brand.js')
        with Image.open(ASSETS / 'mailai-icon-256.ico') as image:
            self.assertIn((16, 16), image.ico.sizes())
            self.assertIn((256, 256), image.ico.sizes())


if __name__ == '__main__':
    unittest.main()
