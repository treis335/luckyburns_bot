require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;

// ==================== CONFIGURATION ====================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE_URL = 'https://rpc-mainnet.supra.com/rpc/v1';
const MODULE_ADDRESS = '0xdc694898dff98a1b0447e0992d0413e123ea80da1021d464a4fbaf0265870d8';
const CURVE_TYPE = `${MODULE_ADDRESS}::curves::Uncorrelated`;
const SUPRA_COIN_TYPE = '0x1::supra_coin::SupraCoin';
const CASH_COIN_TYPE = '0x9176f70f125199a3e3d5549ce795a8e906eed75901d535ded623802f15ae3637::cdp_multi::CASH';
const BURN_ADDRESS = '0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff';
const BURN_ADDRESS_SHORT = '0xffffffffffffffffffffffffffffffff';
const BURN_ADDRESS_DISPLAY = '0x0000...ffff';
const SUPRASCAN_BURN_URL = `https://suprascan.io/address/${BURN_ADDRESS}/f?tab=coins&pageNo=1&rows=10&assetType=coin`;
const SUPRA_DECIMALS = 1e8;
const CASH_DECIMALS = 1e8;
const POLLING_INTERVAL_MS = 5000;
const PRICE_INTERVAL_MS = 60 * 1000;
const BURN_EVENT_TYPE = '0x1::coin::CoinDeposit';
const CHAT_IDS_FILE = './burnChatIds.json';
const PROCESSED_EVENTS_FILE = './processedBurnEvents.json';
const LAST_BLOCK_FILE = './lastProcessedBlock.json';
const MAX_BLOCK_RANGE = 10;
const MAX_PROCESSED_EVENTS = 10000;
const PRICE_CACHE_TTL = 30000;          // 30 segundos de cache para preços
const MAX_EVENTS_PER_CYCLE = 5;          // limite de eventos por ciclo
const REQUEST_DELAY_MS = 1000;           // delay entre pedidos à API
const INITIAL_BACKOFF_MS = 2000;         // backoff inicial para 429
const MAX_BACKOFF_MS = 60000;            // backoff máximo

// ==================== KNOWN TOKENS ====================
const KNOWN_TOKENS = {
  '0x4205c82380bff5708cd7c59e0043a45890a457a6cdb60c9191d818958fd7ac26::LUCKY::LUCKY': {
    name: 'LUCKY', decimals: 1e6, supply: 1e9,
    mediaFileId: 'CgACAgQAAxkBAAMMaJZoU14NQ9lgePA4TIT5RsOn9rwAAg0HAALaru1TqDuFpkuS_Ho2BA',
    mediaType: 'animation'
  },
  [SUPRA_COIN_TYPE]: { name: 'SUPRA', decimals: 1e8, supply: 1e11, mediaFileId: null, mediaType: null },
  '0x635f53147391781c93bf3e1c68dcea5e2f7234ec371b0f241d150465606a9007::ROBBIE::ROBBIE': {
    name: 'ROBBIE', decimals: 1e6, supply: 1e9, mediaFileId: null, mediaType: null
  },
  '0xb8e94e7204d8eeb565a653d262ae6f7434a3a452e2aaf624810b33dfa3b64d09::DAWGZ::DAWGZ': {
    name: 'DAWGZ', decimals: 1e6, supply: 1e9, mediaFileId: null, mediaType: null
  }
};

// ==================== GLOBAL STATE ====================
let supraPrice = 0.007186;
let tokenPriceCache = {};          // { typeTag: { price, timestamp } }
let processedBurnEventIds = new Set();
let fallbackEventCounter = 0;
let lastProcessedBlock = 0;
let pendingTokenInput = {};
let pendingImageUploads = {};
let pendingSettingsInput = {};
let isProcessing = false;

// ==================== INIT BOT ====================
if (!TELEGRAM_BOT_TOKEN) {
  console.error('[BurnBot] ❌ TELEGRAM_BOT_TOKEN not defined in .env');
  process.exit(1);
}
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
let botId = null;

// ==================== HELPERS ====================
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function delayRandom(min = 300, max = 800) {
  await sleep(Math.floor(Math.random() * (max - min + 1) + min));
}

function getTokenInfo(typeTag) {
  if (KNOWN_TOKENS[typeTag]) return { typeTag, ...KNOWN_TOKENS[typeTag] };
  return { typeTag, name: typeTag.split('::').pop(), decimals: 1e6, supply: 0, mediaFileId: null, mediaType: null };
}

function formatAmount(rawAmount, decimals) {
  const num = Number(rawAmount) / decimals;
  if (isNaN(num)) return '0.00';
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPrice(price) {
  if (!price || price === 0) return '$0.000000';
  if (price < 0.000001) return `$${price.toFixed(12)}`;
  if (price < 0.01) return `$${price.toFixed(8)}`;
  return `$${price.toFixed(6)}`;
}

function formatMarketCap(mc) {
  if (!mc || mc === 0) return '0';
  if (mc >= 1_000_000) return `${(mc / 1_000_000).toFixed(2)}M`;
  if (mc >= 1_000) return Math.round(mc).toLocaleString('en-US');
  return mc.toFixed(2);
}

function isFatalChatError(err) {
  const m = err.message || '';
  return m.includes('chat not found') || m.includes('bot was kicked') ||
    m.includes('bot was blocked') || m.includes('user is deactivated') ||
    m.includes('have no rights to send') || m.includes('group chat was upgraded') ||
    m.includes('PEER_ID_INVALID');
}

// ==================== PERSISTENT BLOCK NUMBER ====================
async function loadLastProcessedBlock() {
  try {
    const data = await fs.readFile(LAST_BLOCK_FILE, 'utf8');
    const json = JSON.parse(data);
    lastProcessedBlock = json.lastBlock || 0;
    console.log(`[BurnBot] Loaded last processed block: ${lastProcessedBlock}`);
  } catch (err) {
    lastProcessedBlock = 0;
    console.log('[BurnBot] No previous block data, starting from block 0');
  }
}

async function saveLastProcessedBlock() {
  await fs.writeFile(LAST_BLOCK_FILE, JSON.stringify({ lastBlock: lastProcessedBlock }, null, 2));
}

// ==================== API CALL WITH BACKOFF ====================
async function callApiWithRetry(apiCall, context = '') {
  let attempt = 0;
  let delay = INITIAL_BACKOFF_MS;
  while (true) {
    try {
      const result = await apiCall();
      return result;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        attempt++;
        console.warn(`[BurnBot] ⚠️ Rate limited (429) ${context}, attempt ${attempt}, waiting ${delay}ms`);
        await sleep(delay);
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        continue;
      }
      throw err;
    }
  }
}

