# Modelo de Negocio y Reglas de Facturación - DriverFlow

## 1. Definición Fundamental
DriverFlow comercializa **TRÁFICO / INTERMEDIACIÓN**.
*   **Valor Vendido**: Acceso Validado entre Empresa y Driver (Match).
*   **Responsabilidad**: No garantiza resultados operativos, cierre de viaje ni asistencia de conductores.
*   **Cobro**: Se devenga la deuda en el instante de la aceptación mutua y liberación de datos de contacto.

## 2. Precio y Facturación (Tickets)
*   **Unidad de Cobro**: Ticket (generado por Match exitoso).
*   **Precio**: USD 150 por Ticket.
*   **Devengo**: Instantáneo al generar el Match.
*   **Facturación**:
    *   **Corte Semanal**: Lunes a Lunes.
    *   **Día de Pago**: Viernes siguiente al corte.
    *   **Consolidación**: Un solo pago semanal acumulado.

## 3. Política de Crédito y Cobranza
*   **Modelo**: Post-pago (Sin cobro anticipado).
*   **Pago**: No depende de la ejecución final del servicio por parte del driver.
*   **Tolerancia de Impago**:
    *   **Semana 1 Impaga**: Cuenta Activa + Aviso.
    *   **Semana 2 Impaga**: Cuenta Activa + Aviso.
    *   **Semana 3 Impaga**: Cuenta Activa + Aviso Crítico.
    *   **Semana 4 Impaga**: **BLOQUEO AUTOMÁTICO** de nuevas solicitudes.
*   **Deuda**: La deuda acumulada es exigible legalmente siempre, independientemente del bloqueo.

## 4. Gestión de Disputas y Estados
*   **Semáforo de Deuda**: Alerta administrativa si deuda >= USD 10,000 (sin bloqueo automático por monto, solo por tiempo).
*   **Estados de Ticket**:
    *   `GENERADO`: Match creado.
    *   `PENDIENTE_DE_CORTE`: Esperando cierre de lunes.
    *   `FACTURADO`: Incluido en factura semanal.
    *   `PAGADO`: Deuda saldada.
    *   `EN_DISPUTA`: Reclamado (no suspende servicio general).
    *   `CONFIRMADO`: Disputa rechazada.
    *   `ANULADO`: Administrativo (excepcional).

## 5. Marco Legal
*   **Contrato Digital**: Firma obligatoria al registro.
*   **Reconocimiento**: El cliente acepta que cada ticket es una obligación de pago irrevocable salvo anulación administrativa.
*   **Jurisdicción**: Aceptada para cobro ejecutivo.
