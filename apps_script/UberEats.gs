/**
 * YOLO TPV — Integración Uber Eats (Marketplace / POS API)
 * ------------------------------------------------------------------
 * Archivo HERMANO de Code.gs, en el MISMO proyecto de Apps Script.
 * Reutiliza: TABLAS, _hoja(), _filaDesde(), _indiceLlaves() de Code.gs.
 *
 * Qué hace:
 *   - Recibe el webhook de Uber (pedido nuevo) en  <URL>/exec?src=uber&uk=<secreto>
 *   - Pide el detalle del pedido a Uber (OAuth Client Credentials)
 *   - Le asigna el SIGUIENTE folio (nfactura) de la MISMA secuencia del TPV
 *   - Escribe cabecera en 'notas' + renglones en 'ventas' (así aparece solo en el TPV)
 *     con atendio = "UBER EATS" para diferenciarlo, y los extras en la pestaña 'ubereats'
 *   - (Opcional) acepta el pedido automáticamente en Uber
 *
 * CONFIG — Project Settings → Script Properties (NO en el código):
 *   UBER_CLIENT_ID       (de tu app en developer.uber.com)
 *   UBER_CLIENT_SECRET   (Setup → Authenticate with Client Secret)
 *   UBER_STORE_ID        (córrelo con listStoresUber() y pégalo)
 *   UBER_WEBHOOK_SECRET  (invéntalo; va en la URL del webhook, ej. un UUID)
 *   UBER_ENV             'sandbox' (default) | 'prod'
 *   UBER_AUTOACCEPT      'true' (default) | 'false'
 *   UBER_TOKEN_URL       (opcional, override del endpoint de token)
 *   UBER_SCOPE           (opcional, default 'eats.store.orders.read eats.order' — para leer y aceptar pedidos)
 *
 * NOTA de seguridad: Apps Script NO expone los headers de la petición,
 * así que la firma X-Uber-Signature no se puede verificar aquí. Usamos un
 * secreto en la URL (uk=...). Para producción, poner un relay (Cloudflare
 * Worker) que valide el HMAC y reenvíe. Ver docs/ubereats-integracion.md.
 */

// ====== Config ======
function _uProp(k, def) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  return (v === null || v === undefined || v === '') ? def : v;
}

function _uCfg() {
  var env = _uProp('UBER_ENV', 'sandbox');
  var prod = env === 'prod';
  return {
    env: env,
    apiBase: prod ? 'https://api.uber.com' : 'https://test-api.uber.com',
    authBase: 'https://auth.uber.com', // mismo host de token en prod y sandbox; solo cambia apiBase
    clientId: _uProp('UBER_CLIENT_ID', ''),
    clientSecret: _uProp('UBER_CLIENT_SECRET', ''),
    storeId: _uProp('UBER_STORE_ID', ''),
    webhookSecret: _uProp('UBER_WEBHOOK_SECRET', ''),
    scope: _uProp('UBER_SCOPE', 'eats.store.orders.read eats.order'),
    autoaccept: _uProp('UBER_AUTOACCEPT', 'true') === 'true'
  };
}

// ====== OAuth 2.0 (Client Credentials) ======
function _uToken() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('uber_token');
  if (cached) return cached;
  var c = _uCfg();
  if (!c.clientId || !c.clientSecret) throw new Error('Falta UBER_CLIENT_ID / UBER_CLIENT_SECRET en Script Properties');
  var url = _uProp('UBER_TOKEN_URL', c.authBase + '/oauth/v2/token');
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: {
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: 'client_credentials',
      scope: c.scope
    },
    muteHttpExceptions: true
  });
  var body;
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = {}; }
  if (!body.access_token) throw new Error('Token Uber falló (' + res.getResponseCode() + '): ' + res.getContentText());
  var ttl = Math.max(60, (Number(body.expires_in) || 3600) - 60);
  cache.put('uber_token', body.access_token, Math.min(ttl, 21600)); // cache máx 6h
  return body.access_token;
}

function _uGet(path) {
  var c = _uCfg();
  var res = UrlFetchApp.fetch(c.apiBase + path, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + _uToken() },
    muteHttpExceptions: true
  });
  return { code: res.getResponseCode(), text: res.getContentText() };
}

