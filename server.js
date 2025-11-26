// @ts-nocheck
// ================== Boot & safety ==================
process.on('uncaughtException', (e) => console.error('[uncaughtException]', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', (e && e.stack) || e));

// ================== Setup básico ==================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const OpenAI = require('openai');
const IORedis = require('ioredis');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ================== Config ==================
const PORT = process.env.PORT || 3008;
const TIMEZONE = process.env.TIMEZONE || 'America/Bogota';
const DEBUG = String(process.env.DEBUG || '1') === '1';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || '10000', 10);
const OPENAI_MAX_TOKENS = parseInt(process.env.OPENAI_MAX_TOKENS || '1200', 10);

const COMPANY_NAME = process.env.COMPANY_NAME || 'Perrote y Gatote';
const BOT_NAME = process.env.BOT_NAME || 'Asesor';

// Redis para historial de chat
const redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const HISTORY_TTL_SECONDS = (parseInt(process.env.MEMORY_TTL_DAYS, 10) || 30) * 24 * 60 * 60;
const HISTORY_MAX_MESSAGES = 24;

// Claves redis
const keyHistory = (waId) => `chat:wa:${waId}:history`;
const keyLastProduct = (waId) => `chat:wa:${waId}:last-product`;

// UltraMsg
const ULTRA_INSTANCE_ID = process.env.ULTRA_INSTANCE_ID || '';
const ULTRA_TOKEN = process.env.ULTRA_TOKEN || '';
const ULTRA_BASE_URL =
    process.env.ULTRA_BASE_URL ||
    (ULTRA_INSTANCE_ID ? `https://api.ultramsg.com/${ULTRA_INSTANCE_ID}` : '');

if (DEBUG) {
    console.log('[CFG] PORT=', PORT);
    console.log('[CFG] TIMEZONE=', TIMEZONE);
    console.log('[CFG] MODEL=', OPENAI_MODEL);
    console.log('[CFG] ULTRA_BASE_URL=', ULTRA_BASE_URL);
}

// ================== OpenAI client ==================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ================== Helpers generales ==================
function normalize(str) {
    return (str || '')
        .toString()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function parseCOPnum(v) {
    if (v == null) return null;
    const digits = String(v).replace(/[^\d]/g, '');
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
}

function formatCOP(n) {
    try {
        return '$' + Number(n).toLocaleString('es-CO');
    } catch {
        return '$' + n;
    }
}

// Levenshtein para tolerar mala ortografía
function levenshtein(a, b) {
    a = a || '';
    b = b || '';
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const temp = dp[j];
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[j] = Math.min(
                dp[j] + 1,
                dp[j - 1] + 1,
                prev + cost
            );
            prev = temp;
        }
    }
    return dp[n];
}

function similarity(a, b) {
    a = a || '';
    b = b || '';
    const maxLen = Math.max(a.length, b.length);
    if (!maxLen) return 0;
    const dist = levenshtein(a, b);
    return 1 - dist / maxLen;
}

// ================== Catálogo (products.json) ==================
const CATALOG_PATH = path.join(__dirname, 'data', 'products.json');
let CATALOG = [];

function loadCatalog() {
    try {
        if (fs.existsSync(CATALOG_PATH)) {
            const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
            CATALOG = JSON.parse(raw);
            if (DEBUG) console.log('[CATALOG] cargados', CATALOG.length, 'productos');
        } else {
            console.warn('[CATALOG] No se encontró data/products.json, el bot no tendrá info de productos.');
            CATALOG = [];
        }
    } catch (e) {
        console.error('[CATALOG] error al cargar products.json:', e && e.message ? e.message : e);
        CATALOG = [];
    }
}
loadCatalog();

