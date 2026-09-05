/* ============================================================
   YOLO TPV - Lógica de la aplicación (Fase 1, 100% local)
   ============================================================ */
(function () {
  const IVA = 0.16;
  const FOLIO_INICIAL = 800; // continúa después de lo último visto en AppSheet

  // Datos fiscales del negocio (para el ticket). Editables aquí.
  const NEGOCIO = {
    nombre: 'YOLO COFFEE SHOP',
    rfc: 'YCS230608N64',
    regimen: 'Sociedad por Acciones Simplificadas de Capital Variable',
    direccion: 'Calle 6 Avenida José Vasconcelos # 280 por 17B y 19, Colonia Jardines de Vista Alegre, C.P. 97138',
    telefono: '9999438625',
    email: 'yoloyucatan@gmail.com',
    logo: 'assets/logo.png',
    pie: '” Muchas Gracias” ☺',
  };

  // Personalización de comida
  const CAT_COMIDA = ['Alimentos'];
  const EXTRAS_COMIDA = [
    { nombre: 'Tocino', precio: 25 },
    { nombre: 'Jamón', precio: 28 },
    { nombre: 'Chorizo', precio: 25 },
    { nombre: 'Queso gouda', precio: 38 },
  ];

  // ---------- utilidades ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const money = (n) => '$' + (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
  const hoy = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10));
  const toast = (msg) => {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), 2200);
  };

  // ---------- estado en memoria ----------
  const S = {
    notaActual: null,   // {nfactura,...}
    lineas: [],         // líneas de la nota actual
    categoria: 'Todos',
    metodoCobro: 'Efectivo',
  };

  // ---------- arranque ----------
  async function init() {
    await DB.open();
    await seedProductos();
    await aplicarFotosSeed();
    window.__toast = toast;
    // al bajar datos del Sheet, refresca la vista visible (sin estorbar si hay una nota abierta)
    window.__afterPull = async () => {
      if (S.vista === 'notas') await renderNotas();
      else if (S.vista === 'historial') await renderHistorial();
    };
    if (window.Sync) await Sync.init();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { });
    }
    bindUI();
    actualizarRed();
    window.addEventListener('online', actualizarRed);
    window.addEventListener('offline', actualizarRed);
    await renderNotas();
    await refreshInfo();
  }

  async function seedProductos() {
    const n = await DB.count('productos');
    if (n > 0) return;
    const seed = (window.CATALOGO_SEED || []).map((p) => ({
      id: p.id || uid(),
      nombre: p.nombre,
      precio: Number(p.precio) || 0,
      categoria: p.categoria || 'Otros',
      foto: p.foto || '',
      activo: p.activo !== false,
      ctrl_inv: false,
      existencia: 0,
    }));
    await DB.bulkPut('productos', seed);
    if ((await DB.getMeta('folio', null)) === null) await DB.setMeta('folio', FOLIO_INICIAL);
    toast('Catálogo cargado: ' + seed.length + ' productos');
  }

  // Aplica la ruta de foto de la semilla a productos ya existentes (sin pisar fotos propias).
  const FOTOS_VER = 3;
  async function aplicarFotosSeed() {
    if ((await DB.getMeta('fotos_ver', 0)) >= FOTOS_VER) return;
    const seedById = Object.fromEntries((window.CATALOGO_SEED || []).map((p) => [p.id, p]));
    const prods = await DB.all('productos');
    const cambios = [];
    for (const p of prods) {
      const s = seedById[p.id];
      // sincroniza foto desde la semilla SOLO si la foto actual es una ruta de assets o está vacía
      // (respeta las fotos que el usuario suba, que son dataURL). Permite también limpiar (foto '').
      if (s && (!p.foto || p.foto.startsWith('assets/productos/'))) {
        const nueva = s.foto || '';
        if (p.foto !== nueva) { p.foto = nueva; cambios.push(p); }
      }
    }
    if (cambios.length) await DB.bulkPut('productos', cambios);
    await DB.setMeta('fotos_ver', FOTOS_VER);
  }

  // ---------- navegación ----------
  function mostrar(vista) {
    S.vista = vista;
    $('#viewNotas').hidden = vista !== 'notas';
    $('#viewNota').hidden = vista !== 'nota';
    $('#viewProductos').hidden = vista !== 'productos';
    $('#viewHistorial').hidden = vista !== 'historial';
    $('#viewPrecios').hidden = vista !== 'precios';
    $('#viewCorte').hidden = vista !== 'corte';
    $('#viewReportes').hidden = vista !== 'reportes';
    $('#btnBack').hidden = vista === 'notas';
    cerrarDrawer();
  }

  // ============================================================
  //  VISTA: NOTAS ABIERTAS
  // ============================================================
  async function renderNotas() {
    const abiertas = (await DB.byIndex('notas', 'estado', 'Abierta'))
      .sort((a, b) => b.nfactura - a.nfactura);
    const cont = $('#listaNotas');
    cont.innerHTML = '';
    $('#notasVacio').hidden = abiertas.length > 0;
    for (const n of abiertas) {
      const lineas = await DB.byIndex('lineas', 'nfactura', n.nfactura);
      const tot = calcTotales(lineas, n.desc_pct || 0).total;
      const uds = lineas.reduce((s, l) => s + l.uds, 0);
      const card = document.createElement('button');
      card.className = 'nota-card';
      card.innerHTML = `
        <div class="nc-top"><span class="nc-mesa">Mesa ${escapeHtml(n.mesa)}</span>
        <span class="nc-folio">#${n.nfactura}</span></div>
        <div class="nc-atendio">${escapeHtml(n.atendio || '—')}</div>
        <div class="nc-bottom"><span>${uds} art.</span><span class="nc-total">${money(tot)}</span></div>`;
      card.onclick = () => abrirNota(n.nfactura);
      cont.appendChild(card);
    }
  }

  // ============================================================
  //  VISTA: NOTA (catálogo + carrito)
  // ============================================================
  async function nuevaNota() {
    $('#dlgNotaTitulo').textContent = 'Nueva nota';
    $('#inpFolio').value = await siguienteFolioSugerido();
    $('#inpMesa').value = '';
    $('#inpAtendio').value = await DB.getMeta('ultimo_mesero', '');
    await llenarMeseros();
    const dlg = $('#dlgNota');
    dlg.returnValue = '';
    dlg.showModal();
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'ok') return;
      const nfactura = parseInt($('#inpFolio').value, 10);
      if (!nfactura || nfactura < 1) { toast('N° de nota inválido'); return; }
      if (await DB.get('notas', nfactura)) { toast('Ya existe la nota #' + nfactura); return; }
      const mesa = $('#inpMesa').value.trim() || 'S/M';
      const atendio = $('#inpAtendio').value.trim();
      const nota = {
        nfactura, fecha: hoy(), mesa, atendio,
        estado: 'Abierta', subtotal: 0, iva: 0, desc_pct: 0, descuento: 0, total: 0,
        updated: Date.now(),
      };
      await DB.put('notas', nota);
      await DB.setMeta('folio', nfactura);
      sync('notas', 'upsert', nota);
      if (atendio) await DB.setMeta('ultimo_mesero', atendio);
      await cargarNota(nfactura);
    };
  }

  // sugiere el siguiente folio sin consumirlo (máximo global + 1)
  async function siguienteFolioSugerido() {
    const notas = await DB.all('notas');
    return notas.reduce((m, n) => Math.max(m, Number(n.nfactura) || 0), FOLIO_INICIAL - 1) + 1;
  }

  async function abrirNota(nfactura) { await cargarNota(nfactura); }

  async function cargarNota(nfactura) {
    S.notaActual = await DB.get('notas', nfactura);
    S.lineas = (await DB.byIndex('lineas', 'nfactura', nfactura)).sort((a, b) => a.fecha - b.fecha);
    S.categoria = 'Todos';
    $('#cNfactura').textContent = '#' + nfactura;
    $('#cMesa').textContent = S.notaActual.mesa;
    $('#cAtendio').textContent = S.notaActual.atendio || 'S/N';
    $('#descPct').value = String(S.notaActual.desc_pct || 0);
    $('#buscar').value = '';
    await renderCategorias();
    await renderProductos();
    renderLineas();
    $('.carrito').classList.remove('expandida'); // en móvil arranca colapsado
    mostrar('nota');
  }

  async function renderCategorias() {
    const prods = await DB.all('productos');
    const cats = ['Todos', ...new Set(prods.filter((p) => p.activo).map((p) => p.categoria))];
    const cont = $('#categorias');
    cont.innerHTML = '';
    cats.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'chip' + (c === S.categoria ? ' activo' : '');
      b.textContent = c;
      b.onclick = () => { S.categoria = c; renderProductos(); renderCategorias(); };
      cont.appendChild(b);
    });
  }

  async function renderProductos() {
    const q = $('#buscar').value.trim().toLowerCase();
    let prods = (await DB.all('productos')).filter((p) => p.activo);
    if (S.categoria !== 'Todos') prods = prods.filter((p) => p.categoria === S.categoria);
    if (q) prods = prods.filter((p) => p.nombre.toLowerCase().includes(q));
    prods.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    const cont = $('#productos');
    cont.innerHTML = '';
    for (const p of prods) {
      const b = document.createElement('button');
      b.className = 'prod-card' + (p.foto ? ' con-foto' : '');
      b.innerHTML = `
        <div class="prod-foto">${fotoHtml(p)}</div>
        <div class="prod-cuerpo">
          <div class="prod-nombre">${escapeHtml(p.nombre)}</div>
          <div class="prod-precio">${money(p.precio)}</div>
        </div>`;
      b.onclick = () => agregarLinea(p);
      cont.appendChild(b);
    }
    if (!prods.length) cont.innerHTML = '<p class="vacio small">Sin productos.</p>';
  }

  // ¿el producto lleva personalización (salsa/aderezo/extras)? -> comida
  function esComida(p) { return CAT_COMIDA.includes(p.categoria); }

  async function agregarLinea(p) {
    if (esComida(p)) { abrirModificadores(p); return; }
    await pushLinea(p, null);
  }

  // mods = null (sin personalizar) o {salsa, aderezo, extras:[{nombre,precio}], nota}
  async function pushLinea(p, mods) {
    const extras = (mods && mods.extras) || [];
    const extrasTotal = extras.reduce((s, e) => s + e.precio, 0);
    const tieneMods = mods && (mods.salsa || (mods.aderezo && mods.aderezo !== 'Sin aderezos') || extras.length || (mods.nota || '').trim());
    if (!tieneMods) {
      // productos simples: agrupar por producto
      const existe = S.lineas.find((l) => l.iditem === p.id && l.estado === 'Ordenado' && !l.salsa && !(l._extras && l._extras.length) && !l.nota_especial && (!l.aderezo || l.aderezo === 'Sin aderezos'));
      if (existe) {
        existe.uds += 1; existe.importe = round2(existe.uds * existe.precio); existe.updated = Date.now();
        await DB.put('lineas', existe); sync('ventas', 'upsert', existe);
        await guardarTotalesNota(); renderLineas(); return;
      }
    }
    const precioU = round2(p.precio + extrasTotal);
    const l = {
      id: uid(), nfactura: S.notaActual.nfactura, iditem: p.id, item: p.nombre,
      uds: 1, precio: precioU, precio_base: p.precio, importe: precioU, estado: 'Ordenado',
      salsa: (mods && mods.salsa) || '', aderezo: (mods && mods.aderezo) || '',
      _extras: extras, extras: extras.map((e) => e.nombre).join(', '),
      nota_especial: (mods && (mods.nota || '').trim()) || '',
      fecha: Date.now(), updated: Date.now(),
    };
    S.lineas.push(l);
    await DB.put('lineas', l);
    sync('ventas', 'upsert', l);
    await guardarTotalesNota();
    renderLineas();
  }

  // texto de modificadores de una línea (para carrito, ticket y comanda)
  function modsTexto(l) {
    const p = [];
    if (l.salsa) p.push('Salsa ' + l.salsa.toLowerCase());
    if (l.aderezo && l.aderezo !== 'Sin aderezos') p.push(l.aderezo);
    if (l.extras) p.push('+ ' + l.extras);
    if (l.nota_especial) p.push('“' + l.nota_especial + '”');
    return p.join(' · ');
  }

  function renderLineas() {
    const cont = $('#lineas');
    cont.innerHTML = '';
    $('#lineasVacio').hidden = S.lineas.length > 0;
    S.lineas.forEach((l) => {
      const mods = modsTexto(l);
      const div = document.createElement('div');
      div.className = 'linea';
      div.innerHTML = `
        <div class="l-info">
          <div class="l-nombre">${escapeHtml(l.item)}</div>
          ${mods ? `<div class="l-mods">${escapeHtml(mods)}</div>` : ''}
          <div class="l-precio">${money(l.precio)} c/u</div>
        </div>
        <div class="l-qty">
          <button class="qbtn" data-a="menos">−</button>
          <span class="q">${l.uds}</span>
          <button class="qbtn" data-a="mas">+</button>
        </div>
        <div class="l-importe">${money(l.importe)}</div>`;
      div.querySelector('[data-a=mas]').onclick = () => cambiarQty(l, +1);
      div.querySelector('[data-a=menos]').onclick = () => cambiarQty(l, -1);
      cont.appendChild(div);
    });
    pintarTotales(calcTotales(S.lineas, Number($('#descPct').value)));
    actualizarHandle();
  }

  // resumen en la barra (handle) del carrito-hoja en móvil
  function actualizarHandle() {
    const uds = S.lineas.reduce((s, l) => s + l.uds, 0);
    const art = $('#chArt'); if (!art) return;
    art.textContent = uds + ' art.';
    $('#chNfac').textContent = S.notaActual ? '#' + S.notaActual.nfactura : '—';
    const t = calcTotales(S.lineas, Number($('#descPct').value || 0));
    $('#chTotal').textContent = money(t.total);
  }

  // ---------- diálogo de modificadores ----------
  let _modProd = null;
  function abrirModificadores(p) {
    _modProd = p;
    $('#modTitulo').textContent = 'Personalizar: ' + p.nombre;
    const dlg = $('#dlgMod');
    // reset
    dlg.querySelectorAll('input[name=salsa]').forEach((r) => r.checked = r.value === '');
    dlg.querySelectorAll('input[name=aderezo]').forEach((r) => r.checked = r.value === 'Sin aderezos');
    $('#modNota').value = '';
    // extras
    $('#modExtras').innerHTML = EXTRAS_COMIDA.map((e, i) =>
      `<label class="mod-op"><input type="checkbox" class="mod-extra" data-i="${i}"> ${escapeHtml(e.nombre)} +${money(e.precio)}</label>`).join('');
    recalcMod();
    dlg.querySelectorAll('input').forEach((inp) => inp.onchange = recalcMod);
    dlg.returnValue = '';
    dlg.showModal();
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'ok') return;
      const salsa = dlg.querySelector('input[name=salsa]:checked').value;
      const aderezo = dlg.querySelector('input[name=aderezo]:checked').value;
      const extras = [...dlg.querySelectorAll('.mod-extra:checked')].map((c) => EXTRAS_COMIDA[+c.dataset.i]);
      const nota = $('#modNota').value;
      await pushLinea(_modProd, { salsa, aderezo, extras, nota });
    };
  }
  function recalcMod() {
    const dlg = $('#dlgMod');
    const extrasTotal = [...dlg.querySelectorAll('.mod-extra:checked')].reduce((s, c) => s + EXTRAS_COMIDA[+c.dataset.i].precio, 0);
    $('#modSub').textContent = money((_modProd ? _modProd.precio : 0) + extrasTotal);
  }

  async function cambiarQty(l, delta) {
    l.uds += delta;
    if (l.uds <= 0) {
      S.lineas = S.lineas.filter((x) => x.id !== l.id);
      await DB.del('lineas', l.id);
      sync('ventas', 'delete', l);
    } else {
      l.importe = round2(l.uds * l.precio);
      l.updated = Date.now();
      await DB.put('lineas', l);
      sync('ventas', 'upsert', l);
    }
    await guardarTotalesNota();
    renderLineas();
  }

  // ---------- cálculos de dinero ----------
  // El precio de los productos YA incluye IVA (precio de venta redondo).
  // Desglosamos hacia atrás para el ticket.
  function calcTotales(lineas, descPct) {
    const bruto = lineas.reduce((s, l) => s + l.importe, 0);
    const descuento = round2(bruto * (descPct / 100));
    const total = round2(bruto - descuento);
    const subtotal = round2(total / (1 + IVA)); // base sin IVA
    const iva = round2(total - subtotal);
    return { bruto, descuento, total, subtotal, iva };
  }
  function pintarTotales(t) {
    $('#tSubtotal').textContent = money(t.subtotal);
    $('#tIva').textContent = money(t.iva);
    $('#tDescuento').textContent = '-' + money(t.descuento);
    $('#tTotal').textContent = money(t.total);
  }
  async function guardarTotalesNota() {
    const descPct = Number($('#descPct').value);
    const t = calcTotales(S.lineas, descPct);
    Object.assign(S.notaActual, {
      subtotal: t.subtotal, iva: t.iva, desc_pct: descPct,
      descuento: t.descuento, total: t.total, updated: Date.now(),
    });
    await DB.put('notas', S.notaActual);
    sync('notas', 'upsert', S.notaActual);
  }

  // ---------- cobro (con descuento y pago mixto) ----------
  function abrirCobro() {
    if (!S.lineas.length) { toast('La nota está vacía'); return; }
    $('#coNfactura').textContent = '#' + S.notaActual.nfactura;
    $('#coDescPct').value = String(S.notaActual.desc_pct || 0);
    $('#pagEfectivo').value = '';
    $('#pagTarjeta').value = '';
    $('#pagTransfer').value = '';
    recalcCobro();
    const dlg = $('#dlgCobro');
    dlg.returnValue = '';
    dlg.showModal();
    dlg.onclose = async () => { if (dlg.returnValue === 'ok') await confirmarCobro(); };
  }

  // total a cobrar = total con descuento (la propina NO se cobra, solo se sugiere)
  function _dueCobro() {
    const t = calcTotales(S.lineas, Number($('#coDescPct').value));
    return { t, due: t.total };
  }

  function recalcCobro() {
    const { due } = _dueCobro();
    const e = parseFloat($('#pagEfectivo').value) || 0;
    const ta = parseFloat($('#pagTarjeta').value) || 0;
    const tr = parseFloat($('#pagTransfer').value) || 0;
    const pagado = round2(e + ta + tr);
    const falta = round2(Math.max(0, due - pagado));
    // cambio solo puede venir del efectivo (tarjeta/transfer son exactos)
    const cambio = round2(Math.max(0, pagado - due));
    $('#coTotal').textContent = money(due);
    $('#coPagado').textContent = money(pagado);
    $('#coFalta').textContent = money(falta);
    $('#coCambio').textContent = money(cambio);
    $('#rowFalta').style.color = falta > 0 ? 'var(--danger)' : 'var(--muted)';
    // sugerencias de propina (solo informativas)
    $('#propinaSug').innerHTML = [5, 10, 15, 20].map((pct) =>
      `<span class="psug"><b>${pct}%</b> ${money(round2(due * pct / 100))}</span>`).join('');
    S._due = due;
  }

  // Toca un método -> llena ese campo con lo que falta para cubrir el total
  function llenarMetodo(targetId) {
    const { due } = _dueCobro();
    const ids = ['pagEfectivo', 'pagTarjeta', 'pagTransfer'];
    const otros = ids.filter((id) => id !== targetId)
      .reduce((s, id) => s + (parseFloat($('#' + id).value) || 0), 0);
    const restante = round2(Math.max(0, due - otros));
    $('#' + targetId).value = restante ? String(restante) : '';
    recalcCobro();
  }

  async function confirmarCobro() {
    const descPct = Number($('#coDescPct').value);
    const t = calcTotales(S.lineas, descPct);
    const propPct = 0, propina = 0;   // la propina no se cobra
    const due = t.total;
    let e = parseFloat($('#pagEfectivo').value) || 0;
    const ta = parseFloat($('#pagTarjeta').value) || 0;
    const tr = parseFloat($('#pagTransfer').value) || 0;
    const pagado = round2(e + ta + tr);
    const cambio = round2(Math.max(0, pagado - due));
    // efectivo neto que entra a caja (descontando el cambio)
    const efectivoNeto = round2(Math.max(0, e - cambio));

    const metodos = [];
    if (e > 0) metodos.push('Efectivo');
    if (ta > 0) metodos.push('Tarjeta');
    if (tr > 0) metodos.push('Transferencia');
    const metodo = metodos.length > 1 ? 'Mixto' : (metodos[0] || 'Efectivo');

    const pago = {
      nfactura: S.notaActual.nfactura, metodo,
      efectivo: efectivoNeto, tarjeta: ta, transferencia: tr,
      recibido_efectivo: e, cambio,
      propina_pct: propPct, propina,
      desc_pct: descPct, descuento: t.descuento,
      total: t.total, due, fecha: Date.now(),
    };
    await DB.put('pagos', pago);
    sync('pagos', 'upsert', pago);

    // guarda el descuento aplicado en la nota
    Object.assign(S.notaActual, {
      estado: 'Cobrada', metodo, desc_pct: descPct, descuento: t.descuento,
      subtotal: t.subtotal, iva: t.iva, total: t.total, updated: Date.now(),
    });
    for (const l of S.lineas) { l.estado = 'Pagado'; l.updated = Date.now(); await DB.put('lineas', l); sync('ventas', 'upsert', l); }
    await DB.put('notas', S.notaActual);
    sync('notas', 'upsert', S.notaActual);

    // guarda datos para el ticket post-cobro
    S._ultimoCobro = { nota: { ...S.notaActual }, lineas: S.lineas.map((l) => ({ ...l })), pago };
    // PDF automático a Drive (se encola; sube al sincronizar)
    if (window.Sync && Sync.enqueuePDF) {
      const html = buildPdfHtml(S._ultimoCobro.nota, S._ultimoCobro.lineas, pago);
      Sync.enqueuePDF(S.notaActual.nfactura, html);
    }
    mostrarCobrado(S._ultimoCobro);

    S.notaActual = null; S.lineas = [];
    await renderNotas(); await refreshInfo();
    mostrar('notas');
  }

  function mostrarCobrado(c) {
    $('#okNfactura').textContent = '#' + c.nota.nfactura;
    const p = c.pago;
    const filas = [];
    if (p.efectivo > 0) filas.push(['Efectivo', money(p.recibido_efectivo)]);
    if (p.tarjeta > 0) filas.push(['Tarjeta', money(p.tarjeta)]);
    if (p.transferencia > 0) filas.push(['Transferencia', money(p.transferencia)]);
    if (p.cambio > 0) filas.push(['Cambio', money(p.cambio)]);
    $('#okResumen').innerHTML =
      `<div class="row total"><span>Total</span><b>${money(p.total)}</b></div>` +
      filas.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join('');
    const dlg = $('#dlgCobrado');
    dlg.returnValue = '';
    dlg.showModal();
  }

  // ---------- impresión de ticket ----------
  function fechaTicket(ts) {
    const d = ts ? new Date(ts) : new Date();
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear() + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function ticketHTML(nota, lineas, pago, titulo, logoSrc) {
    const LOGO = logoSrc || NEGOCIO.logo;
    const t = calcTotales(lineas, nota.desc_pct || 0);
    const filas = lineas.map((l) => {
      const m = modsTexto(l);
      return `
      <tr><td class="ti">${escapeHtml(l.item)}${m ? `<div class="tmod">${escapeHtml(m)}</div>` : ''}</td>
      <td class="tu">${l.uds}</td>
      <td class="tp">${money(l.importe)}</td></tr>`;
    }).join('');
    let pagoHtml = '';
    if (pago) {
      const p = [];
      if (pago.efectivo > 0) p.push(`<div class="tk-row"><span>Efectivo</span><span>${money(pago.recibido_efectivo)}</span></div>`);
      if (pago.tarjeta > 0) p.push(`<div class="tk-row"><span>Tarjeta</span><span>${money(pago.tarjeta)}</span></div>`);
      if (pago.transferencia > 0) p.push(`<div class="tk-row"><span>Transferencia</span><span>${money(pago.transferencia)}</span></div>`);
      if (pago.propina > 0) p.push(`<div class="tk-row"><span>Propina</span><span>${money(pago.propina)}</span></div>`);
      if (pago.cambio > 0) p.push(`<div class="tk-row"><span>Cambio</span><span>${money(pago.cambio)}</span></div>`);
      pagoHtml = `<div class="tk-sep"></div>${p.join('')}`;
    }
    return `
      <div class="tk">
        <img class="tk-logo" src="${LOGO}" onerror="this.style.display='none'">
        <div class="tk-nom">${escapeHtml(NEGOCIO.nombre)}</div>
        <div class="tk-fiscal">
          RFC: ${NEGOCIO.rfc}<br>
          Régimen: ${escapeHtml(NEGOCIO.regimen)}<br>
          ${escapeHtml(NEGOCIO.direccion)}<br>
          Tel. ${NEGOCIO.telefono}<br>${NEGOCIO.email}
        </div>
        <div class="tk-sep"></div>
        ${titulo ? `<div class="tk-titulo">${titulo}</div>` : ''}
        <div class="tk-meta">
          <div class="tk-row"><span>Nota:</span><span># ${nota.nfactura}</span></div>
          <div class="tk-row"><span>Fecha:</span><span>${fechaTicket(pago ? pago.fecha : Date.now())}</span></div>
          <div class="tk-row"><span>Mesa:</span><span>${escapeHtml(nota.mesa)}</span></div>
          <div class="tk-row"><span>Atendió:</span><span>${escapeHtml(nota.atendio || '')}</span></div>
        </div>
        <div class="tk-sep"></div>
        <table class="tk-tabla">
          <thead><tr><th class="ti">Producto</th><th class="tu">Uds</th><th class="tp">Precio</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
        <div class="tk-sep"></div>
        <div class="tk-row"><span>Suma sin IVA</span><span>${money(t.subtotal)}</span></div>
        <div class="tk-row"><span>Descuento ${nota.desc_pct || 0}%</span><span>-${money(t.descuento)}</span></div>
        <div class="tk-row"><span>IVA 16%</span><span>${money(t.iva)}</span></div>
        <div class="tk-row tk-total"><span>TOTAL</span><span>${money(t.total)}</span></div>
        ${pagoHtml}
        <div class="tk-pie">${escapeHtml(NEGOCIO.pie)}</div>
      </div>`;
  }

  // HTML autocontenido (con CSS embebido y logo en data URI) para convertir a PDF en Apps Script
  function buildPdfHtml(nota, lineas, pago) {
    const inner = ticketHTML(nota, lineas, pago, null, window.LOGO_DATAURI || NEGOCIO.logo);
    const css = `
      *{box-sizing:border-box} body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#000;font-weight:700}
      .tk{width:76mm;margin:0 auto;font-size:15px;line-height:1.45}
      .tk-logo{display:block;margin:0 auto 6px;max-width:34mm;max-height:34mm;filter:grayscale(1) contrast(1.35)}
      .tk-nom{text-align:center;font-weight:800;font-size:19px}
      .tk-fiscal{text-align:center;font-size:12px;font-weight:600;margin-top:3px}
      .tk-titulo{text-align:center;font-weight:800;font-size:16px;margin:3px 0}
      .tk-sep{border-top:2px solid #000;margin:6px 0}
      .tk-row{display:flex;justify-content:space-between;gap:8px}
      .tk-total{font-weight:800;font-size:19px;border-top:2px solid #000;margin-top:4px;padding-top:4px}
      .tk-tabla{width:100%;border-collapse:collapse}
      .tk-tabla th{text-align:left;font-size:12px;font-weight:800;border-bottom:2px solid #000;padding-bottom:2px}
      .tk-tabla td{vertical-align:top;padding:2px 0;font-weight:700}
      .tk-tabla .tu{text-align:center;width:30px}.tk-tabla .tp{text-align:right;white-space:nowrap;width:70px}
      .tk .tmod{font-size:13px;font-weight:600}.tk-pie{text-align:center;margin-top:10px;font-weight:800;font-size:15px}`;
    return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${inner}</body></html>`;
  }

  function imprimir(html) {
    const cont = $('#ticketPrint');
    cont.innerHTML = html;
    document.body.classList.add('imprimiendo');
    const limpiar = () => { document.body.classList.remove('imprimiendo'); window.removeEventListener('afterprint', limpiar); };
    window.addEventListener('afterprint', limpiar);
    setTimeout(() => window.print(), 60);
  }

  function imprimirNotaActual() {
    if (!S.notaActual || !S.lineas.length) { toast('La nota está vacía'); return; }
    // usa el descuento actual del carrito
    const nota = { ...S.notaActual, desc_pct: Number($('#descPct').value) };
    imprimir(ticketHTML(nota, S.lineas, null, 'NOTA DE CONSUMO'));
  }

  function imprimirTicketCobrado() {
    if (!S._ultimoCobro) return;
    const c = S._ultimoCobro;
    imprimir(ticketHTML(c.nota, c.lineas, c.pago, null));
  }

  // Comanda para cocina: sin precios ni datos fiscales, solo el pedido
  function comandaHTML(nota, lineas) {
    const filas = lineas.map((l) => {
      const m = modsTexto(l);
      return `<div class="cmd-item"><span class="cmd-uds">${l.uds}×</span>
        <span class="cmd-nom">${escapeHtml(l.item)}${m ? `<div class="cmd-mod">${escapeHtml(m)}</div>` : ''}</span></div>`;
    }).join('');
    return `<div class="tk cmd">
      <div class="cmd-titulo">COMANDA</div>
      <div class="tk-row"><span>Nota #${nota.nfactura}</span><span>${fechaTicket(Date.now())}</span></div>
      <div class="tk-row"><span>Mesa: <b>${escapeHtml(nota.mesa)}</b></span><span>${escapeHtml(nota.atendio || '')}</span></div>
      <div class="tk-sep"></div>
      ${filas}
    </div>`;
  }
  function imprimirComandaActual() {
    if (!S.notaActual || !S.lineas.length) { toast('La nota está vacía'); return; }
    imprimir(comandaHTML(S.notaActual, S.lineas));
  }

  async function cancelarNota() {
    if (!S.notaActual) return;
    if (!confirm('¿Cancelar la nota #' + S.notaActual.nfactura + '? Se eliminarán sus productos.')) return;
    for (const l of S.lineas) { await DB.del('lineas', l.id); sync('ventas', 'delete', l); }
    S.notaActual.estado = 'Cancelada'; S.notaActual.updated = Date.now();
    await DB.put('notas', S.notaActual);
    sync('notas', 'upsert', S.notaActual);
    toast('Nota cancelada');
    S.notaActual = null; S.lineas = [];
    await renderNotas();
    mostrar('notas');
  }

  // ---------- editar datos de nota ----------
  async function editarNota() {
    $('#dlgNotaTitulo').textContent = 'Editar nota #' + S.notaActual.nfactura;
    $('#inpFolio').value = S.notaActual.nfactura;
    $('#inpMesa').value = S.notaActual.mesa;
    $('#inpAtendio').value = S.notaActual.atendio || '';
    await llenarMeseros();
    const dlg = $('#dlgNota');
    dlg.returnValue = '';
    dlg.showModal();
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'ok') return;
      const nuevoNf = parseInt($('#inpFolio').value, 10);
      const viejoNf = S.notaActual.nfactura;
      if (!nuevoNf || nuevoNf < 1) { toast('N° de nota inválido'); return; }
      if (nuevoNf !== viejoNf) {
        if (await DB.get('notas', nuevoNf)) { toast('Ya existe la nota #' + nuevoNf); return; }
        await migrarFolio(viejoNf, nuevoNf);
      }
      S.notaActual.mesa = $('#inpMesa').value.trim() || 'S/M';
      S.notaActual.atendio = $('#inpAtendio').value.trim();
      S.notaActual.updated = Date.now();
      await DB.put('notas', S.notaActual);
      sync('notas', 'upsert', S.notaActual);
      $('#cNfactura').textContent = '#' + S.notaActual.nfactura;
      $('#cMesa').textContent = S.notaActual.mesa;
      $('#cAtendio').textContent = S.notaActual.atendio || 'S/N';
    };
  }

  // Cambia el número de nota (folio): migra líneas y pago, borra el viejo. Sincroniza.
  async function migrarFolio(viejoNf, nuevoNf) {
    const nota = await DB.get('notas', viejoNf);
    const lineas = await DB.byIndex('lineas', 'nfactura', viejoNf);
    const pago = await DB.get('pagos', viejoNf);
    const nueva = { ...nota, nfactura: nuevoNf, updated: Date.now() };
    await DB.put('notas', nueva); sync('notas', 'upsert', nueva);
    for (const l of lineas) { l.nfactura = nuevoNf; l.updated = Date.now(); await DB.put('lineas', l); sync('ventas', 'upsert', l); }
    if (pago) {
      const np = { ...pago, nfactura: nuevoNf };
      await DB.put('pagos', np); sync('pagos', 'upsert', np);
      await DB.del('pagos', viejoNf); sync('pagos', 'delete', { nfactura: viejoNf });
    }
    await DB.del('notas', viejoNf); sync('notas', 'delete', { nfactura: viejoNf });
    if (nuevoNf > (await DB.getMeta('folio', 0))) await DB.setMeta('folio', nuevoNf);
    // recargar estado en memoria a la nueva nota + sus líneas
    S.notaActual = await DB.get('notas', nuevoNf);
    S.lineas = (await DB.byIndex('lineas', 'nfactura', nuevoNf)).sort((a, b) => a.fecha - b.fecha);
  }

  async function llenarMeseros() {
    const notas = await DB.all('notas');
    const set = [...new Set(notas.map((n) => n.atendio).filter(Boolean))];
    $('#meseros').innerHTML = set.map((m) => `<option value="${escapeHtml(m)}">`).join('');
  }

  // ============================================================
  //  VISTA: PRODUCTOS (catálogo / fotos)
  // ============================================================
  let _prodEnEdicion = null;

  async function renderProductosAdmin() {
    const q = ($('#buscarProd').value || '').trim().toLowerCase();
    let prods = await DB.all('productos');
    if (q) prods = prods.filter((p) => p.nombre.toLowerCase().includes(q));
    prods.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    const cont = $('#listaProductos');
    cont.innerHTML = '';
    for (const p of prods) {
      const row = document.createElement('div');
      row.className = 'prod-row' + (p.activo ? '' : ' inactivo');
      row.innerHTML = `
        <div class="pr-foto">${fotoHtml(p)}</div>
        <div class="pr-info">
          <div class="pr-nombre">${escapeHtml(p.nombre)}</div>
          <div class="pr-meta">${escapeHtml(p.categoria)} · ${money(p.precio)}${p.activo ? '' : ' · inactivo'}</div>
        </div>
        <button class="btn ghost pr-edit">Editar</button>`;
      row.querySelector('.pr-edit').onclick = () => editarProducto(p.id);
      cont.appendChild(row);
    }
    if (!prods.length) cont.innerHTML = '<p class="vacio">Sin productos.</p>';
  }

  async function llenarCategorias() {
    const prods = await DB.all('productos');
    const cats = [...new Set(prods.map((p) => p.categoria).filter(Boolean))].sort();
    $('#cats').innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}">`).join('');
  }

  async function editarProducto(id) {
    const p = id ? await DB.get('productos', id) : { id: uid(), nombre: '', precio: 0, categoria: '', foto: '', activo: true, ctrl_inv: false, existencia: 0 };
    _prodEnEdicion = { ...p };
    $('#dlgProdTitulo').textContent = id ? 'Editar producto' : 'Nuevo producto';
    $('#epNombre').value = p.nombre;
    $('#epPrecio').value = p.precio || '';
    $('#epCategoria').value = p.categoria || '';
    $('#epActivo').checked = p.activo !== false;
    pintarFotoEdit();
    await llenarCategorias();
    const dlg = $('#dlgProd');
    dlg.returnValue = '';
    dlg.showModal();
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'ok') return;
      _prodEnEdicion.nombre = $('#epNombre').value.trim();
      _prodEnEdicion.precio = parseFloat($('#epPrecio').value) || 0;
      _prodEnEdicion.categoria = $('#epCategoria').value.trim() || 'Otros';
      _prodEnEdicion.activo = $('#epActivo').checked;
      if (!_prodEnEdicion.nombre) { toast('Falta el nombre'); return; }
      await DB.put('productos', _prodEnEdicion);
      sync('productos', 'upsert', _prodEnEdicion);
      toast('Producto guardado');
      await renderProductosAdmin();
    };
  }

  function pintarFotoEdit() {
    const cont = $('#peFoto');
    cont.innerHTML = '';
    if (_prodEnEdicion.foto) {
      const img = document.createElement('img');
      img.src = _prodEnEdicion.foto;
      cont.appendChild(img);
    } else {
      cont.appendChild(placeholder(_prodEnEdicion.nombre || '?'));
    }
    $('#btnQuitarFoto').hidden = !_prodEnEdicion.foto;
  }

  // redimensiona la foto a máx 500px y la guarda como dataURL (ligera, offline)
  function procesarFoto(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const max = 500;
        let { width: w, height: h } = img;
        if (w > h && w > max) { h = Math.round(h * max / w); w = max; }
        else if (h > max) { w = Math.round(w * max / h); h = max; }
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  // ============================================================
  //  CONSULTAR PRECIOS (solo lectura)
  // ============================================================
  async function renderPrecios() {
    const q = ($('#buscarPrecio').value || '').toLowerCase().trim();
    let prods = (await DB.all('productos')).filter((p) => p.activo);
    if (q) prods = prods.filter((p) => p.nombre.toLowerCase().includes(q));
    prods.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    const cont = $('#listaPrecios');
    cont.innerHTML = '';
    for (const p of prods) {
      const row = document.createElement('div');
      row.className = 'precio-row';
      row.innerHTML = `<div class="pr-foto">${fotoHtml(p)}</div>
        <div class="precio-nom">${escapeHtml(p.nombre)}<div class="precio-cat">${escapeHtml(p.categoria)}</div></div>
        <div class="precio-val">${money(p.precio)}</div>`;
      cont.appendChild(row);
    }
    if (!prods.length) cont.innerHTML = '<p class="vacio">Sin resultados.</p>';
  }

  // ============================================================
  //  HISTORIAL (notas pagadas / canceladas)
  // ============================================================
  async function renderHistorial() {
    const q = ($('#buscarHist').value || '').toLowerCase().trim();
    let notas = (await DB.all('notas')).filter((n) => n.estado === 'Cobrada' || n.estado === 'Cancelada');
    notas.sort((a, b) => b.nfactura - a.nfactura);
    if (q) notas = notas.filter((n) => ('' + n.nfactura).includes(q) || (n.mesa || '').toLowerCase().includes(q) || (n.atendio || '').toLowerCase().includes(q));
    notas = notas.slice(0, 100);
    const cont = $('#listaHistorial');
    cont.innerHTML = '';
    for (const n of notas) {
      const est = n.estado === 'Cancelada' ? 'cancel' : 'cobr';
      const row = document.createElement('div');
      row.className = 'hist-row';
      row.innerHTML = `
        <div class="h-main">
          <div class="h-top"><b>#${n.nfactura}</b> · Mesa ${escapeHtml(n.mesa)} <span class="h-est ${est}">${n.estado}</span></div>
          <div class="h-sub">${n.fecha} · ${escapeHtml(n.atendio || '')}${n.metodo ? ' · ' + escapeHtml(n.metodo) : ''}</div>
        </div>
        <div class="h-tot">${money(n.total)}</div>
        <div class="h-acc">
          <button class="btn ghost mini" data-a="ticket" title="Reimprimir">🖨️</button>
          <button class="btn ghost mini" data-a="reabrir">Reabrir</button>
          <button class="btn ghost mini hdel" data-a="borrar" title="Eliminar">🗑</button>
        </div>`;
      row.querySelector('[data-a=ticket]').onclick = () => reimprimirNota(n.nfactura);
      row.querySelector('[data-a=reabrir]').onclick = () => reabrirNota(n.nfactura);
      row.querySelector('[data-a=borrar]').onclick = () => eliminarNotaHist(n.nfactura);
      cont.appendChild(row);
    }
    if (!notas.length) cont.innerHTML = '<p class="vacio">Sin notas en el historial.</p>';
  }

  async function reabrirNota(nfactura) {
    if (!confirm('¿Reabrir la nota #' + nfactura + '?\nVolverá a "Notas abiertas" para editarla o cobrarla de nuevo. Se quitará el pago registrado.')) return;
    const nota = await DB.get('notas', nfactura);
    if (!nota) return;
    const lineas = await DB.byIndex('lineas', 'nfactura', nfactura);
    const pago = await DB.get('pagos', nfactura);
    if (pago) { await DB.del('pagos', nfactura); sync('pagos', 'delete', { nfactura }); }
    for (const l of lineas) { l.estado = 'Ordenado'; l.updated = Date.now(); await DB.put('lineas', l); sync('ventas', 'upsert', l); }
    nota.estado = 'Abierta'; nota.metodo = ''; nota.updated = Date.now();
    await DB.put('notas', nota); sync('notas', 'upsert', nota);
    toast('Nota #' + nfactura + ' reabierta');
    await cargarNota(nfactura);
  }

  async function eliminarNotaHist(nfactura) {
    if (!confirm('¿ELIMINAR la nota #' + nfactura + ' de forma permanente?\nSe borrará del sistema y de la hoja al sincronizar. No se puede deshacer.')) return;
    const lineas = await DB.byIndex('lineas', 'nfactura', nfactura);
    for (const l of lineas) { await DB.del('lineas', l.id); sync('ventas', 'delete', l); }
    const pago = await DB.get('pagos', nfactura);
    if (pago) { await DB.del('pagos', nfactura); sync('pagos', 'delete', { nfactura }); }
    await DB.del('notas', nfactura); sync('notas', 'delete', { nfactura });
    toast('Nota #' + nfactura + ' eliminada');
    await renderHistorial();
  }

  async function reimprimirNota(nfactura) {
    const nota = await DB.get('notas', nfactura);
    const lineas = (await DB.byIndex('lineas', 'nfactura', nfactura)).sort((a, b) => a.fecha - b.fecha);
    const pago = await DB.get('pagos', nfactura);
    if (!nota) return;
    imprimir(ticketHTML(nota, lineas, pago || null, null));
  }

  // ============================================================
  //  CORTE DE CAJA
  // ============================================================
  async function calcVentasDia(fechaStr) {
    const notas = await DB.all('notas');
    const pagos = await DB.all('pagos');
    const pById = Object.fromEntries(pagos.map((p) => [p.nfactura, p]));
    const cobradas = notas.filter((n) => n.estado === 'Cobrada' && n.fecha === fechaStr);
    const canceladas = notas.filter((n) => n.estado === 'Cancelada' && n.fecha === fechaStr).length;
    let total = 0, ef = 0, tar = 0, tr = 0, desc = 0, prop = 0;
    for (const n of cobradas) {
      const p = pById[n.nfactura]; if (!p) continue;
      total += p.total || 0; ef += p.efectivo || 0; tar += p.tarjeta || 0; tr += p.transferencia || 0;
      desc += p.descuento || 0; prop += p.propina || 0;
    }
    return { total, ef, tar, tr, desc, prop, nNotas: cobradas.length, canceladas };
  }

  async function renderCorte() {
    const f = hoy();
    $('#corteFecha').textContent = f;
    const v = await calcVentasDia(f);
    S._corteVentas = v;
    const g = await DB.get('cortes', f);
    $('#corteApertura').value = g ? g.apertura : (await DB.getMeta('apertura_hoy_v', '') || '');
    $('#corteOtros').value = g ? (g.otros || '') : '';
    $('#corteMotivo').value = g ? (g.motivo || '') : '';
    $('#corteResumen').innerHTML = `
      <div class="row"><span>Notas cobradas</span><b>${v.nNotas}</b></div>
      <div class="row"><span>Total de ventas</span><b>${money(v.total)}</b></div>
      <div class="row"><span>💵 Efectivo</span><span>${money(v.ef)}</span></div>
      <div class="row"><span>💳 Tarjeta</span><span>${money(v.tar)}</span></div>
      <div class="row"><span>📲 Transferencia</span><span>${money(v.tr)}</span></div>
      <div class="row"><span>Descuentos</span><span>${money(v.desc)}</span></div>
      <div class="row"><span>Propinas</span><span>${money(v.prop)}</span></div>
      <div class="row"><span>Notas canceladas</span><span>${v.canceladas}</span></div>`;
    recalcCorte();
    await renderCorteHist();
  }
  function recalcCorte() {
    const ap = parseFloat($('#corteApertura').value) || 0;
    const otros = parseFloat($('#corteOtros').value) || 0;
    const v = S._corteVentas || { ef: 0 };
    $('#corteEntregar').textContent = money(round2(ap + v.ef - otros));
  }
  async function guardarCorte() {
    const f = hoy();
    const v = S._corteVentas || await calcVentasDia(f);
    const ap = parseFloat($('#corteApertura').value) || 0;
    const otros = parseFloat($('#corteOtros').value) || 0;
    const corte = {
      fecha: f, apertura: ap, total_ventas: v.total, v_efectivo: v.ef, v_tarjeta: v.tar, v_transfer: v.tr,
      descuentos: v.desc, entregar: round2(ap + v.ef - otros), otros, motivo: $('#corteMotivo').value.trim(),
      canceladas: v.canceladas, updated: Date.now(),
    };
    await DB.put('cortes', corte);
    sync('cortes', 'upsert', corte);
    await DB.setMeta('apertura_hoy_v', ap);
    toast('Corte del día guardado');
    await renderCorteHist();
  }
  async function renderCorteHist() {
    const cortes = (await DB.all('cortes')).sort((a, b) => (a.fecha < b.fecha ? 1 : -1)).slice(0, 7);
    $('#corteHist').innerHTML = cortes.map((c) =>
      `<div class="ch-row"><span>${c.fecha}</span><span>${money(c.total_ventas)}</span><b>${money(c.entregar)}</b></div>`).join('')
      || '<p class="vacio small">Aún no hay cortes.</p>';
  }

  // ============================================================
  //  REPORTES
  // ============================================================
  function setRangoRep(desde, hasta) { $('#repDesde').value = desde; $('#repHasta').value = hasta; }

  function rangoFechas(desde, hasta) {
    const out = []; const d = new Date(desde + 'T00:00:00'); const h = new Date(hasta + 'T00:00:00'); let g = 0;
    while (d <= h && g < 400) { out.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')); d.setDate(d.getDate() + 1); g++; }
    return out;
  }
  function svgBarras(serie, titulo) {
    const W = 340, H = 170, pad = 22, bottom = 26, top = 14;
    const max = Math.max(1, ...serie.map((s) => s.val));
    const n = serie.length, gap = (W - pad * 2) / n, bw = gap * 0.62;
    const step = n <= 12 ? 1 : Math.ceil(n / 12);
    const bars = serie.map((s, i) => {
      const x = pad + gap * i + (gap - bw) / 2;
      const bh = (s.val / max) * (H - top - bottom);
      const y = H - bottom - bh;
      const lbl = (i % step === 0)
        ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - bottom + 12}" font-size="8" text-anchor="middle" fill="#6b7a90">${s.etq}</text>` : '';
      const val = s.val > 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" font-size="8" text-anchor="middle" fill="#6b7a90">${Math.round(s.val)}</text>` : '';
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="2" fill="#157b8a"/>${val}${lbl}`;
    }).join('');
    return `<div class="rep-graf"><div class="rep-graf-t">${titulo}</div>
      <svg viewBox="0 0 ${W} ${H}" class="rep-svg" preserveAspectRatio="xMidYMid meet">
      <line x1="${pad}" y1="${H - bottom}" x2="${W - pad + 6}" y2="${H - bottom}" stroke="#c1c9d3"/>${bars}</svg></div>`;
  }
  function svgBarrasH(items, titulo) {
    const max = Math.max(1, ...items.map((s) => s.val));
    const rows = items.map((s) => {
      const pct = (s.val / max) * 100;
      return `<div class="hb-row"><span class="hb-lbl">${s.etq}</span>
        <span class="hb-track"><span class="hb-fill" style="width:${pct.toFixed(1)}%;background:${s.col}"></span></span>
        <span class="hb-val">${money(s.val)}</span></div>`;
    }).join('');
    return `<div class="rep-graf"><div class="rep-graf-t">${titulo}</div><div class="hb-wrap">${rows}</div></div>`;
  }
  async function renderReportes() {
    const desde = $('#repDesde').value, hasta = $('#repHasta').value;
    if (!desde || !hasta) return;
    const notas = await DB.all('notas');
    const pagos = await DB.all('pagos');
    const lineas = await DB.all('lineas');
    const pById = Object.fromEntries(pagos.map((p) => [p.nfactura, p]));
    const cobradas = notas.filter((n) => n.estado === 'Cobrada' && n.fecha >= desde && n.fecha <= hasta);
    const setNf = new Set(cobradas.map((n) => n.nfactura));
    let total = 0, ef = 0, tar = 0, tr = 0, prop = 0, desc = 0;
    for (const n of cobradas) { const p = pById[n.nfactura]; if (!p) continue; total += p.total || 0; ef += p.efectivo || 0; tar += p.tarjeta || 0; tr += p.transferencia || 0; prop += p.propina || 0; desc += p.descuento || 0; }
    const prom = cobradas.length ? total / cobradas.length : 0;
    $('#repResumen').innerHTML = `
      <div class="rep-card"><span>Ventas</span><b>${money(total)}</b></div>
      <div class="rep-card"><span>Notas</span><b>${cobradas.length}</b></div>
      <div class="rep-card"><span>Ticket prom.</span><b>${money(prom)}</b></div>
      <div class="rep-card"><span>💵 Efectivo</span><b>${money(ef)}</b></div>
      <div class="rep-card"><span>💳 Tarjeta</span><b>${money(tar)}</b></div>
      <div class="rep-card"><span>📲 Transfer.</span><b>${money(tr)}</b></div>
      <div class="rep-card"><span>Propinas</span><b>${money(prop)}</b></div>
      <div class="rep-card"><span>Descuentos</span><b>${money(desc)}</b></div>`;
    // ---- gráficas ----
    // ventas por día en el rango
    const porDia = {};
    for (const n of cobradas) { const p = pById[n.nfactura]; if (!p) continue; porDia[n.fecha] = (porDia[n.fecha] || 0) + (p.total || 0); }
    const dias = rangoFechas(desde, hasta);
    const serie = dias.map((d) => ({ etq: d.slice(5), val: porDia[d] || 0 }));
    const gDia = serie.length > 1
      ? svgBarras(serie, 'Ventas por día')
      : `<div class="rep-graf"><div class="rep-graf-t">Ventas del día</div><div class="rep-1dia">${money(total)}</div></div>`;
    const gMet = svgBarrasH([
      { etq: 'Efectivo', val: ef, col: '#2e9e6b' },
      { etq: 'Tarjeta', val: tar, col: '#157b8a' },
      { etq: 'Transferencia', val: tr, col: '#6198a8' },
    ], 'Ventas por método');
    $('#repGraficas').innerHTML = gDia + gMet;

    // top productos por unidades
    const agg = {};
    for (const l of lineas) {
      if (!setNf.has(l.nfactura)) continue;
      if (!agg[l.item]) agg[l.item] = { uds: 0, importe: 0 };
      agg[l.item].uds += l.uds; agg[l.item].importe += l.importe;
    }
    const top = Object.entries(agg).sort((a, b) => b[1].uds - a[1].uds).slice(0, 15);
    $('#repTop').innerHTML = '<h3 class="rep-top-t">Productos más vendidos</h3>' + (top.map(([nom, d], i) =>
      `<div class="rep-top-row"><span class="rtn">${i + 1}. ${escapeHtml(nom)}</span><span>${d.uds} uds</span><b>${money(d.importe)}</b></div>`).join('') || '<p class="vacio small">Sin ventas en el rango.</p>');
  }

  // ============================================================
  //  SEPARAR CUENTA
  // ============================================================
  function abrirSeparar() {
    if (!S.notaActual || S.lineas.length < 2) { toast('Necesitas al menos 2 productos para separar'); return; }
    const cont = $('#sepLineas');
    cont.innerHTML = '';
    S.lineas.forEach((l, i) => {
      const row = document.createElement('label');
      row.className = 'sep-row';
      row.innerHTML = `<input type="checkbox" data-i="${i}"><span class="sep-nom">${escapeHtml(l.item)} ×${l.uds}</span><span>${money(l.importe)}</span>`;
      cont.appendChild(row);
    });
    cont.querySelectorAll('input').forEach((c) => c.onchange = recalcSeparar);
    recalcSeparar();
    const dlg = $('#dlgSeparar');
    dlg.returnValue = '';
    dlg.showModal();
    dlg.onclose = async () => { if (dlg.returnValue === 'ok') await ejecutarSeparar(); };
  }
  function recalcSeparar() {
    let nueva = 0, queda = 0;
    $('#sepLineas').querySelectorAll('input').forEach((c) => {
      const l = S.lineas[+c.dataset.i];
      if (c.checked) nueva += l.importe; else queda += l.importe;
    });
    $('#sepTotalNueva').textContent = money(nueva);
    $('#sepTotalQueda').textContent = money(queda);
  }
  async function ejecutarSeparar() {
    const sel = [...$('#sepLineas').querySelectorAll('input:checked')].map((c) => S.lineas[+c.dataset.i]);
    if (!sel.length || sel.length === S.lineas.length) { toast('Elige algunos productos, no todos'); return; }
    const nfactura = await nuevoFolio();
    const tn = calcTotales(sel, 0);
    const nueva = {
      nfactura, fecha: hoy(), mesa: S.notaActual.mesa, atendio: S.notaActual.atendio,
      estado: 'Abierta', subtotal: tn.subtotal, iva: tn.iva, desc_pct: 0, descuento: 0, total: tn.total, updated: Date.now(),
    };
    await DB.put('notas', nueva); sync('notas', 'upsert', nueva);
    for (const l of sel) { l.nfactura = nfactura; l.updated = Date.now(); await DB.put('lineas', l); sync('ventas', 'upsert', l); }
    S.lineas = S.lineas.filter((l) => !sel.includes(l));
    await guardarTotalesNota();
    renderLineas();
    await refreshInfo();
    toast('Cuenta separada → nueva nota #' + nfactura);
  }

  // ---------- info / red ----------
  async function refreshInfo() {
    $('#infoFolio').textContent = await DB.getMeta('folio', FOLIO_INICIAL);
    $('#infoProd').textContent = await DB.count('productos');
  }
  function actualizarRed() {
    const on = navigator.onLine;
    const b = $('#netBadge');
    b.style.color = on ? '#22c55e' : '#f59e0b';
    b.title = on ? 'En línea' : 'Sin conexión (los cambios se guardan local)';
  }

  // ---------- drawer ----------
  function abrirDrawer() { $('#drawer').hidden = false; }
  function cerrarDrawer() { $('#drawer').hidden = true; }

  async function abrirSync() {
    cerrarDrawer();
    await Sync.cargarCfg();
    const c = Sync.cfg;
    $('#syncUrl').value = c.url || '';
    $('#syncToken').value = c.token || 'yolo-tpv-2026';
    $('#syncOn').checked = !!c.on;
    const n = await Sync.pendientes();
    $('#syncEstado').textContent = c.on ? ('Pendientes por enviar: ' + n) : 'Sincronización desactivada';
    $('#dlgSync').returnValue = '';
    $('#dlgSync').showModal();
  }

  // ---------- imágenes ----------
  // product.foto puede ser: ruta relativa (assets/productos/<id>.jpg) o dataURL (foto tomada).
  function fotoHtml(p) {
    if (p.foto) return `<img src="${p.foto}" alt="" loading="lazy" onerror="this.parentNode.innerHTML='' ;this.parentNode.appendChild(window.__ph('${escapeAttr(p.nombre)}'))">`;
    return placeholder(p.nombre).outerHTML;
  }
  function placeholder(nombre) {
    const div = document.createElement('div');
    div.className = 'ph';
    const ini = (nombre || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    let h = 0; for (const c of nombre || '') h = (h * 31 + c.charCodeAt(0)) % 360;
    div.style.background = `hsl(${h} 45% 88%)`;
    div.style.color = `hsl(${h} 45% 35%)`;
    div.textContent = ini;
    return div;
  }
  window.__ph = placeholder; // usado por onerror

  // ---------- helpers ----------
  function sync(tabla, op, data) { if (window.Sync) Sync.enqueue(tabla, op, { ...data }); }
  // Folio único entre dispositivos: siguiente al máximo que exista localmente
  // (tras sincronizar, local ya incluye las notas de los demás dispositivos).
  async function nuevoFolio() {
    const notas = await DB.all('notas');
    const max = notas.reduce((m, n) => Math.max(m, Number(n.nfactura) || 0), FOLIO_INICIAL - 1);
    const nuevo = max + 1;
    await DB.setMeta('folio', nuevo);
    return nuevo;
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }
  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- bind ----------
  function bindUI() {
    $('#btnNueva').onclick = nuevaNota;
    $('#btnBack').onclick = () => { S.notaActual = null; S.lineas = []; renderNotas(); mostrar('notas'); };
    $('#btnCobrar').onclick = abrirCobro;
    $('#btnCancelarNota').onclick = cancelarNota;
    $('#btnEditarNota').onclick = editarNota;
    $('#buscar').oninput = renderProductos;
    $('#descPct').onchange = async () => { await guardarTotalesNota(); renderLineas(); };
    $('#btnImprimir').onclick = imprimirNotaActual;
    $('#carritoHandle').onclick = () => $('.carrito').classList.toggle('expandida');
    // cobro: descuento, propina, montos de pago
    $('#coDescPct').onchange = recalcCobro;
    $('#pagEfectivo').oninput = recalcCobro;
    $('#pagTarjeta').oninput = recalcCobro;
    $('#pagTransfer').oninput = recalcCobro;
    $$('.psplit-lbl').forEach((b) => b.onclick = () => llenarMetodo(b.dataset.t));
    // no permitir confirmar si lo pagado no cubre el total
    $('#btnConfirmarCobro').addEventListener('click', (e) => {
      const { due } = _dueCobro();
      const pagado = (parseFloat($('#pagEfectivo').value) || 0) + (parseFloat($('#pagTarjeta').value) || 0) + (parseFloat($('#pagTransfer').value) || 0);
      if (round2(pagado) < due - 0.001) { e.preventDefault(); toast('El pago no cubre el total (faltan ' + money(due - pagado) + ')'); }
    });
    // post-cobro
    $('#btnImprimirTicket').onclick = () => { $('#dlgCobrado').close(); imprimirTicketCobrado(); };
    $('#btnCerrarCobrado').onclick = () => $('#dlgCobrado').close();
    $('#btnMenu').onclick = abrirDrawer;
    $('#drawer').onclick = (e) => { if (e.target.id === 'drawer') cerrarDrawer(); };
    $$('.drawer-item').forEach((b) => b.onclick = async () => {
      const nav = b.dataset.nav;
      cerrarDrawer();
      if (nav === 'notas') { await renderNotas(); mostrar('notas'); if (window.Sync) Sync.sincronizar(); }
      else if (nav === 'historial') { await renderHistorial(); mostrar('historial'); if (window.Sync) Sync.sincronizar(); }
      else if (nav === 'productos') { await renderProductosAdmin(); mostrar('productos'); }
      else if (nav === 'precios') { await renderPrecios(); mostrar('precios'); }
      else if (nav === 'corte') { await renderCorte(); mostrar('corte'); }
      else if (nav === 'reportes') { const h = hoy(); if (!$('#repDesde').value) setRangoRep(h, h); await renderReportes(); mostrar('reportes'); }
      else if (nav === 'sync') abrirSync();
      else if (nav === 'acerca') $('#dlgAbout').showModal();
      else toast('“' + b.textContent.trim() + '” llega pronto');
    });

    // ----- precios / corte / reportes / comanda / separar / about -----
    $('#buscarPrecio').oninput = renderPrecios;
    $('#buscarHist').oninput = renderHistorial;
    $('#btnComanda').onclick = imprimirComandaActual;
    $('#btnSeparar').onclick = abrirSeparar;
    $('#corteApertura').oninput = recalcCorte;
    $('#corteOtros').oninput = recalcCorte;
    $('#btnGuardarCorte').onclick = guardarCorte;
    $('#btnRepGenerar').onclick = renderReportes;
    $$('.rep-quick .chip').forEach((c) => c.onclick = async () => {
      const h = new Date(); const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      let desde = fmt(h);
      if (c.dataset.rango === 'semana') { const d = new Date(); d.setDate(d.getDate() - 6); desde = fmt(d); }
      else if (c.dataset.rango === 'mes') { const d = new Date(); d.setDate(1); desde = fmt(d); }
      setRangoRep(desde, fmt(h)); await renderReportes();
    });
    $('#btnCerrarAbout').onclick = () => $('#dlgAbout').close();

    // ----- sincronización -----
    $('#btnProbarSync').onclick = async () => {
      await Sync.guardarCfg($('#syncUrl').value, $('#syncToken').value, $('#syncOn').checked);
      $('#syncEstado').textContent = 'Enviando prueba…';
      const ok = await Sync.probar();
      $('#syncEstado').textContent = ok ? '✓ Servidor alcanzado (revisa que aparezcan las pestañas en tu Sheet)' : '✕ No se pudo contactar (revisa la URL)';
    };
    $('#btnSubirTodo').onclick = async () => {
      await Sync.guardarCfg($('#syncUrl').value, $('#syncToken').value, true);
      $('#syncOn').checked = true;
      $('#syncEstado').textContent = 'Subiendo todo…';
      await Sync.subirTodo();
      const n = await Sync.pendientes();
      $('#syncEstado').textContent = n > 0 ? ('Pendientes por enviar: ' + n) : '✓ Todo enviado';
    };
    $('#btnGuardarSync').addEventListener('click', async () => {
      await Sync.guardarCfg($('#syncUrl').value, $('#syncToken').value, $('#syncOn').checked);
      toast('Sincronización guardada');
    });

    // ----- productos / fotos -----
    $('#btnBack').addEventListener('click', () => mostrar('notas'));
    $('#buscarProd').oninput = renderProductosAdmin;
    $('#btnNuevoProd').onclick = () => editarProducto(null);
    $('#btnCambiarFoto').onclick = () => $('#fileFoto').click();
    $('#btnQuitarFoto').onclick = () => { _prodEnEdicion.foto = ''; pintarFotoEdit(); };
    $('#fileFoto').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        _prodEnEdicion.foto = await procesarFoto(f);
        pintarFotoEdit();
        toast('Foto lista (se guarda al tocar Guardar)');
      } catch { toast('No se pudo procesar la imagen'); }
      e.target.value = '';
    };
  }

  window.addEventListener('DOMContentLoaded', init);
})();
