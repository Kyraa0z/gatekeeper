process.env.NTBA_FIX_350 = 1;
const TelegramBot = require('node-telegram-bot-api');
const { db }      = require('./database');
const { accessLogger, systemLogger } = require('./logger');
const fs   = require('fs');
const path = require('path');

// ── Sabitler ──────────────────────────────────────────────────────────────────
const LOG_DIR   = path.join(__dirname, '../data/logs');
const LOG_FILES = {
    access: path.join(LOG_DIR, 'access.log'),
    system: path.join(LOG_DIR, 'system.log'),
    error:  path.join(LOG_DIR, 'error.log'),
};

// Zaman aşımı — runtime'da değiştirilebilir
let timeoutMinutes = parseInt(process.env.APPROVAL_TIMEOUT_MINUTES || '10', 10);

// ── Yardımcı fonksiyonlar ─────────────────────────────────────────────────────

function readLastLines(filePath, count = 20) {
    if (!fs.existsSync(filePath)) return null;
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    return lines.slice(-count).join('\n').substring(0, 3800);
}

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

function buildRequestMessage(ip, note, ua, sessionId) {
    const { browser, os } = parseUA(ua);
    return (
        `🚨 <b>ERİŞİM TALEBİ</b>\n\n` +
        `<b>IP:</b> <code>${ip}</code>\n` +
        `<b>ID:</b> <code>${sessionId}</code>\n` +
        `<b>Tarayıcı:</b> ${browser}\n` +
        `<b>İşletim Sistemi:</b> ${os}\n` +
        `<b>Not:</b> <i>${note || 'Yok'}</i>\n\n` +
        (timeoutMinutes > 0
            ? `⏱ <i>Bu talep ${timeoutMinutes} dakika içinde yanıtlanmazsa otomatik reddedilir.</i>`
            : '')
    );
}

function startTimeout(sessionId, bot, io, adminId) {
    if (!timeoutMinutes || timeoutMinutes <= 0) return;
    setTimeout(() => {
        db.get('SELECT status FROM visitors WHERE session_id = ?', [sessionId], (err, row) => {
            if (!row || row.status !== 'pending') return;
            db.run("UPDATE visitors SET status = 'rejected' WHERE session_id = ?", [sessionId], () => {
                io.to(sessionId).emit('status_update', { status: 'rejected' });
                accessLogger.warn(`Zaman aşımı: session=${sessionId}`);
                bot.sendMessage(adminId,
                    `⏱ <b>Zaman Aşımı</b>\n<code>${sessionId}</code> otomatik reddedildi.`,
                    { parse_mode: 'HTML' }
                );
            });
        });
    }, timeoutMinutes * 60 * 1000);
}

