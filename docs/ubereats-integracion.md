# Integración Uber Eats → YOLO TPV

Recibe pedidos de Uber Eats por webhook y los escribe en el mismo Google Sheet
del TPV (pestañas `notas` + `ventas`), con folio (`nfactura`) en la **misma
secuencia** del TPV. Los extras del pedido van a la pestaña nueva `ubereats`.

## Archivos
- `apps_script/UberEats.gs` — **nuevo**. Webhook, OAuth, escritura, aceptar pedido.
- `apps_script/Code.gs` — **modificado**: registra la pestaña `ubereats` y enruta el
  webhook cuando la URL trae `?src=uber`.
- `js/db.js` — **modificado**: `nextFolio()` anti-colisión (Opción A). Nunca reutiliza
  un `nfactura` ya presente en `notas` (incluye los pedidos Uber bajados por sync).

## Cómo se ve un pedido Uber en el TPV
- Se crea una **nota** con `atendio = "UBER EATS"` y `mesa = "UBER"` → aparece sola en
  el TPV al siguiente `pull` (cada 25 s) y se distingue por el "atendió".
- Sus renglones van a `ventas` (igual que un ticket normal).
- Detalle extra (cliente, teléfono, dirección, tipo de entrega, notas, order_id,
  estatus) en la pestaña `ubereats`.

## Configuración (una vez)

### 1. Pega el código en Apps Script
El TPV ya usa un proyecto de Apps Script (el del Web App `/exec`).
- Abre el Sheet **YOLO-TPV-2** → Extensiones → Apps Script.
- Reemplaza `Code.gs` por la versión de este repo y **crea un archivo nuevo
  `UberEats.gs`** con el contenido de `apps_script/UberEats.gs`.

### 2. Script Properties (Configuración del proyecto → Propiedades de secuencia de comandos)
| Propiedad | Valor |
|---|---|
| `UBER_CLIENT_ID` | tu Client ID (Application ID de la app en developer.uber.com) |
| `UBER_CLIENT_SECRET` | tu Client Secret (Setup → Authenticate with Client Secret) |
| `UBER_WEBHOOK_SECRET` | invéntalo (ej. un UUID). Va en la URL del webhook |
| `UBER_ENV` | `sandbox` (por ahora) |
| `UBER_STORE_ID` | (lo llenas en el paso 4) |
| `UBER_AUTOACCEPT` | `true` para aceptar el pedido automáticamente, o `false` |

> El `client_secret` vive **solo aquí** (privado del proyecto), nunca en el repo.

### 3. Redespliega el Web App
Implementar → Administrar implementaciones → editar la actual → **Nueva versión**.
La URL `/exec` no cambia.

### 4. Obtén tu Store ID
En el editor de Apps Script, selecciona la función **`listStoresUber`** y dale ▶ Ejecutar.
Autoriza si lo pide. En **Registros** verás la lista de tiendas con su `id`.
Copia ese id a la propiedad `UBER_STORE_ID`.

### 5. Registra el webhook en Uber
En el dashboard de tu app (developer.uber.com → tu app → **Webhooks**), configura la URL:

```
https://script.google.com/macros/s/<TU_DEPLOY_ID>/exec?src=uber&uk=<UBER_WEBHOOK_SECRET>
```

Suscribe el evento de pedidos (p. ej. `orders.notification`).

### 6. Prueba
- **Escritura al Sheet (sin Uber):** corre la función `_testEscrituraLocal` → debe
  crear una nota con folio nuevo, sus renglones y una fila en `ubereats`.
- **Con Uber:** genera un pedido de prueba en el sandbox. Revisa **Registros**: el
  handler imprime `ORDER RAW: {...}` — con ese JSON afinamos el "MAPEO DEL PEDIDO"
  (nombres de campos reales) en `UberEats.gs`.

## Pendientes conocidos (a afinar tras el 1er pedido real del sandbox)
1. **Mapeo del pedido**: los nombres de campos (`cart.items`, precios, dirección,
   total) están puestos de forma defensiva. Con el `ORDER RAW` del primer pedido los
   ajustamos exacto. Los precios se asumen en **centavos** (heurística en `_money`).
2. **Endpoints/scopes**: `listStoresUber` y `_getUberOrder` usan rutas documentadas;
   confirmarlas contra el sandbox. El token pide scopes
   `eats.pos_provisioning eats.store eats.order` (ajustar según lo concedido).
3. **Firma del webhook**: Apps Script **no expone headers**, así que la firma
   `X-Uber-Signature` no se valida aquí. Protección actual: el secreto `uk` en la URL.
   Endurecimiento futuro: un relay (Cloudflare Worker) que valide el HMAC y reenvíe.

## Reportes (fase 2)
Con los pedidos ya en `notas`/`ventas` (filtrando `atendio = "UBER EATS"`) + `ubereats`
+ la Reporting API de Uber, se arma un dashboard de ventas (gráficas TPV vs Uber).
