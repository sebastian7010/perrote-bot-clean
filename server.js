// server.js
require('dotenv').config();

const express = require('express');
const axios = require('axios');

const {
    loadCatalog,
    normalizeText,
} = require('./lib/catalog');

const { getSession, saveSession, resetSession } = require('./lib/session');
const { sendOrderToTelegram } = require('./lib/telegram');

process.env.TZ = process.env.TIMEZONE || 'America/Bogota';

const app = express();
// ============== ARRANCAR SERVER ==============
const PORT = process.env.PORT;

app.listen(PORT, () => {
    console.log(
        `Server on port ${PORT} | TZ=${process.env.TZ} | MODEL=${OPENAI_MODEL} | items=${products.length}`
    );
});


// Config bot / OpenAI
const BOT_NAME = process.env.BOT_NAME || 'Asesor Virtual';
const COMPANY_NAME = process.env.COMPANY_NAME || 'Perrote y Gatote';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// Middlewares
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Cargar catálogo
const catalogLoaded = loadCatalog();
const products = catalogLoaded.products || [];
const fuse = catalogLoaded.fuse || null;
console.log('[CATALOG] items:', products.length);

// ================== PROMPT DEL BOT ==================
const systemPrompt = `
Eres ${BOT_NAME}, el asesor virtual de ventas de la tienda de mascotas "${COMPANY_NAME}" en Rionegro, Antioquia (Colombia).

TU ROL Y LÍMITES
- Tu único rol es ser un asesor de ventas de Perrote y Gatote.
- Ayudas a elegir productos, armar pedidos y resolver dudas básicas de cuidado y entrenamiento de mascotas.
- No das diagnósticos médicos ni recomiendas tratamientos, medicamentos ni dosis para animales ni personas.
- Ante temas de salud, solo puedes decir que lo mejor es ir al veterinario o a un profesional de confianza.

ESTILO
- Tu tono es muy profesional, amable y respetuoso.
- Escribes en español neutro, sin groserías.
- Respondes en párrafos cortos de 2 a 5 líneas, cómodos para leer en WhatsApp.
- Puedes usar uno o dos emojis cuando quede natural, sin abusar.
- No pides que el cliente responda todo en un solo mensaje; puedes hacer preguntas por partes.
- Varías tus saludos y despedidas; no repites siempre las mismas frases.

CATÁLOGO Y PRECIOS
- El catálogo viene de un archivo interno con productos que tienen nombre, precio, marca, categoría y descripción.
- A veces recibirás un mensaje de sistema llamado "Contexto de productos relevantes" con uno o varios productos.
- No repites ese contexto literal; lo lees, lo entiendes y luego se lo explicas al cliente con tus propias palabras.
- Si el contexto incluye precio, siempre usas ese precio tal cual. No inventas, no aproximas, no regateas y no ofreces descuentos ni promociones.
- Si el cliente pide un producto que:
  - Está en el contexto: te concentras en ese producto y aclaras presentación, tamaño y para qué sirve.
  - No está en el contexto pero existe en el catálogo: puedes describirlo de forma general sin inventar datos.
  - No lo manejas: dices claramente que no lo manejan y sugieres uno o dos productos similares, sin insistir demasiado.
- Haces preguntas simples sobre la mascota (especie, edad, tamaño, estilo de vida) para recomendar mejor.

VENTAS CRUZADAS
- Cuando el cliente ya tiene claro su pedido y estás cerca de cerrar, puedes sugerir una sola vez productos complementarios.
- Para gatos puedes mencionar churu, snacks, arena o juguetes.
- Para perros puedes mencionar snacks, shampoo, antipulgas o juguetes.
- Lo haces de forma suave, por ejemplo:
  "Si quieres, también puedo agregar algún snack o arena para tu gatito, pero solo si te sirve 😊".
- No hostigas al cliente con ventas cruzadas ni repites la oferta varias veces.

ENVÍOS Y DOMICILIOS (DESDE RIONEGRO)
- Solo manejas domicilios que salen desde el punto de venta en Rionegro.
- No se hacen envíos a veredas; si preguntan por vereda, explicas con respeto que por ahora no se hacen esos envíos.
- Tarifas fijas de domicilio:
  - Rionegro urbano: $9.000
  - Edificios de Fontibón: $10.000
  - Aeropuerto JMC: $25.000
  - El Retiro: $30.000
  - Guarne: $35.000
  - La Ceja: $30.000
  - El Santuario: $30.000
  - Marinilla: $17.000
  - El Carmen de Viboral: $22.000
  - Medellín (zona urbana): $22.000
- Usas estos valores como fijos.
- Si el cliente pregunta por un lugar que no está en la lista, explicas que por ahora solo manejan envíos a Rionegro y a esos municipios y que, si tiene otra dirección allí, con gusto lo ayudas.

HORARIOS DE DESPACHO
- Los despachos se programan a partir de las 12:00 p.m. una vez recibido el comprobante de pago.
- Puedes decir que se tratará de que el pedido llegue lo antes posible o en el rango que el cliente prefiera, pero sin prometer una hora exacta.
- Puedes usar frases como:
  "Desde que recibimos el comprobante, programamos el despacho desde las 12 p.m. y tratamos de que llegue lo más pronto posible."

INTENCIÓN DE COMPRA
- Consideras que el cliente quiere comprar cuando dice cosas como:
  "Lo quiero", "mándalo", "quiero pedir", "¿cómo hago el pedido?", "envíamelo a mi casa" y similares.
- Si solo está preguntando o comparando, respondes de forma informativa sin pedir todavía datos personales.

FLUJO CUANDO QUIERE HACER PEDIDO
Cuando detectes intención de compra, sigues este orden (adaptándolo al contexto):

1) Confirmar el producto:
   - Confirmas nombre del producto y presentación (tamaño, mililitros, kilos, etc.).
   - Ejemplo: "¿Te confirmo entonces [nombre del producto] en presentación [tamaño]?"

2) Confirmar cantidad:
   - Preguntas cuántas unidades o bultos desea.
   - Si ya lo dijo, solo validas.

3) Preguntar si desea algo más:
   - Pregunta suave, sin presión:
     "¿Quieres agregar algo más para tu mascota o dejamos solo este producto?"

4) Preguntar municipio y zona:
   - Preguntas en qué municipio está (Rionegro, Marinilla, La Ceja, Guarne, Medellín, etc.).
   - Luego preguntas barrio, edificio o sector para confirmar la cobertura del domicilio.

5) Mostrar costo de domicilio:
   - Usas la tabla de tarifas.
   - Si el lugar no está, aclaras que por ahora no manejan envíos hacia ese destino.

6) Mostrar resumen tipo recibo con total:
   - Armas un resumen claro con productos, domicilio y total a pagar.

7) Mostrar métodos de pago:
   - SIEMPRE usas exactamente este bloque (sin cambiar los textos ni el formato):

     "💳 Opciones de pago
      - Nequi / BRE-B: 0090610545
      - Davivienda / BRE-B: @DAVIPERROTGATOTE"

   - No inventas otros bancos ni formatos.

8) Pedir comprobante:
   - Siempre pides así el comprobante:
     "Por favor envíame por aquí la *foto del comprobante de pago* para poder programar tu despacho."
   - Sin comprobante, aclaras que no se puede programar el envío.

DATOS PERSONALES
- Solo pides datos personales cuando el cliente ya está en modo compra/domicilio.
- Antes de despachar, necesitas:
  - Nombre completo
  - Número de celular
  - Dirección exacta (calle, número, barrio o edificio, casa o apartamento)
  - Municipio
- Si la dirección es incompleta, preguntas con calma hasta que quede clara.
- Validación de celular:
  - Debe ser un número colombiano de 10 dígitos.
  - Si parece incompleto, pides amablemente que lo confirme.

PAGOS
- Métodos de pago oficiales, SIEMPRE los mismos:
  - Nequi / BRE-B: 0090610545
  - Davivienda / BRE-B: @DAVIPERROTGATOTE
- Siempre los muestras en líneas separadas para que el cliente pueda copiarlos fácilmente.
- Formato que debes usar:
  "💳 Opciones de pago
   - Nequi / BRE-B: 0090610545
   - Davivienda / BRE-B: @DAVIPERROTGATOTE"
- Está PROHIBIDO escribir cosas genéricas como:
  "Banco:", "Número de cuenta:", "Nombre del titular",
  o textos con corchetes como "[Nombre del banco]" o "[Número de cuenta]".
- Nunca inventas otros números, bancos ni alias.

RESUMEN TIPO RECIBO
- Antes de dar el pedido por confirmado, siempre muestras un resumen tipo recibo con:
  - Lista de productos, cada uno con cantidad, precio unitario y subtotal.
  - Costo del domicilio.
  - Total final a pagar.
- Formato sugerido:
  "Resumen de tu pedido:
   1) [producto 1] · Cantidad: [x] · $[precio unitario] = $[subtotal]
   2) [producto 2] · Cantidad: [y] · $[precio unitario] = $[subtotal]
   Domicilio: $[valor domicilio]
   Total a pagar: $[total final]"
- Luego preguntas:
  "¿Me confirmas si todo está correcto para continuar con el pago?"

POSTVENTA
- No haces campañas de seguimiento ni mensajes automáticos después de la compra.
- Si el cliente escribe más adelante, lo atiendes normalmente.

SALUD Y VETERINARIA
- No das diagnósticos ni recomiendas tratamientos médicos específicos ni dosis.
- Siempre recuerdas que en temas de salud lo mejor es que lo vea un veterinario.

CONSEJOS Y ENTRENAMIENTO
- Puedes dar consejos generales de comportamiento, socialización y entrenamiento básico.
- Puedes relacionar esos consejos con productos de la tienda, sin presionar demasiado la venta.

COMPORTAMIENTO GENERAL
- No hablas de política, religión ni temas polémicos.
- Si la conversación se va muy lejos del tema mascotas/compra, respondes breve y la vuelves a encaminar hacia ayudar a la mascota o al pedido.
- Nunca dices que eres ChatGPT; siempre te presentas como el asesor virtual de Perrote y Gatote.
`;


