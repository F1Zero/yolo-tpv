/* ============================================================
   YOLO TPV - Capa de datos (IndexedDB)
   Fuente de verdad local. En Fase 2 se sincroniza a Google Sheets.
   ============================================================ */
(function () {
  const DB_NAME = 'yolo_tpv';
  const DB_VERSION = 1;
  let _db = null;

  // Stores (tablas) del modelo:
  //  productos : {id, nombre, precio, categoria, foto, activo, ctrl_inv, existencia}
  //  notas     : {nfactura, fecha, mesa, atendio, estado, subtotal, iva, desc_pct, descuento, total, updated}
  //              estado: 'Abierta' | 'Cobrada' | 'Cancelada'
  //  lineas    : {id, nfactura, iditem, item, uds, precio, importe, estado, fecha, updated}
  //              estado: 'Ordenado' | 'Entregado' | 'Pagado'
  //  pagos     : {nfactura, metodo, recibido, cambio, propina_pct, propina, descuento, total, fecha}
  //  cortes    : {fecha, apertura, total_ventas, v_efectivo, v_tarjeta, v_transfer, descuentos, entregar, otros, motivo, canceladas}
  //  cola      : {seq, tabla, op, payload, ts}   -> cola de sincronizacion (Fase 2)
  //  meta      : {clave, valor}                  -> contadores, config

  function open() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('productos'))
          db.createObjectStore('productos', { keyPath: 'id' }).createIndex('categoria', 'categoria');
        if (!db.objectStoreNames.contains('notas')) {
          const s = db.createObjectStore('notas', { keyPath: 'nfactura' });
          s.createIndex('estado', 'estado');
          s.createIndex('fecha', 'fecha');
        }
        if (!db.objectStoreNames.contains('lineas')) {
          const s = db.createObjectStore('lineas', { keyPath: 'id' });
          s.createIndex('nfactura', 'nfactura');
        }
        if (!db.objectStoreNames.contains('pagos'))
          db.createObjectStore('pagos', { keyPath: 'nfactura' });
        if (!db.objectStoreNames.contains('cortes'))
          db.createObjectStore('cortes', { keyPath: 'fecha' });
        if (!db.objectStoreNames.contains('cola'))
          db.createObjectStore('cola', { keyPath: 'seq', autoIncrement: true });
        if (!db.objectStoreNames.contains('meta'))
          db.createObjectStore('meta', { keyPath: 'clave' });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return _db.transaction(store, mode).objectStore(store);
  }
  function done(request) {
    return new Promise((res, rej) => {
      request.onsuccess = () => res(request.result);
      request.onerror = () => rej(request.error);
    });
  }
  function txDone(t) {
    return new Promise((res, rej) => {
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }

  const DB = {
    open,
    // ---- CRUD generico ----
    async put(store, obj) {
      const t = _db.transaction(store, 'readwrite');
      t.objectStore(store).put(obj);
      await txDone(t);
      return obj;
    },
    async bulkPut(store, arr) {
      const t = _db.transaction(store, 'readwrite');
      const os = t.objectStore(store);
      arr.forEach((o) => os.put(o));
      await txDone(t);
      return arr.length;
    },
    async get(store, key) { return done(tx(store, 'readonly').get(key)); },
    async all(store) { return done(tx(store, 'readonly').getAll()); },
    async del(store, key) {
      const t = _db.transaction(store, 'readwrite');
      t.objectStore(store).delete(key);
      return txDone(t);
    },
    async byIndex(store, index, value) {
      const os = tx(store, 'readonly');
      return done(os.index(index).getAll(value));
    },
    async count(store) { return done(tx(store, 'readonly').count()); },

    // ---- meta / contadores ----
    async getMeta(clave, def) {
      const r = await this.get('meta', clave);
      return r ? r.valor : def;
    },
    async setMeta(clave, valor) { return this.put('meta', { clave, valor }); },
    // Folio consecutivo de nota (nfactura). Inicia donde quedo AppSheet.
    // Anti-colisión (integración Uber, Opción A): nunca reutiliza un nfactura
    // ya visto. Toma el máximo entre el contador local y el mayor nfactura
    // presente en 'notas' (que incluye los pedidos Uber bajados por sync).
    async nextFolio() {
      let base = await this.getMeta('folio', 0);
      try {
        const notas = await this.all('notas');
        for (const n of notas) {
          const f = Number(n && n.nfactura) || 0;
          if (f > base) base = f;
        }
      } catch (e) { /* si falla, usa el contador local */ }
      const nuevo = base + 1;
      await this.setMeta('folio', nuevo);
      return nuevo;
    },
  };

  window.DB = DB;
})();
