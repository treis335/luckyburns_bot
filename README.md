# 🔥 Lucky Burn Bot

> Real-time token burn tracker for the **Supra blockchain**, delivered straight to your Telegram group.


---

## 📌 What it does

Monitors the Supra blockchain for `CoinDeposit` events sent to the **burn address** and instantly notifies subscribed Telegram groups with:

- Amount burned + USD value
- Total tokens ever burned
- Token market cap
- Direct link to the burn address on SupraScan

---

## ⚙️ Features

| | Feature |
|---|---|
| 🔥 | Real-time burn detection (5s polling) |
| 💰 | Live price via on-chain AMM reserves (SUPRA/CASH pair) |
| 🎨 | Custom notification image (photo, GIF or sticker) |
| 🔢 | Configurable emoji count per burn amount |
| 💵 | Minimum USD threshold to filter small burns |
| 🗑️ | Auto-delete previous alerts to keep groups clean |
| 📌 | Topic-aware — lock alerts to a specific forum topic |
| 🔗 | Burn address info + SupraScan link built in |
| 👮 | Admin-only configuration in groups |

---

## 🚀 Setup

### 1. Clone & install

```bash
git clone https://github.com/treis335/luckyburns_bot.git
cd luckyburns_bot
npm install
```

### 2. Configure `.env`

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
```

Get your token from [@BotFather](https://t.me/BotFather).

### 3. Run

```bash
node index.js
```

---

## 🤖 Commands

### Anyone

| Command | Description |
|---|---|
| `/luckyburn_start` | 🔥 Open main menu |
| `/luckyburn_price` | 📊 Current token price |
| `/luckyburn_burned` | 💀 Total tokens burned |
| `/luckyburn_burnaddress` | 🔗 Burn address + SupraScan link |
| `/luckyburn_help` | ℹ️ Command list |

### Admin only (in groups)

| Command | Description |
|---|---|
| `/luckyburn_subscribe` | ✅ Enable burn alerts |
| `/luckyburn_unsubscribe` | ❌ Disable burn alerts |
| `/luckyburn_settoken <address>` | 🔹 Set token to monitor |
| `/luckyburn_changeimage` | 🎨 Change notification image |
| `/luckyburn_deleteprevious on\|off` | 🗑️ Toggle auto-delete |
| `/luckyburn_setemoji <emoji>` | 🔥 Set notification emoji |
| `/luckyburn_setemojibase <amount>` | 🔢 Tokens per emoji |
| `/luckyburn_setminburnusd <usd>` | 💵 Min USD to trigger alert |
| `/luckyburn_resettopic` | 📌 Reset pinned topic |

---

## 🔥 Burn Address

All burned tokens on Supra are permanently sent to this provably unspendable address:

```
0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff
```

> No one controls this address. Tokens sent here are removed from circulation forever.

[🔍 View on SupraScan](https://suprascan.io/address/0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff/f?tab=coins&pageNo=1&rows=10&assetType=coin)

---

## 🏗️ Architecture

| | |
|---|---|
| **Runtime** | Node.js |
| **Blockchain** | Supra Mainnet RPC |
| **DEX** | Atmos AMM (Balancer-style weighted pools) |
| **Price** | On-chain AMM reserves (SUPRA ↔ CASH pair) |
| **State** | Local JSON files |

---

## 📁 Project Structure

```
.
├── index.js                  # Main bot file
├── burnChatIds.json          # Subscribed chats (auto-created)
├── processedBurnEvents.json  # Processed event IDs (auto-created)
├── .env                      # Bot token — never commit this!
├── .env.example              # Token template
└── package.json
```

---

## 📦 Dependencies

| Package | Purpose |
|---|---|
| `dotenv` | Load env variables |
| `axios` | HTTP requests to Supra RPC |
| `node-telegram-bot-api` | Telegram bot framework |

---

## 📄 License

MIT — free to use and modify.