// ==================== PRICE FUNCTIONS WITH CACHE ====================
async function callView(fn, typeArgs, args = []) {
  return callApiWithRetry(async () => {
    await delayRandom(300, 800);
    const res = await axios.post(`${API_BASE_URL}/view`, { function: fn, type_arguments: typeArgs, arguments: args });
    return res.data.result;
  }, `view ${fn}`);
}

async function updateSupraPrice() {
  await callApiWithRetry(async () => {
    const isXFirst = SUPRA_COIN_TYPE < CASH_COIN_TYPE;
    const typeArgs = isXFirst ? [SUPRA_COIN_TYPE, CASH_COIN_TYPE, CURVE_TYPE] : [CASH_COIN_TYPE, SUPRA_COIN_TYPE, CURVE_TYPE];
    const reserves = await callView(`${MODULE_ADDRESS}::router::get_reserves_size`, typeArgs);
    const fees = await callView(`${MODULE_ADDRESS}::router::get_fees_config`, typeArgs);
    const [rx, ry] = reserves.map(v => BigInt(v));
    const [fee_pct, fee_scale] = fees.map(Number);
    const coinIn = BigInt(1 * SUPRA_DECIMALS);
    const mult = BigInt(fee_scale - fee_pct);
    const afterFees = coinIn * mult / BigInt(fee_scale);
    const reserveIn = isXFirst ? rx : ry;
    const reserveOut = isXFirst ? ry : rx;
    const amountOut = afterFees * reserveOut / (reserveIn + afterFees);
    supraPrice = Number(amountOut) / CASH_DECIMALS;
    console.log(`[BurnBot] SUPRA price updated: $${supraPrice.toFixed(6)}`);
  }, 'updateSupraPrice');
}

async function getTokenPriceUSD(typeTag) {
  const now = Date.now();
  const cached = tokenPriceCache[typeTag];
  if (cached && (now - cached.timestamp) < PRICE_CACHE_TTL) {
    return cached.price;
  }

  try {
    let price;
    if (typeTag === SUPRA_COIN_TYPE) price = supraPrice;
    else if (typeTag === CASH_COIN_TYPE) price = 1;
    else {
      const token = getTokenInfo(typeTag);
      const isXFirst = typeTag < SUPRA_COIN_TYPE;
      const typeArgs = isXFirst ? [typeTag, SUPRA_COIN_TYPE, CURVE_TYPE] : [SUPRA_COIN_TYPE, typeTag, CURVE_TYPE];
      const reserves = await callView(`${MODULE_ADDRESS}::router::get_reserves_size`, typeArgs);
      const [rx, ry] = reserves.map(v => Number(v));
      const reserveToken = isXFirst ? rx : ry;
      const reserveSupra = isXFirst ? ry : rx;
      const priceInSupra = (reserveSupra / SUPRA_DECIMALS) / (reserveToken / token.decimals);
      price = priceInSupra * supraPrice;
    }
    tokenPriceCache[typeTag] = { price, timestamp: now };
    return price;
  } catch (err) {
    console.error(`[BurnBot] Error getting price for ${typeTag}:`, err.message);
    return cached ? cached.price : 0;
  }
}

async function getBurnedBalance(typeTag) {
  try {
    const result = await callView('0x1::coin::balance', [typeTag], [BURN_ADDRESS]);
    const token = getTokenInfo(typeTag);
    return Number(result[0]) / token.decimals;
  } catch (err) {
    console.error(`[BurnBot] Error fetching burned balance:`, err.message);
    return 0;
  }
}

// ==================== PROCESSED EVENTS ====================
async function loadProcessedEventIds() {
  try {
    const data = await fs.readFile(PROCESSED_EVENTS_FILE, 'utf8');
    if (!data.trim()) throw new Error('empty');
    const parsed = JSON.parse(data);
    return { eventIds: new Set(parsed.eventIds || []), counter: parsed.counter || 0 };
  } catch (err) {
    await fs.writeFile(PROCESSED_EVENTS_FILE, JSON.stringify({ eventIds: [], counter: 0 }, null, 2));
    return { eventIds: new Set(), counter: 0 };
  }
}

async function saveProcessedEventIds() {
  if (processedBurnEventIds.size > MAX_PROCESSED_EVENTS) {
    const arr = [...processedBurnEventIds];
    processedBurnEventIds = new Set(arr.slice(Math.floor(arr.length / 2)));
  }
  await fs.writeFile(PROCESSED_EVENTS_FILE, JSON.stringify({ eventIds: [...processedBurnEventIds], counter: fallbackEventCounter }, null, 2));
}

// ==================== CHAT MANAGEMENT ====================
async function loadChatIds() {
  try {
    const data = await fs.readFile(CHAT_IDS_FILE, 'utf8');
    if (!data.trim()) return [];
    let configs = JSON.parse(data);
    if (!Array.isArray(configs)) return [];
    configs = configs.map(c => ({
      chatId: c.chatId,
      isSubscribed: c.isSubscribed ?? false,
      token: c.token || null,
      imageFileId: c.imageFileId || null,
      mediaType: c.mediaType || null,
      lastMessageIds: c.lastMessageIds || [],
      deletePrevious: c.deletePrevious ?? true,
      emoji: c.emoji || '🔥',
      emojiBaseAmount: c.emojiBaseAmount ?? 1000,
      minBurnUsd: c.minBurnUsd ?? null,
      topicId: c.topicId || null
    }));
    return configs;
  } catch (err) {
    if (err.code === 'ENOENT') { await fs.writeFile(CHAT_IDS_FILE, '[]'); return []; }
    return [];
  }
}

async function saveChatIds(configs) {
  await fs.writeFile(CHAT_IDS_FILE, JSON.stringify(configs, null, 2));
}

async function updateChat(chatId, action, opts = {}) {
  const configs = await loadChatIds();
  let cfg = configs.find(c => c.chatId === chatId);
  if (!cfg) {
    cfg = { chatId, isSubscribed: false, token: null, imageFileId: null, mediaType: null, lastMessageIds: [], deletePrevious: true, emoji: '🔥', emojiBaseAmount: 1000, minBurnUsd: null, topicId: null };
    configs.push(cfg);
  }
  switch (action) {
    case 'subscribe':
      if (cfg.isSubscribed) return false;
      cfg.isSubscribed = true; cfg.token = null; cfg.lastMessageIds = [];
      if (opts.topicId !== undefined) cfg.topicId = opts.topicId;
      break;
    case 'unsubscribe':
      if (!cfg.isSubscribed) return false;
      cfg.isSubscribed = false; cfg.token = null; cfg.lastMessageIds = [];
      break;
    case 'settoken':
      if (!cfg.isSubscribed) return false;
      cfg.token = opts.token; cfg.imageFileId = opts.imageFileId || null; cfg.mediaType = opts.mediaType || null;
      break;
    case 'changeimage':
      if (!cfg.isSubscribed) return false;
      cfg.imageFileId = opts.imageFileId; cfg.mediaType = opts.mediaType;
      break;
    case 'updatemessageids': cfg.lastMessageIds = opts.msgIds || []; break;
    case 'setdeleteprevious': if (!cfg.isSubscribed) return false; cfg.deletePrevious = opts.value; break;
    case 'setemoji': if (!cfg.isSubscribed) return false; cfg.emoji = opts.value; break;
    case 'setemojibase': if (!cfg.isSubscribed) return false; cfg.emojiBaseAmount = opts.value; break;
    case 'setminburnusd': if (!cfg.isSubscribed) return false; cfg.minBurnUsd = opts.value; break;
    case 'settopic': if (!cfg.isSubscribed) return false; cfg.topicId = opts.topicId; break;
    case 'reset':
      if (!cfg.isSubscribed) return false;
      cfg.token = null; cfg.imageFileId = null; cfg.mediaType = null;
      cfg.emoji = '🔥'; cfg.emojiBaseAmount = 1000; cfg.minBurnUsd = null;
      cfg.lastMessageIds = []; cfg.topicId = null;
      break;
    default: return false;
  }
  await saveChatIds(configs);
  return true;
}

