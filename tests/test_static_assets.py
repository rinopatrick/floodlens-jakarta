import re

from floodlens.config import PUBLIC_DIR

INDEX = (PUBLIC_DIR / "index.html").read_text(encoding="utf-8")


def test_no_third_party_script_or_style_cdn():
    assert "unpkg.com" not in INDEX
    assert "cdn.jsdelivr.net" not in INDEX


def test_every_local_asset_reference_exists():
    references = re.findall(r'(?:src|href)="(/[^"]+)"', INDEX)

    assert references
    for reference in references:
        assert (PUBLIC_DIR / reference.lstrip("/")).is_file(), reference


def test_vendor_css_images_exist():
    for stylesheet in (PUBLIC_DIR / "vendor").rglob("*.css"):
        css = stylesheet.read_text(encoding="utf-8")
        for raw in re.findall(r"url\(([^)]+)\)", css):
            reference = raw.strip("'\" ")
            if reference.startswith(("data:", "http:", "https:", "//", "#")):
                continue
            assert (stylesheet.parent / reference).is_file(), (
                stylesheet,
                reference,
            )


def test_vendor_licenses_are_present():
    assert (PUBLIC_DIR / "vendor/leaflet/LICENSE").is_file()
    assert (PUBLIC_DIR / "vendor/leaflet-draw/LICENSE.md").is_file()
