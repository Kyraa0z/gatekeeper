process.env.NTBA_FIX_350 = 1;
const TelegramBot = require('node-telegram-bot-api');
const { db }      = require('./database');
const { accessLogger, systemLogger } = require('./logger');
const fs   = require('fs');
const path = require('path');

// ── Sabitler ─────────────────────────────────────────────────────────────────
const LOG_DIR   = path.join(__dirname, '../data/logs');
const LOG_FILES = {
    access: path.join(LOG_DIR, 'access.log'),
    system: path.join(LOG_DIR, 'system.log'),
    error:  path.join(LOG_DIR, 'error.log'),
};

// Zaman aşımı: .env'den al, varsayılan 10 dakika (0 = devre dışı)
const TIMEOUT_MINUTES = parseInt(process.env.APPROVAL_TIMEOUT_MINUTES || '10', 10);

// ── Yardımcı fonksiyonlar ─────────────────────────────────────────────────────

// Log dosyasından son N satır
function readLastLines(filePath, count = 20) {
    if (!fs.existsSync(filePath)) return null;
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    return lines.slice(-count).join('\n').substring(0, 3800);
}

// User-Agent'tan tarayıcı ve işletim sistemi çıkar
function parseUA(ua) {
    if (!ua) return { browser: 'Bilinmiyor', os: 'Bilinmiyor' };

    let browser = 'Diğer';
    if      (ua.includes('Edg/'))      browser = 'Edge';
    else if (ua.includes('OPR/') || ua.includes('Opera')) browser = 'Opera';
    else if (ua.includes('Chrome/'))   browser = 'Chrome';
    else if (ua.includes('Firefox/'))  browser = 'Firefox';
    else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';

    let os = 'Diğer';
    if      (ua.includes('Windows NT 10'))  os = 'Windows 10/11';
    else if (ua.includes('Windows NT 6.1')) os = 'Windows 7';
    else if (ua.includes('Windows'))        os = 'Windows';
    else if (ua.includes('iPhone'))         os = 'iOS (iPhone)';
    else if (ua.includes('iPad'))           os = 'iOS (iPad)';
    else if (ua.includes('Android'))        os = 'Android';
    else if (ua.includes('Mac OS X'))       os = 'macOS';
    else if (ua.includes('Linux'))          os = 'Linux';

    return { browser, os };
}

// Erişim talebi Telegram mesajı oluştur
function buildRequestMessage(ip, note, ua, sessionId) {
    const { browser, os } = parseUA(ua);
    return (
        `🚨 <b>ERİŞİM TALEBİ</b>\n\n` +
        `<b>IP:</b> <code>${ip}</code>\n` +
        `<b>ID:</b> <code>${sessionId}</code>\n` +
        `<b>Tarayıcı:</b> ${browser}\n` +
        `<b>İşletim Sistemi:</b> ${os}\n` +
        `<b>Not:</b> <i>${note || 'Yok'}</i>\n\n` +
        (TIMEOUT_MINUTES > 0
            ? `⏱ <i>Bu talep ${TIMEOUT_MINUTES} dakika içinde yanıtlanmazsa otomatik reddedilir.</i>`
            : '')
    );
}

// Zaman aşımı zamanlayıcısını başlat
function startTimeout(sessionId, bot, io, adminId) {
    if (!TIMEOUT_MINUTES || TIMEOUT_MINUTES <= 0) return;

    setTimeout(() => {
        db.get(
            "SELECT status FROM visitors WHERE session_id = ?",
            [sessionId],
            (err, row) => {
                if (!row || row.status !== 'pending') return; // Zaten işlem gördü
                db.run(
                    "UPDATE visitors SET status = 'rejected' WHERE session_id = ?",
                    [sessionId],
                    () => {
                        io.to(sessionId).emit('status_update', { status: 'rejected' });
                        accessLogger.warn(`Zaman aşımı ile reddedildi: session=${sessionId}`);
                        bot.sendMessage(
                            adminId,
                            `⏱ <b>Zaman Aşımı:</b> <code>${sessionId}</code> oturumu ${TIMEOUT_MINUTES} dakika içinde yanıtlanmadı, otomatik reddedildi.`,
                            { parse_mode: 'HTML' }
                        );
                    }
                );
            }
        );
    }, TIMEOUT_MINUTES * 60 * 1000);
}

