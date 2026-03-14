require('dotenv').config();

const express = require('express');
const axios = require('axios');

const { loadCatalog, normalizeText, applyCorrections } = require('./lib/catalog');
const { getSession, saveSession } = require('./lib/session');
const { sendOrderToTelegram } = require('./lib/telegram');
const { getShippingForCity } = require('./lib/shipping');

process.env.TZ = process.env.TIMEZONE || 'America/Bogota';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const BOT_NAME = process.env.BOT_NAME || 'Asesor Virtual';
const COMPANY_NAME = process.env.COMPANY_NAME || 'Perrote y Gatote';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || '30000', 10);
const OPENAI_MAX_TOKENS = parseInt(process.env.OPENAI_MAX_TOKENS || '600', 10);
const OPENAI_MAX_ATTEMPTS = parseInt(process.env.OPENAI_MAX_ATTEMPTS || '1', 10);
const HISTORY_MAX_TURNS = parseInt(process.env.HISTORY_MAX_TURNS || '12', 10);

const ULTRA_INSTANCE_ID = process.env.ULTRA_INSTANCE_ID;
const ULTRA_TOKEN = process.env.ULTRA_TOKEN;
const ULTRA_BASE_URL = process.env.ULTRA_BASE_URL || '';

const PAYMENT_BLOCK =
    'Opciones de pago\n' +
    '- Nequi / BRE-B: 0090610545\n' +
    '- Davivienda / BRE-B: @DAVIPERROTGATOTE';

const catalogLoaded = loadCatalog();
const products = catalogLoaded.products || [];
const fuse = catalogLoaded.fuse || null;
const catalogFiles = catalogLoaded.files || [];

console.log('[CATALOG] items:', products.length, '| files:', catalogFiles.length);

const systemPrompt = `
Eres ${BOT_NAME}, el asesor virtual de ventas de "${COMPANY_NAME}" en Rionegro, Antioquia (Colombia).

TU ROL Y LIMITES
- Tu unico rol es ser un asesor de ventas de ${COMPANY_NAME}.
- Atiendes productos para mascotas y tambien herramientas o articulos generales del catalogo.
- Si el cliente habla de herramientas, no lo rediriges a mascotas. Si habla de mascotas, no mezclas herramientas salvo que el cliente las pida.
- No das diagnosticos medicos ni recomiendas tratamientos, medicamentos ni dosis para animales ni personas.
- Ante temas de salud, solo puedes decir que lo mejor es ir al veterinario o a un profesional de confianza.

ESTILO
- Tu tono es profesional, amable y respetuoso.
- Escribes en espanol neutro, sin groserias.
- Respondes en parrafos cortos, comodos para leer en WhatsApp.

CATALOGO Y PRECIOS
- El catalogo viene de archivos internos con productos que tienen nombre, precio, marca, categoria y descripcion.
- A veces recibiras un mensaje de sistema llamado "Contexto de productos relevantes" con uno o varios productos.
- No repites ese contexto literal; lo entiendes y luego se lo explicas al cliente con tus propias palabras.
- Si el contexto incluye precio, siempre usas ese precio tal cual.
- Si el contexto muestra herramientas o articulos generales, hablas de uso, potencia, materiales, medidas, piezas o compatibilidad solo si esa informacion aparece en el contexto.

CONSEJOS DE COMPRA
- Si el cliente consulta mascotas, puedes preguntar especie, edad, tamano y estilo de vida.
- Si el cliente consulta herramientas, puedes preguntar uso, presupuesto, si la quiere manual o electrica, potencia o cantidad de piezas.
- No inventas especificaciones tecnicas, garantia, stock ni compatibilidades que no esten en el contexto.

ENVIO Y PAGO
- Solo manejas domicilios que salen desde Rionegro.
- Antes de despachar, necesitas nombre completo, numero de celular, direccion exacta y municipio.

COMPORTAMIENTO GENERAL
- Nunca dices que eres ChatGPT; siempre te presentas como el asesor virtual de ${COMPANY_NAME}.
- Si el cliente pregunta si eres IA o robot, respondes con transparencia que si eres una inteligencia artificial creada para ${COMPANY_NAME} y que si prefiere una persona puede escribir al 3108853158.
`;

function formatCurrency(value) {
    const number = Number(value || 0);
    return '$' + number.toLocaleString('es-CO');
}

