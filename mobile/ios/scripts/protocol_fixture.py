"""Local TLS IMAP/SMTP fixture. Synthetic data only; never connects to an email provider."""
import json
import base64
import argparse
import asyncio
import re
import ssl
from email import policy
from email.parser import BytesParser

BODY = b"Synthetic offline message.\r\n"
ATTACHMENT = base64.b64encode(b"synthetic attachment")
ARCHIVED = set()
ENVELOPE = '("Tue, 20 Oct 2026 12:00:00 +0000" "Synthetic mail" (("Sender" NIL "sender" "example.com")) NIL NIL ((NIL NIL "demo" "example.com")) NIL NIL NIL "<synthetic@example.com>")'


async def write(writer, value):
    writer.write(value.encode() if isinstance(value, str) else value)
    await writer.drain()


async def imap(reader, writer):
    await write(writer, '* OK synthetic IMAP fixture\r\n')
    try:
        while line := await reader.readline():
            command = line.decode().strip()
            tag = command.split()[0]
            upper = command.upper()
            if ' CAPABILITY' in upper:
                await write(writer, '* CAPABILITY IMAP4rev1 UIDPLUS MOVE AUTH=PLAIN\r\n')
            elif ' SELECT ' in upper or ' EXAMINE ' in upper:
                await write(writer, '* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 10] valid\r\n* OK [UIDNEXT 8] next\r\n')
            elif ' LIST ' in upper:
                await write(writer, '* LIST () "/" "INBOX"\r\n* LIST (\\Sent) "/" "Sent"\r\n* LIST (\\Archive) "/" "Archive"\r\n')
            elif ' FETCH ' in upper:
                if 'BODY.PEEK[' in upper:
                    section = re.search(r'BODY\.PEEK\[([^]]*)\]', command, re.I).group(1)
                    partial = '<0>' if '<' in command else ''
                    payload = ATTACHMENT if section == '2' else BODY
                    await write(writer, f'* 1 FETCH (UID 7 BODY[{section}]{partial} {{{len(payload)}}}\r\n'.encode() + payload + b')\r\n')
                else:
                    await write(writer, f'* 1 FETCH (UID 7 FLAGS () INTERNALDATE "20-Oct-2026 12:00:00 +0000" RFC822.SIZE 200 ENVELOPE {ENVELOPE} BODYSTRUCTURE (("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" {len(BODY)} 1)("APPLICATION" "OCTET-STREAM" ("NAME" "synthetic.txt") NIL NIL "BASE64" {len(ATTACHMENT)} NIL ("ATTACHMENT" ("FILENAME" "synthetic.txt"))) "MIXED"))\r\n')
            elif ' MOVE ' in upper:
                await write(writer, f'{tag} OK [COPYUID 10 7 9] moved\r\n'); continue
            elif ' SEARCH ' in upper:
                if 'MESSAGE-ID' in upper:
                    match = re.search(r'<[^>]+>', command)
                    exists = match and match.group(0) in ARCHIVED
                    await write(writer, '* SEARCH' + (' 7' if exists else '') + '\r\n')
                else:
                    await write(writer, '* SEARCH 7\r\n')
            elif ' APPEND ' in upper:
                size = int(re.search(r'\{(\d+)\+?\}$', command).group(1))
                await write(writer, '+ send literal\r\n')
                literal = await reader.readexactly(size)
                parsed = BytesParser(policy=policy.default).parsebytes(literal)
                if parsed.get('Message-ID'): ARCHIVED.add(str(parsed['Message-ID']))
                await reader.readline()
            elif ' LOGOUT' in upper:
                await write(writer, f'* BYE fixture closing\r\n{tag} OK logout\r\n'); break
            elif ' AUTHENTICATE ' in upper and len(command.split()) < 4:
                await write(writer, '+ \r\n'); await reader.readline()
            await write(writer, f'{tag} OK completed\r\n')
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()


async def smtp(reader, writer):
    await write(writer, '220 fixture.example ESMTP\r\n')
    uncertain = False
    try:
        while line := await reader.readline():
            upper = line.decode().upper().strip()
            if upper.startswith(('EHLO ', 'HELO ')):
                await write(writer, '250-fixture.example\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n')
            elif upper.startswith('AUTH LOGIN'):
                await write(writer, '334 VXNlcm5hbWU6\r\n'); await reader.readline()
                await write(writer, '334 UGFzc3dvcmQ6\r\n'); await reader.readline()
                await write(writer, '235 2.7.0 authenticated\r\n')
            elif upper.startswith('AUTH PLAIN'):
                if len(upper.split()) < 3:
                    await write(writer, '334 \r\n'); await reader.readline()
                await write(writer, '235 2.7.0 authenticated\r\n')
            elif upper.startswith('RCPT TO:'):
                uncertain = uncertain or 'UNCERTAIN@EXAMPLE.COM' in upper
                await write(writer, '250 2.1.5 accepted\r\n')
            elif upper == 'DATA':
                await write(writer, '354 send content\r\n')
                content = bytearray()
                while (part := await reader.readline()) not in (b'.\r\n', b''):
                    content.extend(part)
                parsed = BytesParser(policy=policy.default).parsebytes(bytes(content))
                body = parsed.get_body(preferencelist=('plain',))
                text = body.get_content() if body else ''
                if parsed.get('Bcc') is not None:
                    await write(writer, '550 5.7.1 Bcc must not be present in delivered headers\r\n')
                elif 'synthetic' not in text.lower():
                    await write(writer, '550 5.7.1 fixture accepts synthetic tests only\r\n')
                elif uncertain:
                    writer.close(); return
                else:
                    await write(writer, '250 2.0.0 accepted synthetic message\r\n')
            elif upper == 'QUIT':
                await write(writer, '221 bye\r\n'); break
            else:
                await write(writer, '250 OK\r\n')
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()


async def model_http(reader, writer):
    try:
        header = await reader.readuntil(b'\r\n\r\n')
        path = header.split(b' ')[1].decode()
        match = re.search(rb'Content-Length: (\d+)', header, re.I)
        length = int(match.group(1)) if match else 0
        if length > 100000: return
        content = await reader.readexactly(length)
        if path.startswith('/redirect/'):
            await write(writer, 'HTTP/1.1 302 Found\r\nLocation: https://localhost:18443/leak/chat/completions\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            return
        payload = json.loads(content) if content else {}
        if path.startswith('/leak/'): payload = {'model': 'fixture'}
        if payload.get('model') != 'fixture':
            await write(writer, 'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return
        if path.startswith('/slow/'):
            await asyncio.sleep(4)
        result = {'choices': [{'finish_reason': 'length' if path.startswith('/incomplete/') else 'stop', 'message': {'content': 'synthetic model response'}}]}
        body = json.dumps(result).encode()
        await write(writer, f'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode() + body)
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        writer.close()


async def main(args):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(args.cert, args.key)
    servers = [await asyncio.start_server(imap, '127.0.0.1', 1993, ssl=context),
               await asyncio.start_server(smtp, '127.0.0.1', 1465, ssl=context),
               await asyncio.start_server(model_http, '127.0.0.1', 18443, ssl=context)]
    print('Synthetic TLS IMAP/SMTP fixtures ready', flush=True)
    await asyncio.gather(*(server.serve_forever() for server in servers))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cert', required=True); parser.add_argument('--key', required=True)
    asyncio.run(main(parser.parse_args()))