// ── Bot başlatma ──────────────────────────────────────────────────────────────
function initBot(token, adminId, io) {
    const bot = new TelegramBot(token, { polling: true });

    // ── Menü ──────────────────────────────────────────────────────────────────
    const adminMenu = {
        reply_markup: {
            keyboard: [
                [{ text: '🌐 Sitedeki Aktifler' }, { text: '🔑 Tüm Yetkililer'   }],
                [{ text: '🚫 Engelli Listesi'   }, { text: '📋 Log Kategorileri' }],
                [{ text: '📊 İstatistikler'     }, { text: '🗑 Veritabanı Temizle'}]
            ],
            resize_keyboard: true
        }
    };

    // ── /start ────────────────────────────────────────────────────────────────
    bot.onText(/\/start/, (msg) => {
        if (msg.chat.id.toString() !== adminId) return;
        bot.sendMessage(
            adminId,
            `🛡️ <b>GateKeeper Yönetim Paneli</b>\n\n` +
            `Hoş geldiniz. Aşağıdaki menüden işlem seçin.\n` +
            (TIMEOUT_MINUTES > 0
                ? `\n⚙️ Otomatik zaman aşımı: <b>${TIMEOUT_MINUTES} dakika</b>`
                : '\n⚙️ Otomatik zaman aşımı: <b>devre dışı</b>'),
            { parse_mode: 'HTML', ...adminMenu }
        );
    });

    // ── Mesaj handler ─────────────────────────────────────────────────────────
    bot.on('message', async (msg) => {
        if (msg.chat.id.toString() !== adminId) return;
        const text = msg.text;

        // ── 🌐 Sitedeki Aktifler ───────────────────────────────────────────
        if (text === '🌐 Sitedeki Aktifler') {
            const sockets = await io.fetchSockets();
            if (!sockets.length) return bot.sendMessage(adminId, '🌐 Şu an bağlı kimse yok.');

            const sids = sockets.map(s => s.handshake.auth.sessionId);
            const ph   = sids.map(() => '?').join(',');

            db.all(
                `SELECT * FROM visitors WHERE session_id IN (${ph}) AND status = 'approved'`,
                sids,
                (err, rows) => {
                    if (!rows?.length) {
                        return bot.sendMessage(adminId,
                            '🌐 Şu an yetkili oturum açmış kimse yok.\n' +
                            '<i>(Bağlı kullanıcılar beklemede veya reddedilmiş olabilir.)</i>',
                            { parse_mode: 'HTML' }
                        );
                    }

                    bot.sendMessage(adminId, `🌐 <b>Sitedeki Aktif Yetkililer</b> — ${rows.length} kişi`, { parse_mode: 'HTML' });

                    rows.forEach(row => {
                        const { browser, os } = parseUA(row.user_agent);
                        bot.sendMessage(adminId,
                            `✅ <b>Aktif Oturum</b>\n` +
                            `<b>IP:</b> <code>${row.ip}</code>\n` +
                            `<b>ID:</b> <code>${row.session_id}</code>\n` +
                            `<b>Tarayıcı:</b> ${browser} / ${os}\n` +
                            `<b>Son görülme:</b> ${row.last_seen}`,
                            {
                                parse_mode: 'HTML',
                                reply_markup: { inline_keyboard: [[
                                    { text: '⚠️ Siteden At', callback_data: `kick_${row.session_id}` },
                                    { text: '🚫 Banla',      callback_data: `ban_${row.session_id}`  }
                                ]]}
                            }
                        );
                    });
                }
            );
        }

        // ── 🔑 Tüm Yetkililer ──────────────────────────────────────────────
        if (text === '🔑 Tüm Yetkililer') {
            db.all(
                "SELECT * FROM visitors WHERE status = 'approved' ORDER BY last_seen DESC",
                [],
                (err, rows) => {
                    if (!rows?.length) return bot.sendMessage(adminId, '🔑 Henüz yetkili kullanıcı yok.');

                    bot.sendMessage(adminId, `🔑 <b>Tüm Yetkili Kullanıcılar</b> — ${rows.length} kişi`, { parse_mode: 'HTML' });

                    rows.forEach(row => {
                        const { browser, os } = parseUA(row.user_agent);
                        bot.sendMessage(adminId,
                            `🔑 <b>Yetkili Kullanıcı</b>\n` +
                            `<b>IP:</b> <code>${row.ip}</code>\n` +
                            `<b>ID:</b> <code>${row.session_id}</code>\n` +
                            `<b>Tarayıcı:</b> ${browser} / ${os}\n` +
                            `<b>Son görülme:</b> ${row.last_seen}`,
                            {
                                parse_mode: 'HTML',
                                reply_markup: { inline_keyboard: [[
                                    { text: '⚠️ Yetkiyi Kaldır',   callback_data: `kick_${row.session_id}` },
                                    { text: '🚫 Engelle ve Banla', callback_data: `ban_${row.session_id}`  }
                                ]]}
                            }
                        );
                    });
                }
            );
        }

        // ── 🚫 Engelli Listesi ─────────────────────────────────────────────
        if (text === '🚫 Engelli Listesi') {
            db.all("SELECT ip FROM blocked_ips ORDER BY ip", [], (err, rows) => {
                if (!rows?.length) return bot.sendMessage(adminId, '🚫 Engelli listesi boş.');

                bot.sendMessage(adminId, `🚫 <b>Engelli IP Listesi</b> — ${rows.length} kayıt`, { parse_mode: 'HTML' });

                rows.forEach(r => {
                    bot.sendMessage(adminId, `🚫 <code>${r.ip}</code>`, {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[
                            { text: '🔓 Engeli Kaldır', callback_data: `unbanip_${r.ip}` }
                        ]]}
                    });
                });
            });
        }

        // ── 📋 Log Kategorileri ────────────────────────────────────────────
        if (text === '📋 Log Kategorileri') {
            bot.sendMessage(adminId, '📋 <b>Log Kategorileri</b>\nHangi logu görmek istiyorsunuz?', {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [
                    [
                        { text: '🔵 Erişim',  callback_data: 'log_access' },
                        { text: '⚙️ Sistem',  callback_data: 'log_system' },
                        { text: '🔴 Hatalar', callback_data: 'log_error'  }
                    ]
                ]}
            });
        }

        // ── 📊 İstatistikler ───────────────────────────────────────────────
        if (text === '📊 İstatistikler') {
            db.get(
                `SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
                    SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END) AS pending,
                    SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
                 FROM visitors`,
                [],
                (err, stats) => {
                    db.get("SELECT COUNT(*) AS blocked FROM blocked_ips", [], (err2, bips) => {
                        db.get("SELECT COUNT(*) AS bdev FROM blocked_devices", [], (err3, bdev) => {
                            bot.sendMessage(adminId,
                                `📊 <b>Genel İstatistikler</b>\n\n` +
                                `👥 Toplam ziyaretçi: <b>${stats.total}</b>\n` +
                                `✅ Yetkili:          <b>${stats.approved}</b>\n` +
                                `⏳ Beklemede:        <b>${stats.pending}</b>\n` +
                                `❌ Reddedilen:       <b>${stats.rejected}</b>\n\n` +
                                `🚫 Engelli IP:       <b>${bips.blocked}</b>\n` +
                                `🚫 Engelli cihaz:    <b>${bdev.bdev}</b>`,
                                { parse_mode: 'HTML' }
                            );
                        });
                    });
                }
            );
        }

        // ── 🗑 Veritabanı Temizle ──────────────────────────────────────────
        if (text === '🗑 Veritabanı Temizle') {
            bot.sendMessage(adminId,
                `🗑 <b>Veritabanı Temizleme</b>\n\nNe yapmak istiyorsunuz?`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [
                        [
                            { text: '🧹 Eski rejected/idle kayıtları sil', callback_data: 'clean_old' }
                        ],
                        [
                            { text: '🔴 TÜM ziyaretçileri sil (dikkat!)', callback_data: 'clean_all' }
                        ]
                    ]}
                }
            );
        }
    });

    // ── Callback handler ──────────────────────────────────────────────────────
    bot.on('callback_query', (query) => {
        const underscoreIndex = query.data.indexOf('_');
        const action = query.data.substring(0, underscoreIndex);
        const value  = query.data.substring(underscoreIndex + 1);

        // ── approve ───────────────────────────────────────────────────────
        if (action === 'approve') {
            db.get('SELECT ip FROM visitors WHERE session_id = ?', [value], (err, row) => {
                db.run("UPDATE visitors SET status = 'approved' WHERE session_id = ?", [value], (err2) => {
                    if (err2) return bot.answerCallbackQuery(query.id, { text: 'Veritabanı hatası!' });
                    const token = bot.generateToken ? bot.generateToken(value, row.ip) : null;
                    io.to(value).emit('status_update', { status: 'approved', token });
                    accessLogger.info(`Erişim onaylandı: session=${value}`);
                    bot.editMessageText('✅ Onaylandı.', {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id
                    }).finally(() => bot.answerCallbackQuery(query.id, { text: 'Kullanıcı onaylandı.' }));
                });
            });
        }

        // ── reject ────────────────────────────────────────────────────────
        else if (action === 'reject') {
            db.run("UPDATE visitors SET status = 'rejected' WHERE session_id = ?", [value], (err) => {
                if (err) return bot.answerCallbackQuery(query.id, { text: 'Veritabanı hatası!' });
                io.to(value).emit('status_update', { status: 'rejected' });
                accessLogger.info(`Erişim reddedildi: session=${value}`);
                bot.editMessageText('❌ Reddedildi.', {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                }).finally(() => bot.answerCallbackQuery(query.id, { text: 'Kullanıcı reddedildi.' }));
            });
        }

        // ── kick ──────────────────────────────────────────────────────────
        else if (action === 'kick') {
            db.run("UPDATE visitors SET status = 'idle' WHERE session_id = ?", [value], (err) => {
                if (err) return bot.answerCallbackQuery(query.id, { text: 'Veritabanı hatası!' });
                // force_reload: istemci sayfayı yeniler, Turnstile temiz başlar.
                // status_update:idle yerine ayrı event — bağlantı sırasındaki idle
                // ile karıştırılmaz, sonsuz döngü olmaz.
                io.to(value).emit('force_reload');
                accessLogger.info(`Kullanıcı atıldı: session=${value}`);
                bot.editMessageText('⚠️ Yetki kaldırıldı, kullanıcı atıldı.', {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                }).finally(() => bot.answerCallbackQuery(query.id, { text: 'Kullanıcı atıldı.' }));
            });
        }

        // ── ban ───────────────────────────────────────────────────────────
        else if (action === 'ban') {
            db.get("SELECT ip, device_id FROM visitors WHERE session_id = ?", [value], (err, row) => {
                if (!row) return bot.answerCallbackQuery(query.id, { text: 'Kullanıcı bulunamadı.' });

                db.run("INSERT OR IGNORE INTO blocked_ips (ip) VALUES (?)", [row.ip]);
                db.run("INSERT OR IGNORE INTO blocked_devices (device_id) VALUES (?)", [row.device_id]);
                db.run("DELETE FROM visitors WHERE session_id = ?", [value], () => {
                    io.to(value).emit('status_update', { status: 'blocked' });
                    accessLogger.warn(`Banlandı: ip=${row.ip} device=${row.device_id} session=${value}`);
                    bot.editMessageText(`🚫 <code>${row.ip}</code> banlandı.`, {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id,
                        parse_mode: 'HTML'
                    }).finally(() => bot.answerCallbackQuery(query.id, { text: 'Kullanıcı banlandı.' }));
                });
            });
        }

        // ── unbanip ───────────────────────────────────────────────────────
        else if (action === 'unbanip') {
            db.run("DELETE FROM blocked_ips WHERE ip = ?", [value], (err) => {
                if (err) return bot.answerCallbackQuery(query.id, { text: 'Veritabanı hatası!' });
                accessLogger.info(`IP engeli kaldırıldı: ip=${value}`);
                bot.editMessageText(`✅ <code>${value}</code> engeli kaldırıldı.`, {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id,
                    parse_mode: 'HTML'
                }).finally(() => bot.answerCallbackQuery(query.id, { text: 'Engel kaldırıldı.' }));
            });
        }

        // ── log_* ─────────────────────────────────────────────────────────
        else if (action === 'log') {
            const labels = { access: '🔵 Erişim', system: '⚙️ Sistem', error: '🔴 Hata' };
            const filePath = LOG_FILES[value];
            if (!filePath) return bot.answerCallbackQuery(query.id, { text: 'Bilinmeyen kategori.' });

            bot.answerCallbackQuery(query.id, { text: 'Yükleniyor...' });
            const lines = readLastLines(filePath, 20);
            if (!lines) return bot.sendMessage(adminId, `${labels[value]} Logları: henüz kayıt yok.`);

            bot.sendMessage(adminId,
                `${labels[value]} <b>Logları (son 20)</b>\n\n<pre>${lines}</pre>`,
                { parse_mode: 'HTML' }
            );
        }

        // ── approveall ────────────────────────────────────────────────────
        else if (action === 'approveall') {
            db.all("SELECT session_id FROM visitors WHERE status = 'pending'", [], (err, rows) => {
                if (!rows?.length) return bot.answerCallbackQuery(query.id, { text: 'Bekleyen kimse yok.' });

                db.run("UPDATE visitors SET status = 'approved' WHERE status = 'pending'", [], () => {
                    rows.forEach(r => io.to(r.session_id).emit('status_update', { status: 'approved' }));
                    accessLogger.info(`Toplu onay: ${rows.length} kullanıcı onaylandı.`);
                    bot.editMessageText(`✅ ${rows.length} kullanıcı toplu olarak onaylandı.`, {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id
                    }).finally(() => bot.answerCallbackQuery(query.id, { text: `${rows.length} kişi onaylandı.` }));
                });
            });
        }

        // ── rejectall ─────────────────────────────────────────────────────
        else if (action === 'rejectall') {
            db.all("SELECT session_id FROM visitors WHERE status = 'pending'", [], (err, rows) => {
                if (!rows?.length) return bot.answerCallbackQuery(query.id, { text: 'Bekleyen kimse yok.' });

                db.run("UPDATE visitors SET status = 'rejected' WHERE status = 'pending'", [], () => {
                    rows.forEach(r => io.to(r.session_id).emit('status_update', { status: 'rejected' }));
                    accessLogger.info(`Toplu red: ${rows.length} kullanıcı reddedildi.`);
                    bot.editMessageText(`❌ ${rows.length} kullanıcı toplu olarak reddedildi.`, {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id
                    }).finally(() => bot.answerCallbackQuery(query.id, { text: `${rows.length} kişi reddedildi.` }));
                });
            });
        }

        // ── clean_old ─────────────────────────────────────────────────────
        else if (action === 'clean') {
            if (value === 'old') {
                db.run("DELETE FROM visitors WHERE status IN ('rejected', 'idle')", [], function(err) {
                    if (err) return bot.answerCallbackQuery(query.id, { text: 'Hata!' });
                    const count = this.changes;
                    systemLogger.info(`DB temizlendi: ${count} eski kayıt silindi.`);
                    bot.editMessageText(`🧹 ${count} eski kayıt silindi.`, {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id
                    }).finally(() => bot.answerCallbackQuery(query.id, { text: 'Temizlendi.' }));
                });
            } else if (value === 'all') {
                db.run("DELETE FROM visitors", [], function(err) {
                    if (err) return bot.answerCallbackQuery(query.id, { text: 'Hata!' });
                    const count = this.changes;
                    systemLogger.warn(`DB tamamen temizlendi: ${count} kayıt silindi.`);
                    bot.editMessageText(`🗑 Tüm ziyaretçi kayıtları silindi (${count} kayıt).`, {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id
                    }).finally(() => bot.answerCallbackQuery(query.id, { text: 'Tümü silindi.' }));
                });
            }
        }

        else {
            bot.answerCallbackQuery(query.id);
        }
    });

    // ── Günlük özet (her gün 20:00) ───────────────────────────────────────────
    function scheduleDailySummary() {
        const now    = new Date();
        const target = new Date();
        target.setHours(20, 0, 0, 0);
        if (target <= now) target.setDate(target.getDate() + 1); // Bugün geçtiyse yarın

        const msUntil = target - now;
        setTimeout(() => {
            sendDailySummary();
            setInterval(sendDailySummary, 24 * 60 * 60 * 1000); // Her 24 saatte bir
        }, msUntil);

        systemLogger.info(`Günlük özet için ${Math.round(msUntil / 60000)} dakika sonra zamanlandı.`);
    }

    function sendDailySummary() {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayStr = todayStart.toISOString().replace('T', ' ').substring(0, 19);

        db.get(
            `SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
                SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END) AS pending
             FROM visitors
             WHERE last_seen >= ?`,
            [todayStr],
            (err, stats) => {
                if (err) return;
                db.get("SELECT COUNT(*) AS newBans FROM blocked_ips", [], (err2, bans) => {
                    const date = new Date().toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
                    bot.sendMessage(adminId,
                        `📅 <b>Günlük Özet — ${date}</b>\n\n` +
                        `👥 Toplam istek:  <b>${stats.total}</b>\n` +
                        `✅ Onaylanan:     <b>${stats.approved}</b>\n` +
                        `❌ Reddedilen:    <b>${stats.rejected}</b>\n` +
                        `⏳ Beklemede:     <b>${stats.pending}</b>\n\n` +
                        `🚫 Toplam engelli IP: <b>${bans.newBans}</b>`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: { inline_keyboard: [[
                                { text: '✅ Hepsini Onayla', callback_data: 'approveall_x' },
                                { text: '❌ Hepsini Reddet', callback_data: 'rejectall_x'  }
                            ]]}
                        }
                    );
                });
            }
        );
    }

    scheduleDailySummary();

    // ── startTimeout dışa ver (server.js'den çağrılacak) ─────────────────────
    bot.startTimeout = (sessionId) => startTimeout(sessionId, bot, io, adminId);
    bot.buildRequestMessage = buildRequestMessage;

    return bot;
}

module.exports = { initBot };