async function getStatusText(chatId) {
  const configs = await loadChatIds();
  const cfg = configs.find(c => c.chatId === chatId);
  if (!cfg || !cfg.isSubscribed) return '❌ <b>Not subscribed</b>\n\nPress <b>Subscribe</b> to start receiving burn alerts.';
  let text = '✅ <b>Subscribed</b>\n';
  if (cfg.token) {
    const t = getTokenInfo(cfg.token);
    text += `🔹 <b>Token:</b> ${t.name}\n`;
    text += `🖼️ <b>Image:</b> ${cfg.imageFileId ? '✅ Custom' : '⚪ Default'}\n`;
  } else {
    text += `🔹 <b>Token:</b> <i>Not set</i> — use Set Token to configure\n`;
  }
  text += `🗑️ <b>Delete previous:</b> ${cfg.deletePrevious ? 'ON ✅' : 'OFF ❌'}\n`;
  text += `🔥 <b>Emoji:</b> ${cfg.emoji} (1 per ${cfg.emojiBaseAmount.toLocaleString()} tokens)\n`;
  text += `💵 <b>Min USD:</b> ${cfg.minBurnUsd !== null ? `$${cfg.minBurnUsd}` : 'Disabled'}\n`;
  if (cfg.topicId) text += `📌 <b>Topic ID:</b> ${cfg.topicId}\n`;
  return text;
}

// ==================== ADMIN CHECK ====================
async function isAdmin(chatId, userId) {
  if (chatId === userId) return true;
  try {
    const member = await bot.getChatMember(chatId, userId);
    return ['creator', 'administrator'].includes(member.status);
  } catch { return false; }
}

// ==================== TOPIC-AWARE SEND HELPERS ====================
async function getTopicId(chatId) {
  const configs = await loadChatIds();
  return configs.find(c => c.chatId === chatId)?.topicId || null;
}

async function sendMsg(chatId, text, extra = {}) {
  const topicId = extra._topicId !== undefined ? extra._topicId : await getTopicId(chatId);
  delete extra._topicId;
  if (topicId) extra.message_thread_id = topicId;
  return bot.sendMessage(chatId, text, extra);
}

async function sendAnim(chatId, fileId, extra = {}) {
  const topicId = extra._topicId !== undefined ? extra._topicId : await getTopicId(chatId);
  delete extra._topicId;
  if (topicId) extra.message_thread_id = topicId;
  return bot.sendAnimation(chatId, fileId, extra);
}

async function sendPho(chatId, fileId, extra = {}) {
  const topicId = extra._topicId !== undefined ? extra._topicId : await getTopicId(chatId);
  delete extra._topicId;
  if (topicId) extra.message_thread_id = topicId;
  return bot.sendPhoto(chatId, fileId, extra);
}

async function sendStick(chatId, fileId, extra = {}) {
  const topicId = extra._topicId !== undefined ? extra._topicId : await getTopicId(chatId);
  delete extra._topicId;
  if (topicId) extra.message_thread_id = topicId;
  return bot.sendSticker(chatId, fileId, extra);
}

async function editMsg(chatId, messageId, text, extra = {}) {
  delete extra._topicId;
  return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...extra });
}

// ==================== KEYBOARDS ====================
const mainMenuKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '✅ Subscribe', callback_data: 'subscribe' }, { text: '❌ Unsubscribe', callback_data: 'unsubscribe' }],
      [{ text: '🔹 Set Token', callback_data: 'settoken_prompt' }, { text: '💰 Price', callback_data: 'price' }],
      [{ text: '🔥 Burned', callback_data: 'burned' }, { text: '⚙️ Settings', callback_data: 'settings' }],
      [{ text: '🔗 Burn Address', callback_data: 'burnaddress' }],
      [{ text: 'ℹ️ Help', callback_data: 'help' }]
    ]
  }
};

const settingsKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🎨 Change Image', callback_data: 'changeimage_prompt' }],
      [{ text: '🗑️ Delete Previous Msgs', callback_data: 'toggle_delete' }],
      [{ text: '🔥 Set Emoji', callback_data: 'setemoji_prompt' }],
      [{ text: '🔢 Set Emoji Base Amount', callback_data: 'setemojibase_prompt' }],
      [{ text: '💵 Set Min USD', callback_data: 'setminburnusd_prompt' }],
      [{ text: '🧹 Reset All Settings', callback_data: 'reset_all' }],
      [{ text: '🔙 Back to Menu', callback_data: 'main_menu' }]
    ]
  }
};

function burnAddressKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔍 View on SupraScan', url: SUPRASCAN_BURN_URL }],
        [{ text: '🔙 Back to Menu', callback_data: 'main_menu' }]
      ]
    }
  };
}

function getBurnAddressText() {
  return (
    `🔥 <b>Burn Address</b>\n\n` +
    `All burned tokens on Supra are sent to the following address:\n\n` +
    `<code>${BURN_ADDRESS}</code>\n\n` +
    `This is a provably unspendable address — no one controls it. ` +
    `Tokens sent here are permanently removed from circulation.\n\n` +
    `🔍 <b>Verify on SupraScan:</b>\n${SUPRASCAN_BURN_URL}`
  );
}

// ==================== BURN EVENT FETCHING (WITH BLOCK PERSISTENCE) ====================
async function getLatestBlock() {
  const res = await axios.get(`${API_BASE_URL}/block`);
  const h = Number(res.data.height);
  if (isNaN(h)) throw new Error('Invalid block height');
  return h;
}