// Buscar productos relevantes usando coincidencia + algo de tolerancia a errores
function findRelevantProducts(query, maxResults = 5) {
    if (!query || !CATALOG.length) return [];
    const qNorm = normalize(query);
    const tokens = qNorm.split(/\s+/).filter(t => t.length > 2);
    if (!tokens.length) return [];

    const scored = [];

    for (const p of CATALOG) {
        const name = p.nombre || p.name || p.titulo || '';
        const desc = p.descripcion || p.description || '';
        const brand = p.marca || p.brand || '';
        const cat = p.categoria || p.category || '';
        const haystack = normalize(name + ' ' + desc + ' ' + brand + ' ' + cat);

        let score = 0;
        for (const t of tokens) {
            if (haystack.includes(t)) score += 2; // coincidencia directa suma más
        }

        // Si no hubo coincidencias directas, probamos similitud difusa con el nombre
        if (score === 0 && tokens.length) {
            const nameNorm = normalize(name);
            const nameWords = nameNorm.split(/\s+/).filter(Boolean);
            let bestSim = 0;
            for (const t of tokens) {
                for (const w of nameWords) {
                    const sim = similarity(t, w);
                    if (sim > bestSim) bestSim = sim;
                }
            }
            // Solo aceptamos productos que se parezcan bastante (ej. dogurmet vs dogurmet)
            if (bestSim >= 0.7) {
                score = 1 + bestSim; // algo positivo para entrar
            }
        }

        if (score > 0) {
            scored.push({ prod: p, score });
        }
    }

    if (!scored.length) return [];
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map(x => x.prod);
}

// Construye un mensaje de sistema con contexto de productos relevantes
function buildProductContext(userText) {
    const prods = findRelevantProducts(userText, 5);
    if (!prods.length) return null;

    const lines = [];
    lines.push(
        'LISTA DE PRODUCTOS DEL CATÁLOGO (NO INVENTES OTROS):\n' +
        'Solo puedes hablar de estos productos como disponibles en la tienda. ' +
        'Si el usuario menciona algo que NO coincide claramente con estos productos, ' +
        'debes decirle que no lo tienes o que no aparece en tu catálogo y ofrecerle alternativas de esta misma lista. ' +
        'Nunca inventes nombres de productos ni precios.'
    );
    lines.push('');

    prods.forEach((p, idx) => {
        const name = p.nombre || p.name || p.titulo || 'Producto sin nombre';
        const brand = p.marca || p.brand || '';
        const rawPrice = p.precio || p.price || p.valor || null;
        const nPrice = parseCOPnum(rawPrice);
        const price = nPrice != null ? formatCOP(nPrice) : 'precio no disponible';
        const desc = p.descripcion || p.description || '';

        let line = `${idx + 1}. ${name} — ${price}`;
        if (brand) line += ` — ${brand}`;
        if (desc) line += `. ${desc}`;
        lines.push(line);
    });

    return lines.join('\n');
}

// ================== Tarifas de domicilio (VOPU) ==================
const SHIPPING_ZONES = [{
        key: 'rionegro',
        label: 'Rionegro urbano (recorrido mínimo)',
        patterns: ['rionegro'],
        priceCOP: 9000,
    },
    {
        key: 'fontibon',
        label: 'Edificios de Fontibón',
        patterns: ['fontibon', 'fontibón'],
        priceCOP: 10000,
    },
    {
        key: 'aeropuerto',
        label: 'Aeropuerto JMC',
        patterns: ['aeropuerto', 'jmc', 'jose maria cordova', 'josé maría córdoba', 'josé maría córdova'],
        priceCOP: 25000,
    },
    {
        key: 'vereda',
        label: 'Vereda (tarifa por kilómetro)',
        patterns: ['vereda'],
        priceCOP: null, // se cotiza
    },
    {
        key: 'retiro',
        label: 'El Retiro',
        patterns: ['retiro'],
        priceCOP: 30000,
    },
    {
        key: 'guarne',
        label: 'Guarne',
        patterns: ['guarne'],
        priceCOP: 35000,
    },
    {
        key: 'ceja',
        label: 'La Ceja',
        patterns: ['la ceja', 'ceja'],
        priceCOP: 30000,
    },
    {
        key: 'santuario',
        label: 'El Santuario',
        patterns: ['santuario'],
        priceCOP: 30000,
    },
    {
        key: 'marinilla',
        label: 'Marinilla',
        patterns: ['marinilla'],
        priceCOP: 17000,
    },
    {
        key: 'carmen',
        label: 'El Carmen de Viboral',
        patterns: ['carmen', 'carmen de viboral'],
        priceCOP: 22000,
    },
    {
        key: 'medellin',
        label: 'Medellín (tarifa mínima)',
        patterns: ['medellin', 'medellín'],
        priceCOP: 80000,
    },
];

function detectShippingZone(text) {
    const norm = normalize(text);
    for (const zone of SHIPPING_ZONES) {
        for (const pat of zone.patterns) {
            if (norm.includes(pat)) return zone;
        }
    }
    return null;
}

