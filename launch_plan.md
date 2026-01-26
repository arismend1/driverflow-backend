# Plan de Lanzamiento Controlado (Piloto) - DriverFlow

## 1. Definición del Piloto
Fase operativa limitada diseñada para validar el modelo de negocio y estabilidad técnica en un entorno real pero contenido.

*   **Alcance**:
    *   **Duración**: 4 Semanas.
    *   **Usuarios**: Máximo 5 Empresas ("Early Adopters") y 20 Drivers verificados manualmente.
    *   **Geografía**: Limitado a una sola zona urbana / distrito.
    *   **Versión**: `v1.2-prod` (Congelada).

## 2. Métricas de Monitoreo (KPIs)
El monitoreo será conceptual (manual o consultas SQL directas), sin dashboards automáticos.

*   **Tasa de "Fill Rate"**: Porcentaje de solicitudes `PENDIENTE` que llegan a `ACEPTADA`.
*   **Tiempo de Asignación**: Tiempo promedio desde `create_request` hasta `accept_request`.
*   **Estabilidad Técnica**: Número de caídas del servidor o errores 500 reportados.
*   **Liquidez de Créditos**: Velocidad de recompra de créditos por parte de las empresas.

## 3. Criterios de Éxito y Fracaso

| Estado | Criterio | Acción |
|---|---|---|
| **ÉXITO** | - Fill Rate > 80%<br>- 0 Incidentes Críticos de Seguridad<br>- >50% de Empresas recompran créditos. | **Autorizar Fase de Escalamiento**. |
| **FRACASO PARCIAL** | - Fill Rate < 50% (Falta de drivers)<br>- Quejas sobre usabilidad.<br>- Errores menores. | **Pausa Táctica**. Ajustar parámetros (Tiempos de ronda, Precios) y reiniciar piloto. |
| **FRACASO CRÍTICO** | - Incidente Legal/Tránsito.<br>- Pérdida de Data.<br>- Fraude masivo detectado. | **ROLLBACK TOTAL**. Apagar servidores. Devolución de dinero. Rediseño completo. |

## 4. Condiciones para Escalar o Pausar

### Trigger de PAUSA Inmediata
*   Si el **Fill Rate cae bajo 20%** por más de 48 horas (Efecto "Cementerio de Solicitudes").
*   Si se detecta cualquier intento de inyección SQL o acceso no autorizado.

### Trigger de ESCALAMIENTO (Go-Big)
*   Finalizar las 4 semanas con **Saldo Financiero Positivo**.
*   Validación cualitativa: Empresas solicitan activamente más cupos o expansión de zona.
