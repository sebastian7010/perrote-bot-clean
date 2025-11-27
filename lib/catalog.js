// lib/catalog.js
const fs = require('fs');
const path = require('path');
const Fuse = require('fuse.js');

// 🔤 Normalización básica de texto
function normalizeText(str = '') {
    return str
        .toString()
        .trim()
        .toLowerCase()
        .normalize('NFD') // separa tildes
        .replace(/[\u0300-\u036f]/g, '') // elimina tildes
        .replace(/[^a-z0-9ñ\s]/gi, ' ') // quita símbolos raros
        .replace(/\s+/g, ' ')
        .trim();
}

// 🧠 Correcciones manuales de errores típicos
const COMMON_CORRECTIONS = {
    'dogumet': 'dogurmet',
    'doguermet': 'dogurmet',
    'dogurme': 'dogurmet',
    'dogumer': 'dogurmet',
    'churru': 'churu',
    'churuu': 'churu',
    'churruu': 'churu',
    'hilz': 'hills',
    'hilss': 'hills',
    'hillls': 'hills'
};

function applyCorrections(normalized) {
    let fixed = normalized;
    for (const wrong in COMMON_CORRECTIONS) {
        const right = COMMON_CORRECTIONS[wrong];
        const re = new RegExp('\\b' + wrong + '\\b', 'g');
        fixed = fixed.replace(re, right);
    }
    return fixed;
}

// 📦 Carga catálogo desde /data/products.json
function loadCatalog() {
    const jsonPath = process.env.PRODUCTS_JSON_PATH ||
        path.join(__dirname, '..', 'data', 'products.json');
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const products = JSON.parse(raw);

    const normProducts = products.map(function(p, idx) {
        var priceBase;
        if (p.price != null) {
            priceBase = p.price;
        } else if (p.precio != null) {
            priceBase = p.precio;
        } else {
            priceBase = 0;
        }

        return {
            id: p.id || ('prod-' + idx),
            name: p.name || p.nombre || '',
            brand: p.brand || p.marca || '',
            price: Number(priceBase),
            description: p.description || p.descripcion || '',
            images: p.images || p.imagenes || []
        };
    });

    const fuse = new Fuse(normProducts, {
        keys: ['name', 'brand'],
        includeScore: true,
        threshold: 0.3,
        distance: 100
    });

    return { products: normProducts, fuse };
}

// 🔎 Fuzzy search ESTRICTO (para chat normal) – similitud mínima 0.80
function searchProductsByText(rawText, fuse, maxResults) {
    if (!rawText || rawText.trim().length === 0) return [];
    if (!maxResults) maxResults = 5;

    const normalized = applyCorrections(normalizeText(rawText));
    if (!normalized) return [];

    const results = fuse.search(normalized).slice(0, maxResults);

    const filtered = results.filter(function(r) {
        return (1 - r.score) >= 0.8;
    });

    return filtered.map(function(r) {
        return {
            similarity: 1 - r.score,
            product: r.item
        };
    });
}

// 🔎 Fuzzy search “LOOSE” (para pedidos copiados desde la web)
// Aquí NO filtramos por 0.80, tomamos el mejor match que encuentre Fuse.
function searchProductsByTextLoose(rawText, fuse, maxResults) {
    if (!rawText || rawText.trim().length === 0) return [];
    if (!maxResults) maxResults = 5;

    const normalized = applyCorrections(normalizeText(rawText));
    if (!normalized) return [];

    const results = fuse.search(normalized).slice(0, maxResults);

    return results.map(function(r) {
        return {
            similarity: 1 - r.score,
            product: r.item
        };
    });
}

// 🔢 Detección de cantidad numérica
function detectQuantity(rawText) {
    const text = normalizeText(rawText);
    const match = text.match(/\b(\d+)\b/);
    if (!match) return 1;
    const num = parseInt(match[1], 10);
    return (isNaN(num) || num <= 0) ? 1 : num;
}

// 🐶🐱 Detección de animal (perro/gato)
function detectAnimal(rawText) {
    const t = normalizeText(rawText);
    if (/(gato|gatito|felino)/.test(t)) return 'gato';
    if (/(perro|perrito|canino)/.test(t)) return 'perro';
    return null;
}

module.exports = {
    loadCatalog,
    searchProductsByText,
    searchProductsByTextLoose,
    detectQuantity,
    detectAnimal,
    normalizeText,
    applyCorrections
};