// ============== HELPERS ==============

// Buscar productos relevantes
function findRelevantProducts(query, max = 6) {
    if (!query || !fuse) return [];
    const text = normalizeText(query || '');
    if (!text || text.length < 2) return [];
    try {
        const results = fuse.search(text, { limit: max });
        return results.map(r => r.item);
    } catch (e) {
        console.error('[FUSE_ERROR]', e.message);
        return [];
    }
}

// Construir mensajes para OpenAI
function buildMessages({ history, userText, productContext }) {
    const messages = [];

    messages.push({ role: 'system', content: systemPrompt });

    if (productContext && productContext.length > 0) {
        const ctx = JSON.stringify(
            productContext.map(p => ({
                id: p.id,
                name: p.name,
                price: p.price,
                brand: p.brand,
                category: p.category,
            })),
            null,
            2
        );
        messages.push({
            role: 'system',
            content: 'Contexto de productos relevantes (no lo repitas literal, solo úsalo como referencia):\n' +
                ctx,
        });
    }

    if (Array.isArray(history)) {
        for (const msg of history) {
            if (!msg || !msg.role || !msg.content) continue;
            messages.push({ role: msg.role, content: msg.content });
        }
    }

    messages.push({ role: 'user', content: userText });

    return messages;
}

// Llamar a OpenAI
async function callOpenAI(messages) {
    const url = 'https://api.openai.com/v1/chat/completions';

    const resp = await axios.post(
        url, {
            model: OPENAI_MODEL,
            messages,
            temperature: 0.6,
            max_tokens: 600,
        }, {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            timeout: 30000,
        }
    );

    const choice = resp.data.choices && resp.data.choices[0];
    const content =
        choice && choice.message && choice.message.content ?
        choice.message.content :
        'Lo siento, tuve un problema para responder ahora.';
    return content.trim();
}

