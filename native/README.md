# macOS credential reader lifecycle

`app/native/credential-agent-v1.zip` is a sealed, signed archive. Release builds
must include it byte for byte and must not compile or sign its executable again.
The application installs the reader at the same private user path and pins both
the archive hash and certificate/application identifier before execution.

The login Keychain can retain `cdhash:` partition permissions for self-signed
applications, independent of the designated requirement. Recompiling an app
changes that hash. A fixed reader keeps the credential access process unchanged,
while checking the live caller's pinned certificate and MailAI identifier for
every request. Its test mode uses a separate synthetic service, never the MailAI
service. No general-purpose system utility is a reader for new master items.

The one-time signed migration client accepts an authenticated old vault through
stdin and writes a new encrypted file, retaining the old vault. It never outputs
credential bytes, prompts silently, overwrites a destination or changes an
existing Keychain ACL. All records and deletion tombstones migrate together.

Rebuilding this archive is a reader identity change and needs a new versioned
account/archive and an explicit migration. Use the signing check workflow only
for a deliberate new reader, review native sources, run the real signed-caller
integration test on the supported OS, then commit the archive and its pin. Never
regenerate v1 as part of a normal application release.
