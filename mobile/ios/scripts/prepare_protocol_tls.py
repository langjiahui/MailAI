"""Generate a per-run synthetic CA without inheriting host OpenSSL extensions."""
from pathlib import Path
import subprocess

root = Path('build')
root.mkdir(exist_ok=True)
(root / 'fixture-ca.cnf').write_text('''[req]
distinguished_name=dn
x509_extensions=ca_ext
prompt=no
[dn]
CN=MailAI Synthetic Test CA
[ca_ext]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
''')


def run(*args):
    subprocess.run(args, check=True)


run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', 'build/fixture-key.pem', '-out', 'build/fixture-ca.pem', '-config', 'build/fixture-ca.cnf')
run('openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'build/fixture-server-key.pem',
    '-out', 'build/fixture.csr', '-subj', '/CN=localhost')
(root / 'fixture.ext').write_text('''subjectAltName=DNS:localhost,IP:127.0.0.1
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
''')
run('openssl', 'x509', '-req', '-in', 'build/fixture.csr', '-CA', 'build/fixture-ca.pem',
    '-CAkey', 'build/fixture-key.pem', '-CAcreateserial', '-out', 'build/fixture-server.pem',
    '-days', '2', '-extfile', 'build/fixture.ext')
for name in ['fixture-ca.pem', 'fixture-server.pem']:
    text = subprocess.check_output(['openssl', 'x509', '-in', str(root / name), '-text', '-noout'], text=True)
    if text.count('X509v3 Basic Constraints:') != 1:
        raise SystemExit('Malformed fixture: duplicated or missing Basic Constraints')
run('security', 'verify-cert', '-c', 'build/fixture-server.pem', '-r', 'build/fixture-ca.pem', '-p', 'ssl', '-n', 'localhost')
