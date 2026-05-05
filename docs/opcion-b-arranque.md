# Opción B: App local + backups (implementación funcional)

Este documento describe la implementación funcional de la **Opción B**: backend local/offline con SQLite para una app instalable en Android (sin depender de servicios cloud pagados).

## Objetivo
Construir un sistema de préstamos para prestamista independiente con:
- Reenganche ilimitado (decisión manual presencial).
- Tasas configurables globales y por préstamo.
- Contabilidad de caja/cartera/ganancia.
- Reportes periódicos (incluido trimestral).
- Funcionamiento offline + backup/restore.

## Componentes implementados
1. **Esquema SQLite** (`sql/loan_option_b_schema.sql`)
   - tablas de clientes, préstamos, cuotas, pagos, reenganches, ledger, auditoría y backup.
   - índices y triggers para consistencia automática.
   - vistas de reportes (`v_cash_position`, `v_portfolio_summary`, `v_quarterly_report`, `v_loan_customer_overview`).

2. **Motor financiero** (`opcionb/loan_engine_sqlite.js`)
   - generación de cronograma,
   - asignación de pagos por prioridad y por cuota,
   - reprogramación de cuotas post-reenganche.

3. **Servicio de aplicación** (`opcionb/app_service.js`)
   - inicialización de DB,
   - setup de prestamista y capital inicial,
   - crear cliente/préstamo,
   - cobrar pago,
   - aplicar reenganche,
   - dashboard con reportes,
   - exportar/restore de respaldo.

4. **Módulo backup/restore** (`opcionb/backup_sqlite.js`)
   - envelope versionado con hash SHA-256,
   - validación estructural,
   - resumen de respaldo,
   - script SQL transaccional de restauración.

5. **API HTTP local** (`opcionb/http_server.js`)
   - endpoints REST para operar toda la lógica desde una app móvil o panel local.

## Endpoints disponibles
- `GET /optionb/health`
- `POST /optionb/init`
- `POST /optionb/setup`
- `POST /optionb/customers`
- `POST /optionb/loans`
- `POST /optionb/loans/:loanId/payments`
- `POST /optionb/loans/:loanId/reenganches`
- `GET /optionb/dashboard`
- `POST /optionb/backup/export`
- `POST /optionb/backup/restore`

## Flujo de arranque rápido
1. Inicializar DB: `POST /optionb/init`
2. Configurar prestamista/capital inicial: `POST /optionb/setup`
3. Crear cliente: `POST /optionb/customers`
4. Crear préstamo: `POST /optionb/loans`
5. Registrar cobros: `POST /optionb/loans/:loanId/payments`
6. Registrar reenganche: `POST /optionb/loans/:loanId/reenganches`
7. Consultar estado/reportes: `GET /optionb/dashboard`
8. Exportar backup: `POST /optionb/backup/export`

## Ejecutar servidor local
```bash
npm run start:optionb
```
Variables opcionales:
- `OPTIONB_DB_PATH` (ruta del archivo `.sqlite`)
- `PORT` (por defecto `3099`)

## Cobertura de pruebas
- `tests/opcionb_engine.test.js` (motor financiero)
- `tests/opcionb_backup.test.js` (backup/restore)
- `tests/opcionb_schema_smoke.test.js` (consistencia de esquema/triggers)
- `tests/opcionb_service_smoke.test.js` (flujo funcional end-to-end)
