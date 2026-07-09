/* ============================================================
   ROZI — Telegram OTP Server (v2) — now with Supabase memory
   ============================================================
   WHY THIS VERSION:
   The old server kept each user's Telegram chat id only in memory.
   Render's free server sleeps and wipes memory, so the bot forgot
   users and forced them to /start + re-share their number every time.

   NOW: the phone -> chat link is saved in Supabase (contacts table)
   and the verification codes are saved too (otps table). So after a
   user shares their number ONCE, the bot remembers them forever —
   even after the server restarts. No more re-/start.
   ============================================================ */

const express     = require('express');
const cors        = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('BOT_TOKEN is missing.'); process.exit(1); }

// Uses env vars on Render if set; falls back to your public key (fine while RLS is off).
// When you turn RLS on later, set SUPABASE_KEY to your service_role key in Render.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ptwdnucguxzdxpwnulyq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_xPpqa4annkZVQrZAdTXThA_1FIHkwsr';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
app.use(cors());
app.use(express.json());

// Fast in-memory cache, backed by the database below
const phoneToChat = new Map();

function normPhone(p){ p = (p||'').replace(/\s/g,''); if(!p.startsWith('+')) p = '+'+p; return p; }

// ── BOT ──────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  // Returning user? If this chat is already linked to a phone, try to auto-send a pending code.
  try {
    const { data } = await sb.from('contacts').select('phone').eq('chat_id', chatId).order('id',{ascending:false}).limit(1);
    if (data && data[0] && data[0].phone) {
      const phone = data[0].phone;
      phoneToChat.set(phone, chatId);
      const sent = await sendPendingCode(phone, chatId);
      if (sent) return;  // a fresh code was waiting -> delivered automatically, no need to re-share contact
      bot.sendMessage(chatId, '✅ Raqamingiz eslab qolindi. Ilovada "Kodni olish" tugmasini bossangiz, kod shu yerga avtomatik keladi.');
      return;
    }
  } catch (e) { console.warn('/start lookup:', e.message); }
  // First-time user -> ask for the contact
  bot.sendMessage(chatId,
    'Assalomu alaykum! Rozi ilovasi uchun raqamingizni tasdiqlang.\n\nPastdagi tugmani bosing 👇',
    { reply_markup: { keyboard: [[{ text: '📱 Raqamimni yuborish', request_contact: true }]],
      resize_keyboard: true, one_time_keyboard: true } }
  );
});

// User shares their number — save the phone->chat link permanently
bot.on('contact', async (msg) => {
  const phone = normPhone(msg.contact.phone_number);
  phoneToChat.set(phone, msg.chat.id);
  try {
    await sb.from('contacts').delete().eq('phone', phone);
    await sb.from('contacts').insert({ phone: phone, chat_id: msg.chat.id });
  } catch (e) { console.warn('contacts save:', e.message); }
  const sent = await sendPendingCode(phone, msg.chat.id);
  if (!sent) {
    bot.sendMessage(msg.chat.id,
      '✅ Rahmat! Raqamingiz saqlandi.\n\nEndi ilovaga qayting — kod shu yerga avtomatik keladi.',
      { reply_markup: { remove_keyboard: true } }
    );
  } else {
    bot.sendMessage(msg.chat.id, '', { reply_markup: { remove_keyboard: true } }).catch(()=>{});
  }
});

// Send a not-yet-expired pending code for this phone, if one exists. Returns true if sent.
async function sendPendingCode(phone, chatId){
  try {
    const { data } = await sb.from('otps').select('*').eq('phone', phone).order('id',{ascending:false}).limit(1);
    if (data && data[0] && data[0].code && Date.now() < data[0].expires_at) {
      await bot.sendMessage(chatId,
        '🔐 Rozi tasdiqlash kodingiz:\n\n*' + data[0].code + '*\n\nKod 5 daqiqa amal qiladi.',
        { parse_mode: 'Markdown' });
      return true;
    }
  } catch (e) { console.warn('sendPendingCode:', e.message); }
  return false;
}

// ── API ──────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'Rozi OTP server 2 running' }));

// Look up a chat id: memory first, then the database (survives restarts)
async function getChatId(phone){
  if (phoneToChat.has(phone)) return phoneToChat.get(phone);
  try {
    const { data } = await sb.from('contacts').select('chat_id').eq('phone', phone).order('id',{ascending:false}).limit(1);
    if (data && data[0] && data[0].chat_id){ phoneToChat.set(phone, data[0].chat_id); return data[0].chat_id; }
  } catch (e) {}
  return null;
}

