/* ============================================================
   ROZI — Telegram OTP Verification Server
   ============================================================
   WHAT THIS DOES:
   - Runs your Telegram bot AND a small web API in one program.
   - The bot learns each user's phone number (they tap a button).
   - When the app asks, it generates a random 6-digit code and
     sends it to that user inside Telegram.
   - The app then asks this server "is 1-2-3-4-5-6 correct?" and
     the server answers yes/no.

   HOW THE APP AND BOT TALK TO EACH OTHER:
   They never talk directly. This server sits in the middle and
   remembers two things in memory:
     phoneToChat:  phone number  ->  Telegram chat id
     otpStore:     phone number  ->  { the code, when it expires }
   The app talks to this server over HTTP (fetch).
   This server talks to Telegram using the bot token.
   ============================================================ */

const express     = require('express');
const cors        = require('cors');
const TelegramBot = require('node-telegram-bot-api');

// Your bot token from @BotFather goes in an environment variable
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN is missing. Set it in your environment variables.');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
app.use(cors());                 // lets your app (on Netlify) call this server
app.use(express.json());         // lets the server read JSON bodies

/* ---- MEMORY: the bridge between app and bot ----
   NOTE: this is in-memory, so it resets if the server restarts.
   Fine for testing. For production, store these in a database. */
const phoneToChat = new Map();   // "+998901234567" -> 123456789 (chat id)
const otpStore    = new Map();   // "+998901234567" -> { code: "482913", expires: 1699999999 }

/* ============================================================
   PART 1 — THE BOT
   ============================================================ */

// When a user opens the bot and taps Start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    'Assalomu alaykum! Rozi ilovasi uchun raqamingizni tasdiqlang.\n\n' +
    'Pastdagi tugmani bosing 👇',
    {
      reply_markup: {
        keyboard: [[{ text: '📱 Raqamimni yuborish', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    }
  );
});

// When the user taps "Share my number", Telegram sends us their REAL number
bot.on('contact', (msg) => {
  let phone = msg.contact.phone_number.replace(/\s/g, '');
  if (!phone.startsWith('+')) phone = '+' + phone;

  // Remember: this phone belongs to this Telegram chat
  phoneToChat.set(phone, msg.chat.id);

  bot.sendMessage(msg.chat.id,
    '✅ Rahmat! Raqamingiz tasdiqlandi.\n\n' +
    'Endi ilovaga qaytib, "Kodni olish" tugmasini bosing.',
    { reply_markup: { remove_keyboard: true } }
  );
});

/* ============================================================
   PART 2 — THE WEB API (the app calls these)
   ============================================================ */

// Health check — open the server URL in a browser to see this
app.get('/', (_req, res) => {
  res.json({ status: 'Rozi OTP server is running' });
});

// STEP 1: app asks the server to send a code to a phone number
app.post('/send-otp', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: 'phone_required' });

  // Has this person started the bot and shared their number yet?
  const chatId = phoneToChat.get(phone);
  if (!chatId) {
    // No — tell the app to show "open the bot first" screen
    return res.json({ success: false, error: 'not_started' });
  }

  // Yes — make a random 6-digit code, valid for 5 minutes
  const code = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(phone, { code, expires: Date.now() + 5 * 60 * 1000 });

  // Send the code to the user inside Telegram
  bot.sendMessage(chatId,
    '🔐 Rozi tasdiqlash kodingiz:\n\n' +
    '*' + code + '*\n\n' +
    'Kod 5 daqiqa amal qiladi.',
    { parse_mode: 'Markdown' }
  );

  res.json({ success: true });
});

// STEP 2: app asks the server to check the code the user typed
app.post('/verify-otp', (req, res) => {
  const { phone, code } = req.body;
  const record = otpStore.get(phone);

  if (!record)                       return res.json({ verified: false, reason: 'no_code' });
  if (Date.now() > record.expires) { otpStore.delete(phone); return res.json({ verified: false, reason: 'expired' }); }
  if (record.code !== String(code))  return res.json({ verified: false, reason: 'wrong_code' });

  // Correct! Remove the used code and confirm.
  otpStore.delete(phone);
  res.json({ verified: true });
});

/* ============================================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Rozi OTP server 2 running on port ' + PORT));
