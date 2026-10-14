"""One-time build of the immutable, signed credential reader and migration client."""
import argparse,hashlib,json,os,shutil,sys
from pathlib import Path
import subprocess,zipfile,plistlib
from macos_signing import sign,verify,fingerprint
ROOT=Path(__file__).resolve().parents[1]
AGENT_ID='com.langjiahui.mailai.credential-agent.v1'
MIGRATION_ID='com.langjiahui.mailai.credential-migration.v1'

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probes-only',action='store_true',help='Reuse pinned archive; compile only disposable signed callers')
    args=parser.parse_args()
    output=ROOT/'build/credential-agent-v1';output.mkdir(parents=True,exist_ok=True)
    entries={}
    for name,source,identifier,compiler in (() if args.probes_only else (
        ('MailAICredentialAgent','macos_credential_agent.c',AGENT_ID,['xcrun','clang','-Wno-deprecated-declarations','-O2','-framework','Security','-framework','CoreFoundation']),
        ('MailAICredentialMigration','macos_credential_migration.swift',MIGRATION_ID,['xcrun','swiftc','-O','-target','arm64-apple-macosx13.0']))):
        target=output/name
        subprocess.run([*compiler,str(ROOT/'native'/source),'-o',str(target)],check=True)
        sign(target,identifier=identifier)
        entries[name]={'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'identifier':identifier,'source_sha256':hashlib.sha256((ROOT/'native'/source).read_bytes()).hexdigest()}
    if args.probes_only:
        sys.path.insert(0,str(ROOT))
        from app.macos_credential_agent import ARCHIVE_SHA256
        sealed=ROOT/'app/native/credential-agent-v1.zip'
        if hashlib.sha256(sealed.read_bytes()).hexdigest()!=ARCHIVE_SHA256:
            raise ValueError('Refusing changed immutable reader archive')
        shutil.copy2(sealed,output/sealed.name)
    else:
        manifest={'version':1,'certificate_sha1':fingerprint(),'files':entries}
        (output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
        with zipfile.ZipFile(output/'credential-agent-v1.zip','w',zipfile.ZIP_DEFLATED) as archive:
            for name in (*entries,'manifest.json'):archive.write(output/name,name)
    probes=ROOT/'build/credential-agent-probes';probes.mkdir(parents=True,exist_ok=True)
    for variant,identifier,adhoc in [('1','com.langjiahui.mailai',False),('2','com.langjiahui.mailai',False),('3','com.langjiahui.mailai',True),('4','com.langjiahui.mailai.unrelated',False)]:
        app=probes/f'caller-{variant}.app';executable=app/'Contents/MacOS/MailAI';executable.parent.mkdir(parents=True,exist_ok=True)
        (app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':identifier,'CFBundleVersion':variant,'CFBundleExecutable':'MailAI','CFBundlePackageType':'APPL'}))
        subprocess.run(['xcrun','clang','-O2',f'-DBUILD_VARIANT="{variant}"',str(ROOT/'tests/fixtures/macos_credential_agent_caller.c'),'-o',str(executable)],check=True)
        if adhoc:subprocess.run(['codesign','--force','--sign','-',str(app)],check=True)
        else:sign(app,identifier=identifier)
    with zipfile.ZipFile(output/'credential-agent-probes.zip','w',zipfile.ZIP_DEFLATED) as archive:
        for file in probes.rglob('*'):
            if file.is_file():archive.write(file,str(file.relative_to(probes)))
    print('Reused sealed reader; built disposable callers' if args.probes_only else 'Built immutable signed agent archive (must be reused byte-for-byte in future releases)')
if __name__=='__main__':main()
