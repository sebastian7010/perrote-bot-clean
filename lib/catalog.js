const fs = require('fs');
const path = require('path');
const Fuse = require('fuse.js');

function normalizeText(str = '') {
    return String(str)
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const COMMON_CORRECTIONS = {
    dogumet: 'dogurmet',
    doguermet: 'dogurmet',
    dogurme: 'dogurmet',
    dogumer: 'dogurmet',
    churru: 'churu',
    churuu: 'churu',
    churruu: 'churu',
    hilz: 'hills',
    hilss: 'hills',
    hillls: 'hills',
    herramenta: 'herramienta',
    herramienta: 'herramienta',
    atorniyador: 'atornillador',
    destorniyador: 'destornillador',
    pulidoraa: 'pulidora',
    taladroo: 'taladro'
};

function applyCorrections(normalized) {
    let fixed = normalized;
    for (const wrong of Object.keys(COMMON_CORRECTIONS)) {
        const right = COMMON_CORRECTIONS[wrong];
        const re = new RegExp('\\b' + wrong + '\\b', 'g');
        fixed = fixed.replace(re, right);
    }
    return fixed;
}

function toNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (value == null) {
        return 0;
    }

    const cleaned = String(value).replace(/[^\d,-.]/g, '').trim();
    if (!cleaned) {
        return 0;
    }

    if (cleaned.includes(',') && cleaned.includes('.')) {
        return Number(cleaned.replace(/\./g, '').replace(',', '.')) || 0;
    }

    if (cleaned.includes(',')) {
        return Number(cleaned.replace(/\./g, '').replace(',', '.')) || 0;
    }

    return Number(cleaned.replace(/\./g, '')) || 0;
}

function toArray(value) {
    if (Array.isArray(value)) {
        return value.filter(Boolean).map(String);
    }

    if (!value) {
        return [];
    }

    return [String(value)];
}

function resolveCatalogFiles() {
    if (process.env.PRODUCTS_JSON_PATH) {
        return process.env.PRODUCTS_JSON_PATH
            .split(/[;,]/)
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => path.isAbsolute(part) ? part : path.join(__dirname, '..', part));
    }

    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
        return [];
    }

    return fs.readdirSync(dataDir)
        .filter((file) => file.toLowerCase().endsWith('.json'))
        .sort()
        .map((file) => path.join(dataDir, file));
}

function readCatalogFile(filePath) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error('[CATALOG][FILE_ERROR]', filePath, error.message);
        return [];
    }
}

function normalizeProduct(product, idx, sourceFile) {
    const name = product.name || product.nombre || '';
    const brand = product.brand || product.marca || '';
    const category =
        product.category ||
        product.categoria ||
        product['categoria producto'] ||
        '';
    const description = product.description || product.descripcion || '';
    const reference = product.reference || product.referencia || '';
    const sourceUrl = product.source_url || product.sourceUrl || product.url || '';
    const images = toArray(product.images || product.imagenes || product.url);
    const price = toNumber(product.price != null ? product.price : product.precio);

    const searchText = applyCorrections(
        normalizeText([name, brand, category, description, reference].join(' '))
    );

    return {
        id: product.id || [path.basename(sourceFile, '.json'), idx].join('-'),
        name,
        brand,
        category,
        price,
        description,
        reference,
        sourceUrl,
        images,
        searchText
    };
}

function dedupeProducts(products) {
    const seen = new Set();
    const unique = [];

    for (const product of products) {
        if (!product || !product.name) {
            continue;
        }

        const key = [
            normalizeText(product.name),
            product.price,
            normalizeText(product.brand),
            normalizeText(product.category)
        ].join('|');

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        unique.push(product);
    }

    return unique;
}

function loadCatalog() {
    const files = resolveCatalogFiles();
    const merged = [];

    for (const filePath of files) {
        const items = readCatalogFile(filePath);
        items.forEach((item, idx) => {
            merged.push(normalizeProduct(item, idx, filePath));
        });
    }

    const products = dedupeProducts(merged);

    const fuse = new Fuse(products, {
        keys: [
            { name: 'name', weight: 0.45 },
            { name: 'brand', weight: 0.2 },
            { name: 'category', weight: 0.15 },
            { name: 'description', weight: 0.1 },
            { name: 'searchText', weight: 0.1 }
        ],
        includeScore: true,
        threshold: 0.38,
        ignoreLocation: true,
        minMatchCharLength: 2
    });

    return { products, fuse, files };
}

function searchProductsByText(rawText, fuse, maxResults) {
    if (!rawText || rawText.trim().length === 0 || !fuse) return [];
    if (!maxResults) maxResults = 5;

    const normalized = applyCorrections(normalizeText(rawText));
    if (!normalized) return [];

    const results = fuse.search(normalized).slice(0, maxResults);
    const filtered = results.filter((result) => (1 - result.score) >= 0.8);

    return filtered.map((result) => ({
        similarity: 1 - result.score,
        product: result.item
    }));
}

function searchProductsByTextLoose(rawText, fuse, maxResults) {
    if (!rawText || rawText.trim().length === 0 || !fuse) return [];
    if (!maxResults) maxResults = 5;

    const normalized = applyCorrections(normalizeText(rawText));
    if (!normalized) return [];

    return fuse.search(normalized).slice(0, maxResults).map((result) => ({
        similarity: 1 - result.score,
        product: result.item
    }));
}

function detectQuantity(rawText) {
    const text = normalizeText(rawText);
    const match = text.match(/\b(\d+)\b/);
    if (!match) return 1;
    const num = parseInt(match[1], 10);
    return (isNaN(num) || num <= 0) ? 1 : num;
}

function detectAnimal(rawText) {
    const text = normalizeText(rawText);
    if (/(gato|gatito|felino)/.test(text)) return 'gato';
    if (/(perro|perrito|canino)/.test(text)) return 'perro';
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
