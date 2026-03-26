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

// ── Startup check ──
if (!GEMINI_KEY) {
  console.error('❌ GEMINI_API_KEY is not set in .env — translation will not work!');
} else {
  console.log('✅ GEMINI_API_KEY loaded:', GEMINI_KEY.slice(0, 8) + '...');
}

// Store rooms: roomCode -> { en: socketId, hi: socketId }
const rooms = {};

async function translate(text, from, to) {
  const names = { en: 'English', hi: 'Hindi' };

  if (!GEMINI_KEY) {
    console.error('translate() called but GEMINI_API_KEY is missing');
    return null;
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    const body = {
      contents: [{
        parts: [{
          text: `Translate this ${names[from]} text to ${names[to]}. Return ONLY the translated text, no explanations, no quotes, no extra text.\n\nText: ${text}`
        }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 512,
      }
    };

    console.log(`[translate] ${from}→${to}: "${text.slice(0, 60)}"`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    // Log full response on error
    if (!response.ok || data.error) {
      console.error('[translate] Gemini API error:', JSON.stringify(data, null, 2));
      return null;
    }

    const translated = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!translated) {
      console.error('[translate] Empty result from Gemini. Full response:', JSON.stringify(data, null, 2));
      return null;
    }

    console.log(`[translate] Result: "${translated.slice(0, 80)}"`);
    return translated;

  } catch (e) {
    console.error('[translate] Network/parse error:', e.message);
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
      // Set null instead of delete — keeps room object alive for the remaining user
      rooms[code][socket.lang] = null;
      io.to(code).emit('partner-left');
      // Clean up only when BOTH seats are empty
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
