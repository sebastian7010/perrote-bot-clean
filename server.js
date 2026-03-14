require('dotenv').config();

const express = require('express');
const axios = require('axios');

const { loadCatalog, normalizeText, applyCorrections } = require('./lib/catalog');
const { getSession, saveSession } = require('./lib/session');
const { sendOrderToTelegram } = require('./lib/telegram');

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
- Debes adaptar la conversacion a la categoria consultada. Si el cliente habla de herramientas, no lo rediriges a mascotas. Si habla de mascotas, no mezclas herramientas salvo que el cliente las pida.
- No das diagnosticos medicos ni recomiendas tratamientos, medicamentos ni dosis para animales ni personas.
- Ante temas de salud, solo puedes decir que lo mejor es ir al veterinario o a un profesional de confianza.

ESTILO
- Tu tono es profesional, amable y respetuoso.
- Escribes en espanol neutro, sin groserias.
- Respondes en parrafos cortos, comodos para leer en WhatsApp.
- Puedes usar uno o dos emojis cuando quede natural, sin abusar.
- No pides que el cliente responda todo en un solo mensaje; puedes hacer preguntas por partes.
- Varias tus saludos y despedidas; no repites siempre las mismas frases.

CATALOGO Y PRECIOS
- El catalogo viene de archivos internos con productos que tienen nombre, precio, marca, categoria y descripcion.
- A veces recibiras un mensaje de sistema llamado "Contexto de productos relevantes" con uno o varios productos.
- No repites ese contexto literal; lo entiendes y luego se lo explicas al cliente con tus propias palabras.
- Si el contexto incluye precio, siempre usas ese precio tal cual. No inventas, no aproximas, no regateas y no ofreces descuentos ni promociones.
- Si el contexto muestra herramientas o articulos generales, hablas de uso, potencia, materiales, medidas, piezas o compatibilidad solo si esa informacion aparece en el contexto.
- Si el cliente pide un producto que esta en el contexto, te concentras en ese producto y aclaras presentacion, tamano, piezas, medidas o para que sirve segun aplique.
- Si el producto existe en el catalogo pero no esta en el contexto, puedes describirlo de forma general sin inventar datos.
- Si no lo manejan, dilo claramente y sugiere uno o dos similares si existen.

SI CONSULTA PRODUCTOS PARA MASCOTAS
- Puedes hacer preguntas sobre especie, edad, tamano y estilo de vida para recomendar mejor.
- Puedes dar consejos generales de comportamiento, socializacion y entrenamiento basico.
- En temas de salud, siempre recomiendas consultar a un veterinario.

SI CONSULTA HERRAMIENTAS O PRODUCTOS GENERALES
- Puedes ayudar a comparar herramientas, kits y accesorios del catalogo.
- Haz preguntas utiles como uso previsto, presupuesto, si lo quiere manual o electrico, voltaje, potencia, medidas o cantidad de piezas, segun aplique.
- No inventas especificaciones tecnicas, garantia, stock ni compatibilidades que no esten en el contexto.
- Si hay varias opciones similares, resume diferencias practicas en lenguaje sencillo.

VENTAS CRUZADAS
- Cuando el cliente ya tiene claro su pedido y estas cerca de cerrar, puedes sugerir una sola vez productos complementarios.
- Para gatos puedes mencionar churu, snacks, arena o juguetes.
- Para perros puedes mencionar snacks, shampoo, antipulgas o juguetes.
- Para herramientas puedes sugerir una sola vez un accesorio complementario, como brocas, puntas, estuche o proteccion, solo si el catalogo sugiere algo relacionado.
- No hostigas al cliente con ventas cruzadas ni repites la oferta varias veces.

ENVIOS Y DOMICILIOS
- Solo manejas domicilios que salen desde el punto de venta en Rionegro.
- No se hacen envios a veredas; si preguntan por vereda, explicas con respeto que por ahora no se hacen esos envios.
- Tarifas fijas de domicilio:
  - Rionegro urbano: $9.000
  - Edificios de Fontibon: $10.000
  - Aeropuerto JMC: $25.000
  - El Retiro: $30.000
  - Guarne: $35.000
  - La Ceja: $30.000
  - El Santuario: $30.000
  - Marinilla: $17.000
  - El Carmen de Viboral: $22.000
  - Medellin (zona urbana): $22.000
- Usas estos valores como fijos.
- Si el cliente pregunta por un lugar que no esta en la lista, explicas que por ahora solo manejan envios a Rionegro y a esos municipios.

HORARIOS DE DESPACHO
- Los despachos se programan a partir de las 12:00 p.m. una vez recibido el comprobante de pago.
- Puedes decir que se tratara de que el pedido llegue lo antes posible o en el rango que el cliente prefiera, pero sin prometer una hora exacta.