async function fetchBurnEvents() {
  const latest = await getLatestBlock();
  let start = lastProcessedBlock === 0 ? latest : lastProcessedBlock + 1;
  let end = Math.min(latest + 1, start + MAX_BLOCK_RANGE);
  if (start >= end) return [];

  const res = await axios.get(`${API_BASE_URL}/events/${BURN_EVENT_TYPE}`, {
    params: { start, end }, timeout: 10000
  });
  const events = res.data.data || [];

  const burnEvents = events.filter(ev => {
    const acc = ev.data?.account?.toLowerCase() || '';
    return acc === BURN_ADDRESS_SHORT || acc === BURN_ADDRESS.toLowerCase();
  });

  const newEvents = burnEvents.filter(ev => {
    let id;
    if (ev.guid?.account_address && ev.guid?.creation_number && ev.data?.timestamp) {
      id = `${ev.guid.account_address}:${ev.guid.creation_number}:${ev.data.timestamp}`;
    } else if (ev.transaction_hash) {
      id = `tx:${ev.transaction_hash}`;
    } else {
      id = `block:${ev.block_height || start}:counter:${fallbackEventCounter++}`;
    }
    if (processedBurnEventIds.has(id)) return false;
    processedBurnEventIds.add(id);
    return true;
  });

  if (newEvents.length > 0) {
    await saveProcessedEventIds();
    lastProcessedBlock = latest;
    await saveLastProcessedBlock();
  } else {
    lastProcessedBlock = latest;
    await saveLastProcessedBlock();
  }
  return newEvents;
}

// ==================== SEND BURN NOTIFICATION ====================
async function sendBurnNotification(chatId, cfg, tokenInfo, amountRaw, usdValue, totalBurned, marketCap) {
  const amount = formatAmount(amountRaw, tokenInfo.decimals);
  const emojiCount = Math.min(Math.floor((amountRaw / tokenInfo.decimals) / cfg.emojiBaseAmount), 35);
  const emojiStr = emojiCount > 0 ? cfg.emoji.repeat(emojiCount) : '';

  let message = `🔥 A new burn of <b>${tokenInfo.name}</b> has been detected!${emojiStr}\n\n`;
  message += `💀 <b>Burned:</b> ${amount} ${tokenInfo.name}\n\n`;
  message += `💵 <b>Value:</b> ${formatPrice(usdValue)}\n\n`;
  message += `🗑️ <b>Total Burned:</b> ${totalBurned.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${tokenInfo.name}\n\n`;
  if (marketCap > 0) message += `🏦 <b>Market Cap:</b> ${formatMarketCap(marketCap)} USD\n\n`;
  message += `<i>LuckyPowerBots</i> 🍀`;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: '📱 Telegram', url: 'https://t.me/lucky_supra' },
        { text: '🐦 X', url: 'https://x.com/LuckyTokenz' }
      ],
      [
        { text: '🔍 Burn Address', url: SUPRASCAN_BURN_URL }
      ]
    ]
  };

  // Delete previous messages
  if (cfg.deletePrevious && cfg.lastMessageIds.length) {
    for (const mid of cfg.lastMessageIds) {
      try { await bot.deleteMessage(chatId, mid); } catch (e) {}
    }
  }

  const imageId = cfg.imageFileId || tokenInfo.mediaFileId || null;
  const mediaType = cfg.imageFileId ? cfg.mediaType : tokenInfo.mediaType;

  let newMsgIds = [];
  try {
    let sent;
    if (imageId && mediaType === 'animation') {
      sent = await sendAnim(chatId, imageId, { caption: message, parse_mode: 'HTML', reply_markup: inlineKeyboard });
    } else if (imageId && mediaType === 'photo') {
      sent = await sendPho(chatId, imageId, { caption: message, parse_mode: 'HTML', reply_markup: inlineKeyboard });
    } else if (imageId && mediaType === 'sticker') {
      const s = await sendStick(chatId, imageId);
      const t = await sendMsg(chatId, message, { parse_mode: 'HTML', reply_markup: inlineKeyboard });
      newMsgIds.push(s.message_id, t.message_id);
      await updateChat(chatId, 'updatemessageids', { msgIds: newMsgIds });
      return;
    } else {
      sent = await sendMsg(chatId, message, { parse_mode: 'HTML', reply_markup: inlineKeyboard });
    }
    newMsgIds.push(sent.message_id);
  } catch (err) {
    console.error(`[BurnBot] Send error to ${chatId}:`, err.message);
    if (isFatalChatError(err)) { await updateChat(chatId, 'unsubscribe'); return; }
    try {
      const sent = await sendMsg(chatId, message, { parse_mode: 'HTML', reply_markup: inlineKeyboard });
      newMsgIds.push(sent.message_id);
    } catch (e) {
      console.error(`[BurnBot] Fallback failed for ${chatId}:`, e.message);
      if (isFatalChatError(e)) await updateChat(chatId, 'unsubscribe');
      return;
    }
  }
  await updateChat(chatId, 'updatemessageids', { msgIds: newMsgIds });
}

// ==================== PROCESS BURN EVENTS (COM LIMITES) ====================
async function processBurnEvents() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    const events = await fetchBurnEvents();
    if (!events.length) return;

    const eventsToProcess = events.slice(0, MAX_EVENTS_PER_CYCLE);
    for (const ev of eventsToProcess) {
      const typeTag = ev.data?.coin_type;
      if (!typeTag) continue;
      const tokenInfo = getTokenInfo(typeTag);
      const amountRaw = Number(ev.data.amount);

      console.log(`[BurnBot] 🔥 Burn: ${formatAmount(amountRaw, tokenInfo.decimals)} ${tokenInfo.name}`);

      const priceUSD = await getTokenPriceUSD(typeTag);
      const usdValue = priceUSD * (amountRaw / tokenInfo.decimals);
      const totalBurned = await getBurnedBalance(typeTag);
      const marketCap = tokenInfo.supply > 0 ? priceUSD * tokenInfo.supply : 0;

      const configs = await loadChatIds();
      for (const cfg of configs) {
        if (!cfg.isSubscribed || !cfg.token || cfg.token !== typeTag) continue;
        if (cfg.minBurnUsd !== null && usdValue < cfg.minBurnUsd) continue;
        await sendBurnNotification(cfg.chatId, cfg, tokenInfo, amountRaw, usdValue, totalBurned, marketCap);
        await sleep(REQUEST_DELAY_MS);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  } catch (err) {
    console.error('[BurnBot] Error in processBurnEvents:', err.message);
  } finally {
    isProcessing = false;
  }
}

