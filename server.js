// server.js
require('dotenv').config();

const express = require('express');
const axios = require('axios');

const {
    loadCatalog,
    searchProductsByText,
    searchProductsByTextLoose,
    detectQuantity,
    detectAnimal,
    normalizeText
} = require('./lib/catalog');

const { getShippingForCity } = require('./lib/shipping');
const { getSession, saveSession, resetSession } = require('./lib/session');
const { sendOrderToTelegram } = require('./lib/telegram');

process.env.TZ = process.env.TIMEZONE || 'America/Bogota';

const app = express();
const PORT = process.env.PORT || 3008;

// ====== Pagos (desde .env) ======
const NEQUI_ACCOUNT = process.env['BRE-B_NEQUI'] || '0090610545';
const DAVIVIENDA_ACCOUNT = process.env['BRE-B_DAVIVIENDA'] || '@DAVIPERROTGATOTE';

const PAYMENT_BLOCK =
    '💳 Opciones de pago:\n' +
    `• Nequi: ${NEQUI_ACCOUNT}\n` +
    `• BRE-B: ${DAVIVIENDA_ACCOUNT}`;

const PAYMENT_PROOF_LINE =
    'Por favor envíame por aquí la *foto del comprobante de pago* para programar el despacho. 🙏';

// ====== UltraMsg config ======
const ULTRA_BASE_URL = process.env.ULTRA_BASE_URL || 'https://api.ultramsg.com/instance150829/';
const ULTRA_TOKEN = process.env.ULTRA_TOKEN;

// ====== Middlewares ======
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Cargar catálogo al inicio
const catalogLoaded = loadCatalog();
const products = catalogLoaded.products;
const fuse = catalogLoaded.fuse;
console.log('[CATALOG] items: ' + products.length);

// ========== Helpers numéricos ==========

function parseCOPnum(str) {
    if (!str) return 0;
    const digits = String(str).replace(/[^\d]/g, '');
    if (!digits) return 0;
    return parseInt(digits, 10);
}

function calculateSubtotal(items) {
    if (!Array.isArray(items)) return 0;
    return items.reduce((sum, it) => {
        const price = Number(it.price) || 0;
        const qty = Number(it.qty) || 0;
        return sum + price * qty;
    }, 0);
}

// ========== Helpers de texto ==========

function isGreeting(text) {
    const t = normalizeText(text);
    return /^(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches)/.test(t);
}

function isIAQuestion(text) {
    const t = normalizeText(text);
    return /(eres una ia|eres ia|eres un bot|quien te creo|quien te creó|como funcionas|cómo funcionas)/.test(t);
}

function isFinishOrder(text) {
    const t = normalizeText(text);
    return /^(no|no gracias|nada mas|nada más|eso es todo|solo eso|solo seria)/.test(t);
}

// ================== Parseo de carrito web ==================

function parseWebCart(text) {
    const out = { items: [], totalFromText: null };
    if (!text) return out;

    const lines = String(text)
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);

    for (const line of lines) {
        if (!/cantidad\s*[:\-]/i.test(line)) continue;

        // Ejemplos:
        // "Agility Gold Obesos x 7 kilos Cantidad: 3 Precio unitario: $140.200 Subtotal: $420.600"
        // "*Agility* Cantidad: 1 Precio unitario: $56.300 Subtotal: $56.300"
        const m = line.match(
            /(.+?)\s*Cantidad\s*[:\-]\s*(\d+)\s*.*?Precio\s*unitario\s*[:\-]\s*([\$\d\.,]+)\s*.*?Subtotal\s*[:\-]\s*([\$\d\.,]+)/i
        );
        if (!m) continue;

        let name = m[1].trim();
        name = name.replace(/^[\-\*\•\d\.\)]+/, '').trim(); // limpia viñetas/numeración

        const qty = parseInt(m[2], 10);
        const unit = parseCOPnum(m[3]);
        const subtotal = parseCOPnum(m[4]);

        if (!name || !Number.isFinite(qty) || !Number.isFinite(unit)) continue;

        out.items.push({
            rawName: name,
            name,
            qty,
            unit,
            subtotal: Number.isFinite(subtotal) ? subtotal : qty * unit
        });
    }

    const totalMatch = text.match(/Total\s*a\s*pagar\s*[:\-]\s*([\$\d\.\,]+)/i);
    if (totalMatch) {
        out.totalFromText = parseCOPnum(totalMatch[1]);
    }

    return out;
}