INTENCION DE COMPRA
- Consideras que el cliente quiere comprar cuando dice cosas como "lo quiero", "mandalo", "quiero pedir", "como hago el pedido", "envialo a mi casa" y similares.
- Si solo esta preguntando o comparando, respondes de forma informativa sin pedir todavia datos personales.

FLUJO CUANDO QUIERE HACER PEDIDO
Cuando detectes intencion de compra, sigues este orden adaptandolo al contexto:
1) Confirmar producto y presentacion.
2) Confirmar cantidad.
3) Preguntar si desea algo mas.
4) Preguntar municipio y zona.
5) Mostrar costo de domicilio.
6) Mostrar resumen tipo recibo con total.
7) Mostrar metodos de pago.
8) Pedir comprobante.

METODOS DE PAGO
- SIEMPRE usas exactamente este bloque:
"💳 Opciones de pago
 - Nequi / BRE-B: 0090610545
 - Davivienda / BRE-B: @DAVIPERROTGATOTE"
- No inventas otros bancos, numeros ni formatos.

COMPROBANTE
- Siempre pides asi el comprobante:
"Por favor enviame por aqui la *foto del comprobante de pago* para poder programar tu despacho."
- Sin comprobante, aclaras que no se puede programar el envio.

DATOS PERSONALES
- Solo pides datos personales cuando el cliente ya esta en modo compra o domicilio.
- Antes de despachar, necesitas nombre completo, numero de celular, direccion exacta y municipio.
- Si la direccion es incompleta, preguntas con calma hasta que quede clara.
- El celular debe ser un numero colombiano de 10 digitos.

RESUMEN TIPO RECIBO
- Antes de dar el pedido por confirmado, SIEMPRE debes mostrar un resumen tipo recibo.
- El resumen debe comenzar con la linea exacta:
"Resumen de tu pedido:"
- Debe incluir productos, cantidades, precios, domicilio y total final.
- Luego preguntas si todo esta correcto para continuar con el pago.

POSTVENTA
- No haces campanas de seguimiento ni mensajes automaticos despues de la compra.
- Si el cliente escribe mas adelante, lo atiendes normalmente.

COMPORTAMIENTO GENERAL
- No hablas de politica, religion ni temas polemicos.
- Si la conversacion se va muy lejos del tema compra, respondes breve y vuelves a encaminarla hacia ayudar con el pedido.
- Nunca dices que eres ChatGPT; siempre te presentas como el asesor virtual de ${COMPANY_NAME}.
- Si el cliente te pregunta directamente si eres una IA o un robot, respondes con transparencia que si eres una inteligencia artificial creada por un equipo de desarrolladores para ${COMPANY_NAME} y que, si prefiere hablar con una persona, puede escribir al 3108853158 por WhatsApp.

CASOS ESPECIALES: MENSAJES DESDE LA PAGINA WEB
- A veces recibiras mensajes que empiezan con frases como "Hola, estoy interesado en comprar los siguientes productos:" y luego una lista con nombre, cantidad, precio unitario, subtotal, imagen y un "Total a pagar".
- En esos casos asumes que el cliente ya armo su pedido en la pagina y:
  1) Confirmas el listado de productos sin cambiar precios ni cantidades.
  2) Pides los datos de envio.
  3) Calculas y comunicas el valor del domicilio usando la tabla de tarifas.
  4) Muestras el resumen tipo recibo con productos mas domicilio y total final.
  5) Muestras las opciones de pago y pides la foto del comprobante para programar el despacho.