// ====== Utilidades para leer el JSON del pedido de forma segura ======
function _g(obj, path, def) {
  var cur = obj;
  for (var i = 0; i < path.length; i++) {
    if (cur === null || cur === undefined) return def;
    cur = cur[path[i]];
  }
  return (cur === undefined || cur === null) ? def : cur;
}
// Uber suele mandar dinero en centavos: {amount: 15000} => 150.00
function _money(v) {
  if (v && typeof v === 'object') v = (v.amount !== undefined ? v.amount : v.amount_e5);
  var n = Number(v);
  if (!isFinite(n)) return 0;
  return n >= 1000 ? Math.round(n) / 100 : n; // heurística centavos; ajustar tras 1er pedido real
}
function _idFromHref(href) {
  if (!href) return '';
  var m = String(href).split('?')[0].split('/');
  return m[m.length - 1] || '';
}

// ====== 1) Listar tiendas para obtener el Store ID (córrelo UNA vez) ======
function listStoresUber() {
  var r = _uGet('/v1/eats/stores');   // TODO verificar endpoint del sandbox
  Logger.log('HTTP ' + r.code);
  Logger.log(r.text);
  return r.text;
}

// ====== 2) Traer el detalle de un pedido ======
function _getUberOrder(orderId) {
  // TODO: confirmar ruta real del sandbox (v2/eats/order o v1/eats/orders)
  var r = _uGet('/v2/eats/order/' + encodeURIComponent(orderId));
  if (r.code >= 300) throw new Error('getOrder ' + r.code + ': ' + r.text);
  return JSON.parse(r.text);
}

// ====== 3) Folio compartido (autoridad del lado servidor) ======
// Lee el máximo nfactura de la pestaña 'notas' y regresa max+1.
function _nextFolioServidor() {
  var sh = _hoja('notas');                 // definido en Code.gs
  var last = sh.getLastRow();
  if (last < 2) return 1;
  var vals = sh.getRange(2, 1, last - 1, 1).getValues(); // nfactura = col 1
  var max = 0;
  for (var i = 0; i < vals.length; i++) {
    var n = Number(vals[i][0]) || 0;
    if (n > max) max = n;
  }
  return max + 1;
}

// Escribe una fila sin volver a pedir el lock (ya lo tenemos tomado)
function _uAppend(tabla, obj) {
  var sh = _hoja(tabla);
  sh.appendRow(_filaDesde(tabla, obj));    // _filaDesde definido en Code.gs
}
function _uUpsert(tabla, obj) {
  var sh = _hoja(tabla);
  var def = TABLAS[tabla];
  var idx = _indiceLlaves(sh, tabla);      // definido en Code.gs
  var keyVal = String(obj[def.key]);
  if (idx[keyVal]) sh.getRange(idx[keyVal], 1, 1, def.cols.length).setValues([_filaDesde(tabla, obj)]);
  else sh.appendRow(_filaDesde(tabla, obj));
}

// ====== 4) Guardar el pedido de Uber en el Sheet ======
function _guardarPedidoUber(order) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var now = Date.now();
    var fecha = Utilities.formatDate(new Date(), 'America/Merida', 'yyyy-MM-dd');
    var nfactura = _nextFolioServidor();

    // ---- MAPEO DEL PEDIDO (ajustar a los nombres reales del payload sandbox) ----
    var orderId = order.id || order.order_id || _g(order, ['meta', 'order_id'], '');
    var cliente = _g(order, ['eater', 'first_name'], '') + ' ' + _g(order, ['eater', 'last_name'], '');
    cliente = cliente.trim() || _g(order, ['eater', 'name'], 'Cliente Uber');
    var telefono = _g(order, ['eater', 'phone'], '') || _g(order, ['eater', 'phone_code'], '');
    var tipo_entrega = _g(order, ['type'], '') || _g(order, ['fulfillment_type'], '') || _g(order, ['deliveries', 0, 'type'], '');
    var direccion = _g(order, ['deliveries', 0, 'location', 'street_address'], '') ||
                    _g(order, ['delivery', 'location', 'address'], '') ||
                    _g(order, ['delivery_address', 'address'], '');
    var notas_pedido = _g(order, ['special_instructions'], '') || _g(order, ['eater', 'delivery_instructions'], '');

    // Renglones (items del carrito)
    var items = _g(order, ['cart', 'items'], null) || order.items || [];
    var subtotal = 0;
    var ventasRows = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var uds = Number(it.quantity || it.qty || 1) || 1;
      var precio = _money(it.price || _g(it, ['price', 'unit_price'], 0) || it.unit_price || 0);
      var importe = Math.round(precio * uds * 100) / 100;
      subtotal += importe;
      var titulo = it.title || it.name || _g(it, ['title', 'translation'], 'Producto Uber');
      var notasItem = '';
      // instrucciones / modificadores del item
      if (it.special_instructions) notasItem = String(it.special_instructions);
      ventasRows.push({
        id: Utilities.getUuid(),
        nfactura: nfactura,
        iditem: it.external_data || it.id || '',
        item: notasItem ? (titulo + ' — ' + notasItem) : titulo,
        uds: uds,
        precio: precio,
        importe: importe,
        estado: 'Ordenado',
        fecha: now,
        updated: now
      });
    }
    subtotal = Math.round(subtotal * 100) / 100;

    var total = _money(_g(order, ['payment', 'charges', 'total'], null)) ||
                _money(_g(order, ['charges', 'total'], null)) || subtotal;
    // IVA incluido (16%) estimado a partir del total; ajusta si tu cálculo es otro
    var iva = Math.round((total - total / 1.16) * 100) / 100;

    // Cabecera: aparece en el TPV como ticket. atendio="UBER EATS" lo diferencia.
    var nota = {
      nfactura: nfactura, fecha: fecha, mesa: 'UBER', atendio: 'UBER EATS',
      estado: 'Abierta', subtotal: Math.round((total - iva) * 100) / 100,
      iva: iva, desc_pct: 0, descuento: 0, total: total, metodo: 'Uber Eats', updated: now
    };

    // Extras Uber (para reportes y detalle completo)
    var uber = {
      order_id: orderId, nfactura: nfactura, cliente: cliente, telefono: telefono,
      direccion: direccion, tipo_entrega: tipo_entrega, notas: notas_pedido,
      estatus_uber: order.current_state || order.state || '', total: total,
      creado: now, updated: now
    };

    _uAppend('notas', nota);
    for (var j = 0; j < ventasRows.length; j++) _uAppend('ventas', ventasRows[j]);
    _uUpsert('ubereats', uber);

    Logger.log('Pedido Uber guardado: folio ' + nfactura + ' order ' + orderId);
    return { nfactura: nfactura, orderId: orderId };
  } finally {
    lock.releaseLock();
  }
}