function looksLikeWebCart(text) {
    if (!text) return false;
    const hasCantidad = /Cantidad\s*[:\-]\s*\d+/i.test(text);
    const hasPrecio = /Precio\s*unitario\s*[:\-]\s*[\$\d\.\,]+/i.test(text);
    const hasSub = /Subtotal\s*[:\-]\s*[\$\d\.\,]+/i.test(text);
    const hasTotal = /Total\s*a\s*pagar\s*[:\-]\s*[\$\d\.\,]+/i.test(text);
    return (hasCantidad && hasPrecio && hasSub) || hasTotal;
}

function parseWebOrder(text) {
    if (!looksLikeWebCart(text)) return null;
    const cart = parseWebCart(text);
    if (!cart.items.length) return null;
    return cart;
}

// ========== Núcleo de lógica del bot ==========

async function handleMessage(wa, text) {
    const rawText = text || '';
    const normalized = normalizeText(rawText);

    let session = await getSession(wa);

    // Asegurar estructura básica
    session.cart = session.cart || [];
    session.shipping = session.shipping || {};
    session.notes = session.notes || '';
    session.stage = session.stage || 'idle';

    // Guardar notas de contexto
    if (
        rawText.length > 20 &&
        /mi perro|mi gato|mi perrito|mi gatito|cachorro|sobrepeso|esterilizado|esterilizada/i.test(rawText)
    ) {
        session.notes = (session.notes || '') + ' ' + rawText.trim();
    }

    // 1) Pregunta de identidad IA (branding)
    if (isIAQuestion(rawText)) {
        return (
            'Sí, soy un asistente creado por Tolentino Software para ayudarte con tus compras en Perrote y Gatote.\n' +
            'Si quieres una IA como esta para tu negocio, visita: https://www.tolentinosftw.com/'
        );
    }

    // 2) Saludo inicial
    if (session.stage === 'idle' && session.cart.length === 0 && isGreeting(rawText)) {
        return '¡Hola! Soy Juan, asesor de Perrote y Gatote 🐶🐱. ¿En qué puedo ayudarte hoy?';
    }

    // 3) Si ya hay carrito y el cliente dice que no quiere agregar más → pasar a datos de envío
    if (session.cart.length > 0 && isFinishOrder(rawText)) {
        session.stage = 'collect-name';
        await saveSession(wa, session);
        return 'Perfecto, para el envío necesito algunos datos.\n1️⃣ Nombre completo:';
    }

    // 4) Manejo de flujo de datos de envío
    if (session.stage && (session.stage.indexOf('collect-') === 0 || session.stage === 'await-alt-city')) {
        return await handleShippingFlow(wa, rawText, session);
    }

    // 5) Detección de pedido copiado desde la web
    const webOrder = parseWebOrder(rawText);
    if (webOrder) {
        return await handleWebOrder(wa, webOrder, session);
    }

    // 6) Flujo WhatsApp (cliente escribe a mano)

    // Detectar animal si no lo tenemos aún
    if (!session.animal) {
        const animal = detectAnimal(rawText);
        if (animal) {
            session.animal = animal;
            await saveSession(wa, session);
        }
    }

    // --- Preparar texto de búsqueda limpiando la frase del usuario ---
    let searchText = rawText;

    // Si el texto empieza con "quiero comprar ..." uso solo lo que viene después
    const mComprar = rawText.match(/quiero\s+comprar\s+(.+)/i);
    if (mComprar) {
        searchText = mComprar[1];
    }

    // Si al final viene "por $56,300" o similar, se lo quito
    searchText = searchText.replace(/por\s+[\$\d\.\,]+/i, '').trim();

    // Buscar producto en catálogo (primero estricto, luego loose)
    let matches = searchProductsByText(searchText || rawText, fuse, 3);

    if (!matches.length) {
        matches = searchProductsByTextLoose(searchText || rawText, fuse, 5);
    }

    if (!matches.length) {
        return 'Este producto no está disponible, pero puedo sugerirte otros similares.';
    }

    const best = matches[0].product;
    const qty = detectQuantity(rawText);

    // Agregar al carrito
    const existing = session.cart.find(i => i.productId === best.id);

    if (existing) {
        existing.qty += qty;
    } else {
        session.cart.push({
            productId: best.id,
            name: best.name,
            price: best.price,
            qty: qty
        });
    }

    session.stage = 'building-cart';
    await saveSession(wa, session);

    const line1 =
        'Listo, agregué a tu carrito: ' +
        qty +
        ' x ' +
        best.name +
        ' por $' +
        best.price.toLocaleString('es-CO') +
        ' c/u.';
    const line2 = '¿Quieres agregar algo más o pasamos a los datos de envío? (Escríbeme "no" si ya está bien así)';

    return line1 + '\n' + line2;
}

