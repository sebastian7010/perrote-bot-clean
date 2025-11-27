// lib/telegram.js
const axios = require('axios');

async function sendOrderToTelegram(order) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        console.log('[TELEGRAM] No configurado, se omite.');
        return;
    }

    const {
        customerName,
        phone,
        city,
        address,
        cart,
        subtotal,
        shippingCost,
        shippingLabel,
        total,
        notes
    } = order;

    const lines = [];
    lines.push('🧾 *Nuevo pedido Perrote y Gatote*');
    lines.push('');
    lines.push('👤 Nombre: ' + (customerName || 'N/D'));
    lines.push('📱 Teléfono: ' + (phone || 'N/D'));
    lines.push('📍 Ciudad: ' + (city || 'N/D'));
    lines.push('🏠 Dirección: ' + (address || 'N/D'));
    lines.push('');
    lines.push('📦 Productos:');

    cart.forEach(function(item) {
        const sub = item.price * item.qty;
        const line = '• ' + item.qty + ' x ' + item.name +
            ' → $' + item.price.toLocaleString('es-CO') +
            ' c/u (Sub: $' + sub.toLocaleString('es-CO') + ')';
        lines.push(line);
    });

    lines.push('');
    lines.push('🛒 Subtotal productos: $' + subtotal.toLocaleString('es-CO'));
    if (shippingCost != null) {
        lines.push('🚚 Envío (' + (shippingLabel || 'N/D') + '): $' +
            shippingCost.toLocaleString('es-CO'));
    }
    lines.push('💰 Total: $' + total.toLocaleString('es-CO'));

    if (notes) {
        lines.push('');
        lines.push('📝 Notas: ' + notes);
    }

    const text = lines.join('\n');

    try {
        await axios.post(
            'https://api.telegram.org/bot' + token + '/sendMessage', {
                chat_id: chatId,
                text: text,
                parse_mode: 'Markdown'
            }
        );
        console.log('[TELEGRAM] Pedido enviado.');
    } catch (err) {
        var detail;
        if (err && err.response && err.response.data) {
            detail = err.response.data;
        } else {
            detail = err && err.message ? err.message : String(err);
        }
        console.error('[TELEGRAM] Error enviando pedido:', detail);
    }
}

module.exports = {
    sendOrderToTelegram
};