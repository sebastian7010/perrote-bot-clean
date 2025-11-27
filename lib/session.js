// lib/session.js
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL);
const TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 30);
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

function sessionKey(wa) {
    return `session:${wa}`;
}

async function getSession(wa) {
    const key = sessionKey(wa);
    const raw = await redis.get(key);
    if (!raw) {
        return {
            cart: [],
            animal: null,
            shipping: {
                name: null,
                phone: null,
                address: null,
                city: null,
                extra: null,
                shippingCost: null,
                shippingLabel: null
            },
            stage: 'idle',
            notes: ''
        };
    }
    try {
        return JSON.parse(raw);
    } catch {
        return {
            cart: [],
            animal: null,
            shipping: {
                name: null,
                phone: null,
                address: null,
                city: null,
                extra: null,
                shippingCost: null,
                shippingLabel: null
            },
            stage: 'idle',
            notes: ''
        };
    }
}

async function saveSession(wa, session) {
    const key = sessionKey(wa);
    await redis.set(key, JSON.stringify(session), 'EX', TTL_SECONDS);
}

async function resetSession(wa) {
    const key = sessionKey(wa);
    await redis.del(key);
}

module.exports = {
    getSession,
    saveSession,
    resetSession
};