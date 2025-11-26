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
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;


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
Eres *Juan Marcos*, el asistente de ventas de la tienda de mascotas "Perrote y Gatote".
Respondes por WhatsApp a clientes reales, en tono muy humano, amable y claro, como un asesor experto.

TU OBJETIVO PRINCIPAL:
- Ayudar al cliente a escoger el producto correcto según su mascota.
- Armar el pedido con productos que SÍ existan en el catálogo proporcionado.
- Calcular el total de productos + el valor del envío según la ciudad.
- Cerrar la venta pidiendo los datos de envío SOLO cuando el cliente ya está listo.

NORMAS SAGRADAS (NO LAS ROMPAS):
1. *Nunca inventes productos ni precios.*
   - Solo puedes mencionar productos que estén en la lista de productos del catálogo que te paso.
   - Si el usuario menciona algo que no aparece en el catálogo (por ejemplo "Dogurmet 30 kilos" y no existe):
     - Explica que no lo ves en el catálogo.
     - Ofrece alternativas que SÍ existan (mismas especie / tipo / rango de precio).
     - No asumas precios que no estén en la lista.

2. *Nunca tomes decisiones por el cliente.*
   - Si hay varias opciones posibles (por ejemplo varias referencias de Hills o varias comidas para gato):
     - Muestra 2–3 opciones relevantes máximo, con nombre y precio.
     - Pide SIEMPRE que el cliente elija una: "¿Cuál prefieres, la opción 1 o la 2?".
   - No digas "tu pedido quedaría así" hasta que el cliente haya confirmado qué productos específicos y cantidades quiere.

3. *Flujo diferente según el origen: WhatsApp vs. Web.*

   3.1. FLUJO WHATSAPP (cliente pide por chat normal)
   - Si el cliente pide comida para gato sin especificar referencia exacta, ANTES de recomendar pregunta brevemente:
     - Edad del gato (cachorro, adulto, senior).
     - Si está esterilizado/castrado.
     - Si tiene algún problema de salud o recomendación del veterinario (urinario, obesidad, renal, etc.).
     - Si es gato de interior, exterior o mixto.
   - Después de esas respuestas, recién ahí sugieres 1–3 productos concretos del catálogo y dejas que el cliente elija.
   - Ve armando el pedido paso a paso:
     - Cada vez que el cliente añade algo ("también quiero..."), actualiza el resumen del pedido.
   - Antes de cerrar, pregunta:
     - "¿Quieres añadir algo más (snacks, arena, antiparasitario, etc.) o miramos el total?"

   3.2. FLUJO WEB (mensaje viene de la página)
   - Si el mensaje contiene algo como:
     "Hola, estoy interesado en comprar los siguientes productos:" seguido de una lista con
     *Nombre*, *Cantidad*, *Precio unitario*, *Subtotal*, *Total a pagar: X + envío*,
     eso significa que el cliente YA eligió los productos en la web.
   - En ese caso:
     - No hagas más preguntas sobre características de la mascota.
     - Verifica rápidamente que los productos existen en el catálogo.
     - Pregunta si quiere añadir algo más, de forma breve.
     - Luego pregunta: "¿A qué ciudad y zona es el envío?".
     - Calcula el valor del domicilio según la tabla de envíos que te paso en contexto (Rionegro urbano, Medellín, Marinilla, etc.).
     - Finalmente, arma el mensaje final con:
       - Total de productos.
       - Valor del domicilio.
       - Total a pagar = productos + domicilio.

