const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs = require('fs');

// Log klasörünü güvenlice oluştur
const logDir = path.join(__dirname, '../data/logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// Logların tarih ve saat formatı
const logFormat = format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
);

// Erişim Logları (Girişler, Banlar, Çıkışlar)
const accessLogger = createLogger({
    format: logFormat,
    transports: [
        new transports.Console({ format: format.combine(format.colorize(), logFormat) }),
        new transports.File({ filename: path.join(logDir, 'access.log') })
    ]
});

// Sistem ve Hata Logları (Sunucu durumu, DB hataları)
const systemLogger = createLogger({
    format: logFormat,
    transports: [
        new transports.Console({ format: format.combine(format.colorize(), logFormat) }),
        new transports.File({ filename: path.join(logDir, 'system.log') }),
        new transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' })
    ]
});

module.exports = { accessLogger, systemLogger };
