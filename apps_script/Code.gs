/**
 * YOLO TPV — API sobre Google Sheets (Google Apps Script)
 * ------------------------------------------------------------------
 * Pega TODO este archivo en: tu Google Sheet → Extensiones → Apps Script.
 * Luego: Implementar → Nueva implementación → tipo "Aplicación web":
 *    - Ejecutar como: Yo (tu cuenta)
 *    - Quién tiene acceso: Cualquier usuario
 * Copia la URL /exec y pégala en la app (menú ⚙ Sincronización).
 *
 * Seguridad: comparte un TOKEN con la app. Cámbialo aquí y en la app.
 */

var TOKEN = 'yolo-tpv-2026';   // <-- cámbialo por algo tuyo y ponlo igual en la app
var PDF_FOLDER_ID = '1knNQRbWLCi3jqr2l5C2JazT78CM054AY';  // carpeta de Drive para los PDF de notas

// Pestañas y su columna llave + encabezados (orden de columnas en el Sheet)
var TABLAS = {
  productos: { key: 'id', cols: ['id','nombre','precio','categoria','foto','activo','ctrl_inv','existencia','updated'] },
  notas:     { key: 'nfactura', cols: ['nfactura','fecha','mesa','atendio','estado','subtotal','iva','desc_pct','descuento','total','metodo','updated'] },
  ventas:    { key: 'id', cols: ['id','nfactura','iditem','item','uds','precio','importe','estado','fecha','updated'] },
  pagos:     { key: 'nfactura', cols: ['nfactura','metodo','efectivo','tarjeta','transferencia','recibido_efectivo','cambio','propina_pct','propina','desc_pct','descuento','total','due','fecha'] },
  cortes:    { key: 'fecha', cols: ['fecha','apertura','total_ventas','v_efectivo','v_tarjeta','v_transfer','descuentos','entregar','otros','motivo','canceladas','updated'] },
  // Extras de pedidos Uber Eats (la escribe UberEats.gs; el TPV la ignora al hacer pull)
  ubereats:  { key: 'order_id', cols: ['order_id','nfactura','cliente','telefono','direccion','tipo_entrega','notas','estatus_uber','total','creado','updated'] }
};

function _ss() { return SpreadsheetApp.getActive(); }