// ── Bot başlatma ──────────────────────────────────────────────────────────────
function initBot(token, adminId, io) {
    const bot = new TelegramBot(token, { polling: true });

    // ── Menü ──────────────────────────────────────────────────────────────────
    const adminMenu = {
        reply_markup: {
            keyboard: [
                [{ text: '🌐 Sitedeki Aktifler' }, { text: '🔑 Tüm Yetkililer'   }],
                [{ text: '⏳ Bekleyen Talepler'  }, { text: '🚫 Engelli Listesi'  }],
                [{ text: '📊 İstatistikler'      }, { text: '📋 Log Kategorileri' }],
                [{ text: '🗑 Veritabanı Temizle' }, { text: '⚙️ Ayarlar'          }]
            ],
            resize_keyboard: true
        }
    };

    // ── /start ────────────────────────────────────────────────────────────────
    bot.onText(/\/start/, (msg) => {
        if (msg.chat.id.toString() !== adminId) return;
        bot.sendMessage(adminId,
            `🛡️ <b>GateKeeper Yönetim Paneli</b>\n\n` +
            `⏱ Zaman aşımı: <b>${timeoutMinutes > 0 ? timeoutMinutes + ' dakika' : 'devre dışı'}</b>\n\n` +
            `Komutlar:\n` +
            `/ara &lt;ip veya id&gt; — kullanıcı ara\n` +
            `/timeout &lt;dakika&gt; — zaman aşımı ayarla\n` +
            `/bekleyenler — bekleyen talepleri listele`,
            { parse_mode: 'HTML', ...adminMenu }
        );
    });

    // ── /ara komutu ───────────────────────────────────────────────────────────
    bot.onText(/\/ara (.+)/, (msg, match) => {
        if (msg.chat.id.toString() !== adminId) return;
        const query = match[1].trim();

        db.all(
            `SELECT * FROM visitors WHERE ip LIKE ? OR session_id LIKE ? ORDER BY last_seen DESC LIMIT 5`,
            [`%${query}%`, `%${query}%`],
            (err, rows) => {
                if (!rows?.length) {
                    return bot.sendMessage(adminId, `🔍 "<code>${query}</code>" için sonuç bulunamadı.`, { parse_mode: 'HTML' });
                }

                bot.sendMessage(adminId, `🔍 <b>${rows.length} sonuç bulundu:</b>`, { parse_mode: 'HTML' });

                rows.forEach(row => {
                    const { browser, os } = parseUA(row.user_agent);
                    const statusIcon = row.status === 'approved' ? '✅' : row.status === 'pending' ? '⏳' : '❌';
                    bot.sendMessage(adminId,
                        `${statusIcon} <b>${row.status.toUpperCase()}</b>\n` +
                        `<b>IP:</b> <code>${row.ip}</code>\n` +
                        `<b>ID:</b> <code>${row.session_id}</code>\n` +
                        `<b>Tarayıcı:</b> ${browser} / ${os}\n` +
                        `<b>Son görülme:</b> ${row.last_seen}`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: { inline_keyboard: [[
                                { text: '✅ Onayla',        callback_data: `approve_${row.session_id}` },
                                { text: '⚠️ At',           callback_data: `kick_${row.session_id}`    },
                                { text: '🚫 Banla',        callback_data: `ban_${row.session_id}`     }
                            ]]}
                        }
                    );
                });
            }
        );
    });

    // ── /timeout komutu ───────────────────────────────────────────────────────
    bot.onText(/\/timeout (\d+)/, (msg, match) => {
        if (msg.chat.id.toString() !== adminId) return;
        const minutes = parseInt(match[1], 10);

        if (isNaN(minutes) || minutes < 0) {
            return bot.sendMessage(adminId, '❌ Geçersiz değer. Örnek: /timeout 10');
        }

        timeoutMinutes = minutes;
        const msg2 = minutes === 0
            ? '⚙️ Zaman aşımı <b>devre dışı</b> bırakıldı.'
            : `⚙️ Zaman aşımı <b>${minutes} dakika</b> olarak ayarlandı.`;

        bot.sendMessage(adminId, msg2, { parse_mode: 'HTML' });
        systemLogger.info(`Zaman aşımı değiştirildi: ${minutes} dakika`);
    });

    // ── /bekleyenler komutu ───────────────────────────────────────────────────
    bot.onText(/\/bekleyenler/, (msg) => {
        if (msg.chat.id.toString() !== adminId) return;
        listPending(bot, adminId, io, null);
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
                            '🌐 Şu an yetkili oturum açmış kimse yok.\n<i>(Bekleme veya reddedilmiş olabilir.)</i>',
                            { parse_mode: 'HTML' }
                        );
                    }
                    bot.sendMessage(adminId, `🌐 <b>Sitedeki Aktifler</b> — ${rows.length} kişi`, { parse_mode: 'HTML' });
                    rows.forEach(row => {
                        const { browser, os } = parseUA(row.user_agent);
                        bot.sendMessage(adminId,
                            `✅ <b>Aktif Oturum</b>\n` +
                            `<b>IP:</b> <code>${row.ip}</code>\n` +
                            `<b>ID:</b> <code>${row.session_id}</code>\n` +
                            `<b>Tarayıcı:</b> ${browser} / ${os}\n` +
                            `<b>Son görülme:</b> ${row.last_seen}`,
                            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
                                { text: '⚠️ Siteden At', callback_data: `kick_${row.session_id}` },
                                { text: '🚫 Banla',      callback_data: `ban_${row.session_id}`  }
                            ]]}}
                        );
                    });
                }
            );
        }

        // ── 🔑 Tüm Yetkililer ──────────────────────────────────────────────
        if (text === '🔑 Tüm Yetkililer') {
            db.all("SELECT * FROM visitors WHERE status = 'approved' ORDER BY last_seen DESC", [], (err, rows) => {
                if (!rows?.length) return bot.sendMessage(adminId, '🔑 Henüz yetkili kullanıcı yok.');
                bot.sendMessage(adminId, `🔑 <b>Tüm Yetkililer</b> — ${rows.length} kişi`, { parse_mode: 'HTML' });
                rows.forEach(row => {
                    const { browser, os } = parseUA(row.user_agent);
                    bot.sendMessage(adminId,
                        `🔑 <b>Yetkili</b>\n` +
                        `<b>IP:</b> <code>${row.ip}</code>\n` +
                        `<b>ID:</b> <code>${row.session_id}</code>\n` +
                        `<b>Tarayıcı:</b> ${browser} / ${os}\n` +
                        `<b>Son görülme:</b> ${row.last_seen}`,
                        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
                            { text: '⚠️ Yetkiyi Kaldır',   callback_data: `kick_${row.session_id}` },
                            { text: '🚫 Engelle ve Banla', callback_data: `ban_${row.session_id}`  }
                        ]]}}
                    );
                });
            });
        }

        // ── ⏳ Bekleyen Talepler ────────────────────────────────────────────
        if (text === '⏳ Bekleyen Talepler') {
            listPending(bot, adminId, io, null);
        }

        // ── 🚫 Engelli Listesi ─────────────────────────────────────────────
        if (text === '🚫 Engelli Listesi') {
            bot.sendMessage(adminId, '🚫 <b>Engelli Listesi</b>\nHangi listeyi görmek istiyorsunuz?', {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[
                    { text: '🌐 Engelli IP\'ler',    callback_data: 'banlist_ip'     },
                    { text: '📱 Engelli Cihazlar',  callback_data: 'banlist_device' }
                ]]}
            });
        }

        // ── 📊 İstatistikler ───────────────────────────────────────────────
        if (text === '📊 İstatistikler') {
            const now       = new Date();
            const todayStr  = new Date(now.setHours(0,0,0,0)).toISOString().replace('T',' ').substring(0,19);
            const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7);
            const weekStr   = weekStart.toISOString().replace('T',' ').substring(0,19);

            db.get(`SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
                SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected
            FROM visitors`, [], (err, all) => {
                db.get(`SELECT COUNT(*) AS today FROM visitors WHERE last_seen >= ?`, [todayStr], (err2, tod) => {
                    db.get(`SELECT COUNT(*) AS week FROM visitors WHERE last_seen >= ?`, [weekStr], (err3, wk) => {
                        db.get("SELECT COUNT(*) AS bip FROM blocked_ips", [], (err4, bip) => {
                            db.get("SELECT COUNT(*) AS bdev FROM blocked_devices", [], (err5, bdev) => {
                                bot.sendMessage(adminId,
                                    `📊 <b>İstatistikler</b>\n\n` +
                                    `📅 <b>Bugün:</b> ${tod.today} istek\n` +
                                    `📆 <b>Bu hafta:</b> ${wk.week} istek\n` +
                                    `🗂 <b>Toplam:</b> ${all.total} istek\n\n` +
                                    `✅ Yetkili:    <b>${all.approved}</b>\n` +
                                    `⏳ Beklemede: <b>${all.pending}</b>\n` +
                                    `❌ Reddedilen: <b>${all.rejected}</b>\n\n` +
                                    `🚫 Engelli IP:    <b>${bip.bip}</b>\n` +
                                    `🚫 Engelli cihaz: <b>${bdev.bdev}</b>\n\n` +
                                    `⏱ Zaman aşımı: <b>${timeoutMinutes > 0 ? timeoutMinutes + ' dk' : 'devre dışı'}</b>`,
                                    { parse_mode: 'HTML' }
                                );
                            });
                        });
                    });
                });
            });
        }

        // ── 📋 Log Kategorileri ────────────────────────────────────────────
        if (text === '📋 Log Kategorileri') {
            bot.sendMessage(adminId, '📋 <b>Log Kategorileri</b>', {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[
                    { text: '🔵 Erişim',  callback_data: 'log_access' },
                    { text: '⚙️ Sistem',  callback_data: 'log_system' },
                    { text: '🔴 Hatalar', callback_data: 'log_error'  }
                ]]}
            });
        }

        // ── ⚙️ Ayarlar ─────────────────────────────────────────────────────
        if (text === '⚙️ Ayarlar') {
            bot.sendMessage(adminId,
                `⚙️ <b>Ayarlar</b>\n\n` +
                `⏱ Zaman aşımı: <b>${timeoutMinutes > 0 ? timeoutMinutes + ' dakika' : 'devre dışı'}</b>\n\n` +
                `Değiştirmek için:`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [
                        [
                            { text: '5 dk',  callback_data: 'setTimeout_5'  },
                            { text: '10 dk', callback_data: 'setTimeout_10' },
                            { text: '15 dk', callback_data: 'setTimeout_15' },
                            { text: '30 dk', callback_data: 'setTimeout_30' },
                        ],
                        [
                            { text: '60 dk',      callback_data: 'setTimeout_60' },
                            { text: '⛔ Devre dışı', callback_data: 'setTimeout_0'  }
                        ]
                    ]}
                }
            );
        }

        // ── 🗑 Veritabanı Temizle ──────────────────────────────────────────
        if (text === '🗑 Veritabanı Temizle') {
            bot.sendMessage(adminId, '🗑 <b>Veritabanı Temizleme</b>\nNe yapmak istiyorsunuz?', {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [
                    [{ text: '🧹 Eski rejected/idle kayıtları sil', callback_data: 'clean_old' }],
                    [{ text: '🔴 TÜM ziyaretçileri sil (dikkat!)',  callback_data: 'clean_all' }]
                ]}
            });
        }
    });

    // ── Bekleyen talepler listele ─────────────────────────────────────────────
    function listPending(bot, adminId, io, queryId) {
        db.all("SELECT * FROM visitors WHERE status = 'pending' ORDER BY last_seen ASC", [], (err, rows) => {
            if (!rows?.length) {
                if (queryId) bot.answerCallbackQuery(queryId, { text: 'Bekleyen talep yok.' });
                return bot.sendMessage(adminId, '⏳ Şu an bekleyen talep yok.');
            }

            bot.sendMessage(adminId,
                `⏳ <b>Bekleyen Talepler</b> — ${rows.length} talep\n\n` +
                `Toplu işlem:`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[
                        { text: `✅ Hepsini Onayla (${rows.length})`, callback_data: 'approveall_x' },
                        { text: `❌ Hepsini Reddet (${rows.length})`, callback_data: 'rejectall_x'  }
                    ]]}
                }
            );

            rows.forEach(row => {
                const { browser, os } = parseUA(row.user_agent);
                bot.sendMessage(adminId,
                    `⏳ <b>Bekleyen Talep</b>\n` +
                    `<b>IP:</b> <code>${row.ip}</code>\n` +
                    `<b>ID:</b> <code>${row.session_id}</code>\n` +
                    `<b>Tarayıcı:</b> ${browser} / ${os}\n` +
                    `<b>Bekleme:</b> ${row.last_seen}`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[
                            { text: '✅ Onayla', callback_data: `approve_${row.session_id}` },
                            { text: '❌ Reddet', callback_data: `reject_${row.session_id}`  },
                            { text: '🚫 Banla',  callback_data: `ban_${row.session_id}`     }
                        ]]}
                    }
                );
            });

            if (queryId) bot.answerCallbackQuery(queryId);
        });
    }

    // ── Callback handler ──────────────────────────────────────────────────────
    bot.on('callback_query', (query) => {
        const underscoreIndex = query.data.indexOf('_');
        const action = query.data.substring(0, underscoreIndex);
        const value  = query.data.substring(underscoreIndex + 1);

        // ── approve ───────────────────────────────────────────────────────
        if (action === 'approve') {
            db.get('SELECT ip FROM visitors WHERE session_id = ?', [value], (err, row) => {
                if (err || !row) return bot.answerCallbackQuery(query.id, { text: 'Kullanıcı bulunamadı.' });
                db.run("UPDATE visitors SET status = 'approved' WHERE session_id = ?", [value], (err2) => {
                    if (err2) return bot.answerCallbackQuery(query.id, { text: 'Veritabanı hatası!' });
                    const token = bot.generateToken ? bot.generateToken(value, row.ip) : null;
                    io.to(value).emit('status_update', { status: 'approved', token });
                    accessLogger.info(`Onaylandı: session=${value}`);
                    bot.editMessageText('✅ Onaylandı.', {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id
                    }).finally(() => bot.answerCallbackQuery(query.id, { text: 'Onaylandı.' }));
                });
            });
        }

        // ── reject ────────────────────────────────────────────────────────
        else if (action === 'reject') {
            db.run("UPDATE visitors SET status = 'rejected' WHERE session_id = ?", [value], (err) => {
                if (err) return bot.answerCallbackQuery(query.id, { text: 'Veritabanı hatası!' });
                io.to(value).emit('status_update', { status: 'rejected' });
                accessLogger.info(`Reddedildi: session=${value}`);
                bot.editMessageText('❌ Reddedildi.', {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                }).finally(() => bot.answerCallbackQuery(query.id, { text: 'Reddedildi.' }));
            });
        }

        // ── kick ──────────────────────────────────────────────────────────
        else if (action === 'kick') {
            db.run("UPDATE visitors SET status = 'idle' WHERE session_id = ?", [value], (err) => {
                if (err) return bot.answerCallbackQuery(query.id, { text: 'Veritabanı hatası!' });
                io.to(value).emit('force_reload');
                accessLogger.info(`Atıldı: session=${value}`);
                bot.editMessageText('⚠️ Kullanıcı atıldı.', {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                }).finally(() => bot.answerCallbackQuery(query.id, { text: 'Atıldı.' }));
            });
        }

        // ── ban ───────────────────────────────────────────────────────────
        else if (action === 'ban') {
            db.get('SELECT ip, device_id FROM visitors WHERE session_id = ?', [value], (err, row) => {
                if (!row) return bot.answerCallbackQuery(query.id, { text: 'Kullanıcı bulunamadı.' });
                db.run('INSERT OR IGNORE INTO blocked_ips (ip) VALUES (?)', [row.ip]);
                db.run('INSERT OR IGNORE INTO blocked_devices (device_id) VALUES (?)', [row.device_id]);
                db.run('DELETE FROM visitors WHERE session_id = ?', [value], () => {
                    io.to(value).emit('status_update', { status: 'blocked' });
                    accessLogger.warn(`Banlandı: ip=${row.ip} session=${value}`);
                    bot.editMessageText(`🚫 <code>${row.ip}</code> banlandı.`, {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id,
                        parse_mode: 'HTML'
                    }).finally(() => bot.answerCallbackQuery(query.id, { text: 'Banlandı.' }));
                });
            });
        }

        // ── unbanip ───────────────────────────────────────────────────────
        else if (action === 'unbanip') {
            db.run('DELETE FROM blocked_ips WHERE ip = ?', [value], (err) => {
                if (err) return bot.answerCallbackQuery(query.id, { text: 'Veritabanı hatası!' });
                accessLogger.info(`IP engeli kaldırıldı: ${value}`);
                bot.editMessageText(`✅ <code>${value}</code> engeli kaldırıldı.`, {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id,
                    parse_mode: 'HTML'
                }).finally(() => bot.answerCallbackQuery(query.id, { text: 'Engel kaldırıldı.' }));
            });
        }

        // ── unbandev ──────────────────────────────────────────────────────
        else if (action === 'unbandev') {
            db.run('DELETE FROM blocked_devices WHERE device_id = ?', [value], (err) => {
                if (err) return bot.answerCallbackQuery(query.id, { text: 'Veritabanı hatası!' });
                accessLogger.info(`Cihaz engeli kaldırıldı: ${value}`);
                bot.editMessageText(`✅ Cihaz engeli kaldırıldı.`, {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                }).finally(() => bot.answerCallbackQuery(query.id, { text: 'Engel kaldırıldı.' }));
            });
        }

        // ── banlist ───────────────────────────────────────────────────────
        else if (action === 'banlist') {
            if (value === 'ip') {
                db.all('SELECT ip FROM blocked_ips ORDER BY ip', [], (err, rows) => {
                    if (!rows?.length) return bot.answerCallbackQuery(query.id, { text: 'Engelli IP yok.' });
                    bot.answerCallbackQuery(query.id);
                    bot.sendMessage(adminId, `🌐 <b>Engelli IP\'ler</b> — ${rows.length} kayıt`, { parse_mode: 'HTML' });
                    rows.forEach(r => {
                        bot.sendMessage(adminId, `🚫 <code>${r.ip}</code>`, {
                            parse_mode: 'HTML',
                            reply_markup: { inline_keyboard: [[
                                { text: '🔓 Engeli Kaldır', callback_data: `unbanip_${r.ip}` }
                            ]]}
                        });
                    });
                });
            } else if (value === 'device') {
                db.all('SELECT device_id FROM blocked_devices ORDER BY device_id', [], (err, rows) => {
                    if (!rows?.length) return bot.answerCallbackQuery(query.id, { text: 'Engelli cihaz yok.' });
                    bot.answerCallbackQuery(query.id);
                    bot.sendMessage(adminId, `📱 <b>Engelli Cihazlar</b> — ${rows.length} kayıt`, { parse_mode: 'HTML' });
                    rows.forEach(r => {
                        const short = r.device_id.substring(0, 16) + '...';
                        bot.sendMessage(adminId, `📱 <code>${short}</code>`, {
                            parse_mode: 'HTML',
                            reply_markup: { inline_keyboard: [[
                                { text: '🔓 Engeli Kaldır', callback_data: `unbandev_${r.device_id}` }
                            ]]}
                        });
                    });
                });
            }
        }

        // ── log_* ─────────────────────────────────────────────────────────
        else if (action === 'log') {
            const labels   = { access: '🔵 Erişim', system: '⚙️ Sistem', error: '🔴 Hata' };
            const filePath = LOG_FILES[value];
            if (!filePath) return bot.answerCallbackQuery(query.id, { text: 'Bilinmeyen kategori.' });
            bot.answerCallbackQuery(query.id, { text: 'Yükleniyor...' });
            const lines = readLastLines(filePath, 20);
            if (!lines) return bot.sendMessage(adminId, `${labels[value]}: henüz kayıt yok.`);
            bot.sendMessage(adminId, `${labels[value]} <b>Logları (son 20)</b>\n\n<pre>${lines}</pre>`, { parse_mode: 'HTML' });
        }

        // ── setTimeout_* ──────────────────────────────────────────────────
        else if (action === 'setTimeout') {
            const minutes = parseInt(value, 10);
            timeoutMinutes = minutes;
            const msg2 = minutes === 0
                ? '⚙️ Zaman aşımı <b>devre dışı</b> bırakıldı.'
                : `⚙️ Zaman aşımı <b>${minutes} dakika</b> olarak ayarlandı.`;
            systemLogger.info(`Zaman aşımı: ${minutes} dakika`);
            bot.editMessageText(msg2, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id,
                parse_mode: 'HTML'
            }).finally(() => bot.answerCallbackQuery(query.id, { text: `${minutes === 0 ? 'Devre dışı' : minutes + ' dk'} ayarlandı.` }));
        }

        // ── approveall ────────────────────────────────────────────────────
        else if (action === 'approveall') {
            db.all("SELECT session_id FROM visitors WHERE status = 'pending'", [], (err, rows) => {
                if (!rows?.length) return bot.answerCallbackQuery(query.id, { text: 'Bekleyen yok.' });
                db.run("UPDATE visitors SET status = 'approved' WHERE status = 'pending'", [], () => {
                    rows.forEach(r => io.to(r.session_id).emit('status_update', { status: 'approved' }));
                    accessLogger.info(`Toplu onay: ${rows.length} kullanıcı`);
                    bot.editMessageText(`✅ ${rows.length} kullanıcı onaylandı.`, {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id
                    }).finally(() => bot.answerCallbackQuery(query.id, { text: `${rows.length} kişi onaylandı.` }));
                });
            });
        }

        // ── rejectall ─────────────────────────────────────────────────────
        else if (action === 'rejectall') {
            db.all("SELECT session_id FROM visitors WHERE status = 'pending'", [], (err, rows) => {
                if (!rows?.length) return bot.answerCallbackQuery(query.id, { text: 'Bekleyen yok.' });
                db.run("UPDATE visitors SET status = 'rejected' WHERE status = 'pending'", [], () => {
                    rows.forEach(r => io.to(r.session_id).emit('status_update', { status: 'rejected' }));
                    accessLogger.info(`Toplu red: ${rows.length} kullanıcı`);
                    bot.editMessageText(`❌ ${rows.length} kullanıcı reddedildi.`, {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id
                    }).finally(() => bot.answerCallbackQuery(query.id, { text: `${rows.length} kişi reddedildi.` }));
                });
            });
        }

        // ── clean ─────────────────────────────────────────────────────────
        else if (action === 'clean') {
            if (value === 'old') {
                db.run("DELETE FROM visitors WHERE status IN ('rejected', 'idle')", [], function(err) {
                    if (err) return bot.answerCallbackQuery(query.id, { text: 'Hata!' });
                    systemLogger.info(`DB temizlendi: ${this.changes} kayıt`);
                    bot.editMessageText(`🧹 ${this.changes} eski kayıt silindi.`, {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id
                    }).finally(() => bot.answerCallbackQuery(query.id, { text: 'Temizlendi.' }));
                });
            } else if (value === 'all') {
                db.run('DELETE FROM visitors', [], function(err) {
                    if (err) return bot.answerCallbackQuery(query.id, { text: 'Hata!' });
                    systemLogger.warn(`DB tamamen temizlendi: ${this.changes} kayıt`);
                    bot.editMessageText(`🗑 Tüm kayıtlar silindi (${this.changes}).`, {
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
        if (target <= now) target.setDate(target.getDate() + 1);
        const msUntil = target - now;
        setTimeout(() => {
            sendDailySummary();
            setInterval(sendDailySummary, 24 * 60 * 60 * 1000);
        }, msUntil);
        systemLogger.info(`Günlük özet: ${Math.round(msUntil / 60000)} dakika sonra`);
    }

    function sendDailySummary() {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayStr = todayStart.toISOString().replace('T', ' ').substring(0, 19);
        db.get(
            `SELECT COUNT(*) AS total,
             SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
             SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
             SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END) AS pending
             FROM visitors WHERE last_seen >= ?`,
            [todayStr],
            (err, stats) => {
                if (err) return;
                db.get('SELECT COUNT(*) AS bans FROM blocked_ips', [], (err2, bans) => {
                    const date = new Date().toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
                    bot.sendMessage(adminId,
                        `📅 <b>Günlük Özet — ${date}</b>\n\n` +
                        `👥 Toplam:    <b>${stats.total}</b>\n` +
                        `✅ Onaylanan: <b>${stats.approved}</b>\n` +
                        `❌ Reddedilen: <b>${stats.rejected}</b>\n` +
                        `⏳ Beklemede: <b>${stats.pending}</b>\n\n` +
                        `🚫 Engelli IP: <b>${bans.bans}</b>`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: { inline_keyboard: [[
                                { text: `✅ Hepsini Onayla (${stats.pending})`, callback_data: 'approveall_x' },
                                { text: `❌ Hepsini Reddet (${stats.pending})`, callback_data: 'rejectall_x'  }
                            ]]}
                        }
                    );
                });
            }
        );
    }

    scheduleDailySummary();

    bot.startTimeout      = (sessionId) => startTimeout(sessionId, bot, io, adminId);
    bot.buildRequestMessage = buildRequestMessage;

    return bot;
}

module.exports = { initBot };