// ==================== BOT WELCOME (GROUP ADD) ====================
bot.on('new_chat_members', async (msg) => {
  if (!msg.new_chat_members || !botId) return;
  if (!msg.new_chat_members.some(m => m && m.id === botId)) return;
  const chatId = msg.chat.id;
  const welcome =
    `👋 <b>Hello! I'm Lucky Burn Bot.</b> 🔥\n\n` +
    `I monitor <b>token burns</b> on the Supra blockchain and notify your group in real time whenever tokens are burned.\n\n` +
    `<b>🔥 Burn Address:</b>\n` +
    `<code>${BURN_ADDRESS}</code>\n` +
    `<a href="${SUPRASCAN_BURN_URL}">🔍 View on SupraScan</a>\n\n` +
    `<b>📌 Quick Start (admin only):</b>\n` +
    `1️⃣ /luckyburn_subscribe — enable burn alerts\n` +
    `2️⃣ /luckyburn_settoken &lt;address&gt; — set the token to monitor\n` +
    `3️⃣ Customize emoji, min USD threshold, and more\n\n` +
    `<b>💡 Tip:</b> To use inside a specific <b>topic</b>, send any command from within that topic.\n\n` +
    `🍀 <b>LuckyPowerBots</b> | <a href="https://t.me/lucky_supra">Telegram</a> | <a href="https://x.com/LuckyTokenz">X</a>`;
  await bot.sendMessage(chatId, welcome, { parse_mode: 'HTML', disable_web_page_preview: true });
});

// ==================== /luckyburn_start ====================
bot.onText(/\/luckyburn_start/, async (msg) => {
  const chatId = msg.chat.id;
  const incomingTopicId = msg.message_thread_id || null;

  if (incomingTopicId) {
    const configs = await loadChatIds();
    if (!configs.find(c => c.chatId === chatId)?.topicId) {
      await updateChat(chatId, 'settopic', { topicId: incomingTopicId });
    }
  }

  const configs = await loadChatIds();
  const cfg = configs.find(c => c.chatId === chatId);
  const isSubscribed = cfg?.isSubscribed || false;
  const status = await getStatusText(chatId);

  let welcome = `<b>🔥 Lucky Burn Bot</b>\n\n`;
  welcome += `I track <b>real-time token burns</b> on the Supra blockchain and alert your group instantly.\n\n`;
  welcome += `🔥 <b>Burn Address:</b>\n`;
  welcome += `<code>${BURN_ADDRESS}</code>\n\n`;

  if (!isSubscribed) {
    welcome += `<b>📌 Quick Start:</b>\n`;
    welcome += `1️⃣ Press <b>Subscribe</b> below\n`;
    welcome += `2️⃣ Press <b>Set Token</b> and paste the token address\n`;
    welcome += `3️⃣ Customize with ⚙️ Settings\n\n`;
  } else {
    welcome += `<b>✅ You're subscribed and monitoring burns!</b>\n\n`;
  }

  welcome += `${status}\n\n`;
  welcome += `Use the buttons below or commands in groups.`;

  await sendMsg(chatId, welcome, { parse_mode: 'HTML', disable_web_page_preview: true, ...mainMenuKeyboard, _topicId: incomingTopicId });
});

