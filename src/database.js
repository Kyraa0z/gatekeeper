const sqlite3 = require('sqlite3').verbose();
const fs   = require('fs');
const path = require('path');
const { systemLogger } = require('./logger');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'gatekeeper.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) systemLogger.error(`Veritabanı bağlantı hatası: ${err.message}`);
    else     systemLogger.info('Güvenli SQLite veritabanına bağlanıldı.');
});

const initDB = () => {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS visitors (
            session_id  TEXT PRIMARY KEY,
            device_id   TEXT,
            ip          TEXT,
            user_agent  TEXT,
            status      TEXT,
            jwt_token   TEXT,
            user_note   TEXT,
            last_seen   DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run("CREATE TABLE IF NOT EXISTS blocked_ips     (ip        TEXT PRIMARY KEY)");
        db.run("CREATE TABLE IF NOT EXISTS blocked_devices (device_id TEXT PRIMARY KEY)");

        // Mevcut DB'lerde jwt_token kolonu yoksa ekle (migration)
        db.run("ALTER TABLE visitors ADD COLUMN jwt_token TEXT", () => {});
        db.run("ALTER TABLE visitors ADD COLUMN user_note TEXT", () => {});
    });
};

module.exports = { db, initDB };