// ====== 5) Aceptar / rechazar el pedido en Uber ======
function aceptarPedidoUber(orderId) {
  var c = _uCfg();
  var res = UrlFetchApp.fetch(c.apiBase + '/v1/eats/orders/' + encodeURIComponent(orderId) + '/accept_pos_order', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + _uToken() },
    contentType: 'application/json',
    payload: JSON.stringify({ reason: 'Aceptado por YOLO TPV' }),
    muteHttpExceptions: true
  });
  Logger.log('accept ' + res.getResponseCode() + ': ' + res.getContentText());
  return res.getResponseCode();
}

// ====== 6) Router del evento (lo llama doPost cuando ?src=uber) ======
function _procesarEventoUber(evt) {
  var orderId = _g(evt, ['meta', 'resource_id'], '') ||
                _g(evt, ['meta', 'order_id'], '') ||
                evt.order_id ||
                _idFromHref(evt.resource_href || _g(evt, ['meta', 'resource_href'], ''));
  if (!orderId) { Logger.log('Evento Uber sin order id: ' + JSON.stringify(evt)); return; }
  var order = _getUberOrder(orderId);
  Logger.log('ORDER RAW: ' + JSON.stringify(order)); // útil para afinar el MAPEO la 1a vez
  _guardarPedidoUber(order);
  if (_uCfg().autoaccept) { try { aceptarPedidoUber(orderId); } catch (e) { Logger.log('auto-accept: ' + e); } }
}

// Punto de entrada del webhook (invocado desde doPost de Code.gs)
function uberWebhook_(e) {
  var c = _uCfg();
  var uk = (e && e.parameter && e.parameter.uk) || '';
  if (!c.webhookSecret || uk !== c.webhookSecret) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var evt = {};
  try { evt = JSON.parse(e.postData.contents); } catch (err) { evt = {}; }
  try {
    _procesarEventoUber(evt);
  } catch (err) {
    Logger.log('uberWebhook error: ' + err);
    // Respondemos 200 igual para que Uber no reintente en bucle mientras afinamos.
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ====== Pruebas manuales ======
// Simula un evento sin llamar a Uber (útil para validar la escritura en el Sheet)
function _testEscrituraLocal() {
  var demo = {
    id: 'demo-' + Date.now(),
    eater: { first_name: 'Cliente', last_name: 'Prueba', phone: '9990000000', delivery_instructions: 'Tocar el timbre' },
    type: 'DELIVERY',
    deliveries: [{ location: { street_address: 'Calle 6 #280, Mérida' } }],
    special_instructions: 'Sin azúcar',
    cart: { items: [
      { title: 'Latte', quantity: 2, price: 7500 },
      { title: 'Croissant Clásico', quantity: 1, price: 14900, special_instructions: 'Caliente' }
    ] },
    payment: { charges: { total: { amount: 29900 } } },
    current_state: 'CREATED'
  };
  return _guardarPedidoUber(demo);
}
