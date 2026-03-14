const Redis = require('ioredis');

const TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 30);
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;
const DEFAULT_SESSION = {
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
    notes: '',
    history: []
};

const memoryStore = new Map();
let redis = null;
let useMemoryStore = !process.env.REDIS_URL;
let loggedMemoryFallback = false;

if (!useMemoryStore) {
    redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        lazyConnect: true
    });

    redis.on('error', (error) => {
        if (!useMemoryStore) {
            console.warn('[SESSION] Redis no disponible, usando memoria local:', error.message);
        }
        useMemoryStore = true;
    });
} else {
    console.log('[SESSION] REDIS_URL no configurado, usando memoria local.');
}

function cloneDefaultSession() {
    return JSON.parse(JSON.stringify(DEFAULT_SESSION));
}

function normalizeSession(session) {
    return {
        ...cloneDefaultSession(),
        ...(session || {}),
        shipping: {
            ...cloneDefaultSession().shipping,
            ...((session && session.shipping) || {})
        },
        history: Array.isArray(session && session.history) ? session.history : []
    };
}

function logMemoryFallbackOnce() {
    if (loggedMemoryFallback) return;
    loggedMemoryFallback = true;
    console.log('[SESSION] Las sesiones se guardaran temporalmente en memoria local.');
}

function sessionKey(wa) {
    return `session:${wa}`;
}

function cleanupExpiredMemorySessions() {
    const now = Date.now();
    for (const [key, value] of memoryStore.entries()) {
        if (value.expiresAt <= now) {
            memoryStore.delete(key);
        }
    }
}

async function ensureRedis() {
    if (useMemoryStore || !redis) {
        return false;
    }

    if (redis.status === 'ready') {
        return true;
    }

    try {
        await redis.connect();
        return redis.status === 'ready';
    } catch (error) {
        console.warn('[SESSION] No fue posible conectar con Redis, usando memoria local:', error.message);
        useMemoryStore = true;
        return false;
    }
}

async function getSession(wa) {
    const key = sessionKey(wa);

    if (await ensureRedis()) {
        try {
            const raw = await redis.get(key);
            if (!raw) return cloneDefaultSession();
            return normalizeSession(JSON.parse(raw));
        } catch (error) {
            console.warn('[SESSION] Error leyendo Redis, usando memoria local:', error.message);
            useMemoryStore = true;
        }
    }

    logMemoryFallbackOnce();
    cleanupExpiredMemorySessions();

    const record = memoryStore.get(key);
    if (!record) {
        return cloneDefaultSession();
    }

    if (record.expiresAt <= Date.now()) {
        memoryStore.delete(key);
        return cloneDefaultSession();
    }

    return normalizeSession(record.value);
}

async function saveSession(wa, session) {
    const key = sessionKey(wa);
    const normalized = normalizeSession(session);

    if (await ensureRedis()) {
        try {
            await redis.set(key, JSON.stringify(normalized), 'EX', TTL_SECONDS);
            return;
        } catch (error) {
            console.warn('[SESSION] Error guardando en Redis, usando memoria local:', error.message);
            useMemoryStore = true;
        }
    }

    logMemoryFallbackOnce();
    memoryStore.set(key, {
        value: normalized,
        expiresAt: Date.now() + (TTL_SECONDS * 1000)
    });
}

async function resetSession(wa) {
    const key = sessionKey(wa);

    if (await ensureRedis()) {
        try {
            await redis.del(key);
        } catch (error) {
            console.warn('[SESSION] Error eliminando en Redis, usando memoria local:', error.message);
            useMemoryStore = true;
        }
    }

    memoryStore.delete(key);
}

module.exports = {
    getSession,
    saveSession,
    resetSession
};
