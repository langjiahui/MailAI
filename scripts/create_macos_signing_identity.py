"""Create a persistent private signing identity ONCE; never run during builds."""
import argparse
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import secrets
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def create(folder):
    folder = Path(folder).expanduser()
    folder.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(folder, 0o700)
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'MailAI Stable Release Signing')])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1))
        .not_valid_after(now+timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(True, False, False, False, False, False, False, False, False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CODE_SIGNING]), critical=True)
        .sign(key, hashes.SHA256()))
    password = secrets.token_urlsafe(48)
    files = {'identity.p12': pkcs12.serialize_key_and_certificates(b'MailAI Stable Release Signing', key, cert, None,
              serialization.PrivateFormat.PKCS12.encryption_builder().kdf_rounds(50000)
              .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC).hmac_hash(hashes.SHA1())
              .build(password.encode())),
             'password': password.encode(), 'certificate.pem': cert.public_bytes(serialization.Encoding.PEM)}
    for filename, data in files.items():
        with os.fdopen(os.open(folder/filename, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600), 'wb') as stream:
            stream.write(data)
    print('Created private identity; keep this directory backed up securely. No private material was printed.')

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    create(parser.parse_args().directory)
