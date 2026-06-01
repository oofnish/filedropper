/*
 * FileDropper — peer-to-peer file & clipboard transfer over WebRTC.
 *
 * Two ways to connect:
 *   Easy   — a short word code (e.g. "badger-having-toothache"). A public
 *            PeerJS signaling broker maps the code to the WebRTC handshake.
 *            Only the tiny handshake touches the broker; files flow directly
 *            peer-to-peer (over the LAN when both devices are on it).
 *   Manual — copy/paste the WebRTC descriptors directly. No broker, no third
 *            party, works fully offline. The code is long because it carries
 *            the entire handshake (keys, ICE candidates) itself.
 *
 * Both paths converge on one `channel` object (a real RTCDataChannel for the
 * manual path, or a thin wrapper around a PeerJS DataConnection) and share the
 * same message protocol below.
 */

'use strict';

// ---- Config ---------------------------------------------------------------

const CHUNK_SIZE = 16 * 1024;          // safe per-message size for a DataChannel
const BUFFER_HIGH = 1 * 1024 * 1024;   // pause sending above this many buffered bytes
const ICE_TIMEOUT_MS = 3000;           // stop waiting for ICE (host candidates arrive first)
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// PeerJS ids are global on the shared public broker, so namespace ours to
// avoid clashing with other apps' ids.
const PEER_PREFIX = 'filedropper-v1-';

// ---- State ----------------------------------------------------------------

let pc = null;        // RTCPeerConnection (manual path)
let peer = null;      // PeerJS Peer (easy path)
let channel = null;   // active transport (RTCDataChannel or PeerJS wrapper)
let incoming = null;  // in-progress received file: { meta, chunks, received, bar }

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

// ============================================================================
// EASY PATH — friendly word code via PeerJS broker
// ============================================================================

// A small, easy-to-type word list. Three words ~= 21 bits, plenty for a
// transient, namespaced id; collisions are retried on 'unavailable-id'.
const WORDS = [
  'badger', 'maple', 'pickle', 'rocket', 'velvet', 'cobalt', 'mango', 'pebble',
  'tiger', 'willow', 'cactus', 'lemon', 'falcon', 'gravy', 'hazel', 'igloo',
  'jelly', 'kettle', 'lilac', 'meadow', 'noodle', 'olive', 'puffin', 'quartz',
  'raisin', 'sunny', 'turnip', 'umbra', 'violet', 'walnut', 'xenon', 'yodel',
  'zebra', 'amber', 'breezy', 'cocoa', 'dapper', 'ember', 'fizzy', 'glimmer',
  'happy', 'ivory', 'jolly', 'kooky', 'lucky', 'mellow', 'nifty', 'orbit',
  'plucky', 'quirky', 'rusty', 'snappy', 'tidy', 'upbeat', 'vivid', 'witty',
  'having', 'finding', 'chasing', 'baking', 'jumping', 'singing', 'dancing',
  'toothache', 'sandwich', 'umbrella', 'lantern', 'compass', 'biscuit',
  'penguin', 'dragon', 'wizard', 'comet', 'puzzle', 'anchor', 'beacon', 'tunnel',
];

function randomCode() {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return pick() + '-' + pick() + '-' + pick();
}

function brokerAvailable() {
  return typeof Peer !== 'undefined';
}

// If the broker never confirms our registration, surface an error instead of
// hanging silently on the placeholder.
const BROKER_TIMEOUT_MS = 15000;
let brokerTimer = null;

function armBrokerWatchdog(statusId) {
  clearTimeout(brokerTimer);
  brokerTimer = setTimeout(() => {
    $(statusId).textContent =
      'Could not reach the signaling broker. Check your internet, or use the manual code.';
    setStatus('Connection error', 'error');
  }, BROKER_TIMEOUT_MS);
}

function clearBrokerWatchdog() {
  clearTimeout(brokerTimer);
  brokerTimer = null;
}