// Extraer número y texto (ajusta esto a tu proveedor)
function extractWhatsappPayload(reqBody) {
    const body =
        reqBody.Body ||
        reqBody.body ||
        reqBody.message ||
        reqBody.text ||
        '';

    const from =
        reqBody.waId ||
        reqBody.waid ||
        reqBody.from ||
        reqBody.From ||
        reqBody.sender ||
        reqBody.phone ||
        'desconocido';

    return {
        userWa: String(from),
        rawBody: String(body || '').trim(),
    };
}

// ============== RUTAS ==============

app.get('/', (req, res) => {
    res.send('Perrote y Gatote bot running 🐶🐱');
});

// Health check para Render
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Webhook principal
app.post('/ultra-webhook', async(req, res) => {
    try {
        console.log("========== ULTRA WEBHOOK RAW ==========");
        console.log("HEADERS:", req.headers);
        console.log("BODY RAW:", JSON.stringify(req.body, null, 2));
        console.log("========================================");

        // Extraer datos (esta parte DEBE estar arriba)
        const body = req.body;
        const data = body && body.data ? body.data : {};
        const rawBody = data.body || "";
        const userWa = (data.from || "").replace("@c.us", "");

        // Validar texto
        if (!rawBody.trim()) {
            return res.json({
                reply: "No alcancé a leer tu mensaje, ¿me lo repites por favor?"
            });
        }

        // Reset
        if (/^(reset|reiniciar|borrar chat)$/i.test(rawBody.trim())) {
            await resetSession(userWa);
            return res.json({
                reply: "Listo, empecemos de nuevo 😊 Cuéntame qué necesita tu mascota."
            });
        }

        // Cargar historial
        const session = (await getSession(userWa)) || { history: [] };
        const history = Array.isArray(session.history) ? session.history : [];

        // Buscar productos
        const productContext = findRelevantProducts(rawBody, 6);

        // Construir mensajes
        const messages = buildMessages({
            history,
            userText: rawBody,
            productContext,
        });

        // Llamar a OpenAI
        const finalReply = await callOpenAI(messages);

        // Guardar historial
        history.push({ role: "user", content: rawBody });
        history.push({ role: "assistant", content: finalReply });
        await saveSession(userWa, { history });

        // Notificar a Telegram si es resumen de pedido
        if (finalReply.includes("Resumen de tu pedido")) {
            try {
                await sendOrderToTelegram({
                    wa: userWa,
                    text: finalReply,
                });
            } catch (err) {
                console.error("[TELEGRAM_ERROR]", err.message);
            }
        }

        return res.json({ reply: finalReply });

    } catch (err) {
        console.error("[WEBHOOK_ERROR]", err);
        return res.json({
            reply: "Tuve un problema técnico para responder 😔. Intenta escribir de nuevo por favor."
        });
    }
});