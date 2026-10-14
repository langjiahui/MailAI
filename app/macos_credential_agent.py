"""Install the same signed reader bytes across normal MailAI upgrades.

The immutable reader validates the live parent signature before every operation.
Its credentials are exchanged through pipes; no general system-tool reader is
trusted and secrets never appear in argv, persisted logs or diagnostics.
"""
import hashlib
import io
import json
import os
import re
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import zipfile
from .paths import APP_DIR, USER_DIR

ACCOUNT='credential-agent-key:v1'
IDENTIFIER='com.langjiahui.mailai.credential-agent.v1'
CERTIFICATE='a04567b09e3230ba773b70e6b1343244b387186b'
ARCHIVE_SHA256='f310603b06ab8811f314e85faac9e316695b4163ed1fe4c1a9a7d4a2164f704b'
ERROR=-1
_verified_path=None

def install():
    global _verified_path
    if sys.platform!='darwin' or not getattr(sys,'frozen',False):
        raise RuntimeError('Credential agent requires a signed installed application')
    archive=(APP_DIR/'app/native/credential-agent-v1.zip').read_bytes()
    if hashlib.sha256(archive).hexdigest()!=ARCHIVE_SHA256:
        raise ValueError('Credential agent archive identity mismatch')
    directory=USER_DIR/'credential-agent/v1'
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    for parent in (directory.parent,directory):
        attributes=parent.lstat()
        if stat.S_ISLNK(attributes.st_mode) or attributes.st_uid!=os.getuid():
            raise ValueError('Credential agent directory is not private')
        parent.chmod(0o700)
    with zipfile.ZipFile(io.BytesIO(archive)) as package:
        manifest=json.loads(package.read('manifest.json'))
        entry=manifest['files']['MailAICredentialAgent']
        payload=package.read('MailAICredentialAgent')
    digest=entry['sha256']
    if (manifest['certificate_sha1'].lower()!=CERTIFICATE or entry['identifier']!=IDENTIFIER
        or hashlib.sha256(payload).hexdigest()!=digest):
        raise ValueError('Credential reader identity mismatch')
    path=directory/'MailAICredentialAgent'
    if path.is_symlink():
        raise ValueError('Credential agent must not be a link')
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
        descriptor,temporary=tempfile.mkstemp(prefix='.agent-',dir=directory)
        try:
            with os.fdopen(descriptor,'wb') as output:
                output.write(payload);output.flush();os.fsync(output.fileno())
            os.chmod(temporary,0o700);os.replace(temporary,path)
            _verified_path=None
        finally:
            Path(temporary).unlink(missing_ok=True)
    path.chmod(0o700)
    if _verified_path!=path:
        requirement=f'identifier "{IDENTIFIER}" and certificate leaf = H"{CERTIFICATE}"'
        subprocess.run(['/usr/bin/codesign','--verify','--strict','-R','='+requirement,str(path)],
                       check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
        _verified_path=path
    return path

def request(action,*,interactive=False,secret=''):
    if action not in ('read','add'):
        return ERROR,''
    if action=='add' and not re.fullmatch(r'[A-Za-z0-9_-]{43}=',secret):
        return ERROR,''
    try:
        path=install()
        response=subprocess.run([str(path)],input=f'{action}\n{int(interactive)}\n{secret}\n',
            capture_output=True,text=True,timeout=180 if interactive else 10)
        if response.returncode or len(response.stdout)>128:
            return ERROR,''
        fields=response.stdout.split('\n')
        if len(fields)<2:
            return ERROR,''
        status=int(fields[0])
        return status,fields[1] if status==0 else ''
    except (OSError,ValueError,KeyError,RuntimeError,subprocess.SubprocessError,zipfile.BadZipFile):
        return ERROR,''