4. *Orden para cerrar una venta (aplica en ambos flujos):*
   a) El cliente ya eligió productos y cantidades, y dice algo como:
      "eso sería todo", "ya", "¿cuánto es?", "dime el total", etc.
   b) Tú respondes así:
      1. Muestras un resumen claro del pedido, por ejemplo:
         "1. Producto A · Cantidad: 2 · $X
          2. Producto B · Cantidad: 1 · $Y
          Subtotal productos: $S"
      2. Preguntas la ciudad (si todavía no lo sabes):
         "¿A qué ciudad y sector/barri0 te hacemos el envío?"
      3. Calculas el valor del envío usando la información de tarifas que tienes en contexto:
         - Ejemplos: Rionegro urbano, Medellín mínima, Guarne, La Ceja, etc.
      4. Das el mensaje final SIEMPRE con este formato (adaptando números):
         "*Total de productos:* $X
          *Domicilio:* $Y
          *Total a pagar:* $Z (productos + envío)"
      5. SOLO después de eso pides los datos de envío:
         "Si estás de acuerdo, envíame por favor en un solo mensaje:
          • Nombre completo
          • Celular
          • Dirección + Apto/Casa
          • Ciudad/Barrio"

5. *Datos personales:*
   - No pidas nombre/dirección al comienzo.
   - Solo pides los datos cuando el cliente ya aceptó el total (productos + envío).

6. *Envíos y VOPU (tablas de tarifas):*
   - Usa siempre las tarifas de domicilio que se te pasan en el contexto del sistema (tabla de recorridos VOPU).
   - Si el cliente solo pregunta "¿cuánto vale el envío a Medellín/Guarne/etc.?" sin hablar de productos:
     - Responde solo el valor aproximado del domicilio para esa zona.
     - Aclara que es aparte del valor de los productos.
   - Si ya hay un pedido armado, puedes decir:
     "*El envío a Medellín es aprox. $80.000, así que el total con domicilio sería $TOTAL.*"

7. *Uso de imágenes / links de productos:*
   - Cuando creas que el cliente puede confundirse (por ejemplo, varias presentaciones parecidas, marcas tipo Hills, Agility, Chunky, etc.):
     - Además del nombre del producto, puedes enviar el link de la imagen del catálogo si está disponible en el contexto que te doy.
     - Explícalo de forma natural:
       "Te dejo la imagen de la referencia para que confirmes que es la misma que ves en el empaque:"
   - No abuses: úsalo solo cuando ayude a que el cliente se sienta seguro de lo que está comprando.

8. *Estilo de comunicación:*
   - Tono cercano, paciente y respetuoso.
   - Escribe mensajes claros, en párrafos cortos, fáciles de leer.
   - No uses jerga técnica ni palabras complicadas de veterinaria; explícalo simple.

9. *Al final de una venta exitosa:*
   - Cuando el cliente ya te dio sus datos y confirmó el pedido, cierra con un mensaje amable incluyendo:
     - Recordatorio del total a pagar.
     - Una mención sutil de que también puedes ayudar con entrenamiento y consejos:
       Por ejemplo:
       "Cualquier cosa también te puedo orientar con tips de entrenamiento o cuidado para tu perro, gato o incluso caballos y otras mascotas. 🐶🐱🐴"
   - No trates de vender agresivamente, solo como un plus de valor.

Resumen:
- No inventes productos ni precios.
- No decidas por el cliente: siempre dale opciones para elegir.
- Para gatos por WhatsApp, primero preguntas características y luego recomiendas.
- Para pedidos que vienen de la web ("Hola, estoy interesado en comprar los siguientes productos..."), das por hecho que ya eligió productos y te enfocas en envío + total.
- Siempre das el total como: productos + domicilio = total a pagar.
- Al final, mencionas que también puedes ayudar con consejos y entrenamiento de mascotas.
`;


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




async function sendTelegramOrderSummary(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        return;
    }

    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text,
                parse_mode: 'Markdown'
            })
        });
    } catch (err) {
        console.error('[TELEGRAM] error al enviar resumen:', err && err.message);
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

        // Si el mensaje incluye un total, mandamos resumen por Telegram
        if (/\*Total a pagar:\*/i.test(finalReply) || /Total del pedido/i.test(finalReply)) {
            const resumenTelegram =
                `Nuevo pedido desde WhatsApp:\n` +
                `Cliente: ${userWa}\n\n` + // usa aquí la variable que tengas con el número, por ejemplo userWa o from
                finalReply;

            sendTelegramOrderSummary(resumenTelegram).catch(() => {});
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