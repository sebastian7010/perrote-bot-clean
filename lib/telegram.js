const axios = require('axios');

const TELEGRAM_MESSAGE_LIMIT = 4000;

function splitText(text, maxLength = TELEGRAM_MESSAGE_LIMIT) {
    const safeText = String(text || '').trim();
    if (!safeText) {
        return [];
    }

    if (safeText.length <= maxLength) {
        return [safeText];
    }

    const chunks = [];
    let cursor = 0;

    while (cursor < safeText.length) {
        let end = Math.min(cursor + maxLength, safeText.length);
        if (end < safeText.length) {
            const lastBreak = safeText.lastIndexOf('\n', end);
            if (lastBreak > cursor + 200) {
                end = lastBreak;
            }
        }

        chunks.push(safeText.slice(cursor, end).trim());
        cursor = end;
    }

    return chunks.filter(Boolean);
}

function buildStructuredOrderText(order) {
    const cart = Array.isArray(order.cart) ? order.cart : [];
    const subtotal = Number(order.subtotal || 0);
    const shippingCost = order.shippingCost != null ? Number(order.shippingCost) : null;
    const total = Number(order.total || 0);
    const lines = [];

    lines.push('Nuevo pedido Perrote y Gatote');
    lines.push('');
    lines.push('Nombre: ' + (order.customerName || 'N/D'));
    lines.push('Telefono: ' + (order.phone || 'N/D'));
    lines.push('Ciudad: ' + (order.city || 'N/D'));
    lines.push('Direccion: ' + (order.address || 'N/D'));
    lines.push('');
    lines.push('Productos:');

    if (cart.length === 0) {
        lines.push('- Sin detalle de productos');
    }

    cart.forEach((item) => {
        const qty = Number(item.qty || 0);
        const price = Number(item.price || 0);
        const itemSubtotal = qty * price;
        lines.push(
            '- ' + qty + ' x ' + (item.name || 'Producto') +
            ' -> $' + price.toLocaleString('es-CO') +
            ' c/u (Sub: $' + itemSubtotal.toLocaleString('es-CO') + ')'
        );
    });

    lines.push('');
    lines.push('Subtotal productos: $' + subtotal.toLocaleString('es-CO'));
    if (shippingCost != null) {
        lines.push(
            'Envio (' + (order.shippingLabel || 'N/D') + '): $' +
            shippingCost.toLocaleString('es-CO')
        );
    }
    lines.push('Total: $' + total.toLocaleString('es-CO'));

    if (order.notes) {
        lines.push('');
        lines.push('Notas: ' + order.notes);
    }

    return lines.join('\n');
}

function buildTelegramText(order = {}) {
    if (order.text) {
        const lines = ['Alerta del bot'];
        if (order.wa) {
            lines.push('WhatsApp: ' + order.wa);
        }
        if (Array.isArray(order.media) && order.media.length > 0) {
            lines.push('Adjuntos recibidos: ' + order.media.length);
        }
        lines.push('');
        lines.push(String(order.text).trim());
        return lines.join('\n');
    }

    return buildStructuredOrderText(order);
}

async function sendTelegramMessage(token, chatId, threadId, text) {
    const payload = {
        chat_id: chatId,
        text,
        disable_web_page_preview: true
    };

    if (threadId) {
        payload.message_thread_id = Number(threadId);
    }

    await axios.post(
        'https://api.telegram.org/bot' + token + '/sendMessage',
        payload,
        { timeout: 15000 }
    );
}

async function sendOrderToTelegram(order) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const threadId = process.env.TELEGRAM_THREAD_ID;

    if (!token || !chatId) {
        console.log('[TELEGRAM] No configurado, se omite.');
        return;
    }

    const text = buildTelegramText(order);
    const chunks = splitText(text);

    if (chunks.length === 0) {
        console.log('[TELEGRAM] Sin contenido para enviar.');
        return;
    }

    try {
        for (const chunk of chunks) {
            await sendTelegramMessage(token, chatId, threadId, chunk);
        }
        console.log('[TELEGRAM] Mensaje enviado.');
    } catch (err) {
        const detail =
            err && err.response && err.response.data ?
            err.response.data :
            err && err.message ? err.message :
            String(err);
        console.error('[TELEGRAM] Error enviando pedido:', detail);
    }
}

module.exports = {
    sendOrderToTelegram
};