// ==================== CALLBACK QUERIES ====================
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const msgId = callbackQuery.message.message_id;
  const data = callbackQuery.data;
  const userId = callbackQuery.from.id;
  const incomingTopicId = callbackQuery.message.message_thread_id || null;
  await bot.answerCallbackQuery(callbackQuery.id);

  const readOnly = ['price', 'burned', 'help', 'main_menu', 'burnaddress'];
  const isGroup = chatId !== userId;
  if (isGroup && !readOnly.includes(data)) {
    if (!(await isAdmin(chatId, userId))) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: '🚫 Only group admins can configure this bot.', show_alert: true }).catch(() => {});
      return;
    }
  }

  if (incomingTopicId) {
    const configs = await loadChatIds();
    if (!configs.find(c => c.chatId === chatId)?.topicId) {
      await updateChat(chatId, 'settopic', { topicId: incomingTopicId });
    }
  }

  const configs = await loadChatIds();
  const cfg = configs.find(c => c.chatId === chatId);
  const isSubscribed = cfg?.isSubscribed || false;

  async function updateMenu(text, keyboard) {
    try {
      await editMsg(chatId, msgId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard });
    } catch (err) {
      if (!err.message.includes('message is not modified')) {
        await sendMsg(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard, _topicId: incomingTopicId });
      }
    }
  }

  switch (data) {
    case 'subscribe': {
      const ok = await updateChat(chatId, 'subscribe', { topicId: incomingTopicId });
      const status = await getStatusText(chatId);
      if (ok) {
        await updateMenu(
          `<b>🔥 Lucky Burn Bot</b>\n\n✅ <b>Successfully subscribed!</b>\n\nNow press <b>Set Token</b> to choose which token's burns to monitor.\n\n${status}`,
          mainMenuKeyboard
        );
      } else {
        await updateMenu(`<b>🔥 Lucky Burn Bot</b>\n\n⚠️ Already subscribed.\n\n${status}`, mainMenuKeyboard);
      }
      break;
    }
    case 'unsubscribe': {
      const ok = await updateChat(chatId, 'unsubscribe');
      const status = await getStatusText(chatId);
      if (ok) {
        await updateMenu(`<b>🔥 Lucky Burn Bot</b>\n\n❌ <b>Unsubscribed.</b> You will no longer receive burn alerts.\n\n${status}`, mainMenuKeyboard);
      } else {
        await updateMenu(`<b>🔥 Lucky Burn Bot</b>\n\n⚠️ You are not subscribed.\n\n${status}`, mainMenuKeyboard);
      }
      break;
    }
    case 'price': {
      if (!isSubscribed || !cfg?.token) {
        await updateMenu('⚠️ <b>Please subscribe and set a token first.</b>\n\nUse the Subscribe and Set Token buttons.', mainMenuKeyboard);
        break;
      }
      try {
        const tokenInfo = getTokenInfo(cfg.token);
        const price = await getTokenPriceUSD(cfg.token);
        const mc = tokenInfo.supply > 0 ? price * tokenInfo.supply : null;
        let text = `📊 <b>${tokenInfo.name} Price</b>\n\n`;
        text += `💸 <b>Price:</b> ${formatPrice(price)}\n\n`;
        if (mc) text += `🏦 <b>Market Cap:</b> ${formatMarketCap(mc)} USD`;
        await updateMenu(text, mainMenuKeyboard);
      } catch { await updateMenu('❌ Error fetching price. Please try again.', mainMenuKeyboard); }
      break;
    }
    case 'burned': {
      const tokenTag = cfg?.token || '0x4205c82380bff5708cd7c59e0043a45890a457a6cdb60c9191d818958fd7ac26::LUCKY::LUCKY';
      try {
        const tokenInfo = getTokenInfo(tokenTag);
        const totalBurned = await getBurnedBalance(tokenTag);
        const burnedStr = totalBurned.toLocaleString('en-US', { maximumFractionDigits: 2 });
        const price = await getTokenPriceUSD(tokenTag);
        const burnedUsd = price * totalBurned;
        let text = `🔥 <b>${tokenInfo.name} Burn Stats</b>\n\n`;
        text += `💀 <b>Total Burned:</b> ${burnedStr} ${tokenInfo.name}\n\n`;
        text += `💵 <b>Burned Value:</b> ${formatPrice(burnedUsd)}`;
        await updateMenu(text, mainMenuKeyboard);
      } catch { await updateMenu('❌ Error fetching burn data. Please try again.', mainMenuKeyboard); }
      break;
    }
    case 'burnaddress':
      await updateMenu(getBurnAddressText(), burnAddressKeyboard());
      break;
    case 'settings':
      await updateMenu(`⚙️ <b>Settings</b>\n\n${await getStatusText(chatId)}\n\nChoose an option to configure:`, settingsKeyboard);
      break;
    case 'main_menu':
      await updateMenu(`<b>🔥 Lucky Burn Bot</b>\n\n${await getStatusText(chatId)}\n\nUse the buttons below.`, mainMenuKeyboard);
      break;
    case 'toggle_delete': {
      if (!isSubscribed) { await updateMenu('⚠️ Subscribe first.', settingsKeyboard); break; }
      const newVal = !cfg.deletePrevious;
      await updateChat(chatId, 'setdeleteprevious', { value: newVal });
      await updateMenu(`⚙️ <b>Settings</b>\n\n${await getStatusText(chatId)}\n\n🗑️ Delete previous messages: <b>${newVal ? 'ON ✅' : 'OFF ❌'}</b>`, settingsKeyboard);
      break;
    }
    case 'setemoji_prompt':
      pendingSettingsInput[chatId] = 'emoji';
      await updateMenu('🔥 <b>Set Emoji</b>\n\nSend the emoji you want to use for burn notifications.\n\nExample: 🔥 💀 ☠️ 🌋', settingsKeyboard);
      break;
    case 'setemojibase_prompt':
      pendingSettingsInput[chatId] = 'base';
      await updateMenu('🔢 <b>Set Emoji Base Amount</b>\n\nSet how many tokens equals one emoji.\n\nExample: <code>1000</code> means 1 emoji per 1,000 tokens burned.', settingsKeyboard);
      break;
    case 'setminburnusd_prompt':
      pendingSettingsInput[chatId] = 'minburnusd';
      await updateMenu('💵 <b>Set Minimum USD</b>\n\nOnly notify if the burn value exceeds this amount.\n\nExample: <code>10</code> → only burns worth $10+ trigger an alert. Send <code>0</code> to disable.', settingsKeyboard);
      break;
    case 'changeimage_prompt':
      if (!isSubscribed || !cfg?.token) {
        await updateMenu('⚠️ Please subscribe and set a token first.', settingsKeyboard);
      } else {
        pendingImageUploads[chatId] = { action: 'changeimage', token: cfg.token };
        await updateMenu('🎨 <b>Change Image</b>\n\nSend a new <b>photo</b>, <b>GIF</b> or <b>sticker</b> to use as the burn notification image.', settingsKeyboard);
      }
      break;
    case 'settoken_prompt':
      if (!isSubscribed) {
        await updateMenu('⚠️ Please subscribe first before setting a token.', mainMenuKeyboard);
      } else {
        pendingTokenInput[chatId] = true;
        await updateMenu(
          `🔹 <b>Set Token</b>\n\nSend the token address you want to monitor for burns.\n\n` +
          `<b>Example (LUCKY):</b>\n<code>0x4205c82380bff5708cd7c59e0043a45890a457a6cdb60c9191d818958fd7ac26::LUCKY::LUCKY</code>\n\n` +
          `Any valid Supra token address is accepted.`,
          mainMenuKeyboard
        );
      }
      break;
    case 'reset_all':
      if (!isSubscribed) { await updateMenu('⚠️ You are not subscribed.', settingsKeyboard); break; }
      await updateChat(chatId, 'reset');
      await updateMenu(`⚙️ <b>Settings</b>\n\n🧹 All settings have been reset to defaults.\n\n${await getStatusText(chatId)}`, mainMenuKeyboard);
      break;
    case 'help': {
      const helpText =
        `<b>🔥 Lucky Burn Bot — Help</b>\n\n` +
        `<b>🔘 Buttons (private chat)</b>\n` +
        `• <b>Subscribe / Unsubscribe</b> — toggle burn alerts\n` +
        `• <b>Set Token</b> — paste any Supra token address\n` +
        `• <b>Price</b> — current token price + market cap\n` +
        `• <b>Burned</b> — total tokens burned so far\n` +
        `• <b>🔗 Burn Address</b> — view the burn address + SupraScan link\n` +
        `• <b>Settings</b> — image, emoji, min USD, delete previous\n\n` +
        `<b>⌨️ Commands (groups — admin only)</b>\n` +
        `/luckyburn_subscribe\n` +
        `/luckyburn_unsubscribe\n` +
        `/luckyburn_settoken &lt;address&gt;\n` +
        `/luckyburn_changeimage\n` +
        `/luckyburn_deleteprevious on|off\n` +
        `/luckyburn_setemoji &lt;emoji&gt;\n` +
        `/luckyburn_setemojibase &lt;amount&gt;\n` +
        `/luckyburn_setminburnusd &lt;usd&gt;\n` +
        `/luckyburn_price\n` +
        `/luckyburn_burned\n` +
        `/luckyburn_burnaddress\n` +
        `/luckyburn_resettopic\n` +
        `/luckyburn_help\n\n` +
        `<b>💡 Tip:</b> Use /luckyburn_start inside a topic to lock notifications to that topic.`;
      await updateMenu(helpText, mainMenuKeyboard);
      break;
    }
    default: break;
  }
});