function _hoja(tabla) {
  var ss = _ss();
  var sh = ss.getSheetByName(tabla);
  var def = TABLAS[tabla];
  if (!sh) {
    sh = ss.insertSheet(tabla);
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function ensureSheets() { for (var t in TABLAS) _hoja(t); }

/**
 * EJECUTA ESTA FUNCIÓN UNA VEZ (botón ▶ Ejecutar, con "autorizar" seleccionada)
 * para conceder el permiso de Drive que necesita el guardado de PDF.
 * Acepta la ventana de permisos (Advanced → continuar → Allow).
 */
function autorizar() {
  ensureSheets();
  var nombre = DriveApp.getFolderById(PDF_FOLDER_ID).getName();
  Logger.log('OK. Carpeta de PDFs: ' + nombre);
  return nombre;
}

function _colIndex(tabla) {
  return TABLAS[tabla].cols.reduce(function (m, c, i) { m[c] = i; return m; }, {});
}

// Mapa llave -> número de fila (1-based, incluye encabezado)
function _indiceLlaves(sh, tabla) {
  var def = TABLAS[tabla];
  var last = sh.getLastRow();
  var idx = {};
  if (last < 2) return idx;
  var keyCol = def.cols.indexOf(def.key) + 1;
  var vals = sh.getRange(2, keyCol, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) idx[String(vals[i][0])] = i + 2;
  return idx;
}

function _filaDesde(tabla, obj) {
  return TABLAS[tabla].cols.map(function (c) {
    var v = obj[c];
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v;
    return v;
  });
}

// Aplica una lista de cambios [{tabla, op, data}] de forma atómica con bloqueo
function aplicarCambios(cambios) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  var aplicados = 0, errores = [];
  try {
    var cache = {}; // tabla -> {sh, idx}
    for (var i = 0; i < cambios.length; i++) {
      var c = cambios[i];
      if (!TABLAS[c.tabla]) { errores.push('tabla desconocida: ' + c.tabla); continue; }
      if (!cache[c.tabla]) { var sh = _hoja(c.tabla); cache[c.tabla] = { sh: sh, idx: _indiceLlaves(sh, c.tabla) }; }
      var sh = cache[c.tabla].sh, idx = cache[c.tabla].idx, def = TABLAS[c.tabla];
      var keyVal = String(c.data[def.key]);
      var op = c.op || 'upsert';
      if (op === 'delete') {
        if (idx[keyVal]) { sh.deleteRow(idx[keyVal]); cache[c.tabla].idx = _indiceLlaves(sh, c.tabla); }
        aplicados++;
        continue;
      }
      var fila = _filaDesde(c.tabla, c.data);
      if (idx[keyVal]) {
        sh.getRange(idx[keyVal], 1, 1, def.cols.length).setValues([fila]);
      } else {
        sh.appendRow(fila);
        cache[c.tabla].idx[keyVal] = sh.getLastRow();
      }
      aplicados++;
    }
  } finally {
    lock.releaseLock();
  }
  return { aplicados: aplicados, errores: errores };
}

function _leerTabla(tabla) {
  var sh = _hoja(tabla), def = TABLAS[tabla];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, def.cols.length).getValues();
  return vals.map(function (row) {
    var o = {};
    for (var i = 0; i < def.cols.length; i++) o[def.cols[i]] = row[i];
    return o;
  });
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// GET: ?token=..&action=ping | pull(&tabla=productos)
function doGet(e) {
  var p = e.parameter || {};
  if (p.token !== TOKEN) return _json({ ok: false, error: 'token' });
  var action = p.action || 'ping';
  if (action === 'ping') { ensureSheets(); return _json({ ok: true, pong: true, ts: Date.now() }); }
  if (action === 'pull') {
    if (p.tabla) return _json({ ok: true, tabla: p.tabla, rows: _leerTabla(p.tabla) });
    var out = {};
    for (var t in TABLAS) out[t] = _leerTabla(t);
    return _json({ ok: true, data: out });
  }
  return _json({ ok: false, error: 'accion' });
}

// Genera un PDF a partir de HTML y lo guarda en la carpeta de Drive. Reemplaza si ya existe.
function guardarPDF(nfactura, html) {
  var folder = DriveApp.getFolderById(PDF_FOLDER_ID);
  var nombre = 'Nota-' + nfactura + '.pdf';
  // borra versiones previas de la misma nota
  var prev = folder.getFilesByName(nombre);
  while (prev.hasNext()) prev.next().setTrashed(true);
  var blob = Utilities.newBlob(html, 'text/html', 'nota.html').getAs('application/pdf').setName(nombre);
  var file = folder.createFile(blob);
  return file.getUrl();
}

// POST: body JSON {token, cambios:[...]} y/o {token, pdf:{nfactura, html}}
function doPost(e) {
  // Webhook de Uber Eats: llega como <URL>/exec?src=uber&uk=<secreto> (ver UberEats.gs)
  if (e && e.parameter && e.parameter.src === 'uber') return uberWebhook_(e);
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return _json({ ok: false, error: 'json' }); }
  if (!body || body.token !== TOKEN) return _json({ ok: false, error: 'token' });
  if (body.pdf) {
    try {
      var url = guardarPDF(body.pdf.nfactura, body.pdf.html);
      return _json({ ok: true, pdf: true, url: url, ts: Date.now() });
    } catch (err) {
      return _json({ ok: false, error: 'pdf: ' + err });
    }
  }
  var cambios = body.cambios || [];
  var r = aplicarCambios(cambios);
  return _json({ ok: true, aplicados: r.aplicados, errores: r.errores, ts: Date.now() });
}