// Create side: register a code and wait for the other device to connect.
function startEasyHost() {
  if (!brokerAvailable()) {
    $('create-easy-status').textContent =
      'Signaling library could not load (offline?). Use the manual code below.';
    switchCreate('manual');
    return;
  }
  $('my-code').textContent = '…';
  $('create-easy-status').textContent = 'Setting up…';

  const code = randomCode();
  peer = new Peer(PEER_PREFIX + code, { debug: 1 });
  armBrokerWatchdog('create-easy-status');

  peer.on('open', () => {
    clearBrokerWatchdog();
    $('my-code').textContent = code;
    setStatus('Waiting for the other device…', 'connecting');
    $('create-easy-status').textContent = 'Waiting for the other device to join…';
  });

  peer.on('connection', (conn) => {
    // Accept the first peer only.
    setStatus('Connecting…', 'connecting');
    adoptPeerConnection(conn);
  });

  peer.on('error', (err) => {
    clearBrokerWatchdog();
    if (err.type === 'unavailable-id') {
      // Rare clash on the shared broker — try a fresh code.
      peer.destroy();
      startEasyHost();
      return;
    }
    handleBrokerError(err, 'create-easy-status');
  });
}

// Join side: connect to the code typed by the user.
function startEasyJoin() {
  const code = $('join-code').value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!code) { $('join-easy-status').textContent = 'Enter a code first.'; return; }
  if (!brokerAvailable()) {
    $('join-easy-status').textContent =
      'Signaling library could not load (offline?). Use the manual code below.';
    switchJoin('manual');
    return;
  }

  $('join-easy-status').textContent = 'Connecting…';
  setStatus('Connecting…', 'connecting');
  peer = new Peer({ debug: 1 });
  armBrokerWatchdog('join-easy-status');

  peer.on('open', () => {
    clearBrokerWatchdog();
    // 'raw' passes strings and binary through untouched; we do our own
    // chunking. (Note: PeerJS has no 'none' serializer despite the enum.)
    const conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'raw' });
    adoptPeerConnection(conn);
  });

  peer.on('error', (err) => {
    clearBrokerWatchdog();
    if (err.type === 'peer-unavailable') {
      $('join-easy-status').textContent = 'No device is waiting on that code. Double-check it.';
      setStatus('Not connected', 'idle');
      return;
    }
    handleBrokerError(err, 'join-easy-status');
  });
}

function handleBrokerError(err, statusId) {
  console.error('PeerJS error:', err);
  $(statusId).textContent = 'Signaling problem (' + err.type + '). Try again, or use the manual code.';
  setStatus('Connection error', 'error');
}

// Wrap a PeerJS DataConnection so the rest of the app can treat it like an
// RTCDataChannel (same .send / .bufferedAmount / on{open,close,message}).
function adoptPeerConnection(conn) {
  channel = wrapPeerConn(conn);
  setupChannel();
  if (conn.open) channel.onopen();   // may already be open by the time we attach
}

function wrapPeerConn(conn) {
  const w = {
    binaryType: 'arraybuffer',
    bufferedAmountLowThreshold: CHUNK_SIZE,
    onopen: null, onclose: null, onmessage: null,
    get readyState() { return conn.open ? 'open' : 'connecting'; },
    get bufferedAmount() {
      return conn.dataChannel ? conn.dataChannel.bufferedAmount : 0;
    },
    send(data) { conn.send(data); },
    close() { conn.close(); },
    addEventListener(ev, cb, opts) {
      if (conn.dataChannel) conn.dataChannel.addEventListener(ev, cb, opts);
    },
  };
  conn.on('open', () => {
    if (conn.dataChannel) conn.dataChannel.bufferedAmountLowThreshold = CHUNK_SIZE;
    if (w.onopen) w.onopen();
  });
  conn.on('close', () => w.onclose && w.onclose());
  conn.on('data', (d) => w.onmessage && w.onmessage({ data: d }));
  return w;
}

// ============================================================================
// MANUAL PATH — copy/paste descriptors (gzip + base64, 1-char compression flag)
// ============================================================================

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

function createPeerConnection() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connecting' || s === 'new') setStatus('Connecting…', 'connecting');
    else if (s === 'connected') setStatus('Connected', 'connected');
    else if (s === 'failed') setStatus('Connection failed', 'error');
    else if (s === 'disconnected' || s === 'closed') setStatus('Disconnected', 'closed');
  };
  pc.ondatachannel = (e) => { channel = e.channel; setupChannel(); };
}

// Resolve once ICE gathering completes, or after a timeout (host candidates,
// which are all we need on a LAN, arrive first).
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

