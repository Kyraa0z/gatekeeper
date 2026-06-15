# 🛡️ GateKeeper

A JWT-based secure access control system featuring manual approval via Telegram.

## How It Works?

1. The user visits the site, leaves a note, and completes the Cloudflare Turnstile verification.
2. The administrator receives a notification via Telegram (including IP, browser, and OS details).
3. The administrator clicks the Approve or Reject button.
4. Approved users are granted a JWT token, allowing them to access protected pages.
5. The administrator can revoke permissions or ban users at any time.

## Features

- 🔐 One-click approve/reject/ban via Telegram
- 🤖 Bot verification (Cloudflare Turnstile)
- 🪪 JWT-based session management
- 🚦 Rate limiting (HTTP + Socket.IO)
- 📊 Statistics and daily summary reports
- ⏱️ Automatic timeout (unapproved requests are automatically rejected)
- 🔍 Device fingerprinting (FingerprintJS)
- 📋 Categorized logging system
- 🗑️ Database cleanup via the bot
- 🐳 Docker support
- 🔌 Integrates easily into other projects (`gatekeeper.js`)

## Installation

### Requirements

- Node.js 20+
- Docker (optional)
- Telegram bot token ([BotFather](https://t.me/BotFather))
- Cloudflare Turnstile account

### 1. Clone the repository

```bash
git clone https://github.com/Kyraa0z/gatekeeper.git
cd gatekeeper
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create the `.env` file

```bash
cp .env.example .env
nano .env
```

```env
TELEGRAM_BOT_TOKEN=botunuzun_tokeni
ADMIN_CHAT_ID=telegram_chat_id
TURNSTILE_SECRET_KEY=cloudflare_secret
JWT_SECRET=guclu_bir_secret
JWT_EXPIRES_IN=7d
PORT=4000
APPROVAL_TIMEOUT_MINUTES=10
```

> Generating a strong value for `JWT_SECRET`:`openssl rand -hex 32`

### 4. Start the application

**Using Node:**
```bash
node server.js
```

**Using Docker:**
```bash
docker compose up -d
```

## Telegram Bot Commands

| Command | Description |
|-------|----------|
| `/start` | Opens the admin panel |
| 🌐 Sitedeki Aktifler | Currently connected and authorized users |
| 🔑 Tüm Yetkililer | All approved users in the database |
| 🚫 Engelli Listesi | Banned IP list |
| 📋 Log Kategorileri | Access, system, and error logs |
| 📊 İstatistikler | General statistics |
| 🗑️ Veritabanı Temizle | Clean up old database records |

## Integrating with Other Projects

You can add GateKeeper to your own project with a single line:

```js
const gatekeeper = require('./gatekeeper/gatekeeper');

gatekeeper.init(app, server, {
    telegramToken:   process.env.TELEGRAM_BOT_TOKEN,
    adminChatId:     process.env.ADMIN_CHAT_ID,
    turnstileSecret: process.env.TURNSTILE_SECRET_KEY,
    jwtSecret:       process.env.JWT_SECRET,
    timeoutMinutes:  10,
    mountPath:       '/giris',
});

// Korumalı route
app.get('/panel', gatekeeper.protect(), (req, res) => {
    res.json({ mesaj: 'Hoş geldiniz', sessionId: req.gk.sessionId });
});
```

### JWT Verification Endpoint

```
GET /gatekeeper/verify
Authorization: Bearer <token>
```

**Response:**
```json
{ "valid": true, "sessionId": "abc123", "ip": "1.2.3.4" }
```

### Protected API Call from Frontend

```js
const token = localStorage.getItem('gk_token');

fetch('/panel/veri', {
    headers: { 'Authorization': 'Bearer ' + token }
})
.then(res => res.json())
.then(data => console.log(data));
```

## Project Structure

```
gatekeeper/
├── server.js           # Main server
├── gatekeeper.js       # Integration module
├── src/
│   ├── bot.js          # Telegram bot
│   ├── database.js     # SQLite database
│   └── logger.js       # Winston logger
├── public/
│   └── index.html      # User interface
├── data/               # Database and logs (ignored by git)
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## Environment Variables

| Variable | Description | Default |
|----------|----------|------------|
| `TELEGRAM_BOT_TOKEN` | Bot token (from BotFather) | — |
| `ADMIN_CHAT_ID` | Admin Telegram ID | — |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret | — |
| `JWT_SECRET` | JWT signing key | — |
| `JWT_EXPIRES_IN` | Token expiration time | `7d` |
| `PORT` | Server port | `4000` |
| `APPROVAL_TIMEOUT_MINUTES` | Approval timeout (0=disabled) | `10` |

## License

MIT