function parseMoney(value) {
    if (value == null) return 0;
    const cleaned = String(value).replace(/[^\d]/g, '');
    return cleaned ? Number(cleaned) : 0;
}

function createCheckout() {
    return {
        active: false,
        source: null,
        items: [],
        subtotal: 0,
        total: 0,
        customerName: null,
        phone: null,
        shipping: {
            city: null,
            address: null,
            shippingCost: null,
            shippingLabel: null
        },
        paymentRequested: false,
        paymentProofReceived: false,
        proofMediaCount: 0,
        stage: 'idle'
    };
}

function normalizeCheckout(checkout) {
    return {
        ...createCheckout(),
        ...(checkout || {}),
        shipping: {
            ...createCheckout().shipping,
            ...((checkout && checkout.shipping) || {})
        },
        items: Array.isArray(checkout && checkout.items) ? checkout.items : []
    };
}

function normalizeSessionState(session) {
    return {
        ...(session || {}),
        history: Array.isArray(session && session.history) ? session.history : [],
        checkout: normalizeCheckout(session && session.checkout)
    };
}

function isCheckoutActive(checkout) {
    return Boolean(checkout && checkout.active && Array.isArray(checkout.items) && checkout.items.length > 0);
}

function buildOrderItemsText(items) {
    return items.map((item, index) => {
        const subtotal = Number(item.subtotal != null ? item.subtotal : item.qty * item.price);
        return [
            (index + 1) + ') ' + item.name,
            'Cantidad: ' + item.qty,
            'Precio unitario: ' + formatCurrency(item.price),
            'Subtotal: ' + formatCurrency(subtotal)
        ].join(' | ');
    }).join('\n');
}

function buildCheckoutConfirmation(checkout) {
    return [
        'Te confirmo el pedido:',
        '',
        buildOrderItemsText(checkout.items),
        '',
        'Subtotal productos: ' + formatCurrency(checkout.subtotal || checkout.total)
    ].join('\n');
}

function buildCheckoutMunicipalityPrompt(checkout) {
    const lines = ['Te confirmo el pedido:', ''];

    checkout.items.forEach((item) => {
        const subtotal = Number(item.subtotal != null ? item.subtotal : item.qty * item.price);
        lines.push(
            '*' + item.name + '* ' +
            '· Cantidad: ' + item.qty +
            ' · ' + formatCurrency(item.price) +
            ' = ' + formatCurrency(subtotal) + '.'
        );
    });

    lines.push('');
    lines.push('Ahora, por favor indicame en que municipio te encuentras para calcular el costo del domicilio.');
    return lines.join('\n');
}

function buildCheckoutSummary(checkout) {
    const lines = ['Resumen de tu pedido:'];

    checkout.items.forEach((item, index) => {
        const subtotal = Number(item.subtotal != null ? item.subtotal : item.qty * item.price);
        lines.push(
            (index + 1) + ') ' +
            item.name +
            ' | Cantidad: ' + item.qty +
            ' | ' + formatCurrency(item.price) +
            ' = ' + formatCurrency(subtotal)
        );
    });

    lines.push('Domicilio: ' + formatCurrency(checkout.shipping.shippingCost || 0));
    lines.push('Total a pagar: ' + formatCurrency(checkout.total || 0));
    return lines.join('\n');
}

function getMissingCheckoutFields(checkout) {
    const missing = [];

    if (!checkout.customerName) missing.push('nombre completo');
    if (!checkout.phone) missing.push('numero de celular');
    if (!checkout.shipping.city) missing.push('municipio');
    if (!checkout.shipping.address) missing.push('direccion exacta');

    return missing;
}

function buildMissingDataMessage(checkout, options = {}) {
    const missing = getMissingCheckoutFields(checkout);
    const lines = [];

    if (options.ackProof) {
        lines.push('Ya recibi la foto del comprobante.');
    }

    if (checkout.shipping.city && checkout.shipping.shippingCost != null) {
        lines.push(
            'El costo del domicilio a ' +
            checkout.shipping.city +
            ' es de ' +
            formatCurrency(checkout.shipping.shippingCost) +
            '.'
        );
    }

    if (missing.length > 0) {
        lines.push('Para programar tu despacho todavia me faltan estos datos:');
        missing.forEach((field) => {
            lines.push('- ' + field);
        });
        lines.push('');
        lines.push('Puedes enviarmelos en un solo mensaje, por ejemplo: nombre completo, celular, direccion exacta y municipio.');
    }

    return lines.join('\n');
}

