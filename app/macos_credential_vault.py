"""One Keychain master key protects all local credentials using AES-256-GCM.

Legacy individual items are adopted lazily after their authorized read. This
module never broadens their ACLs and never deletes them during migration.
The encrypted file lives outside mail backup/portable-export directories.
"""
import base64
import json
import logging
import os
from pathlib import Path
import tempfile
import threading

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from . import macos_keychain
from .paths import USER_DIR

log=logging.getLogger(__name__)
SERVICE='MailAI'
MASTER_ACCOUNT='credential-vault-key:v2'
LEGACY_MASTER_ACCOUNT='credential-vault-key:v1'
MAGIC=b'MAILAI-CREDENTIALS2\0'
LEGACY_MAGIC=b'MAILAI-CREDENTIALS1\0'
ERROR=-1
MAX_BYTES=16*1024*1024


class Vault:
    def __init__(self,path):
        self.path=Path(path)
        self._lock=threading.RLock()
        self._key=None
        self._records=None
        self._quiet_failure=None
        self._broken=False
        self._needs_upgrade=False

    def _master(self,interactive,*,create=False):
        if self._key is not None:
            return 0
        if self._quiet_failure is not None and not interactive:
            return self._quiet_failure
        status,value=macos_keychain.read_for_app(SERVICE,MASTER_ACCOUNT,interactive=interactive)
        if status==macos_keychain.NOT_FOUND and create:
            # Losing a key must never overwrite an existing encrypted file.
            if self.path.exists() and not self._needs_upgrade:
                return ERROR
            key=os.urandom(32)
            status=macos_keychain.add_new(SERVICE,MASTER_ACCOUNT,base64.urlsafe_b64encode(key).decode('ascii'),interactive=interactive)
            if status==macos_keychain.DUPLICATE:
                # Another creator won. Use its key; never replace it.
                self._quiet_failure=None
                return self._master(interactive)
            if status==0:
                self._key=key
                self._quiet_failure=None
                return 0
        elif status==0:
            try:
                if len(value)!=44:
                    raise ValueError('Invalid master key')
                key=base64.b64decode(value.encode('ascii'),altchars=b'-_',validate=True)
                if len(key)!=32:
                    raise ValueError('Invalid master key')
                self._key=key
                self._quiet_failure=None
                return 0
            except (ValueError,UnicodeError):
                status=ERROR
        self._quiet_failure=status
        return status

    def _load(self,interactive):
        if self._broken:
            return ERROR
        if self._records is not None:
            return 0
        if not self.path.exists():
            self._records={'items':{},'removed':[]}
            return 0
        try:
            if self.path.stat().st_size>MAX_BYTES:
                raise ValueError('Credential vault is too large')
            blob=self.path.read_bytes()
            magic=LEGACY_MAGIC if blob.startswith(LEGACY_MAGIC) else MAGIC
            if not blob.startswith(magic) or len(blob)<len(magic)+28:
                raise ValueError('Invalid credential vault')
            if magic==LEGACY_MAGIC:
                self._needs_upgrade=True
                if not interactive:
                    return -25308
                status,value=macos_keychain.read_for_app(SERVICE,LEGACY_MASTER_ACCOUNT,interactive=True)
                if status:
                    return ERROR if status==macos_keychain.NOT_FOUND else status
                if len(value)!=44:
                    raise ValueError('Invalid legacy master')
                key=base64.b64decode(value.encode('ascii'),altchars=b'-_',validate=True)
                if len(key)!=32:
                    raise ValueError('Invalid legacy master')
            else:
                status=self._master(interactive)
                if status:
                    return ERROR if status==macos_keychain.NOT_FOUND else status
                key=self._key
            nonce=blob[len(magic):len(magic)+12]
            plaintext=AESGCM(key).decrypt(nonce,blob[len(magic)+12:],magic)
            record=json.loads(plaintext)
            if (record.get('version')!=1 or not isinstance(record.get('items'),dict)
                or not isinstance(record.get('removed'),list)
                or not all(isinstance(k,str) and isinstance(v,str) for k,v in record['items'].items())
                or not all(isinstance(k,str) for k in record['removed'])):
                raise ValueError('Invalid credential vault schema')
            self._records={'items':record['items'],'removed':record['removed']}
            return 0
        except Exception as exc:
            self._broken=True
            log.warning('Could not open encrypted credential vault (%s)',type(exc).__name__)
            return ERROR

    def get(self,key,*,interactive=False):
        if not self._lock.acquire(blocking=interactive):
            return -25308,''
        try:
            status=self._load(interactive)
            if status:
                return status,''
            if self._needs_upgrade:
                if not interactive or not self._write(self._records,interactive=True):
                    return -25308,''
            if key in self._records['items']:
                return 0,self._records['items'][key]
            if key in self._records['removed']:
                return 0,''  # Tombstones block revival from a legacy item.
            return macos_keychain.NOT_FOUND,''
        finally:
            self._lock.release()

    def _write(self,record,interactive):
        status=self._master(interactive,create=True)
        if status:
            return False
        plaintext=json.dumps({'version':1,**record},ensure_ascii=False,separators=(',',':')).encode('utf-8')
        if len(plaintext)+len(MAGIC)+28>MAX_BYTES:
            return False
        nonce=os.urandom(12)
        blob=MAGIC+nonce+AESGCM(self._key).encrypt(nonce,plaintext,MAGIC)
        temp=None
        try:
            self.path.parent.mkdir(parents=True,exist_ok=True)
            fd,temp=tempfile.mkstemp(prefix='.credential-vault-',dir=self.path.parent)
            with os.fdopen(fd,'wb') as output:
                output.write(blob);output.flush();os.fsync(output.fileno())
            os.replace(temp,self.path)
            self._records=record
            self._needs_upgrade=False
            return True
        except OSError as exc:
            log.warning('Could not save encrypted credential vault (%s)',type(exc).__name__)
            return False
        finally:
            if temp is not None:
                Path(temp).unlink(missing_ok=True)

    def put(self,key,secret,*,interactive=False):
        if not isinstance(key,str) or not key or not isinstance(secret,str) or not secret:
            return False
        with self._lock:
            if self._load(interactive):
                return False
            if not self._needs_upgrade and self._records['items'].get(key)==secret and key not in self._records['removed']:
                return True
            record={'items':{**self._records['items'],key:secret},
                    'removed':[k for k in self._records['removed'] if k!=key]}
            return self._write(record,interactive)

    def remove(self,key,*,interactive=False):
        if not isinstance(key,str) or not key:
            return False
        with self._lock:
            if self._load(interactive):
                return False
            record={'items':{k:v for k,v in self._records['items'].items() if k!=key},
                    'removed':list(set(self._records['removed'])|{key})}
            return self._write(record,interactive)


_instance=Vault(USER_DIR/'credentials.v1.enc')


def get(key,*,interactive=False):
    return _instance.get(key,interactive=interactive)


def put(key,secret,*,interactive=False):
    return _instance.put(key,secret,interactive=interactive)


def remove(key,*,interactive=False):
    return _instance.remove(key,interactive=interactive)


def unlocked():
    return _instance._key is not None and _instance._records is not None and not _instance._broken and not _instance._needs_upgrade


def contains(key):
    record=_instance._records
    return bool(record is not None and not _instance._needs_upgrade and key in record['items'])
