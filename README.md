# 📨 FileDropper

Peer-to-peer file and clipboard transfer between two browsers on the same
network — **no server, no upload, no native app**. Your data travels directly
device-to-device over a WebRTC DataChannel, so it never leaves your LAN.

The whole thing is static HTML/CSS/JS, so it can be served straight from
**GitHub Pages**.

## How it works

WebRTC lets two browsers open a direct peer-to-peer connection. The only thing
that normally needs a server is *signaling* — the initial exchange of
connection descriptors. FileDropper skips the server by having you copy/paste a
one-time **code** between the two devices:

1. On device **A**, click **Create a connection** → copy the *invite code*.
2. On device **B**, click **Join a connection** → paste the invite code →
   **Generate reply code** → copy the *reply code*.
3. Back on device **A**, paste the reply code → **Connect**.

Once connected, either side can:

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
- No dependencies, no build step — three files: `index.html`, `style.css`,
  `app.js`.