function detectConversationMode(userText, productContext) {
    const text = normalizeText(userText || '');
    const categories = (productContext || [])
        .map((product) => normalizeText(product.category || ''))
        .filter(Boolean);

    const hasToolCategory = categories.some((category) => category.includes('herramient'));
    const hasPetSignal = /(perro|perrito|canino|gato|gatito|felino|mascota|arena|concentrado|snack|veterin)/.test(text);
    const hasToolSignal = /(herramient|taladro|pulidora|llave|destornillador|martillo|hidrolavadora|compresor|broca|juego de llaves|kit)/.test(text);

    if (hasToolCategory || hasToolSignal) return 'tools';
    if (hasPetSignal) return 'pets';
    return 'general';
}

function findRelevantProducts(query, max = 6) {
    if (!query || !fuse) return [];

    const text = applyCorrections(normalizeText(query || ''));
    if (!text || text.length < 2) return [];

    try {
        const exactMatches = products.filter((product) => {
            if (!product || !product.searchText) return false;
            if (product.searchText.includes(text)) return true;

            const tokens = text.split(' ').filter(Boolean);
            const matchedTokens = tokens.filter((token) => product.searchText.includes(token));
            return matchedTokens.length >= Math.max(1, Math.ceil(tokens.length * 0.6));
        });

        const fuzzyMatches = fuse.search(text, { limit: max * 3 }).map((result) => result.item);
        const combined = [];
        const seen = new Set();

        exactMatches.concat(fuzzyMatches).forEach((product) => {
            if (!product || seen.has(product.id)) return;
            seen.add(product.id);
            combined.push(product);
        });

        return combined.slice(0, max);
    } catch (error) {
        console.error('[FUSE_ERROR]', error.message);
        return [];
    }
}

function buildMessages({ history, userText, productContext }) {
    const messages = [{ role: 'system', content: systemPrompt }];
    const mode = detectConversationMode(userText, productContext);

    if (mode === 'tools') {
        messages.push({
            role: 'system',
            content: 'En esta conversacion el cliente esta consultando herramientas o articulos generales. No menciones mascotas salvo que el cliente las pida.'
        });
    } else if (mode === 'pets') {
        messages.push({
            role: 'system',
            content: 'En esta conversacion el cliente esta consultando productos para mascotas. Mantente enfocado en la mascota y en el pedido.'
        });
    }

    if (Array.isArray(productContext) && productContext.length > 0) {
        const context = JSON.stringify(
            productContext.map((product) => ({
                id: product.id,
                name: product.name,
                price: product.price,
                brand: product.brand,
                category: product.category,
                description: product.description,
                reference: product.reference
            })),
            null,
            2
        );

        messages.push({
            role: 'system',
            content: 'Contexto de productos relevantes (no lo repitas literal, solo usalo como referencia):\n' + context
        });
    }

    if (Array.isArray(history)) {
        history.forEach((msg) => {
            if (!msg || !msg.role || !msg.content) return;
            messages.push({ role: msg.role, content: msg.content });
        });
    }

    messages.push({ role: 'user', content: userText });
    return messages;
}

function parseWebOrderMessage(text) {
    const normalized = normalizeText(text || '');
    const looksLikeCatalogOrder =
        normalized.includes('hola estoy interesado en comprar los siguientes productos') ||
        (
            normalized.includes('cantidad') &&
            normalized.includes('precio unitario') &&
            normalized.includes('total a pagar')
        );

    if (!looksLikeCatalogOrder) {
        return null;
    }

    const lines = String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const items = [];
    let total = 0;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];

        if (/^total a pagar\s*:/i.test(line)) {
            total = parseMoney(line);
            continue;
        }

        const quantityLine = lines[index + 1];
        const priceLine = lines[index + 2];
        const subtotalLine = lines[index + 3];

        if (
            quantityLine && /^cantidad\s*:/i.test(quantityLine) &&
            priceLine && /^precio unitario\s*:/i.test(priceLine)
        ) {
            const qty = parseMoney(quantityLine);
            const price = parseMoney(priceLine);
            const subtotal = subtotalLine && /^subtotal\s*:/i.test(subtotalLine) ?
                parseMoney(subtotalLine) :
                qty * price;

            items.push({
                name: line,
                qty: qty || 1,
                price,
                subtotal
            });

            index += subtotalLine && /^subtotal\s*:/i.test(subtotalLine) ? 3 : 2;
        }
    }

    if (items.length === 0) {
        return null;
    }

    const subtotal = items.reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
    return {
        items,
        subtotal,
        total: total || subtotal
    };
}

