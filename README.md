# 📨 FileDropper

Peer-to-peer file and clipboard transfer between two browsers on the same
network — **no server, no upload, no native app**. Your data travels directly
device-to-device over a WebRTC DataChannel, so it never leaves your LAN.

The whole thing is static HTML/CSS/JS, so it can be served straight from
**GitHub Pages**.

## How it works

WebRTC lets two browsers open a direct peer-to-peer connection. The only thing
that normally needs a server is *signaling* — the initial exchange of
connection descriptors (which carry encryption keys and network candidates and
are therefore too large to type by hand). FileDropper offers two ways to get
through that step:

### Easy mode (default) — a short word code

1. Device **A**: click **Create a connection** → it shows a code like
   `badger-having-toothache`.
2. Device **B**: click **Join a connection** → type the code → **Connect**.

A free public [PeerJS](https://peerjs.com) broker maps the code to the WebRTC
handshake. **Only the tiny handshake touches the broker** — the files
themselves flow directly peer-to-peer (over the LAN when both devices are on
it). Needs internet to reach the broker for the initial connect.

### Manual mode (fallback) — copy/paste, fully offline

No broker, no third party — works even with no internet. The trade-off is a
long code, because it carries the entire handshake itself:

1. Device **A**: **Create** → *Use a manual code* → copy the *invite code*.
2. Device **B**: **Join** → *Use a manual code* → paste it →
   **Generate reply code** → copy the *reply code*.
3. Device **A**: paste the reply code → **Connect**.

### Either way, once connected

- **Drag & drop files** (or pick them) to send them — chunked with backpressure
  so even large files transfer reliably.
- **Send text** with the text box.
- **Paste** (⌘/Ctrl-V) anywhere on the page to send clipboard text or images.

Received items appear with a **Save** link (files) or **Copy** button (text).

## Running it

### Locally
Just open `index.html` — or serve the folder:
```bash
python3 -m http.server 8000   # then visit http://localhost:8000
```

### On GitHub Pages
1. Push to GitHub.
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, pick your branch and `/ (root)`.
3. Visit `https://<user>.github.io/filedropper/` on both devices.

## Notes & limitations

- **Same LAN works out of the box.** Browsers use local (mDNS) ICE candidates,
  so the two machines connect directly. The bundled Google STUN server only
  helps if the peers are on *different* networks; on an isolated LAN it's
  ignored.
- **HTTPS is required** for clipboard read/write and is provided by GitHub
  Pages automatically (and by `localhost`).
- Received files are assembled in memory before download, so extremely large
  files are bounded by available RAM. (Streaming to disk via the File System
  Access API is a possible future enhancement.)
- No build step. The PeerJS library is vendored at `vendor/peerjs.min.js`, so
  the page is self-contained — only the easy-mode *broker* (not the page) needs
  the network. Manual mode needs nothing external at all.
- The easy-mode broker is the free public PeerJS cloud server. To avoid any
  third party, you can run your own [PeerServer](https://github.com/peers/peerjs-server)
  and point `Peer` at it via the `host`/`port`/`path` options in `app.js`.
- Peer ids on the public broker are global, so codes are namespaced
  (`filedropper-v1-…`) and a clashing id is retried automatically.
