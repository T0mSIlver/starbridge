A test CA and a certificate it signed for `push.test`, valid until 2126, for `pinned.test.ts`.
Made with `openssl req -x509` (the CA) and `openssl x509 -req` (the leaf, SAN `DNS:push.test`).
The CA's key is not kept: nothing else is signed with it.