// ================== Prompt del bot ==================
const systemPrompt = `
Eres ${BOT_NAME}, un asistente conversacional para WhatsApp de la tienda de mascotas "${COMPANY_NAME}" en Rionegro, Antioquia.

Te comportas como ChatGPT:
- Puedes hablar de cualquier tema que el usuario necesite (mascotas, compras, dudas generales, vida personal, etc.).
- Siempre respondes en español, con tono amable, claro y respetuoso.
- No usas mensajes pre-armados ni bloques repetitivos; escribes de forma natural como una persona real.

ESTILO
- Responde en párrafos cortos (2–5 líneas) para que sea fácil de leer en WhatsApp.
- Puedes usar uno o dos emojis cuando sea natural, pero no abuses.
- Si no entiendes algo, pide aclaración en una sola frase breve.
- No repitas siempre las mismas frases de cortesía; varía un poco tu forma de saludar y despedirte.

CATÁLOGO DE PRODUCTOS Y PRECIOS
- Solo puedes considerar como DISPONIBLES los productos que aparezcan en la lista de "productos relevantes del catálogo" que te manda el sistema.
- Nunca inventes productos ni precios. 
- Si el usuario pregunta por un producto que NO ves claramente en esa lista, responde que no lo tienes o que no aparece en tu catálogo y ofrece alternativas de la lista.
- Si el usuario escribe con mala ortografía, intenta inferir qué producto es, pero SIEMPRE verifica contra la lista. Si no coincide, di que no lo tienes.
- Cuando tengas el precio de un producto en la lista, úsalo tal como está. No cambies el valor.

DOMICILIOS CON VOPU (REFERENCIA)
Usa estas tarifas como referencia aproximada para domicilios desde el punto de venta en Rionegro. Pueden cambiar con el tiempo, pero te sirven como guía:

- Rionegro urbano (mínima): $9.000
- Edificios de Fontibón: $10.000
- Aeropuerto (JMC): $25.000
- Veredas: se cobra por kilómetro, se debe cotizar.
- El Retiro: $30.000
- Guarne: $35.000
- La Ceja: $30.000
- El Santuario: $30.000
- Marinilla: $17.000
- El Carmen de Viboral: $22.000
- Medellín: tarifa mínima alrededor de $80.000

Si el usuario pregunta por el valor del domicilio:
- Si menciona una de estas zonas, puedes responder con estos valores como referencia.
- Si pregunta por otra zona o vereda específica, sugiérele que se cotice con la empresa de mensajería para tener el valor exacto.
- Si el sistema te da un total calculado (producto + domicilio), úsalo tal cual y explícalo.

IMPORTANTE SOBRE DATOS PERSONALES
- No exijas dirección, nombre o teléfono si la persona solo está preguntando algo o explorando opciones.
- Solo si el usuario dice claramente que quiere hacer un pedido o un domicilio, puedes pedir los datos que falten, pero de forma natural, como lo haría un humano.

GENERAL
- Si el usuario solo conversa o hace preguntas que no son de la tienda, respóndele igual, como ChatGPT.
- Tu objetivo es ayudar, no presionar la venta.
`.trim();

// ================== Redis helpers ==================
async function getHistory(waId) {
    try {
        const raw = await redis.get(keyHistory(waId));
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        if (DEBUG) console.error('[REDIS] getHistory:', e && e.message ? e.message : e);
        return [];
    }
}

async function setHistory(waId, history) {
    try {
        const trimmed = history.slice(-HISTORY_MAX_MESSAGES);
        await redis.set(keyHistory(waId), JSON.stringify(trimmed), 'EX', HISTORY_TTL_SECONDS);
    } catch (e) {
        if (DEBUG) console.error('[REDIS] setHistory:', e && e.message ? e.message : e);
    }
}

async function getLastProduct(waId) {
    try {
        const raw = await redis.get(keyLastProduct(waId));
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        if (DEBUG) console.error('[REDIS] getLastProduct:', e && e.message ? e.message : e);
        return null;
    }
}

async function setLastProduct(waId, product) {
    try {
        await redis.set(keyLastProduct(waId), JSON.stringify(product), 'EX', HISTORY_TTL_SECONDS);
    } catch (e) {
        if (DEBUG) console.error('[REDIS] setLastProduct:', e && e.message ? e.message : e);
    }
}

