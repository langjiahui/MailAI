from __future__ import annotations

import hashlib
import sys
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(argv: list[str]) -> int:
    if not argv:
        print("Usage: write_sha256.py FILE [FILE ...]", file=sys.stderr)
        return 2
    for raw_path in argv:
        path = Path(raw_path)
        if not path.is_file():
            print(f"Missing artifact: {path}", file=sys.stderr)
            return 1
        value = sha256(path)
        checksum_path = path.with_name(f"{path.name}.sha256")
        checksum_path.write_text(f"{value}  {path.name}\n", encoding="ascii")
        print(f"SHA256 ({path.name}): {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
