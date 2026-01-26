# Plan de Escalamiento Controlado - DriverFlow (Post-Piloto)

**Arquitectura Base**: v1.2-prod (Monolito Node.js + SQLite)
**Estrategia**: Crecimiento horizontal por zonas geográficas, limitado por la capacidad vertical de la base de datos actual.

## 1. Fases de Escalamiento

### Fase A: Expansión Vecinal (Mes 1-2)
*   **Objetivo**: Validar replicabilidad del modelo en zonas adyacentes sin cambiar infra.
*   **Alcance**:
    *   **Zonas**: +2 Distritos colindantes al piloto.
    *   **Límites**: Máx 50 Empresas / 200 Drivers.
    *   **Volumen**: Hasta 500 solicitudes/día.

### Fase B: Cobertura Urbana (Mes 3-5)
*   **Objetivo**: saturar la capacidad de la arquitectura actual.
*   **Alcance**:
    *   **Zonas**: Toda la ciudad principal.
    *   **Límites**: Máx 200 Empresas / 1,000 Drivers.
    *   **Volumen**: Hasta 2,000 solicitudes/día.
    *   *Nota*: Punto crítico para monitorear bloqueo de escritura en SQLite.

### Fase C: Multi-Ciudad (Detenida)
*   **Condición**: Requiere migración a PostgreSQL. **NO EJECUTAR con v1.2-prod**.

## 2. Límites y Capacidad (Hard Caps)
Para proteger la estabilidad del sistema v1.2, se establecen los siguientes límites operativos estrictos:

| Métrica | Límite Fase A | Límite Fase B | Acción al llegar al límite |
|---|---|---|---|
| **Usuarios Concurrentes** | 50 | 300 | Cola de espera en Login o bloqueo de nuevos registros. |
| **Tamaño DB** | 500 MB | 2 GB | Archivar histórico (Vacuum) o detener operación. |
| **Latencia API (p95)** | 200ms | 800ms | **PAUSAR ESCALAMIENTO**. |

## 3. Indicadores de Control (Semáforo)

### 🟢 CONTINUAR (Green Light)
*   Fill Rate > 80%.
*   Latencia promedio < 300ms.
*   Sin incidentes de integridad de datos (SQLite locks).

### 🟡 DETENER CRECIMIENTO (Yellow Light)
*   Fill Rate cae a 60-70% (Desbalance oferta/demanda).
*   Aparición de errores `SQLITE_BUSY` esporádicos.
*   **Acción**: Congelar nuevos registros. Solo operar con usuarios actuales.

### 🔴 RETROCEDER (Red Light)
*   Fill Rate < 50%.
*   Corrupción de base de datos o pérdida de datos.
*   Tiempo de respuesta > 2s constante.
*   **Acción**: Volver a los límites de la Fase anterior (Desactivar zonas nuevas).

## 4. Gestión de Riesgos Específica
Dado que seguimos en SQLite:
1.  **Backup**: Aumentar frecuencia de snapshot del volumen a cada 1 hora.
2.  **Monitoreo**: Implementar script externo (ping) que valide que el servidor responde.
