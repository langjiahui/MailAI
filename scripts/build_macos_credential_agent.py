"""One-time build of the immutable, signed credential reader and migration client."""
import hashlib,json,os
from pathlib import Path
import subprocess,zipfile
from macos_signing import sign,verify,fingerprint
ROOT=Path(__file__).resolve().parents[1]
AGENT_ID='com.langjiahui.mailai.credential-agent.v1'
MIGRATION_ID='com.langjiahui.mailai.credential-migration.v1'

def main():
    output=ROOT/'build/credential-agent-v1';output.mkdir(parents=True,exist_ok=True)
    entries={}
    for name,source,identifier,compiler in (
        ('MailAICredentialAgent','macos_credential_agent.c',AGENT_ID,['xcrun','clang','-Wno-deprecated-declarations','-O2','-framework','Security','-framework','CoreFoundation']),
        ('MailAICredentialMigration','macos_credential_migration.swift',MIGRATION_ID,['xcrun','swiftc','-O','-target','arm64-apple-macosx13.0'])):
        target=output/name
        subprocess.run([*compiler,str(ROOT/'native'/source),'-o',str(target)],check=True)
        sign(target,identifier=identifier)
        entries[name]={'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'identifier':identifier,'source_sha256':hashlib.sha256((ROOT/'native'/source).read_bytes()).hexdigest()}
    manifest={'version':1,'certificate_sha1':fingerprint(),'files':entries}
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    with zipfile.ZipFile(output/'credential-agent-v1.zip','w',zipfile.ZIP_DEFLATED) as archive:
        for name in (*entries,'manifest.json'):archive.write(output/name,name)
    print('Built immutable signed agent archive (must be reused byte-for-byte in future releases)')
if __name__=='__main__':main()