function extractPhone(text) {
    const match = String(text || '').match(/(?:^|\D)(3\d{9})(?!\d)/);
    return match ? match[1] : null;
}

function extractAddress(text) {
    const match = String(text || '').match(/((?:cra|carrera|calle|cl|kr|transversal|tv|diag|diagonal|av|avenida|manzana|mz)\b[\s\S]*)/i);
    if (!match) return null;
    return match[1].trim().replace(/\s+/g, ' ');
}

function extractName(text, phone, address) {
    const raw = String(text || '').trim();
    let candidate = raw;

    if (phone) {
        candidate = candidate.split(phone)[0].trim();
    }

    if (address) {
        const position = candidate.toLowerCase().indexOf(address.toLowerCase());
        if (position >= 0) {
            candidate = candidate.slice(0, position).trim();
        }
    }

    candidate = candidate.replace(/[-,.;:]+$/g, '').trim();
    if (!candidate) return null;

    const normalized = normalizeText(candidate);
    if (/^(rionegro|marinilla|medellin|la ceja|guarne|fontibon)$/.test(normalized)) {
        return null;
    }

    const words = candidate.split(/\s+/).filter(Boolean);
    return words.length >= 2 ? candidate : null;
}

function updateCheckoutFromText(checkout, rawBody) {
    const text = String(rawBody || '').trim();
    if (!text) return checkout;

    const cityInfo = getShippingForCity(text);
    if (cityInfo) {
        checkout.shipping.city = cityInfo.label;
        checkout.shipping.shippingCost = cityInfo.cost;
        checkout.shipping.shippingLabel = cityInfo.label;
        checkout.total = Number(checkout.subtotal || 0) + Number(cityInfo.cost || 0);
    }

    const phone = extractPhone(text);
    if (phone) {
        checkout.phone = phone;
    }

    const address = extractAddress(text);
    if (address) {
        checkout.shipping.address = address;
    }

    const name = extractName(text, phone, address);
    if (name) {
        checkout.customerName = name;
    }

    return checkout;
}

function isAiQuestion(text) {
    const normalized = normalizeText(text || '');
    if (!normalized) return false;

    return (
        normalized.includes('eres una ia') ||
        normalized.includes('eres ia') ||
        normalized.includes('eres inteligencia artificial') ||
        normalized.includes('eres un robot') ||
        normalized.includes('eres robot') ||
        normalized.includes('eres un bot') ||
        normalized.includes('tu eres ia') ||
        normalized.includes('eres una inteligencia artificial')
    );
}

function buildCatalogFallbackReply(rawBody, productContext) {
    const mode = detectConversationMode(rawBody, productContext);
    const options = Array.isArray(productContext) ? productContext.slice(0, 3) : [];

    if (options.length === 0) {
        if (mode === 'tools') {
            return 'Te ayudo con gusto. Cuentame que tipo de herramienta buscas, para que uso la necesitas y si tienes un presupuesto aproximado.';
        }

        return 'Te ayudo con gusto. Cuentame que producto necesitas y, si es para tu mascota, dime por favor si es perro o gato y que necesidad tienes.';
    }

    const lines = ['Te comparto algunas opciones relacionadas con lo que buscas:', ''];

    options.forEach((product, index) => {
        const parts = [(index + 1) + ') ' + product.name];
        if (product.brand) parts.push('Marca: ' + product.brand);
        if (product.category) parts.push('Categoria: ' + product.category);
        if (product.price) parts.push('Precio: ' + formatCurrency(product.price));
        lines.push(parts.join(' | '));
    });

    lines.push('');
    lines.push(
        mode === 'tools' ?
        'Si quieres, te digo cual te conviene mas segun uso, potencia o presupuesto.' :
        'Si quieres, te ayudo a elegir la mejor opcion segun la necesidad y tu presupuesto.'
    );

    return lines.join('\n');
}

function looksLikeFailureReply(text) {
    const normalized = normalizeText(text || '');
    return (
        !normalized ||
        normalized === 'lo siento tuve un problema para responder ahora' ||
        normalized === 'gracias ya mismo te respondo por aqui'
    );
}

