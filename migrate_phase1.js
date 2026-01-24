// Wrapper para inicializar FASE 1 (Schema base)
// La lógica real está en database.js (initDb)
// Este script simplemente invoca la conexión, lo que fuerza el init.

require('./database');
console.log('Migración Fase 1 (Base Schema) verificada.');
