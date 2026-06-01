/*
 * FileDropper — peer-to-peer file & clipboard transfer over WebRTC.
 *
 * No backend: the two browsers exchange a one-time "code" (an SDP descriptor
 * plus gathered ICE candidates, gzipped + base64) by copy/paste. After that a
 * direct DataChannel carries everything. On a LAN the connection is made
 * machine-to-machine, so data never leaves the network.
 */

'use strict';

// ---- Config ---------------------------------------------------------------

// 16 KiB is a safe per-message size for RTCDataChannel across browsers.
const CHUNK_SIZE = 16 * 1024;
// Pause sending once this many bytes are buffered, resume when drained.
const BUFFER_HIGH = 1 * 1024 * 1024;
// Stop waiting for ICE candidates after this long (host candidates, which are
// all we need on a LAN, arrive almost immediately).
const ICE_TIMEOUT_MS = 3000;
// A public STUN server helps when the two peers aren't on the same LAN.
// On an isolated network it simply times out and host candidates are used.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// ---- State ----------------------------------------------------------------

let pc = null;          // RTCPeerConnection
let channel = null;     // RTCDataChannel
let incoming = null;    // in-progress received file: { meta, chunks, received, li, bar }

// ---- DOM helpers ----------------------------------------------------------

const $ = (id) => document.getElementById(id);

function show(panelId) {
  document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
  $(panelId).classList.remove('hidden');
}

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status status--' + kind;
}

// ---- Signal encoding (gzip + base64, with a 1-char compression flag) ------

function bytesToB64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function encodeSignal(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if ('CompressionStream' in window) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return 'G' + bytesToB64(new Uint8Array(buf));
  }
  return 'U' + bytesToB64(bytes);
}

async function decodeSignal(str) {
  str = str.trim();
  const flag = str[0];
  let bytes = b64ToBytes(str.slice(1));
  if (flag === 'G') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ---- WebRTC setup ---------------------------------------------------------

function createPeer() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connecting' || s === 'new') setStatus('Connecting…', 'connecting');
    else if (s === 'connected') setStatus('Connected', 'connected');
    else if (s === 'failed') setStatus('Connection failed', 'error');
    else if (s === 'disconnected' || s === 'closed') setStatus('Disconnected', 'closed');
  };

  // The joining peer receives the channel created by the other side.
  pc.ondatachannel = (e) => {
    channel = e.channel;
    setupChannel();
  };
}

// Resolves once ICE gathering is complete, or after a timeout (host
// candidates are enough on a LAN and arrive first).
function waitForIce() {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, ICE_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function setupChannel() {
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = CHUNK_SIZE;
  channel.onopen = () => { setStatus('Connected', 'connected'); show('panel-transfer'); };
  channel.onclose = () => setStatus('Disconnected', 'closed');
  channel.onmessage = onMessage;
}

// ---- Role: create (offerer) ----------------------------------------------

async function startOffer() {
  show('panel-create');
  setStatus('Generating invite…', 'connecting');
  createPeer();
  channel = pc.createDataChannel('filedropper', { ordered: true });
  setupChannel();

  await pc.setLocalDescription(await pc.createOffer());
  await waitForIce();
  $('offer-out').value = await encodeSignal(pc.localDescription);
  setStatus('Waiting for reply code…', 'connecting');
}

async function acceptAnswer() {
  const code = $('answer-in').value;
  if (!code.trim()) return alert('Paste the reply code first.');
  try {
    await pc.setRemoteDescription(await decodeSignal(code));
    setStatus('Connecting…', 'connecting');
  } catch (err) {
    alert('That reply code could not be read: ' + err.message);
  }
}

// ---- Role: join (answerer) ------------------------------------------------

async function generateAnswer() {
  const code = $('offer-in').value;
  if (!code.trim()) return alert('Paste the invite code first.');
  setStatus('Generating reply…', 'connecting');
  createPeer();
  try {
    await pc.setRemoteDescription(await decodeSignal(code));
  } catch (err) {
    setStatus('Bad invite code', 'error');
    return alert('That invite code could not be read: ' + err.message);
  }
  await pc.setLocalDescription(await pc.createAnswer());
  await waitForIce();
  $('answer-out').value = await encodeSignal(pc.localDescription);
  $('answer-step').classList.remove('hidden');
  setStatus('Send the reply code back…', 'connecting');
}

// ---- Messaging ------------------------------------------------------------

function onMessage(e) {
  if (typeof e.data === 'string') {
    const msg = JSON.parse(e.data);
    if (msg.type === 'text') addReceivedText(msg.content);
    else if (msg.type === 'file-meta') startReceiveFile(msg);
    else if (msg.type === 'file-end') finishReceiveFile();
  } else if (incoming) {
    incoming.chunks.push(e.data);
    incoming.received += e.data.byteLength;
    if (incoming.bar) incoming.bar.value = incoming.received;
  }
}

function sendText(text) {
  if (!text || !channel || channel.readyState !== 'open') return;
  channel.send(JSON.stringify({ type: 'text', content: text }));
  addOutgoingNote('Text sent (' + text.length + ' chars)');
}

// Wait until the send buffer drains below the threshold (backpressure).
function waitForDrain() {
  if (channel.bufferedAmount < BUFFER_HIGH) return Promise.resolve();
  return new Promise((resolve) => {
    channel.addEventListener('bufferedamountlow', resolve, { once: true });
  });
}

async function sendFile(file) {
  if (!channel || channel.readyState !== 'open') return;
  const note = addOutgoingFile(file.name, file.size);
  channel.send(JSON.stringify({
    type: 'file-meta', name: file.name, size: file.size, mime: file.type,
  }));

  const reader = file.stream().getReader();
  let sent = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let off = 0; off < value.byteLength; off += CHUNK_SIZE) {
      await waitForDrain();
      channel.send(value.subarray(off, off + CHUNK_SIZE));
      sent += Math.min(CHUNK_SIZE, value.byteLength - off);
      note.bar.value = sent;
    }
  }
  channel.send(JSON.stringify({ type: 'file-end' }));
  note.markDone();
}