// ==================== TEXT COMMANDS ====================
bot.on('text', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const incomingTopicId = msg.message_thread_id || null;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const text = msg.text.trim().replace(/^(\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, '$1');

  const readOnlyCommands = ['/luckyburn_price', '/luckyburn_burned', '/luckyburn_help', '/luckyburn_start', '/luckyburn_burnaddress'];
  const isReadOnly = readOnlyCommands.some(cmd => text === cmd || text.startsWith(cmd + ' '));

  if (isGroup && !isReadOnly && text.startsWith('/')) {
    if (!(await isAdmin(chatId, userId))) {
      await sendMsg(chatId, '🚫 Only group admins can configure this bot.', { _topicId: incomingTopicId });
      return;
    }
  }

  if (incomingTopicId && text !== '/luckyburn_resettopic') {
    const configs = await loadChatIds();
    if (!configs.find(c => c.chatId === chatId)?.topicId) {
      await updateChat(chatId, 'settopic', { topicId: incomingTopicId });
    }
  }

  const sendCmd = (content, extra = {}) => sendMsg(chatId, content, { ...extra, _topicId: incomingTopicId });

  // Pending token input
  if (pendingTokenInput[chatId]) {
    delete pendingTokenInput[chatId];
    const isValid = /^0x[a-fA-F0-9]+::[a-zA-Z0-9_]+::[a-zA-Z0-9_]+$/.test(text);
    if (!isValid) {
      await sendCmd('❌ Invalid token format.\n\nExample:\n<code>0x4205c82380bff5708cd7c59e0043a45890a457a6cdb60c9191d818958fd7ac26::LUCKY::LUCKY</code>', { parse_mode: 'HTML' });
      return;
    }
    const ok = await updateChat(chatId, 'settoken', { token: text });
    if (ok) {
      const t = getTokenInfo(text);
      pendingImageUploads[chatId] = { action: 'settoken', token: text };
      await sendCmd(`✅ Token set to <b>${t.name}</b>!\n\nOptionally send a <b>photo</b>, <b>GIF</b> or <b>sticker</b> to use as the notification image. Or skip — a default will be used if available.`, { parse_mode: 'HTML' });
    } else {
      await sendCmd('⚠️ Please subscribe first with /luckyburn_subscribe.');
    }
    return;
  }

  // Pending settings input
  const setting = pendingSettingsInput[chatId];
  if (setting) {
    delete pendingSettingsInput[chatId];
    if (setting === 'emoji') {
      if (!/\p{Emoji_Presentation}|\p{Emoji}\uFE0F/gu.test(text)) {
        await sendCmd('❌ Invalid emoji. Please send a valid emoji like 🔥 or 💀'); return;
      }
      const ok = await updateChat(chatId, 'setemoji', { value: text });
      await sendCmd(ok ? `🔥 Emoji set to ${text}` : '⚠️ Subscribe first.');
    } else if (setting === 'base') {
      const base = parseInt(text, 10);
      if (isNaN(base) || base <= 0) { await sendCmd('❌ Please enter a positive number. Example: 1000'); return; }
      const ok = await updateChat(chatId, 'setemojibase', { value: base });
      await sendCmd(ok ? `🔢 Emoji base set to ${base.toLocaleString()} tokens per emoji.` : '⚠️ Subscribe first.');
    } else if (setting === 'minburnusd') {
      const min = parseFloat(text);
      if (isNaN(min) || min < 0) { await sendCmd('❌ Please enter a non-negative number. Example: 10'); return; }
      const ok = await updateChat(chatId, 'setminburnusd', { value: min });
      await sendCmd(ok ? `💵 Minimum USD set to $${min}. Burns below this value will be ignored.` : '⚠️ Subscribe first.');
    }
    return;
  }

  if (!text.startsWith('/')) return;

  // ----- Commands -----
  if (text === '/luckyburn_subscribe') {
    const ok = await updateChat(chatId, 'subscribe', { topicId: incomingTopicId });
    if (ok) {
      await sendCmd('✅ <b>Subscribed!</b>\n\nNow use /luckyburn_settoken &lt;address&gt; to set the token you want to monitor for burns.', { parse_mode: 'HTML' });
    } else {
      await sendCmd('⚠️ Already subscribed.');
    }

  } else if (text === '/luckyburn_unsubscribe') {
    const ok = await updateChat(chatId, 'unsubscribe');
    await sendCmd(ok ? '❌ Unsubscribed. You will no longer receive burn alerts.' : '⚠️ You are not subscribed.');

  } else if (text === '/luckyburn_settoken' || text.startsWith('/luckyburn_settoken ')) {
    const token = text.startsWith('/luckyburn_settoken ') ? text.substring(20).trim() : '';
    if (!token) {
      pendingTokenInput[chatId] = true;
      await sendCmd('🔹 Send the token address to monitor:\n\n<code>0x4205c82380bff5708cd7c59e0043a45890a457a6cdb60c9191d818958fd7ac26::LUCKY::LUCKY</code>', { parse_mode: 'HTML' });
      return;
    }
    if (!/^0x[a-fA-F0-9]+::[a-zA-Z0-9_]+::[a-zA-Z0-9_]+$/.test(token)) {
      await sendCmd('❌ Invalid token format. Example:\n<code>0x4205c82380bff5708cd7c59e0043a45890a457a6cdb60c9191d818958fd7ac26::LUCKY::LUCKY</code>', { parse_mode: 'HTML' });
      return;
    }
    const ok = await updateChat(chatId, 'settoken', { token });
    if (ok) {
      const t = getTokenInfo(token);
      pendingImageUploads[chatId] = { action: 'settoken', token };
      await sendCmd(`✅ Token set to <b>${t.name}</b>!\n\nOptionally send a photo, GIF or sticker as the notification image.`, { parse_mode: 'HTML' });
    } else {
      await sendCmd('⚠️ Please subscribe first with /luckyburn_subscribe.');
    }

  } else if (text === '/luckyburn_changeimage') {
    const configs = await loadChatIds();
    const cfg = configs.find(c => c.chatId === chatId);
    if (!cfg?.isSubscribed || !cfg.token) { await sendCmd('⚠️ Subscribe and set a token first.'); return; }
    pendingImageUploads[chatId] = { action: 'changeimage', token: cfg.token };
    await sendCmd('🎨 Send a new photo, GIF or sticker for the burn notification.');

  } else if (text.startsWith('/luckyburn_deleteprevious ')) {
    const val = text.substring(25).trim().toLowerCase();
    if (val !== 'on' && val !== 'off') { await sendCmd('❌ Usage: /luckyburn_deleteprevious on|off'); return; }
    const ok = await updateChat(chatId, 'setdeleteprevious', { value: val === 'on' });
    await sendCmd(ok ? `🗑️ Delete previous messages: <b>${val === 'on' ? 'ON ✅' : 'OFF ❌'}</b>` : '⚠️ Subscribe first.', { parse_mode: 'HTML' });

  } else if (text.startsWith('/luckyburn_setemoji ')) {
    const emoji = text.substring(19).trim();
    if (!/\p{Emoji_Presentation}|\p{Emoji}\uFE0F/gu.test(emoji)) { await sendCmd('❌ Invalid emoji. Example: /luckyburn_setemoji 🔥'); return; }
    const ok = await updateChat(chatId, 'setemoji', { value: emoji });
    await sendCmd(ok ? `🔥 Emoji set to ${emoji}` : '⚠️ Subscribe first.');

  } else if (text.startsWith('/luckyburn_setemojibase ')) {
    const base = parseInt(text.substring(23).trim(), 10);
    if (isNaN(base) || base <= 0) { await sendCmd('❌ Please provide a positive number. Example: /luckyburn_setemojibase 1000'); return; }
    const ok = await updateChat(chatId, 'setemojibase', { value: base });
    await sendCmd(ok ? `🔢 Emoji base set to ${base.toLocaleString()} tokens per emoji.` : '⚠️ Subscribe first.');

  } else if (text.startsWith('/luckyburn_setminburnusd ')) {
    const min = parseFloat(text.substring(24).trim());
    if (isNaN(min) || min < 0) { await sendCmd('❌ Non-negative number required. Example: /luckyburn_setminburnusd 10'); return; }
    const ok = await updateChat(chatId, 'setminburnusd', { value: min });
    await sendCmd(ok ? `💵 Minimum USD set to $${min}.` : '⚠️ Subscribe first.');

  } else if (text === '/luckyburn_price') {
    const configs = await loadChatIds();
    const cfg = configs.find(c => c.chatId === chatId);
    const tokenTag = cfg?.token || '0x4205c82380bff5708cd7c59e0043a45890a457a6cdb60c9191d818958fd7ac26::LUCKY::LUCKY';
    try {
      const tokenInfo = getTokenInfo(tokenTag);
      const price = await getTokenPriceUSD(tokenTag);
      const mc = tokenInfo.supply > 0 ? price * tokenInfo.supply : null;
      let resp = `📊 <b>${tokenInfo.name} Price</b>\n\n💸 <b>Price:</b> ${formatPrice(price)}`;
      if (mc) resp += `\n\n🏦 <b>Market Cap:</b> ${formatMarketCap(mc)} USD`;
      await sendCmd(resp, { parse_mode: 'HTML' });
    } catch { await sendCmd('❌ Error fetching price.'); }

  } else if (text === '/luckyburn_burned') {
    const configs = await loadChatIds();
    const cfg = configs.find(c => c.chatId === chatId);
    const tokenTag = cfg?.token || '0x4205c82380bff5708cd7c59e0043a45890a457a6cdb60c9191d818958fd7ac26::LUCKY::LUCKY';
    try {
      const tokenInfo = getTokenInfo(tokenTag);
      const totalBurned = await getBurnedBalance(tokenTag);
      const price = await getTokenPriceUSD(tokenTag);
      const burnedUsd = price * totalBurned;
      await sendCmd(
        `🔥 <b>${tokenInfo.name} Burn Stats</b>\n\n` +
        `💀 <b>Total Burned:</b> ${totalBurned.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${tokenInfo.name}\n\n` +
        `💵 <b>Burned Value:</b> ${formatPrice(burnedUsd)}`,
        { parse_mode: 'HTML' }
      );
    } catch { await sendCmd('❌ Error fetching burn data.'); }

  } else if (text === '/luckyburn_burnaddress') {
    await sendCmd(getBurnAddressText(), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔍 View on SupraScan', url: SUPRASCAN_BURN_URL }]
        ]
      }
    });

  } else if (text === '/luckyburn_resettopic') {
    const ok = await updateChat(chatId, 'settopic', { topicId: null });
    await sendCmd(ok ? '🧹 Topic reset. Future alerts will go to the default channel.' : '⚠️ You are not subscribed.');

  } else if (text === '/luckyburn_help') {
    await sendCmd(
      `<b>🔥 Lucky Burn Bot — Commands</b>\n\n` +
      `<b>Admin-only in groups:</b>\n` +
      `/luckyburn_subscribe — enable burn alerts\n` +
      `/luckyburn_unsubscribe — disable burn alerts\n` +
      `/luckyburn_settoken &lt;address&gt; — set token to monitor\n` +
      `/luckyburn_changeimage — change notification image\n` +
      `/luckyburn_deleteprevious on|off — auto-delete old alerts\n` +
      `/luckyburn_setemoji &lt;emoji&gt; — set notification emoji\n` +
      `/luckyburn_setemojibase &lt;amount&gt; — tokens per emoji\n` +
      `/luckyburn_setminburnusd &lt;usd&gt; — minimum USD to alert\n` +
      `/luckyburn_resettopic — reset pinned topic\n\n` +
      `<b>Anyone:</b>\n` +
      `/luckyburn_price — current token price\n` +
      `/luckyburn_burned — total tokens burned\n` +
      `/luckyburn_burnaddress — view burn address + SupraScan link\n` +
      `/luckyburn_help — this help message\n\n` +
      `<b>🔥 Burn Address:</b>\n` +
      `<code>${BURN_ADDRESS}</code>\n\n` +
      `<b>💡 Tip:</b> Use buttons in private chat for easier setup!`,
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
  }
});

