require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

async function translate(text, from, to) {
  try {
    console.log(`[translate] ${from}→${to}: "${text.slice(0, 60)}"`);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await response.json();
    const result = data[0]?.map(chunk => chunk[0]).join('') || null;
    if (!result) { console.error('[translate] Empty result'); return null; }
    console.log(`[translate] Result: "${result.slice(0, 80)}"`);
    return result;
  } catch (e) {
    console.error('[translate] Error:', e.message);
    return null;
  }
}

function makeRoomCode() {
  const words = ['lion','tiger','eagle','river','moon','star','cloud','fire','wave','tree'];
  const w1 = words[Math.floor(Math.random() * words.length)];
  const w2 = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${w1}-${w2}-${num}`;
}

io.on('connection', (socket) => {

  socket.on('create-room', ({ lang }) => {
    const code = makeRoomCode();
    rooms[code] = { en: null, hi: null };
    rooms[code][lang] = socket.id;
    socket.join(code);
    socket.roomCode = code;
    socket.lang = lang;
    socket.emit('room-created', { code });
    console.log(`[room] Created ${code} by ${lang} user`);
  });

  socket.on('join-room', ({ code, lang }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', { msg: 'Room not found!' });
    if (room[lang]) return socket.emit('error', { msg: `${lang === 'en' ? 'English' : 'Hindi'} seat already taken!` });
    room[lang] = socket.id;
    socket.join(code);
    socket.roomCode = code;
    socket.lang = lang;
    socket.emit('joined', { code });
    io.to(code).emit('partner-joined', { lang });
    console.log(`[room] ${lang} user joined ${code} — room state: ${JSON.stringify(room)}`);
  });

  // ── TEXT CHAT ──
  socket.on('message', async ({ text }) => {
    const code = socket.roomCode;
    const from = socket.lang;
    const to = from === 'en' ? 'hi' : 'en';
    const room = rooms[code];
    console.log(`[message] from=${from}, to=${to}, code=${code}, room=${JSON.stringify(room)}`);
    if (!room || !from) return console.error('[message] Missing room or lang');

    socket.emit('chat', { text, lang: from, type: 'sent', translated: null });

    const translation = await translate(text, from, to);
    const finalTranslation = translation || '(translation unavailable)';

    const otherSocketId = room[to];
    console.log(`[message] otherSocketId=${otherSocketId}`);
    if (otherSocketId) {
      io.to(otherSocketId).emit('chat', { text, lang: from, type: 'received', translated: finalTranslation });
    } else {
      // fallback: find other socket in same room with different lang
      const socketsInRoom = await io.in(code).fetchSockets();
      const other = socketsInRoom.find(s => s.id !== socket.id);
      if (other) {
        other.emit('chat', { text, lang: from, type: 'received', translated: finalTranslation });
        room[to] = other.id; // fix the room record
        console.log(`[message] Fixed missing socket: room[${to}]=${other.id}`);
      }
    }
    socket.emit('translation-update', { original: text, translated: finalTranslation, to });
  });

  // ── SPEECH MESSAGE (audio call transcript) ──
  socket.on('speech-message', async ({ text }) => {
    const code = socket.roomCode;
    const from = socket.lang;
    const to = from === 'en' ? 'hi' : 'en';
    const room = rooms[code];
    if (!room) return;

    const translation = await translate(text, from, to);
    const finalTranslation = translation || text;

    // Send translated text to the other person (they will speak it)
    const otherSocketId = room[to];
    if (otherSocketId) {
      io.to(otherSocketId).emit('speak-translated', {
        original: text,
        translated: finalTranslation,
        fromLang: from,
        toLang: to
      });
    }

    // Show in sender's chat as well
    socket.emit('chat', { text, lang: from, type: 'sent', translated: finalTranslation });
  });

  // ── WebRTC SIGNALING ──
  socket.on('webrtc-offer', ({ offer }) => {
    const code = socket.roomCode;
    const from = socket.lang;
    const to = from === 'en' ? 'hi' : 'en';
    const room = rooms[code];
    if (!room) return;
    const otherSocketId = room[to];
    if (otherSocketId) io.to(otherSocketId).emit('webrtc-offer', { offer });
  });

  socket.on('webrtc-answer', ({ answer }) => {
    const code = socket.roomCode;
    const from = socket.lang;
    const to = from === 'en' ? 'hi' : 'en';
    const room = rooms[code];
    if (!room) return;
    const otherSocketId = room[to];
    if (otherSocketId) io.to(otherSocketId).emit('webrtc-answer', { answer });
  });

  socket.on('webrtc-ice', ({ candidate }) => {
    const code = socket.roomCode;
    const from = socket.lang;
    const to = from === 'en' ? 'hi' : 'en';
    const room = rooms[code];
    if (!room) return;
    const otherSocketId = room[to];
    if (otherSocketId) io.to(otherSocketId).emit('webrtc-ice', { candidate });
  });

  socket.on('call-request', () => {
    const code = socket.roomCode;
    const from = socket.lang;
    const to = from === 'en' ? 'hi' : 'en';
    const room = rooms[code];
    if (!room) return;
    const otherSocketId = room[to];
    if (otherSocketId) io.to(otherSocketId).emit('call-request');
  });

  socket.on('call-accept', () => {
    const code = socket.roomCode;
    const from = socket.lang;
    const to = from === 'en' ? 'hi' : 'en';
    const room = rooms[code];
    if (!room) return;
    const otherSocketId = room[to];
    if (otherSocketId) io.to(otherSocketId).emit('call-accept');
  });

  socket.on('call-reject', () => {
    const code = socket.roomCode;
    const from = socket.lang;
    const to = from === 'en' ? 'hi' : 'en';
    const room = rooms[code];
    if (!room) return;
    const otherSocketId = room[to];
    if (otherSocketId) io.to(otherSocketId).emit('call-reject');
  });

  socket.on('call-end', () => {
    const code = socket.roomCode;
    const from = socket.lang;
    const to = from === 'en' ? 'hi' : 'en';
    const room = rooms[code];
    if (!room) return;
    const otherSocketId = room[to];
    if (otherSocketId) io.to(otherSocketId).emit('call-end');
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (code && rooms[code]) {
      console.log(`[room] ${socket.lang} user left ${code}`);
      rooms[code][socket.lang] = null;
      io.to(code).emit('partner-left');
      if (!rooms[code].en && !rooms[code].hi) {
        delete rooms[code];
        console.log(`[room] Room ${code} deleted (empty)`);
      }
    }
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`BabelTalk running on port ${PORT}`));
