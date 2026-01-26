# Plan de Preparación para Producción - DriverFlow (Fase 4)

## 1. Checklist de Producción
- [ ] **Secretos**: Eliminar hardcoded secrets (`JWT_SECRET`, etc.) y mover a Variables de Entorno.
- [ ] **Persistencia**: Asegurar que `driverflow.db` se guarde en un volumen persistente, no en almacenamiento efímero.
- [ ] **Dependencias**: Verificar `package.json` limpio y usar `npm ci` o `npm install --production`.
- [ ] **Seguridad Básica**:
    - Verificar que `NODE_ENV=production`.
    - Habilitar logs solo a stdout (para que el proveedor de cloud los capture).
- [ ] **Migraciones**: Asegurar que los scripts `migrate_phase2.js` y `migrate_phase3.js` se ejecuten en una BD nueva.

## 2. Variables de Entorno Requeridas
| Variable | Descripción | Ejemplo / Valor |
|---|---|---|
| `NODE_ENV` | Entorno de ejecución | `production` |
| `PORT` | Puerto del servidor | `3000` (o asignado por host) |
| `JWT_SECRET` | Clave privada para firma de tokens | `cadena_larga_aleatoria_segura` |
| `DB_PATH` | Ruta absoluta para archivo SQLite | `/data/driverflow.db` (Importante para volúmenes) |

## 3. Pasos de Despliegue (Standard MVP)
1.  **Provisionamiento**: Servidor VPS o Contenedor con Node.js 18+.
2.  **Volumen**: Adjuntar volumen persistente en ruta conocida (ej: `/data`).
3.  **Configuración**: Cargar las variables de entorno (`.env` o panel de control).
4.  **Instalación**:
    ```bash
    npm install --production
    ```
5.  **Inicialización BD** (Solo primer despliegue):
    *   Ejecutar `node migrate_phase2.js` (si aplica sobre base v1 limpia).
    *   Ejecutar `node migrate_phase3.js`.
    *   *Nota: El código actual inicializa tablas base al arrancar si no existen.*
6.  **Arranque**:
    ```bash
    npm start
    ```

## 4. Riesgos Conocidos (MVP Limitations)
1.  **SQLite en Nube Efímera**: Si se despliega en servicios "Serverless" o "Free Tier" sin discos persistentes (ej: Heroku Dynos, Render Free), **la base de datos se borrará** en cada reinicio.
    *   *Mitigación*: Usar VPS (DigitalOcean Droplet, EC2) o servicio con Disk persistente (Render Disk).
2.  **Single Thread**: Node.js corre en un solo proceso. Si se bloquea (ej: cálculo pesado de rondas con mil drivers), todo el server se pausa.
    *   *Mitigación*: `advance_rounds` es ligero, pero vigilar CPU.
3.  **Sin HTTPS**: La aplicación asume que un Reverse Proxy (Nginx, Cloudflare, Load Balancer) maneja la terminación SSL. **No exponer directamente al puerto 3000 en internet pública sin proxy**.
