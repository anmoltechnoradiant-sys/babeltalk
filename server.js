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

// Store rooms: roomCode -> { en: socketId, hi: socketId }
const rooms = {};

async function translate(text, from, to) {
  try {
    console.log(`[translate] ${from}→${to}: "${text.slice(0, 60)}"`);
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`;
    const response = await fetch(url);
    const data = await response.json();

    const result = data.responseData?.translatedText;

    if (!result) {
      console.error('[translate] Empty result. Response:', JSON.stringify(data));
      return null;
    }

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

  // Create a new room
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

  // Join existing room
  socket.on('join-room', ({ code, lang }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', { msg: 'Room not found!' });
    if (room[lang]) return socket.emit('error', { msg: `${lang === 'en' ? 'English' : 'Hindi'} seat already taken!` });

    room[lang] = socket.id;
    socket.join(code);
    socket.roomCode = code;
    socket.lang = lang;
    socket.emit('joined', { code });

    // Notify both users
    io.to(code).emit('partner-joined', { lang });
    console.log(`[room] ${lang} user joined ${code}`);
  });

  // Send message
  socket.on('message', async ({ text }) => {
    const code = socket.roomCode;
    const from = socket.lang;
    const to = from === 'en' ? 'hi' : 'en';
    const room = rooms[code];
    if (!room) return;

    // Send original to sender immediately (no translation yet)
    socket.emit('chat', { text, lang: from, type: 'sent', translated: null });

    // Translate
    const translation = await translate(text, from, to);
    const finalTranslation = translation || '(translation unavailable)';

    // Send translated to receiver
    const otherSocketId = room[to];
    if (otherSocketId) {
      io.to(otherSocketId).emit('chat', {
        text,
        lang: from,
        type: 'received',
        translated: finalTranslation
      });
    }

    // Update sender's message bubble with translation
    socket.emit('translation-update', {
      original: text,
      translated: finalTranslation,
      to
    });
  });

  // Disconnect
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
