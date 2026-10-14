"""Real signed-caller/immutable-reader test; isolated Keychain, no UI or real data."""
import argparse,base64,hashlib,json,os
from pathlib import Path
import secrets,shutil,subprocess,sys,tempfile,zipfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from macos_signing import verify

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-directory',type=Path,default=Path('build/credential-agent-v1'))
    parser.add_argument('--caller-probes',type=Path)
    args=parser.parse_args()
    probes=args.caller_probes or args.artifact_directory/'credential-agent-probes.zip'
    with tempfile.TemporaryDirectory(prefix='mailai-agent-integration-') as folder:
        root=Path(folder);agent=root/'MailAICredentialAgent';migration=root/'MailAICredentialMigration'
        with zipfile.ZipFile(args.artifact_directory/'credential-agent-v1.zip') as archive:
            manifest=json.loads(archive.read('manifest.json'))
            for name,path in [('MailAICredentialAgent',agent),('MailAICredentialMigration',migration)]:
                payload=archive.read(name);assert hashlib.sha256(payload).hexdigest()==manifest['files'][name]['sha256']
                path.write_bytes(payload);path.chmod(0o700)
                verify(path,mode='self-signed',identifier=manifest['files'][name]['identifier'])
        with zipfile.ZipFile(probes) as archive:archive.extractall(root/'callers')
        keychain=root/'fixture.keychain-db';password=secrets.token_urlsafe(32)
        def security(*values):
            result=subprocess.run(['security',*map(str,values)],capture_output=True)
            if result.returncode:raise RuntimeError('Isolated Keychain setup failed')
        env=dict(os.environ,_MAILAI_TEST_AGENT_KEYCHAIN=str(keychain))
        def caller(number,action,allowed,reader=agent):
            executable=root/f'callers/caller-{number}.app/Contents/MacOS/MailAI';executable.chmod(0o700)
            result=subprocess.run([str(executable),str(reader),action],env=env,capture_output=True,text=True,timeout=15)
            if allowed:assert result.returncode==0 and 'status=0' in result.stdout and (action!='read' or 'length=44' in result.stdout),result.stdout
            else:assert result.returncode!=0 and 'status=-25293' in result.stdout and 'length=0' in result.stdout,result.stdout
            print(result.stdout.strip(),flush=True)
        try:
            security('create-keychain','-p',password,keychain);security('unlock-keychain','-p',password,keychain)
            caller('1','add',True);caller('1','read',True);caller('2','read',True)
            copied=root/'another-path';shutil.copy2(agent,copied);caller('2','read',True,copied)
            caller('3','read',False);caller('4','read',False)
            denied=subprocess.run([str(agent)],input='read\n0\n\n',env=env,capture_output=True,text=True,timeout=15)
            assert denied.returncode!=0 and denied.stdout=='-25293\n\n'
            oldkey=os.urandom(32);nonce=os.urandom(12);magic=b'MAILAI-CREDENTIALS2\0'
            record={'version':1,'items':{'mail-a':'fixture-a','mail-b':'fixture-b'},'removed':['removed']}
            plaintext=json.dumps(record).encode();blob=magic+nonce+AESGCM(oldkey).encrypt(nonce,plaintext,magic)
            envelope=json.dumps({'key':base64.b64encode(oldkey).decode(),'ciphertext':base64.b64encode(blob).decode()})
            destination=root/'migrated.enc'
            result=subprocess.run([str(migration),str(agent),str(destination)],input=envelope,env=env,capture_output=True,text=True,timeout=20)
            assert result.returncode==0,result.stderr
            encrypted=destination.read_bytes();newmagic=b'MAILAI-CREDENTIALS3\0'
            assert encrypted.startswith(newmagic)
            reopened=json.loads(AESGCM(bytes(32)).decrypt(encrypted[len(newmagic):len(newmagic)+12],encrypted[len(newmagic)+12:],newmagic))
            assert reopened==record and destination.stat().st_mode&0o777==0o600
            assert not any(value in encrypted for value in (b'fixture-a',b'fixture-b',oldkey))
            repeated=subprocess.run([str(migration),str(agent),str(destination)],input=envelope,env=env,capture_output=True,text=True,timeout=20)
            assert repeated.returncode!=0 and destination.read_bytes()==encrypted
            print('PASS changed signed caller builds and relocated unchanged reader; unsigned/wrong-ID/direct callers denied; complete encrypted migration; no authorization UI',flush=True)
        finally:
            if keychain.exists():security('delete-keychain',keychain)
if __name__=='__main__':main()