async function buildOffer() {
  createPeerConnection();
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

async function generateAnswer() {
  const code = $('offer-in').value;
  if (!code.trim()) return alert('Paste the invite code first.');
  setStatus('Generating reply…', 'connecting');
  createPeerConnection();
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

// ============================================================================
// SHARED — channel setup, messaging, transfers
// ============================================================================

function setupChannel() {
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = CHUNK_SIZE;
  channel.onopen = () => { setStatus('Connected', 'connected'); show('panel-transfer'); };
  channel.onclose = () => setStatus('Disconnected', 'closed');
  channel.onmessage = onMessage;
}

function onMessage(e) {
  if (typeof e.data === 'string') {
    const msg = JSON.parse(e.data);
    if (msg.type === 'text') addReceivedText(msg.content);
    else if (msg.type === 'file-meta') startReceiveFile(msg);
    else if (msg.type === 'file-end') finishReceiveFile();
  } else if (incoming) {
    const buf = e.data.byteLength !== undefined ? e.data : new Uint8Array(e.data);
    incoming.chunks.push(buf);
    incoming.received += buf.byteLength;
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
      channel.send(value.slice(off, off + CHUNK_SIZE));
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

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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

// ---- Mode toggles & reset -------------------------------------------------

function teardownConnections() {
  clearBrokerWatchdog();
  if (channel) try { channel.close(); } catch (_) {}
  if (pc) try { pc.close(); } catch (_) {}
  if (peer) try { peer.destroy(); } catch (_) {}
  channel = null; pc = null; peer = null; incoming = null;
}

function switchCreate(mode) {
  teardownConnections();
  $('create-easy').classList.toggle('hidden', mode !== 'easy');
  $('create-manual').classList.toggle('hidden', mode !== 'manual');
  if (mode === 'easy') startEasyHost();
  else { $('offer-out').value = ''; $('answer-in').value = ''; buildOffer(); }
}

function switchJoin(mode) {
  teardownConnections();
  $('join-easy').classList.toggle('hidden', mode !== 'easy');
  $('join-manual').classList.toggle('hidden', mode !== 'manual');
  $('answer-step').classList.add('hidden');
  if (mode === 'manual') { $('offer-in').value = ''; $('answer-out').value = ''; }
  if (mode === 'easy') { $('join-easy-status').textContent = ''; }
}

function reset() {
  teardownConnections();
  ['offer-out', 'answer-in', 'offer-in', 'answer-out', 'text-input', 'join-code'].forEach((id) => ($(id).value = ''));
  $('answer-step').classList.add('hidden');
  $('create-easy').classList.remove('hidden');
  $('create-manual').classList.add('hidden');
  $('join-easy').classList.remove('hidden');
  $('join-manual').classList.add('hidden');
  setStatus('Not connected', 'idle');
  show('panel-role');
}

// ---- Wiring ---------------------------------------------------------------

function copyFrom(id, btn) {
  navigator.clipboard.writeText($(id).textContent || $(id).value).then(() => {
    const old = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = old), 1500);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // Role selection
  $('btn-create').onclick = () => { show('panel-create'); switchCreate('easy'); };
  $('btn-join').onclick = () => { show('panel-join'); switchJoin('easy'); };

  // Easy path
  $('btn-copy-code').onclick = (e) => copyFrom('my-code', e.target);
  $('btn-join-connect').onclick = startEasyJoin;
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') startEasyJoin(); });

  // Manual path
  $('btn-accept-answer').onclick = acceptAnswer;
  $('btn-gen-answer').onclick = generateAnswer;
  $('btn-copy-offer').onclick = (e) => copyFrom('offer-out', e.target);
  $('btn-copy-answer').onclick = (e) => copyFrom('answer-out', e.target);

  // Mode toggles
  $('to-create-manual').onclick = () => switchCreate('manual');
  $('to-create-easy').onclick = () => switchCreate('easy');
  $('to-join-manual').onclick = () => switchJoin('manual');
  $('to-join-easy').onclick = () => switchJoin('easy');

  // Cancel / disconnect
  $('btn-disconnect').onclick = reset;
  document.querySelectorAll('.back').forEach((b) => (b.onclick = reset));

  // File picker + drag & drop
  const dz = $('dropzone');
  $('file-input').onchange = (e) => { [...e.target.files].forEach(sendFile); e.target.value = ''; };
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
