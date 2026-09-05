/* ============================================================
   YOLO TPV — Sincronización con Google Sheets (Apps Script)
   Cola offline (store 'cola' de IndexedDB) -> POST al Web App.
   Escrituras idempotentes por llave: reintentar no duplica.
   ============================================================ */
(function () {
  const cfg = { url: '', token: '', on: false };
  let _flushing = false;
  let _timer = null;

  async function cargarCfg() {
    cfg.url = await DB.getMeta('sync_url', '');
    cfg.token = await DB.getMeta('sync_token', 'yolo-tpv-2026');
    cfg.on = await DB.getMeta('sync_on', false);
  }
  async function guardarCfg(url, token, on) {
    cfg.url = (url || '').trim();
    cfg.token = (token || '').trim();
    cfg.on = !!on;
    await DB.setMeta('sync_url', cfg.url);
    await DB.setMeta('sync_token', cfg.token);
    await DB.setMeta('sync_on', cfg.on);
    actualizarBadge();
    if (cfg.on) flush();
  }

  // Encola un cambio. data debe traer la llave (id/nfactura/fecha).
  async function enqueue(tabla, op, data) {
    if (!cfg.on) return;
    try {
      await DB.put('cola', { tabla, op, data, ts: Date.now() });
      programarFlush();
    } catch (e) { /* silencioso */ }
  }

  function programarFlush() {
    clearTimeout(_timer);
    _timer = setTimeout(flush, 800); // agrupa cambios seguidos
  }

  async function pendientes() { return DB.count('cola'); }

  async function flush() {
    if (_flushing || !cfg.on || !cfg.url || !navigator.onLine) return;
    _flushing = true;
    actualizarBadge('sync');
    try {
      const items = await DB.all('cola'); // {seq, tabla, op, data, ts}
      // 1) cambios normales en lotes
      let datos = items.filter((i) => i.tabla !== '__pdf__');
      while (datos.length) {
        const lote = datos.slice(0, 50);
        const cambios = lote.map((i) => ({ tabla: i.tabla, op: i.op, data: i.data }));
        const r = await enviar(cambios);
        if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'respuesta no ok');
        for (const i of lote) await DB.del('cola', i.seq);
        datos = datos.slice(50);
      }
      // 2) PDFs uno por uno
      const pdfs = items.filter((i) => i.tabla === '__pdf__');
      for (const i of pdfs) {
        const r = await enviarPDF(i.data);
        if (!r || !r.ok) throw new Error('pdf no ok');
        await DB.del('cola', i.seq);
      }
      await DB.setMeta('sync_last', Date.now());
    } catch (e) {
      // se queda en la cola para el próximo intento
    } finally {
      _flushing = false;
      actualizarBadge();
    }
  }

  // Encola un PDF (ticket) para archivarlo en Drive vía Apps Script.
  async function enqueuePDF(nfactura, html) {
    if (!cfg.on) return;
    try { await DB.put('cola', { tabla: '__pdf__', op: 'pdf', data: { nfactura, html }, ts: Date.now() }); programarFlush(); } catch (e) { }
  }
  async function enviarPDF(data) {
    const resp = await fetch(cfg.url, {
      method: 'POST', mode: 'cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: cfg.token, pdf: data }),
    });
    return resp.json();
  }

  // POST con lectura de respuesta (Apps Script permite CORS). text/plain evita preflight.
  async function enviar(cambios) {
    const resp = await fetch(cfg.url, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: cfg.token, cambios }),
    });
    return resp.json();
  }

  // ---- BAJAR (pull) y combinar el Sheet en la base local ----
  function fixFecha(v) {
    // el Sheet a veces devuelve la fecha como datetime ISO; la normalizamos a YYYY-MM-DD
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const d = new Date(v);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    return v;
  }
  async function mergeTabla(store, rows, key, tsField, additiveOnly) {
    if (!Array.isArray(rows)) return;
    for (const raw of rows) {
      const row = { ...raw };
      if ('fecha' in row) row.fecha = fixFecha(row.fecha);
      const k = row[key];
      if (k === undefined || k === '' || k === null) continue;
      const local = await DB.get(store, k);
      if (additiveOnly) { if (!local) await DB.put(store, row); continue; }
      const inTs = Number(row[tsField]) || 0;
      const loTs = local ? (Number(local[tsField]) || 0) : -1;
      if (!local || inTs >= loTs) await DB.put(store, row);
    }
  }
  async function pull() {
    if (!cfg.on || !cfg.url || !navigator.onLine) return { ok: false };
    try {
      const r = await fetch(cfg.url + (cfg.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(cfg.token) + '&action=pull', { mode: 'cors' });
      const d = await r.json();
      if (!d || !d.ok || !d.data) return { ok: false };
      const x = d.data;
      await mergeTabla('productos', x.productos, 'id', 'updated', true); // productos: solo agregar nuevos
      await mergeTabla('notas', x.notas, 'nfactura', 'updated', false);
      await mergeTabla('lineas', x.ventas, 'id', 'updated', false);
      await mergeTabla('pagos', x.pagos, 'nfactura', 'fecha', false);
      await mergeTabla('cortes', x.cortes, 'fecha', 'updated', false);
      await DB.setMeta('pull_last', Date.now());
      if (window.__afterPull) try { await window.__afterPull(); } catch (e) { }
      return { ok: true };
    } catch (e) { return { ok: false }; }
  }
  // primero sube lo pendiente, luego baja y combina
  async function sincronizar() { await flush(); await pull(); }

  // Sube TODO lo local al Sheet (reconciliación / carga inicial).
  async function subirTodo() {
    if (!cfg.url) { toastSafe('Configura la URL primero'); return; }
    const tablas = { productos: 'productos', notas: 'notas', ventas: 'lineas', pagos: 'pagos', cortes: 'cortes' };
    for (const [tabla, store] of Object.entries(tablas)) {
      let rows = [];
      try { rows = await DB.all(store); } catch { rows = []; }
      for (const r of rows) await DB.put('cola', { tabla, op: 'upsert', data: r, ts: Date.now() });
    }
    await flush();
    toastSafe('Subida completa enviada al Sheet');
  }

  // Prueba de conexión (lee la respuesta: confirma URL y token correctos)
  async function probar() {
    try {
      const r = await fetch(cfg.url + (cfg.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(cfg.token) + '&action=ping',
        { method: 'GET', mode: 'cors' });
      const d = await r.json();
      return !!(d && d.ok && d.pong);
    } catch { return false; }
  }

  function toastSafe(m) { if (window.__toast) window.__toast(m); }

  function actualizarBadge(estado) {
    const el = document.getElementById('infoSync');
    if (!el) return;
    if (!cfg.on) { el.textContent = 'Solo local'; el.className = 'tag'; return; }
    if (estado === 'sync') { el.textContent = 'Sincronizando…'; el.className = 'tag on'; return; }
    pendientes().then((n) => {
      el.textContent = n > 0 ? ('Pendientes: ' + n) : 'Sincronizado ✓';
      el.className = 'tag ' + (n > 0 ? 'warn' : 'on');
    });
  }

  async function init() {
    await cargarCfg();
    actualizarBadge();
    window.addEventListener('online', sincronizar);
    if (cfg.on) sincronizar();                       // sube pendientes y baja el Sheet al abrir
    setInterval(() => { if (cfg.on) sincronizar(); }, 25000); // subir + bajar cada 25s
  }

  window.Sync = { init, enqueue, enqueuePDF, flush, pull, sincronizar, subirTodo, probar, guardarCfg, cargarCfg, pendientes, get cfg() { return cfg; }, actualizarBadge };
})();