// ==================== IMAGE HANDLING ====================
async function handleMediaUpload(msg, fileId, mediaType) {
  const chatId = msg.chat.id;
  const pending = pendingImageUploads[chatId];
  if (!pending) return;
  const incomingTopicId = msg.message_thread_id || null;
  const action = pending.action === 'changeimage' ? 'changeimage' : 'settoken';
  const ok = await updateChat(chatId, action, { token: pending.token, imageFileId: fileId, mediaType });
  delete pendingImageUploads[chatId];
  const label = mediaType === 'photo' ? '📷 Photo' : mediaType === 'animation' ? '🎞️ GIF' : '🎭 Sticker';
  if (ok) {
    await sendMsg(chatId, `✅ ${label} associated with burn notifications!`, { _topicId: incomingTopicId });
    const status = await getStatusText(chatId);
    await sendMsg(chatId, `📋 <b>Current Status</b>\n\n${status}`, { parse_mode: 'HTML', _topicId: incomingTopicId });
  } else {
    await sendMsg(chatId, '❌ Error saving image. Please try again.', { _topicId: incomingTopicId });
  }
}

bot.on('photo', async (msg) => {
  if (!pendingImageUploads[msg.chat.id]) return;
  await handleMediaUpload(msg, msg.photo[msg.photo.length - 1].file_id, 'photo');
});
bot.on('animation', async (msg) => {
  if (!pendingImageUploads[msg.chat.id]) return;
  await handleMediaUpload(msg, msg.animation.file_id, 'animation');
});
bot.on('sticker', async (msg) => {
  if (!pendingImageUploads[msg.chat.id]) return;
  await handleMediaUpload(msg, msg.sticker.file_id, 'sticker');
});

// ==================== GLOBAL ERROR HANDLERS ====================
process.on('unhandledRejection', reason => console.error('[BurnBot] Unhandled rejection:', reason));
process.on('uncaughtException', err => console.error('[BurnBot] Uncaught exception:', err.message));

// ==================== START ====================
(async () => {
  const { eventIds, counter } = await loadProcessedEventIds();
  processedBurnEventIds = eventIds;
  fallbackEventCounter = counter;
  await loadLastProcessedBlock();

  await updateSupraPrice();
  setInterval(updateSupraPrice, PRICE_INTERVAL_MS);

  // Use setInterval para o polling em vez de recursive setTimeout para evitar acumulação
  setInterval(() => {
    processBurnEvents().catch(err => console.error('[BurnBot] Polling error:', err.message));
  }, POLLING_INTERVAL_MS);

  console.log('[BurnBot] 🔥 Lucky Burn Bot started (optimized). Monitoring burns...');
})();