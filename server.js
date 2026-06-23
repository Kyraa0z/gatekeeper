require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const jwt        = require('jsonwebtoken');
const { db, initDB }                 = require('./src/database');
const { initBot }                    = require('./src/bot');
const { accessLogger, systemLogger } = require('./src/logger');
const cache = require('./src/cache');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(helmet({
    contentSecurityPolicy:     false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy:   false,
}));

app.use(rateLimit({
    windowMs:        60 * 1000,
    max:             60,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { error: 'Çok fazla istek. Lütfen bekleyin.' },
    skip: (req) => req.path.startsWith('/socket.io'),
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/gatekeeper/verify', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ valid: false, reason: 'Token yok' });
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);

        // Önce Redis cache'e bak — DB'ye gitme
        const cachedToken = await cache.getToken(payload.sessionId);
        if (cachedToken && cachedToken === token) {
            return res.json({ valid: true, sessionId: payload.sessionId, ip: payload.ip });
        }

        // Cache'de yoksa DB'den kontrol et
        db.get('SELECT status, jwt_token FROM visitors WHERE session_id = ?', [payload.sessionId], (err, row) => {
            if (!row || row.status !== 'approved' || row.jwt_token !== token) {
                return res.status(403).json({ valid: false, reason: 'Oturum geçersiz' });
            }
            // Doğrulandı — cache'e yaz
            cache.setToken(payload.sessionId, token);
            res.json({ valid: true, sessionId: payload.sessionId, ip: payload.ip });
        });
    } catch (e) {
        res.status(401).json({ valid: false, reason: 'Token geçersiz veya süresi dolmuş' });
    }
});

initDB();
const bot = initBot(process.env.TELEGRAM_BOT_TOKEN, process.env.ADMIN_CHAT_ID, io);

function generateAndSaveToken(sessionId, ip) {
    const token = jwt.sign(
        { sessionId, ip },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    db.run('UPDATE visitors SET jwt_token = ? WHERE session_id = ?', [token, sessionId]);
    cache.setToken(sessionId, token);
    return token;
}
bot.generateToken = generateAndSaveToken;

io.on('connection', (socket) => {
    const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim()
        || socket.handshake.address.replace('::ffff:', '');
    const { sessionId, deviceId } = socket.handshake.auth;

    if (!sessionId || !deviceId) return socket.disconnect();
    socket.join(sessionId);

    db.get(
        'SELECT 1 FROM blocked_ips WHERE ip = ? UNION SELECT 1 FROM blocked_devices WHERE device_id = ?',
        [ip, deviceId],
        (err, bannedRow) => {
            if (bannedRow) {
                accessLogger.warn(`Engelli: ip=${ip}`);
                socket.emit('status_update', { status: 'blocked' });
                return socket.disconnect();
            }

            db.get('SELECT status, jwt_token FROM visitors WHERE session_id = ?', [sessionId], (err, row) => {
                if (!row) return;
                if (row.status === 'approved' && row.jwt_token) {
                    cache.setToken(sessionId, row.jwt_token);
                    socket.emit('status_update', { status: 'approved', token: row.jwt_token });
                } else {
                    socket.emit('status_update', { status: row.status });
                }
            });
        }
    );

    socket.on('request_access', async (data) => {
        // Redis rate limit
        const allowed = await cache.checkRateLimit(ip, 5, 60);
        if (!allowed) {
            accessLogger.warn(`Rate limit: ip=${ip}`);
            return socket.emit('rate_limited', { message: 'Çok fazla istek. 1 dakika bekleyin.' });
        }

        db.get(
            'SELECT 1 FROM blocked_ips WHERE ip = ? UNION SELECT 1 FROM blocked_devices WHERE device_id = ?',
            [ip, deviceId],
            async (err, bannedRow) => {
                if (bannedRow) return socket.emit('status_update', { status: 'blocked' });

                try {
                    const formData = new URLSearchParams();
                    formData.append('secret',   process.env.TURNSTILE_SECRET_KEY);
                    formData.append('response', data.turnstileToken);
                    formData.append('remoteip', ip);

                    const verify  = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: formData });
                    const vResult = await verify.json();

                    if (!vResult.success) {
                        accessLogger.warn(`Turnstile başarısız: ip=${ip}`);
                        return socket.emit('status_update', { status: 'idle' });
                    }

                    function escapeHTML(str) {
                        return str.replace(/[&<>'"]/g, 
                            tag => ({
                                '&': '&amp;',
                                '<': '&lt;',
                                '>': '&gt;',
                                "'": '&#39;',
                                '"': '&quot;'
                            }[tag] || tag)
                        );
                    }
                    const rawNote = data.note ? data.note.substring(0, 200) : '';
                    const note = escapeHTML(rawNote);
                    const ua   = socket.handshake.headers['user-agent'];

                    db.run(
                        "INSERT OR REPLACE INTO visitors (session_id, device_id, ip, user_agent, status) VALUES (?, ?, ?, ?, 'pending')",
                        [sessionId, deviceId, ip, ua],
                        (err) => {
                            if (err) {
                                systemLogger.error(`Kayıt hatası: ${err.message}`);
                                return socket.emit('status_update', { status: 'idle' });
                            }

                            const msgText = bot.buildRequestMessage(ip, note, ua, sessionId);
                            const opts = {
                                parse_mode: 'HTML',
                                reply_markup: { inline_keyboard: [
                                    [
                                        { text: '✅ Onayla',           callback_data: `approve_${sessionId}` },
                                        { text: '❌ Reddet',           callback_data: `reject_${sessionId}`  }
                                    ],
                                    [{ text: '🚫 Engelle ve Banla',    callback_data: `ban_${sessionId}`     }]
                                ]}
                            };

                            bot.sendMessage(process.env.ADMIN_CHAT_ID, msgText, opts);
                            accessLogger.info(`Erişim talebi: ip=${ip} session=${sessionId}`);
                            socket.emit('status_update', { status: 'pending' });
                            bot.startTimeout(sessionId);
                        }
                    );
                } catch (e) {
                    systemLogger.error(`request_access hatası: ${e.message}`);
                    socket.emit('status_update', { status: 'idle' });
                }
            }
        );
    });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => systemLogger.info(`GateKeeper ${PORT} portunda çalışıyor.`));