// ================== OpenAI wrapper ==================
function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('OPENAI_TIMEOUT')), ms);
        promise
            .then((v) => {
                clearTimeout(t);
                resolve(v);
            })
            .catch((e) => {
                clearTimeout(t);
                reject(e);
            });
    });
}

async function askOpenAI(messages) {
    const maxTokens = OPENAI_MAX_TOKENS;
    const temperature = 0.5;

    if (DEBUG) {
        console.log('[AI] mensajes enviados:', messages.length);
    }

    const resp = await withTimeout(
        openai.chat.completions.create({
            model: OPENAI_MODEL,
            messages,
            temperature,
            max_tokens: maxTokens,
        }),
        OPENAI_TIMEOUT_MS
    );

    const choice = resp && resp.choices && resp.choices[0];
    const text = choice && choice.message && choice.message.content ? String(choice.message.content).trim() : '';
    if (!text) throw new Error('Respuesta vacía de OpenAI');
    if (DEBUG) console.log('[AI] respuesta len=', text.length);
    return text;
}

// ================== UltraMsg helpers ==================
async function sendUltraText(waNumber, body) {
    try {
        if (!ULTRA_BASE_URL || !ULTRA_TOKEN) {
            console.error('[ULTRA][SEND] Falta ULTRA_BASE_URL o ULTRA_TOKEN');
            return;
        }
        if (!waNumber || !body) return;

        const to = String(waNumber).replace(/[^\d]/g, '');

        const params = new URLSearchParams();
        params.append('token', ULTRA_TOKEN);
        params.append('to', to);
        params.append('body', body);
        params.append('priority', '10');

        const resp = await axios.post(
            `${ULTRA_BASE_URL}/messages/chat`,
            params.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 20000,
            }
        );

        if (DEBUG) console.log('[ULTRA][SEND] OK', resp.data);
    } catch (e) {
        console.error('[ULTRA][SEND] error:', e && e.message ? e.message : e);
    }
}

// ================== Lógica de conversación ==================
async function processConversation(userId, waNumber, userText) {
    const history = await getHistory(userId);

    // Comando de reset manual
    if (/^\s*(reset|reiniciar|nuevo chat|nuevo pedido)\s*$/i.test(userText.trim())) {
        await setHistory(userId, []);
        await setLastProduct(userId, null);
        return 'Listo, empezamos una conversación nueva. Cuéntame, ¿en qué te ayudo?';
    }

    // Info de contexto extra
    const productContext = buildProductContext(userText);
    const shippingInfo = detectShippingZone(userText);
    const lastProduct = await getLastProduct(userId);

    const messages = [
        { role: 'system', content: systemPrompt },
    ];

    if (productContext) {
        messages.push({
            role: 'system',
            content: productContext,
        });
    }

    if (lastProduct && lastProduct.priceCOP != null) {
        messages.push({
            role: 'system',
            content: `En esta conversación, el último producto que el cliente mostró interés en comprar es ` +
                `"${lastProduct.name}" con precio ${formatCOP(lastProduct.priceCOP)}. ` +
                `Si el usuario pregunta por total a enviar o por domicilio y no menciona otro producto distinto, ` +
                `usa este producto como referencia. No inventes precios distintos.`
        });
    }

    if (shippingInfo) {
        let txt =
            `Referencia de domicilio detectada: el usuario mencionó la zona "${shippingInfo.label}". `;

        if (shippingInfo.priceCOP != null) {
            txt += `La tarifa de envío de referencia para esa zona es ${formatCOP(shippingInfo.priceCOP)}. `;
        } else {
            txt += `La tarifa de envío para esta zona es por kilómetro y debe cotizarse con la empresa de mensajería. `;
        }

        if (shippingInfo.priceCOP != null && lastProduct && lastProduct.priceCOP != null) {
            const total = lastProduct.priceCOP + shippingInfo.priceCOP;
            txt += `Si el usuario quiere saber cuánto debe enviar por "${lastProduct.name}" más domicilio, ` +
                `el total aproximado es ${formatCOP(total)} (producto + envío).`;
        }

        messages.push({ role: 'system', content: txt });
    }

    // Añadimos historial previo
    for (const m of history) {
        messages.push(m);
    }

    // Mensaje actual del usuario
    messages.push({ role: 'user', content: userText });

    let reply;
    try {
        reply = await askOpenAI(messages);
    } catch (e) {
        console.error('[AI] error:', e && e.message ? e.message : e);
        reply = 'Se me presentó un problema técnico al responderte, pero ya estoy de nuevo aquí. ¿Me repites por favor lo que necesitas?';
    }

    // Actualizamos historial
    const newHistory = [
        ...history,
        { role: 'user', content: userText },
        { role: 'assistant', content: reply },
    ];
    await setHistory(userId, newHistory);

    // Guardamos posible último producto principal si parece consulta de compra/precio
    try {
        const maybeProd = findRelevantProducts(userText, 1);
        const lower = userText.toLowerCase();
        const purchaseIntent = /\b(comprar|comprarme|comprarte|comprarles|quiero comprar|quiero pedir|hacer un pedido|llevarme|precio|vale|cu[aá]nto vale|cu[aá]nto cuesta|a cu[aá]nto)\b/.test(lower);

        if (purchaseIntent && maybeProd.length === 1) {
            const p = maybeProd[0];
            const rawPrice = p.precio || p.price || p.valor;
            const priceCOP = parseCOPnum(rawPrice);
            if (priceCOP != null) {
                const name = p.nombre || p.name || p.titulo || 'Producto sin nombre';
                await setLastProduct(userId, { name, priceCOP });
                if (DEBUG) {
                    console.log('[SESSION] lastProduct set:', name, priceCOP);
                }
            }
        }
    } catch (e) {
        if (DEBUG) console.error('[SESSION] error setLastProduct:', e && e.message ? e.message : e);
    }

    return reply;
}

