// lib/shipping.js
const { normalizeText } = require('./catalog');

// Tabla de ciudades y tarifas
const CITY_TABLE = [
    // Oriente Antioqueño
    {
        key: 'rionegro',
        names: ['rionegro'],
        label: 'Rionegro urbano',
        region: 'Oriente Antioqueño',
        cost: 9000
    },
    {
        key: 'fontibon',
        names: ['fontibon', 'fontibón'],
        label: 'Rionegro - Fontibón',
        region: 'Oriente Antioqueño',
        cost: 10000
    },
    {
        key: 'aeropuerto',
        names: ['aeropuerto', 'jmc', 'jose maria cordova', 'josé maría córdova'],
        label: 'Aeropuerto JMC',
        region: 'Oriente Antioqueño',
        cost: 25000
    },
    {
        key: 'el-retiro',
        names: ['el retiro', 'retiro'],
        label: 'El Retiro',
        region: 'Oriente Antioqueño',
        cost: 30000
    },
    {
        key: 'guarne',
        names: ['guarne'],
        label: 'Guarne',
        region: 'Oriente Antioqueño',
        cost: 35000
    },
    {
        key: 'la-ceja',
        names: ['la ceja'],
        label: 'La Ceja',
        region: 'Oriente Antioqueño',
        cost: 30000
    },
    {
        key: 'el-santuario',
        names: ['el santuario', 'santuario'],
        label: 'El Santuario',
        region: 'Oriente Antioqueño',
        cost: 30000
    },
    {
        key: 'marinilla',
        names: ['marinilla'],
        label: 'Marinilla',
        region: 'Oriente Antioqueño',
        cost: 17000
    },
    {
        key: 'el-carmen',
        names: ['el carmen', 'carmen de viboral', 'carmen de viboral'],
        label: 'El Carmen de Viboral',
        region: 'Oriente Antioqueño',
        cost: 22000
    },

    // Medellín y área metropolitana (Coordinadora)
    {
        key: 'medellin',
        names: ['medellin', 'medellín'],
        label: 'Medellín',
        region: 'Área Metropolitana',
        cost: 20000
    },
    {
        key: 'bello',
        names: ['bello'],
        label: 'Bello',
        region: 'Área Metropolitana',
        cost: 20000
    },
    {
        key: 'envigado',
        names: ['envigado'],
        label: 'Envigado',
        region: 'Área Metropolitana',
        cost: 22000
    },
    {
        key: 'itagui',
        names: ['itagui', 'itagüi'],
        label: 'Itagüí',
        region: 'Área Metropolitana',
        cost: 22000
    }
];

function getShippingForCity(cityRaw) {
    if (!cityRaw) return null;
    const norm = normalizeText(cityRaw);

    for (const c of CITY_TABLE) {
        for (const name of c.names) {
            const normName = normalizeText(name);
            if (norm.includes(normName)) {
                return {
                    key: c.key,
                    label: c.label,
                    region: c.region,
                    cost: c.cost
                };
            }
        }
    }
    return null;
}

module.exports = {
    getShippingForCity
};