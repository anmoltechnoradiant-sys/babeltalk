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

const GEMINI_KEY = process.env.GEMINI_API_KEY;

// Store rooms: roomCode -> { en: socketId, hi: socketId }
const rooms = {};

async function translate(text, from, to) {
  const names = { en: 'English', hi: 'Hindi' };
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Translate this ${names[from]} text to ${names[to]}. Return ONLY the translated text, no explanations.\n\nText: ${text}`
            }]
          }]
        })
      }
    );
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  } catch (e) {
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
  });

  // Send message
  socket.on('message', async ({ text }) => {
    const code = socket.roomCode;
    const from = socket.lang;
    const to = from === 'en' ? 'hi' : 'en';
    const room = rooms[code];
    if (!room) return;

    // Send original to sender
    socket.emit('chat', { text, lang: from, type: 'sent', translated: null });

    // Translate
    const translation = await translate(text, from, to);

    // Send translated to other person
    const otherSocketId = room[to];
    if (otherSocketId) {
      io.to(otherSocketId).emit('chat', { text, lang: from, type: 'received', translated: translation });
    }

    // Update sender with translation
    socket.emit('translation-update', { original: text, translated: translation, to });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (code && rooms[code]) {
      delete rooms[code][socket.lang];
      io.to(code).emit('partner-left');
      // Clean up empty rooms
      if (!rooms[code].en && !rooms[code].hi) delete rooms[code];
    }
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`BabelTalk running on port ${PORT}`));
