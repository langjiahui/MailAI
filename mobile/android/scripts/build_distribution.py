#!/usr/bin/env python3
"""Build with a persistent local key; never print signing secrets or commit them."""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
config_path = Path(os.environ.get("MAILAI_ANDROID_SIGNING_CONFIG", Path.home() / ".local/share/mailai/android/signing.json"))
config = json.loads(config_path.read_text())
env = os.environ.copy()
env.update(MAILAI_ANDROID_KEYSTORE=config["keystore"], MAILAI_ANDROID_STORE_PASSWORD=config["password"], MAILAI_ANDROID_KEY_PASSWORD=config["password"])
subprocess.run([str(root / "gradlew"), "-p", str(root), ":app:assembleRelease", ":app:lintRelease", *sys.argv[1:]], env=env, check=True)