app.post('/send-otp', async (req, res) => {
  const phone = normPhone(req.body.phone);
  const code    = String(Math.floor(100000 + Math.random() * 900000));
  const expires = Date.now() + 5 * 60 * 1000;
  // Always store the code first — so even if the bot isn't started yet, it will be
  // auto-delivered the instant the user opens the bot / shares their contact.
  try {
    await sb.from('otps').delete().eq('phone', phone);
    await sb.from('otps').insert({ phone: phone, code: code, expires_at: expires });
  } catch (e) { console.warn('otps save:', e.message); }

  const chatId = await getChatId(phone);
  if (!chatId) return res.json({ success: false, error: 'not_started' });  // stored; will auto-send on bot open

  bot.sendMessage(chatId,
    '🔐 Rozi tasdiqlash kodingiz:\n\n*' + code + '*\n\nKod 5 daqiqa amal qiladi.',
    { parse_mode: 'Markdown' });
  res.json({ success: true });
});

// Flexible chat lookup: exact match, then fall back to last-9-digits
async function getChatIdFlexible(rawPhone){
  const phone = normPhone(rawPhone);
  let id = await getChatId(phone);
  if (id) return id;
  const last9 = (rawPhone||'').replace(/\D/g,'').slice(-9);
  if (last9.length === 9) {
    try {
      const { data } = await sb.from('contacts').select('phone,chat_id').order('id',{ascending:false});
      if (data){ const m = data.find(c => (c.phone||'').replace(/\D/g,'').slice(-9) === last9); if (m) return m.chat_id; }
    } catch (e) {}
  }
  return null;
}

// Notify every ACTIVE worker about a new order (Telegram push) — realm-agnostic
app.post('/notify-order', async (req, res) => {
  try {
    const o = req.body || {};
    const cat   = o.category || 'Buyurtma';
    const addr  = o.address  || '';
    const hours = o.hours    || '';
    const when  = o.date ? (o.date + (o.time ? ' ' + o.time : '')) : '';

    const { data: workers } = await sb.from('users').select('phone').eq('role','w').eq('active', true);
    if (!workers || !workers.length) return res.json({ sent: 0 });

    const text =
      '\uD83D\uDD14 Yangi buyurtma! / New order!\n\n' +
      '\uD83D\uDEE0 ' + cat + '\n' +
      (addr  ? '\uD83D\uDCCD ' + addr  + '\n' : '') +
      (hours ? '\u23F1 ' + hours + ' soat\n' : '') +
      (when  ? '\uD83D\uDDD3 ' + when + '\n' : '') +
      '\nIlovani oching va qabul qiling \uD83D\uDC47';

    let sent = 0;
    for (const w of workers) {
      const chatId = await getChatIdFlexible(w.phone);
      if (chatId) { try { await bot.sendMessage(chatId, text); sent++; } catch (e) {} }
    }
    res.json({ sent });
  } catch (e) { res.json({ sent: 0, error: e.message }); }
});

// Telegram push when a chat message is sent — so the other side hears about it
// even when the app is closed / they're far away. The app itself already polls
// Supabase every 2.5s while the chat is open, so this is throttled to at most
// ONE push per recipient per job per 60s to avoid spamming their Telegram.
const msgNotifyAt = new Map();   // "phone|jobId" -> last push timestamp (ms)
app.post('/notify-message', async (req, res) => {
  try {
    const { to_phone, from_name, text, job_id } = req.body || {};
    if (!to_phone || !text) return res.json({ sent: 0, error: 'bad_request' });

    const key = normPhone(to_phone) + '|' + (job_id || '');
    const now = Date.now();
    if (msgNotifyAt.get(key) && now - msgNotifyAt.get(key) < 60 * 1000) {
      return res.json({ sent: 0, throttled: true });
    }

    const chatId = await getChatIdFlexible(to_phone);
    if (!chatId) return res.json({ sent: 0, error: 'not_started' });

    const preview = String(text).slice(0, 120);
    const msg =
      '\uD83D\uDCAC Yangi xabar / New message' + (from_name ? ' \u2014 ' + from_name : '') + ':\n\n' +
      preview + '\n\n' +
      'Javob berish uchun Rozi ilovasini oching \uD83D\uDC47';
    await bot.sendMessage(chatId, msg);
    msgNotifyAt.set(key, now);
    res.json({ sent: 1 });
  } catch (e) { res.json({ sent: 0, error: e.message }); }
});

app.post('/verify-otp', async (req, res) => {
  const phone = normPhone(req.body.phone);
  const code  = String(req.body.code || '');
  try {
    const { data } = await sb.from('otps').select('*').eq('phone', phone).order('id',{ascending:false}).limit(1);
    const rec = data && data[0];
    if (!rec) return res.json({ verified: false, reason: 'no_code' });
    if (Date.now() > rec.expires_at){ await sb.from('otps').delete().eq('phone', phone); return res.json({ verified: false, reason: 'expired' }); }
    if (String(rec.code) !== code) return res.json({ verified: false, reason: 'wrong_code' });
    await sb.from('otps').delete().eq('phone', phone);
    res.json({ verified: true });
  } catch (e) { res.json({ verified: false, reason: 'error' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Rozi OTP server 2 running on port ' + PORT));