// ================== UltraMsg Webhook ==================
async function handleUltraWebhook(req, res) {
    try {
        if (DEBUG) {
            console.log('[ULTRA][WEBHOOK] body =', JSON.stringify(req.body, null, 2));
        }

        const eventType = req.body.event_type || req.body.eventType || '';
        if (eventType && eventType !== 'message_received') {
            return res.status(200).json({ ok: true, ignored: true });
        }

        const data = req.body.data || {};
        const fromRaw = data.from || '';
        const waNumber = String(fromRaw).split('@')[0];

        let bodyText = data.body || '';
        const type = data.type || 'chat';

        if (!bodyText) {
            if (type && type !== 'chat') {
                bodyText = `[Mensaje de tipo ${type} recibido sin texto]`;
            } else {
                console.error('[ULTRA][WEBHOOK] body vacío');
                return res.status(200).json({ ok: false, reason: 'empty_body' });
            }
        }

        if (!waNumber) {
            console.error('[ULTRA][WEBHOOK] from vacío');
            return res.status(200).json({ ok: false, reason: 'no_from' });
        }

        const userId = 'ultra:' + waNumber;

        if (DEBUG) {
            console.log('IN ULTRA >>', userId, '|', bodyText.slice(0, 140));
        }

        const finalReply = await processConversation(userId, waNumber, bodyText);

        await sendUltraText(waNumber, finalReply);

        if (DEBUG) {
            console.log('OUT ULTRA << len =', finalReply.length);
        }

        return res.status(200).json({ ok: true });
    } catch (e) {
        console.error('[ULTRA] error en webhook:', e && e.message ? e.message : e);
        return res.status(200).json({ ok: false });
    }
}

// Ruta principal de UltraMsg
app.post('/ultra-webhook', handleUltraWebhook);

// Alias opcional por si configuraste la URL del webhook solo con el dominio
app.post('/', handleUltraWebhook);

// ================== Health check ==================
app.get('/health', async(req, res) => {
    try {
        const ping = await redis.ping();
        return res.json({
            ok: true,
            time: new Date().toISOString(),
            redis: ping === 'PONG',
            model: OPENAI_MODEL,
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e && e.message ? e.message : e });
    }
});

// ================== Inicio ==================
app.listen(PORT, () => {
    console.log(
        'Server on http://localhost:' + PORT,
        '| TZ=', TIMEZONE,
        '| Model=', OPENAI_MODEL
    );
});

// ================== Salida limpia ==================
process.on('SIGINT', async() => {
    try { await redis.quit(); } catch {}
    console.log('[EXIT] SIGINT');
    process.exit(0);
});
process.on('SIGTERM', async() => {
    try { await redis.quit(); } catch {}
    console.log('[EXIT] SIGTERM');
    process.exit(0);
});