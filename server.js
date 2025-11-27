// server.js
require('dotenv').config();

const express = require('express');
const axios = require('axios');

const {
    loadCatalog,
    searchProductsByText,
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

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Cargar catálogo al inicio
const catalogLoaded = loadCatalog();
const products = catalogLoaded.products;
const fuse = catalogLoaded.fuse;
console.log('[CATALOG] items: ' + products.length);

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

// Detecta si el texto parece un pedido copiado desde la web
function parseWebOrder(text) {
    const lines = text
        .split('\n')
        .map(function(l) { return l.trim(); })
        .filter(function(l) { return l.length > 0; });

    const items = [];

    lines.forEach(function(line) {
        const mCantidad = line.match(/cantidad[: ]+(\d+)/i);
        if (!mCantidad) return;
        const qty = parseInt(mCantidad[1], 10) || 1;
        const idx = line.toLowerCase().indexOf('cantidad');
        const rawName = idx > 0 ?
            line.slice(0, idx).replace(/^[\-\•\*\·#]+/, '').trim() :
            line.trim();
        if (!rawName) return;
        items.push({ rawName: rawName, qty: qty });
    });

    if (!items.length) return null;
    return { items: items };
}

// Envía mensaje por UltraMsg
async function sendWhatsAppUltra(to, body) {
    const baseUrl = process.env.ULTRA_BASE_URL; // ej: https://api.ultramsg.com/instance150829/
    const token = process.env.ULTRA_TOKEN;

    if (!baseUrl || !token) {
        console.log('[ULTRA] No configurado, respuesta solo log:', body);
        return;
    }

    try {
        await axios.post(baseUrl + 'messages/chat', null, {
            params: {
                token: token,
                to: to,
                body: body
            }
        });
        console.log('[ULTRA] Mensaje enviado a', to);
    } catch (err) {
        var detail;
        if (err && err.response && err.response.data) {
            detail = err.response.data;
        } else {
            detail = err && err.message ? err.message : String(err);
        }
        console.error('[ULTRA] Error enviando mensaje:', detail);
    }
}

// Calcula subtotal del carrito
function calculateSubtotal(cart) {
    return cart.reduce(function(acc, item) {
        return acc + item.price * item.qty;
    }, 0);
}

// ========== Núcleo de lógica de Juan ==========

async function handleMessage(wa, text) {
    const rawText = text || '';
    const normalized = normalizeText(rawText);

    let session = await getSession(wa);

    // Guardar un poquito de contexto como notas
    if (
        rawText.length > 20 &&
        /mi perro|mi gato|mi perrito|mi gatito|cachorro|sobrepeso|esterilizado|esterilizada/i.test(rawText)
    ) {
        session.notes = (session.notes || '') + ' ' + rawText.trim();
    }

    // 1) Pregunta de identidad IA
    if (isIAQuestion(rawText)) {
        return (
            'Sí, soy un asistente creado por un equipo de ingenieros expertos de Tolentino Software para ayudarte con tus compras.\n' +
            'Si quieres una IA como yo para tu negocio, visita: https://www.tolentinosftw.com/'
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

    // Buscar producto en catálogo
    const matches = searchProductsByText(rawText, fuse, 3);

    if (!matches.length) {
        // NO inventamos producto
        return 'Este producto no está disponible, pero puedo sugerirte otros similares.';
    }

    const best = matches[0].product;
    const qty = detectQuantity(rawText);

    // Agregar al carrito
    const existing = session.cart.find(function(i) {
        return i.productId === best.id;
    });

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
    const line2 = '¿Quieres agregar algo más?';

    return line1 + '\n' + line2;
}

// Manejo de flujo de datos de envío
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
            // Si ya le dijimos que no y vuelve a decir "no tengo", cancelamos
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
        session.stage = 'ready-to-confirm';

        const subtotal = calculateSubtotal(session.cart);
        const shippingCost = session.shipping.shippingCost || 0;
        const total = subtotal + shippingCost;

        await saveSession(wa, session);

        const nequi = process.env['BRE-B_NEQUI'] || '0090610545';
        const daviplata = process.env['BRE-B_DAVIVIENDA'] || '@DAVIPERROTGATOTE';

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
        const line3 =
            '💳 Opciones de pago:\n' +
            '• Nequi: ' +
            nequi +
            '\n' +
            '• BRE-B: ' +
            daviplata;
        const line4 =
            'Si quieres, también puedo ayudarte con recomendaciones de entrenamiento o cuidado para tu mascota. 🐶🐱';

        // Enviar a Telegram
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

        session.stage = 'completed';
        await saveSession(wa, session);

        return line1 + '\n' + line2 + '\n\n' + line3 + '\n\n' + line4;
    }

    // Fallback por si algo raro pasa
    session.stage = 'idle';
    await saveSession(wa, session);
    return 'Listo, volvamos a empezar. Cuéntame qué necesitas para tu mascota.';
}

// Manejo de pedido copiado desde la web
async function handleWebOrder(wa, webOrder, session) {
    const items = webOrder.items;
    const recognized = [];
    const notFound = [];

    items.forEach(function(it) {
        const matches = searchProductsByText(it.rawName, fuse, 1);
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
        lines.push('\nEste producto no está disponible, pero puedo sugerirte otros similares para reemplazarlo.');
    }

    lines.push('\nPara continuar con el envío, por favor dime:');
    lines.push('1️⃣ Nombre completo:');

    return lines.join('\n');
}

// ========== Rutas HTTP ==========

app.get('/', function(req, res) {
    res.send('Perrote y Gatote · Bot Juan activo 🐶🐱');
});

// Webhook de UltraMsg
app.post('/ultra-webhook', async function(req, res) {
    try {
        const body = req.body || {};
        const from = body.from || body.waId || '';
        const text = body.body || body.text || body.message || '';

        if (!from) {
            console.log('[WEBHOOK] sin from, body:', body);
            return res.sendStatus(200);
        }

        console.log('[INCOMING]', { from: from, text: text });

        const reply = await handleMessage(from, text);
        await sendWhatsAppUltra(from, reply);

        res.sendStatus(200);
    } catch (err) {
        var detail;
        if (err && err.response && err.response.data) {
            detail = err.response.data;
        } else {
            detail = err && err.message ? err.message : String(err);
        }
        console.error('[WEBHOOK] Error:', detail);
        res.sendStatus(200);
    }
});

app.listen(PORT, function() {
    console.log('Server on http://localhost:' + PORT + ' | TZ=' + process.env.TZ);
});