// ========== Manejo de flujo de datos de envío ==========

async function handleShippingFlow(wa, rawText, session) {
    const t = rawText.trim();

    if (session.stage === 'collect-name') {
        session.shipping.name = t;
        session.stage = 'collect-phone';
        await saveSession(wa, session);
        return '2️⃣ Celular:';
    }

    if (session.stage === 'collect-phone') {
        session.shipping.phone = t;
        session.stage = 'collect-address';
        await saveSession(wa, session);
        return '3️⃣ Dirección + Apto/Casa:';
    }

    if (session.stage === 'collect-address') {
        session.shipping.address = t;
        session.stage = 'collect-city';
        await saveSession(wa, session);
        return '4️⃣ Ciudad (por ejemplo: Rionegro, La Ceja, Medellín, Envigado, etc.):';
    }

    if (session.stage === 'collect-city' || session.stage === 'await-alt-city') {
        const shippingInfo = getShippingForCity(t);
        if (!shippingInfo) {
            if (session.stage === 'await-alt-city' && /no/.test(normalizeText(t))) {
                session.stage = 'cancelled';
                await saveSession(wa, session);
                return (
                    'Entonces por el momento debemos cancelar el envío.\n' +
                    'Si quieres mirar otros productos o tienes otra duda, aquí estoy para ayudarte.'
                );
            }

            session.stage = 'await-alt-city';
            await saveSession(wa, session);
            return 'Por ahora no manejamos ese destino. ¿Tienes otra dirección en Antioquia o Medellín?';
        }

        session.shipping.city = t;
        session.shipping.shippingCost = shippingInfo.cost;
        session.shipping.shippingLabel = shippingInfo.label;
        session.stage = 'collect-extra';
        await saveSession(wa, session);
        return '5️⃣ (Opcional) Barrio o referencias para encontrar tu casa:';
    }

    if (session.stage === 'collect-extra') {
        session.shipping.extra = t;
        session.stage = 'completed';

        const subtotal = calculateSubtotal(session.cart);
        const shippingCost = session.shipping.shippingCost || 0;
        const total = subtotal + shippingCost;

        await saveSession(wa, session);

        const line1 = 'Súper, ya tengo todo listo.';
        const line2 =
            'Tu total es:\n' +
            '🛒 Productos: $' +
            subtotal.toLocaleString('es-CO') +
            '\n' +
            '🚚 Envío (' +
            (session.shipping.shippingLabel || 'domicilio') +
            '): $' +
            shippingCost.toLocaleString('es-CO') +
            '\n' +
            '💰 Total a pagar: $' +
            total.toLocaleString('es-CO');

        const resumenEnvio =
            '\n📦 Datos de envío:\n' +
            '• Nombre: ' +
            (session.shipping.name || '-') +
            '\n' +
            '• Celular: ' +
            (session.shipping.phone || wa) +
            '\n' +
            '• Dirección: ' +
            (session.shipping.address || '-') +
            '\n' +
            '• Ciudad: ' +
            (session.shipping.city || '-') +
            '\n' +
            (session.shipping.extra ? '• Referencias: ' + session.shipping.extra + '\n' : '');

        // Enviar al Telegram interno
        await sendOrderToTelegram({
            customerName: session.shipping.name,
            phone: session.shipping.phone || wa,
            city: session.shipping.city,
            address: session.shipping.address,
            cart: session.cart,
            subtotal: subtotal,
            shippingCost: shippingCost,
            shippingLabel: session.shipping.shippingLabel,
            total: total,
            notes: session.notes
        });

        // Mensaje al cliente SIEMPRE con cuentas + comprobante
        const reply =
            line1 +
            '\n' +
            line2 +
            '\n' +
            resumenEnvio +
            '\n' +
            PAYMENT_BLOCK +
            '\n\n' +
            PAYMENT_PROOF_LINE +
            '\n\n' +
            'Si quieres, también puedo ayudarte con recomendaciones de entrenamiento o cuidado para tu mascota. 🐶🐱';

        return reply;
    }

    // Cualquier otra cosa, reseteamos
    session.stage = 'idle';
    await saveSession(wa, session);
    return 'Listo, volvamos a empezar. Cuéntame qué necesitas para tu mascota.';
}