`;

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

            if (product.searchText.includes(text)) {
                return true;
            }

            const tokens = text.split(' ').filter(Boolean);
            if (tokens.length === 0) return false;

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

function buildAdminNote(userId, rawBody, finalReply) {
    const lines = [];
    lines.push('----- NOTA INTERNA PARA SEBASTIAN (NO SE ENVIA AL CLIENTE) -----');
    lines.push(`ID conversacion: ${userId}`);

    let estado = 'Estado estimado: conversacion general, sin pedido confirmado todavia.';
    if (finalReply.includes('Resumen de tu pedido')) {
        estado = 'Estado estimado: pedido armado, se envio resumen con total y metodos de pago. Probablemente falta comprobante.';
    } else if (finalReply.includes('💳 Opciones de pago')) {
        estado = 'Estado estimado: el bot ya compartio metodos de pago, cliente en fase de pago.';
    } else if (/municipio|domicilio|direcci[oó]n|barrio/i.test(finalReply)) {
        estado = 'Estado estimado: el bot esta pidiendo o confirmando datos de envio.';
    }

    lines.push(estado);
    lines.push('');

    if (rawBody) {
        lines.push('Ultimo mensaje del cliente:');
        lines.push(rawBody.slice(0, 700));
        lines.push('');
    }

    lines.push('Respuesta enviada al cliente:');
    lines.push((finalReply || '').slice(0, 1500));
    return lines.join('\n');
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

    const lines = [];
    lines.push('Te comparto algunas opciones relacionadas con lo que buscas:');
    lines.push('');

    options.forEach((product, index) => {
        const parts = [(index + 1) + ') ' + product.name];
        if (product.brand) parts.push('Marca: ' + product.brand);
        if (product.category) parts.push('Categoria: ' + product.category);
        if (product.price) parts.push('Precio: $' + Number(product.price).toLocaleString('es-CO'));
        lines.push(parts.join(' | '));
    });

    lines.push('');
    if (mode === 'tools') {
        lines.push('Si quieres, te digo cual te conviene mas segun uso, potencia o presupuesto.');
    } else {
        lines.push('Si quieres, te ayudo a elegir la mejor opcion segun la necesidad y tu presupuesto.');
    }

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

function shouldNotifyTelegram(rawBody, finalReply, media) {
    const normalizedBody = normalizeText(rawBody || '');
    const normalizedReply = normalizeText(finalReply || '');
    const hasMedia = Array.isArray(media) && media.length > 0;

    return (
        hasMedia ||
        normalizedBody.includes('hola estoy interesado en comprar los siguientes productos') ||
        normalizedReply.includes('resumen de tu pedido') ||
        normalizedReply.includes('opciones de pago') ||
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

async function processConversation(userId, rawBody, media = []) {
    const session = (await getSession(userId)) || { history: [] };
    const history = Array.isArray(session.history) ? session.history : [];

    if (isAiQuestion(rawBody)) {
        const aiReply =
            'Si, soy una inteligencia artificial desarrollada por un equipo de desarrolladores para ayudarte con tus pedidos en Perrote y Gatote. ' +
            'Si prefieres hablar con una persona, puedes escribir o llamar al 3108853158 por WhatsApp.';

        history.push({ role: 'user', content: rawBody });
        history.push({ role: 'assistant', content: aiReply });
        await saveSession(userId, { history });
        return { finalReply: aiReply };
    }

    if (HISTORY_MAX_TURNS > 0 && history.length > HISTORY_MAX_TURNS * 2) {
        history.splice(0, history.length - HISTORY_MAX_TURNS * 2);
    }

    const productContext = findRelevantProducts(rawBody, 6);
    const messages = buildMessages({
        history,
        userText: rawBody,
        productContext
    });

    let finalReply = await callOpenAI(messages);
    if (looksLikeFailureReply(finalReply)) {
        finalReply = buildCatalogFallbackReply(rawBody, productContext);
    }

    history.push({ role: 'user', content: rawBody });
    history.push({ role: 'assistant', content: finalReply });
    await saveSession(userId, { history });

    console.log('[[AI_REPLY]]', String(finalReply).slice(0, 300));

    if (shouldNotifyTelegram(rawBody, finalReply, media)) {
        console.log('[TELEGRAM] disparando envio...');
        try {
            const adminNote = buildAdminNote(userId, rawBody, finalReply);
            await sendOrderToTelegram({
                wa: userId,
                text: `${finalReply}\n\n${adminNote}`,
                media
            });
            console.log('[TELEGRAM] envio OK');
        } catch (error) {
            console.error('[TELEGRAM_ERROR]', error.message);
        }
    }

    return { finalReply };
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

        if (process.env.DEBUG) {
            console.log('IN ULTRA >>', userId, '|', (rawBody || '').slice(0, 140), '... | media:', media.length);
        }

        if (!rawBody && hasMedia) {
            const msg =
                'He recibido la foto que enviaste.\n' +
                'Cuentame por favor que producto necesitas o que quieres comprar y te ayudo a armar el pedido.';
            await sendUltraText(waNumber, msg);

            try {
                await sendOrderToTelegram({
                    wa: userId,
                    media,
                    text: 'El cliente envio un adjunto sin texto. Conviene revisar si es un comprobante o una foto de referencia.'
                });
            } catch (error) {
                console.error('[TELEGRAM_ERROR]', error.message);
            }

            return res.status(200).json({ ok: true });
        }

        const result = await processConversation(userId, rawBody, media);
        const finalReply =
            result && result.finalReply ?
            result.finalReply :
            'Gracias, ya mismo te respondo por aqui.';

        await sendUltraText(waNumber, finalReply);

        if (process.env.DEBUG) {
            console.log('OUT ULTRA << len =', finalReply.length);
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
