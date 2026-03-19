const Redis  = require('ioredis');
const { systemLogger } = require('./logger');

const client = new Redis({
    host:               process.env.REDIS_HOST || 'redis',
    port:               parseInt(process.env.REDIS_PORT || '6379'),
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    reconnectOnError: () => true,
});

client.on('connect',   () => systemLogger.info('Redis bağlantısı kuruldu.'));
client.on('ready',     () => systemLogger.info('Redis hazır.'));
client.on('error', (e) => systemLogger.error(`Redis hatası: ${e.message}`));

async function setSession(sessionId, data, ttlSeconds = 3600) {
    try { await client.setex(`session:${sessionId}`, ttlSeconds, JSON.stringify(data)); } catch (e) {}
}

async function getSession(sessionId) {
    try {
        const raw = await client.get(`session:${sessionId}`);
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}

async function deleteSession(sessionId) {
    try { await client.del(`session:${sessionId}`); } catch (e) {}
}

async function checkRateLimit(ip, max = 5, windowSeconds = 60) {
    try {
        const key   = `rate:${ip}`;
        const count = await client.incr(key);
        if (count === 1) await client.expire(key, windowSeconds);
        return count <= max;
    } catch (e) { return true; }
}

async function setToken(sessionId, token, ttlSeconds = 7 * 24 * 3600) {
    try { await client.setex(`token:${sessionId}`, ttlSeconds, token); } catch (e) {}
}

async function getToken(sessionId) {
    try { return await client.get(`token:${sessionId}`); } catch (e) { return null; }
}

async function deleteToken(sessionId) {
    try { await client.del(`token:${sessionId}`); } catch (e) {}
}

module.exports = { client, setSession, getSession, deleteSession, checkRateLimit, setToken, deleteToken };