// ========== Manejo de pedido copiado desde la web ==========

async function handleWebOrder(wa, webOrder, session) {
    const items = webOrder.items;
    const recognized = [];
    const notFound = [];

    items.forEach(function(it) {
        // 1) Intento estricto
        let matches = searchProductsByText(it.rawName, fuse, 1);

        // 2) Si no encuentra nada, uso modo LOOSE para pedidos web
        if (!matches.length) {
            matches = searchProductsByTextLoose(it.rawName, fuse, 1);
        }

        if (!matches.length) {
            notFound.push(it.rawName);
            return;
        }

        const best = matches[0].product;
        recognized.push({
            productId: best.id,
            name: best.name,
            price: best.price,
            qty: it.qty
        });
    });

    if (!recognized.length) {
        return 'Este producto no está disponible, pero puedo sugerirte otros similares.';
    }

    session.cart = recognized;
    session.stage = 'collect-name';
    await saveSession(wa, session);

    const subtotal = calculateSubtotal(recognized);
    const lines = [];
    lines.push('Perfecto, veo que vienes de la página con este pedido:');
    recognized.forEach(function(item) {
        const sub = item.price * item.qty;
        lines.push(
            '• ' +
            item.qty +
            ' x ' +
            item.name +
            ' → $' +
            item.price.toLocaleString('es-CO') +
            ' c/u (Sub: $' +
            sub.toLocaleString('es-CO') +
            ')'
        );
    });
    lines.push('\n🛒 Subtotal productos: $' + subtotal.toLocaleString('es-CO'));

    if (notFound.length) {
        lines.push('\nEstos productos no están disponibles en el catálogo actual:');
        notFound.forEach(function(n) {
            lines.push('• ' + n);
        });
        lines.push('\nPuedo sugerirte otros productos similares para reemplazarlos.');
    }

    lines.push('\nPara continuar con el envío, por favor dime:');
    lines.push('1️⃣ Nombre completo:');

    return lines.join('\n');
}

// ========== Envío de mensajes por UltraMsg ==========
async function sendWhatsAppUltra(to, message) {
    if (!ULTRA_TOKEN) {
        console.error('[ULTRA] Falta ULTRA_TOKEN en .env');
        return;
    }
    try {
        const toClean = String(to)
            .replace(/^whatsapp:/, '')
            .replace(/@c\.us$/, '')
            .trim();

        await axios.post(ULTRA_BASE_URL + 'messages/chat', {
            token: ULTRA_TOKEN,
            to: toClean,
            body: message
        });
    } catch (err) {
        console.error('[ULTRA] Error al enviar mensaje:', err && err.response ? err.response.data : err.message);
    }
}


// ========== Rutas HTTP ==========

app.get('/', function(req, res) {
    res.send('Perrote y Gatote · Bot Juan activo 🐶🐱');
});

// Health check para Render
app.get('/health', function(req, res) {
    res.status(200).send('OK');
});
app.post('/ultra-webhook', async function(req, res) {
    try {
        const body = req.body || {};
        const data = body.data || {};

        // UltraMsg a veces manda from/body en la raíz, otras dentro de data
        let from = body.from || body.waId || data.from || '';
        let text = body.body || body.text || body.message || data.body || '';

        // Limpiar formatos tipo "whatsapp:+57..." o "57310...@c.us"
        from = String(from)
            .replace(/^whatsapp:/, '')
            .replace(/@c\.us$/, '')
            .trim();

        if (!from) {
            console.log('[WEBHOOK] sin from, body:', body);
            return res.sendStatus(200);
        }

        // Si viene vacío el texto, no hay nada que procesar
        if (!text) {
            console.log('[WEBHOOK] sin text, body:', body);
            return res.sendStatus(200);
        }

        console.log('[INCOMING]', { from, text });

        const reply = await handleMessage(from, text);

        await sendWhatsAppUltra(from, reply);

        // Útil para pruebas con curl o para ver qué respondió el bot
        return res.json({
            ok: true,
            from,
            sentText: text,
            botReply: reply
        });
    } catch (err) {
        let detail;
        if (err && err.response && err.response.data) {
            detail = err.response.data;
        } else {
            detail = err && err.message ? err.message : String(err);
        }
        console.error('[WEBHOOK] Error:', detail);
        return res.status(200).json({ ok: false, error: detail });
    }
});


app.listen(PORT, function() {
    console.log('Server on http://localhost:' + PORT + ' | TZ=' + process.env.TZ);
});