function buildTelegramPayload(userId, session, rawBody, finalReply, media, stageOverride) {
    const checkout = normalizeCheckout(session.checkout);
    const missingFields = getMissingCheckoutFields(checkout);

    return {
        wa: userId,
        stage: stageOverride || checkout.stage || 'conversation',
        customerName: checkout.customerName,
        phone: checkout.phone,
        city: checkout.shipping.city,
        address: checkout.shipping.address,
        cart: checkout.items,
        subtotal: checkout.subtotal,
        shippingCost: checkout.shipping.shippingCost,
        shippingLabel: checkout.shipping.shippingLabel,
        total: checkout.total,
        proofReceived: checkout.paymentProofReceived,
        missingFields,
        lastCustomerMessage: rawBody,
        botReply: finalReply,
        media
    };
}

function shouldNotifyTelegram(rawBody, finalReply, media, session) {
    const normalizedBody = normalizeText(rawBody || '');
    const normalizedReply = normalizeText(finalReply || '');
    const hasMedia = Array.isArray(media) && media.length > 0;
    const checkout = normalizeCheckout(session && session.checkout);

    return (
        hasMedia ||
        isCheckoutActive(checkout) ||
        normalizedBody.includes('hola estoy interesado en comprar los siguientes productos') ||
        normalizedReply.includes('resumen de tu pedido') ||
        normalizedReply.includes('foto del comprobante de pago')
    );
}