// ---- Receiving UI ---------------------------------------------------------

function clearEmpty(listId) {
  const empty = $(listId).querySelector('.empty');
  if (empty) empty.remove();
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function startReceiveFile(meta) {
  clearEmpty('received');
  const li = document.createElement('li');
  li.innerHTML = `<span class="name">${escapeHtml(meta.name)}</span>
    <span class="meta">${fmtSize(meta.size)}</span>`;
  const bar = document.createElement('progress');
  bar.max = meta.size; bar.value = 0;
  li.appendChild(bar);
  $('received').prepend(li);
  incoming = { meta, chunks: [], received: 0, li, bar };
}

function finishReceiveFile() {
  if (!incoming) return;
  const { meta, chunks, li, bar } = incoming;
  const blob = new Blob(chunks, { type: meta.mime || 'application/octet-stream' });
  bar.remove();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = meta.name;
  a.textContent = 'Save';
  li.appendChild(a);
  incoming = null;
}

function addReceivedText(text) {
  clearEmpty('received');
  const li = document.createElement('li');
  const pre = document.createElement('pre');
  pre.className = 'text-content';
  pre.textContent = text;
  const copy = document.createElement('button');
  copy.className = 'mini';
  copy.textContent = 'Copy';
  copy.onclick = () => {
    navigator.clipboard.writeText(text).then(() => {
      copy.textContent = 'Copied!';
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    });
  };
  li.innerHTML = '<span class="name">📋 Text</span>';
  li.appendChild(copy);
  li.appendChild(pre);
  $('received').prepend(li);
}

// ---- Outgoing UI ----------------------------------------------------------

function addOutgoingFile(name, size) {
  clearEmpty('outgoing');
  const li = document.createElement('li');
  li.innerHTML = `<span class="name">${escapeHtml(name)}</span>
    <span class="meta">${fmtSize(size)}</span>`;
  const bar = document.createElement('progress');
  bar.max = size; bar.value = 0;
  li.appendChild(bar);
  $('outgoing').prepend(li);
  return {
    bar,
    markDone() {
      bar.remove();
      const tag = document.createElement('span');
      tag.className = 'meta';
      tag.textContent = '✓ sent';
      li.appendChild(tag);
    },
  };
}

function addOutgoingNote(text) {
  clearEmpty('outgoing');
  const li = document.createElement('li');
  li.innerHTML = `<span class="name">${escapeHtml(text)}</span>`;
  $('outgoing').prepend(li);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---- Reset ----------------------------------------------------------------

function reset() {
  if (channel) try { channel.close(); } catch (_) {}
  if (pc) try { pc.close(); } catch (_) {}
  channel = null; pc = null; incoming = null;
  ['offer-out', 'answer-in', 'offer-in', 'answer-out', 'text-input'].forEach((id) => ($(id).value = ''));
  $('answer-step').classList.add('hidden');
  setStatus('Not connected', 'idle');
  show('panel-role');
}

// ---- Wiring ---------------------------------------------------------------

function copyFrom(id, btn) {
  navigator.clipboard.writeText($(id).value).then(() => {
    const old = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = old), 1500);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  $('btn-create').onclick = startOffer;
  $('btn-join').onclick = () => show('panel-join');
  $('btn-accept-answer').onclick = acceptAnswer;
  $('btn-gen-answer').onclick = generateAnswer;
  $('btn-copy-offer').onclick = (e) => copyFrom('offer-out', e.target);
  $('btn-copy-answer').onclick = (e) => copyFrom('answer-out', e.target);
  $('btn-disconnect').onclick = reset;
  document.querySelectorAll('.back').forEach((b) => (b.onclick = reset));

  // File picker + drag & drop
  const dz = $('dropzone');
  $('file-input').onchange = (e) => {
    [...e.target.files].forEach(sendFile);
    e.target.value = '';
  };
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.remove('dragover');
  }));
  dz.addEventListener('drop', (e) => [...e.dataTransfer.files].forEach(sendFile));

  // Text send
  $('btn-send-text').onclick = () => {
    const t = $('text-input').value;
    if (t) { sendText(t); $('text-input').value = ''; }
  };

  // Paste anywhere → send clipboard files or text
  document.addEventListener('paste', (e) => {
    if (!channel || channel.readyState !== 'open') return;
    if (document.activeElement === $('text-input')) return; // let the textarea handle it
    const files = [...(e.clipboardData.files || [])];
    if (files.length) { e.preventDefault(); files.forEach(sendFile); return; }
    const text = e.clipboardData.getData('text');
    if (text) { e.preventDefault(); sendText(text); }
  });
});
