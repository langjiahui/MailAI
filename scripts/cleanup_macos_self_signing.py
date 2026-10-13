"""Restore the build search list and remove only the temporary signing keychain."""
import json
import os
from pathlib import Path
import subprocess

root=Path(os.environ['RUNNER_TEMP'])
snapshot=root/'mailai-signing-search-list.json'
if snapshot.exists():
    previous=json.loads(snapshot.read_text())
    subprocess.run(['security','list-keychains','-d','user','-s',*previous],check=True)
    snapshot.unlink()
keychain=root/'mailai-self-signing.keychain-db'
if keychain.exists():
    subprocess.run(['security','delete-keychain',str(keychain)],check=True)