async function callOpenAI(messages) {
    if (!OPENAI_API_KEY) {
        console.error('[OPENAI][ERROR] Falta OPENAI_API_KEY en el .env');
        return '';
    }

    const url = 'https://api.openai.com/v1/chat/completions';
    const maxAttempts = OPENAI_MAX_ATTEMPTS > 0 ? OPENAI_MAX_ATTEMPTS : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await axios.post(
                url,
                {
                    model: OPENAI_MODEL,
                    messages,
                    temperature: 0.6,
                    max_tokens: OPENAI_MAX_TOKENS
                },
                {
                    headers: {
                        Authorization: `Bearer ${OPENAI_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: OPENAI_TIMEOUT_MS
                }
            );

            const choice = response.data && response.data.choices && response.data.choices[0];
            const content =
                choice && choice.message && choice.message.content ?
                choice.message.content :
                '';

            return String(content || '').trim();
        } catch (error) {
            console.error(`[OPENAI][ERROR] intento ${attempt}/${maxAttempts}:`, error.message);
            if (attempt === maxAttempts) break;
        }
    }

    return '';
}

function extractWhatsappPayload(reqBody) {
    const wrapper = reqBody || {};
    const src = wrapper.data && typeof wrapper.data === 'object' ? wrapper.data : wrapper;

    const body = src.Body || src.body || src.message || src.text || '';
    const from = src.waId || src.waid || src.from || src.sender || src.phone || 'desconocido';

    return {
        userWa: String(from),
        rawBody: String(body || '').trim(),
        src
    };
}

function trimHistory(history) {
    if (HISTORY_MAX_TURNS > 0 && history.length > HISTORY_MAX_TURNS * 2) {
        history.splice(0, history.length - HISTORY_MAX_TURNS * 2);
    }
}

function applyCheckoutFlow(session, rawBody) {
    const checkout = normalizeCheckout(session.checkout);
    const webOrder = parseWebOrderMessage(rawBody);

    if (webOrder) {
        const nextCheckout = normalizeCheckout({
            active: true,
            source: 'web_order',
            items: webOrder.items,
            subtotal: webOrder.subtotal,
            total: webOrder.total,
            paymentRequested: false,
            paymentProofReceived: false,
            proofMediaCount: 0,
            stage: 'awaiting_city'
        });

        session.checkout = nextCheckout;

        return {
            handled: true,
            replyMessages: [
                'Buenas tardes, claro ya te ayudo con el pedido.',
                buildCheckoutMunicipalityPrompt(nextCheckout)
            ],
            finalReply: buildCheckoutMunicipalityPrompt(nextCheckout)
        };
    }

    if (!isCheckoutActive(checkout)) {
        return { handled: false };
    }

    updateCheckoutFromText(checkout, rawBody);
    session.checkout = checkout;

    const missingFields = getMissingCheckoutFields(checkout);
    if (missingFields.length > 0) {
        checkout.stage = 'awaiting_customer_data';
        return {
            handled: true,
            finalReply: buildMissingDataMessage(checkout)
        };
    }

    if (!checkout.paymentRequested) {
        checkout.paymentRequested = true;
        checkout.stage = 'awaiting_payment_proof';

        return {
            handled: true,
            finalReply: [
                buildCheckoutSummary(checkout),
                '',
                PAYMENT_BLOCK,
                '',
                'Por favor enviame por aqui la foto del comprobante de pago para poder programar tu despacho.'
            ].join('\n')
        };
    }

    return { handled: false };
}

async function processMediaOnlyMessage(userId, media = []) {
    const session = normalizeSessionState(await getSession(userId));
    const history = session.history;
    const checkout = normalizeCheckout(session.checkout);

    let finalReply;
    let stage = 'media_received';

    history.push({ role: 'user', content: '[Adjunto recibido sin texto]' });

    if (isCheckoutActive(checkout)) {
        checkout.paymentProofReceived = true;
        checkout.proofMediaCount = Number(checkout.proofMediaCount || 0) + media.length;
        checkout.stage = 'proof_received';
        session.checkout = checkout;

        const missingFields = getMissingCheckoutFields(checkout);
        if (missingFields.length > 0) {
            finalReply = buildMissingDataMessage(checkout, { ackProof: true });
            stage = 'proof_received_missing_data';
        } else {
            finalReply = [
                'Ya recibi la foto del comprobante.',
                'Tambien tengo registrados estos datos para tu despacho:',
                '- Nombre: ' + checkout.customerName,
                '- Celular: ' + checkout.phone,
                '- Municipio: ' + checkout.shipping.city,
                '- Direccion: ' + checkout.shipping.address,
                '',
                'Tu pedido queda en programacion de despacho. Si necesitas agregar alguna aclaracion, me la puedes enviar por aqui.'
            ].join('\n');
            stage = 'proof_received_ready_to_dispatch';
        }
    } else {
        finalReply =
            'He recibido la foto que enviaste.\n' +
            'Cuentame por favor que producto necesitas o que quieres comprar y te ayudo a armar el pedido.';
    }

    history.push({ role: 'assistant', content: finalReply });
    trimHistory(history);
    session.history = history;
    await saveSession(userId, session);

    if (shouldNotifyTelegram('', finalReply, media, session)) {
        try {
            await sendOrderToTelegram(buildTelegramPayload(userId, session, '', finalReply, media, stage));
        } catch (error) {
            console.error('[TELEGRAM_ERROR]', error.message);
        }
    }

    return { finalReply };
}

async function processConversation(userId, rawBody, media = []) {
    const session = normalizeSessionState(await getSession(userId));
    const history = session.history;

    if (isAiQuestion(rawBody)) {
        const aiReply =
            'Si, soy una inteligencia artificial desarrollada por un equipo de desarrolladores para ayudarte con tus pedidos en Perrote y Gatote. ' +
            'Si prefieres hablar con una persona, puedes escribir o llamar al 3108853158 por WhatsApp.';

        history.push({ role: 'user', content: rawBody });
        history.push({ role: 'assistant', content: aiReply });
        trimHistory(history);
        session.history = history;
        await saveSession(userId, session);
        return { finalReply: aiReply };
    }

    history.push({ role: 'user', content: rawBody });
    trimHistory(history);
    session.history = history;

    const checkoutResult = applyCheckoutFlow(session, rawBody);
    if (checkoutResult.handled) {
        const replyMessages =
            Array.isArray(checkoutResult.replyMessages) && checkoutResult.replyMessages.length > 0 ?
            checkoutResult.replyMessages :
            [checkoutResult.finalReply];
        const finalReply = checkoutResult.finalReply || replyMessages[replyMessages.length - 1];

        replyMessages.forEach((message) => {
            history.push({ role: 'assistant', content: message });
        });
        trimHistory(history);
        session.history = history;
        await saveSession(userId, session);

        if (shouldNotifyTelegram(rawBody, finalReply, media, session)) {
            try {
                await sendOrderToTelegram(buildTelegramPayload(userId, session, rawBody, finalReply, media));
            } catch (error) {
                console.error('[TELEGRAM_ERROR]', error.message);
            }
        }

        return { finalReply, replyMessages };
    }

    const productContext = findRelevantProducts(rawBody, 6);
    const messages = buildMessages({
        history: history.slice(0, -1),
        userText: rawBody,
        productContext
    });

    let finalReply = await callOpenAI(messages);
    if (looksLikeFailureReply(finalReply)) {
        finalReply = buildCatalogFallbackReply(rawBody, productContext);
    }

    history.push({ role: 'assistant', content: finalReply });
    trimHistory(history);
    session.history = history;
    await saveSession(userId, session);

    console.log('[[AI_REPLY]]', String(finalReply).slice(0, 300));

    if (shouldNotifyTelegram(rawBody, finalReply, media, session)) {
        try {
            await sendOrderToTelegram(buildTelegramPayload(userId, session, rawBody, finalReply, media));
        } catch (error) {
            console.error('[TELEGRAM_ERROR]', error.message);
        }
    }

    return { finalReply, replyMessages: [finalReply] };
}

async function sendUltraText(phoneNumber, text) {
    try {
        if ((!ULTRA_INSTANCE_ID && !ULTRA_BASE_URL) || !ULTRA_TOKEN) {
            console.error('[ULTRA][SEND][ERROR] Faltan ULTRA_INSTANCE_ID/ULTRA_BASE_URL o ULTRA_TOKEN en el .env');
            return;
        }

        const baseUrl =
            ULTRA_BASE_URL && ULTRA_BASE_URL.trim().length > 0 ?
            ULTRA_BASE_URL.replace(/\/+$/, '') + '/' :
            `https://api.ultramsg.com/${ULTRA_INSTANCE_ID}/`;

        const url = `${baseUrl}messages/chat?token=${ULTRA_TOKEN}`;

        const payload = {
            to: phoneNumber,
            body: text,
            priority: 'high'
        };

        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        if (process.env.DEBUG) {
            console.log('[ULTRA][SEND][RESP]', response.data);
        }

        if (!response.data || String(response.data.sent) !== 'true') {
            console.error('[ULTRA][SEND] respuesta inesperada:', response.data);
        }
    } catch (error) {
        console.error('[ULTRA][SEND][ERROR]', error.message);
    }
}

app.get('/', (req, res) => {
    res.send('Perrote y Gatote bot running');
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

async function handleUltraWebhook(req, res) {
    try {
        console.log('========== ULTRA WEBHOOK RAW ==========');
        console.log('HEADERS:', req.headers);
        console.log('BODY RAW:', JSON.stringify(req.body, null, 2));
        console.log('=======================================');

        const { userWa, rawBody, src } = extractWhatsappPayload(req.body);
        console.log('>>> ULTRA PAYLOAD NORMALIZADO:', { userWa, rawBody });

        if (!userWa || userWa === 'desconocido') {
            console.error('[ULTRA] payload sin from');
            return res.status(200).json({ ok: false, reason: 'missing_from' });
        }

        const hasMedia = Boolean(src && src.media);
        if (!rawBody && !hasMedia) {
            console.error('[ULTRA] payload sin body ni media');
            return res.status(200).json({ ok: false, reason: 'empty_message' });
        }

        const waNumber = userWa.replace(/@c\.us$/i, '');
        const media = [];
        if (hasMedia) {
            media.push(src.media);
        }

        const userId = 'ultra:' + waNumber;

        if (!rawBody && hasMedia) {
            const result = await processMediaOnlyMessage(userId, media);
            const replyMessages =
                Array.isArray(result.replyMessages) && result.replyMessages.length > 0 ?
                result.replyMessages :
                [result.finalReply];

            for (const message of replyMessages) {
                await sendUltraText(waNumber, message);
            }
            return res.status(200).json({ ok: true });
        }

        const result = await processConversation(userId, rawBody, media);
        const replyMessages =
            result && Array.isArray(result.replyMessages) && result.replyMessages.length > 0 ?
            result.replyMessages :
            [result && result.finalReply ? result.finalReply : 'Gracias, ya mismo te respondo por aqui.'];

        for (const message of replyMessages) {
            await sendUltraText(waNumber, message);
        }
        return res.status(200).json({ ok: true });
    } catch (error) {
        console.error('[ULTRA][ERROR]', error);
        return res.status(200).json({
            ok: false,
            error: error.message
        });
    }
}

app.post('/ultra-webhook', handleUltraWebhook);

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
    console.log(`Server on port ${PORT} | TZ=${process.env.TZ} | MODEL=${OPENAI_MODEL} | items=${products.length}`);
});
