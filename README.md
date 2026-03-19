# 🛡️ GateKeeper

Telegram üzerinden manuel onay gerektiren, JWT tabanlı güvenli erişim kontrol sistemi.

## Nasıl Çalışır?

1. Kullanıcı siteye girer, not bırakır ve Cloudflare Turnstile doğrulamasını tamamlar
2. Yöneticiye Telegram üzerinden bildirim gelir (IP, tarayıcı, işletim sistemi bilgileriyle)
3. Yönetici **Onayla** veya **Reddet** butonuna basar
4. Onaylanan kullanıcıya JWT token verilir, korumalı sayfalara erişebilir
5. Yönetici istediği zaman yetkiyi kaldırabilir veya kullanıcıyı banlaabilir

## Özellikler

- 🔐 Telegram üzerinden tek tıkla onay/red/ban
- 🤖 Bot doğrulaması (Cloudflare Turnstile)
- 🪪 JWT tabanlı oturum yönetimi
- 🚦 Rate limiting (HTTP + Socket.IO)
- 📊 İstatistikler ve günlük özet raporu
- ⏱️ Otomatik zaman aşımı (onaylanmayan talepler otomatik reddedilir)
- 🔍 Cihaz parmak izi (FingerprintJS)
- 📋 Kategorili log sistemi
- 🗑️ Bot üzerinden veritabanı temizleme
- 🐳 Docker desteği
- 🔌 Başka projelere entegre edilebilir (`gatekeeper.js`)

## Kurulum

### Gereksinimler

- Node.js 20+
- Docker (opsiyonel)
- Telegram bot token ([BotFather](https://t.me/BotFather))
- Cloudflare Turnstile hesabı

### 1. Repoyu klonlayın

```bash
git clone https://github.com/Kyraa0z/gatekeeper.git
cd gatekeeper
```

### 2. Paketleri kurun

```bash
npm install
```

### 3. `.env` dosyasını oluşturun

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

> `JWT_SECRET` için güçlü bir değer üretmek: `openssl rand -hex 32`

### 4. Başlatın

**Node ile:**
```bash
node server.js
```

**Docker ile:**
```bash
docker compose up -d
```

## Telegram Bot Komutları

| Komut | Açıklama |
|-------|----------|
| `/start` | Yönetim panelini açar |
| 🌐 Sitedeki Aktifler | Şu an bağlı ve yetkili kullanıcılar |
| 🔑 Tüm Yetkililer | Veritabanındaki tüm onaylı kullanıcılar |
| 🚫 Engelli Listesi | Banlı IP listesi |
| 📋 Log Kategorileri | Erişim, sistem ve hata logları |
| 📊 İstatistikler | Genel istatistikler |
| 🗑️ Veritabanı Temizle | Eski kayıtları temizle |

## Başka Projeye Entegrasyon

GateKeeper'ı kendi projenize tek satırla ekleyebilirsiniz:

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

### JWT Doğrulama Endpoint'i

```
GET /gatekeeper/verify
Authorization: Bearer <token>
```

**Yanıt:**
```json
{ "valid": true, "sessionId": "abc123", "ip": "1.2.3.4" }
```

### Frontend'den Korumalı API Çağrısı

```js
const token = localStorage.getItem('gk_token');

fetch('/panel/veri', {
    headers: { 'Authorization': 'Bearer ' + token }
})
.then(res => res.json())
.then(data => console.log(data));
```

## Proje Yapısı

```
gatekeeper/
├── server.js           # Ana sunucu
├── gatekeeper.js       # Entegrasyon modülü
├── src/
│   ├── bot.js          # Telegram bot
│   ├── database.js     # SQLite veritabanı
│   └── logger.js       # Winston logger
├── public/
│   └── index.html      # Kullanıcı arayüzü
├── data/               # Veritabanı ve loglar (git'e eklenmez)
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## Ortam Değişkenleri

| Değişken | Açıklama | Varsayılan |
|----------|----------|------------|
| `TELEGRAM_BOT_TOKEN` | Bot token (BotFather'dan) | — |
| `ADMIN_CHAT_ID` | Yönetici Telegram ID | — |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret | — |
| `JWT_SECRET` | JWT imzalama anahtarı | — |
| `JWT_EXPIRES_IN` | Token geçerlilik süresi | `7d` |
| `PORT` | Sunucu portu | `4000` |
| `APPROVAL_TIMEOUT_MINUTES` | Onay zaman aşımı (0=devre dışı) | `10` |

## Lisans

MIT
