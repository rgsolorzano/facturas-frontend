/* ==================================================================
   Procesador de Facturas con IA — frontend estático
   No contiene claves ni secretos: solo la URL pública del backend.
   ================================================================== */

/* ---------- CONFIGURACIÓN (único bloque que debes editar) --------- */

const API_BASE_URL = "https://rough-king-6080.multiboxes-peru.workers.dev/api/health";

const CONFIG = {
  MAX_FILES: 10,           // debe coincidir con el límite del backend
  MAX_FILE_SIZE_MB: 15,    // por archivo
  MAX_TOTAL_SIZE_MB: 40,   // suma de todos los archivos
  BATCH_SIZE: 3,           // facturas por petición (permite mostrar progreso real)
  REQUEST_TIMEOUT_MS: 300000,
};

/* ------------------------------- Estado -------------------------- */

const REVISION = "REVISIÓN MANUAL";
const FUENTES = ["Makro", "Agora", REVISION];
const COLUMNAS = {
  fecha: "Fecha",
  fuente: "Fuente",
  tipo: "Tipo",
  descripcion: "Descripción del producto",
  total: "Total",
};

const state = {
  files: [],        // { id, file, status: 'pendiente'|'procesando'|'procesado'|'error', error }
  rows: [],         // { id, archivo, fecha, fuente, tipo, descripcion, total, revision, edited:Set }
  facturas: [],
  errores: [],
  sort: { key: null, dir: 1 },
  processing: false,
  seq: 0,
};

const $ = (sel) => document.querySelector(sel);
const el = {
  dropzone: $("#dropzone"),
  fileInput: $("#fileInput"),
  btnSelect: $("#btnSelect"),
  filelist: $("#filelist"),
  fileItems: $("#fileItems"),
  fileCount: $("#fileCount"),
  btnClearFiles: $("#btnClearFiles"),
  btnProcess: $("#btnProcess"),
  progress: $("#progress"),
  uploadError: $("#uploadError"),
  limitsHint: $("#limitsHint"),
  status: $("#backendStatus"),
  resultsPanel: $("#resultsPanel"),
  exportPanel: $("#exportPanel"),
  notices: $("#notices"),
  gridBody: $("#gridBody"),
  grid: $("#grid"),
  search: $("#search"),
  filterFuente: $("#filterFuente"),
  filterRevision: $("#filterRevision"),
  rowCount: $("#rowCount"),
  visibleTotal: $("#visibleTotal"),
  exportFields: $("#exportFields"),
  btnSelectAll: $("#btnSelectAll"),
  btnSelectNone: $("#btnSelectNone"),
  withHeaders: $("#withHeaders"),
  btnCopy: $("#btnCopy"),
  fallbackArea: $("#fallbackArea"),
  toast: $("#toast"),
  sumFacturas: $("#sumFacturas"),
  sumProductos: $("#sumProductos"),
  sumRevision: $("#sumRevision"),
  sumErrores: $("#sumErrores"),
};

/* ------------------------------ Arranque ------------------------- */

el.limitsHint.textContent =
  `Solo PDF · máx. ${CONFIG.MAX_FILES} archivos · ${CONFIG.MAX_FILE_SIZE_MB} MB por archivo · ${CONFIG.MAX_TOTAL_SIZE_MB} MB en total`;

comprobarBackend();
registrarEventos();

async function comprobarBackend() {
  setStatus("checking", "Comprobando servicio…");
  try {
    const res = await fetch(`${API_BASE_URL}/api/health`, { method: "GET" });
    const data = await res.json();
    if (res.ok && data.success) {
      setStatus("ok", "Servicio disponible");
      if (data.limits) {
        CONFIG.MAX_FILES = data.limits.max_files ?? CONFIG.MAX_FILES;
        CONFIG.MAX_FILE_SIZE_MB = data.limits.max_file_size_mb ?? CONFIG.MAX_FILE_SIZE_MB;
        CONFIG.MAX_TOTAL_SIZE_MB = data.limits.max_total_size_mb ?? CONFIG.MAX_TOTAL_SIZE_MB;
        el.limitsHint.textContent =
          `Solo PDF · máx. ${CONFIG.MAX_FILES} archivos · ${CONFIG.MAX_FILE_SIZE_MB} MB por archivo · ${CONFIG.MAX_TOTAL_SIZE_MB} MB en total`;
      }
    } else {
      setStatus("error", "Servicio no disponible");
    }
  } catch (err) {
    console.error("[health]", err);
    setStatus("error", "Sin conexión con el servicio");
  }
}

function setStatus(estado, texto) {
  el.status.dataset.state = estado;
  el.status.querySelector(".status__text").textContent = texto;
}

/* ------------------------------ Eventos -------------------------- */

function registrarEventos() {
  el.btnSelect.addEventListener("click", (e) => { e.stopPropagation(); el.fileInput.click(); });
  el.dropzone.addEventListener("click", () => el.fileInput.click());
  el.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.fileInput.click(); }
  });
  el.fileInput.addEventListener("change", () => {
    agregarArchivos([...el.fileInput.files]);
    el.fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add("is-over"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove("is-over"); })
  );
  el.dropzone.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    agregarArchivos(files);
  });

  el.btnClearFiles.addEventListener("click", () => {
    if (state.processing) return;
    state.files = [];
    renderFiles();
  });

  el.btnProcess.addEventListener("click", procesar);

  el.search.addEventListener("input", renderGrid);
  el.filterFuente.addEventListener("change", renderGrid);
  el.filterRevision.addEventListener("change", renderGrid);

  el.grid.querySelectorAll(".th-sort").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      state.sort.dir = state.sort.key === key ? -state.sort.dir : 1;
      state.sort.key = key;
      el.grid.querySelectorAll(".th-sort").forEach((o) => delete o.dataset.dir);
      th.dataset.dir = state.sort.dir === 1 ? "asc" : "desc";
      renderGrid();
    });
  });

  el.btnSelectAll.addEventListener("click", () => toggleCampos(true));
  el.btnSelectNone.addEventListener("click", () => toggleCampos(false));
  el.btnCopy.addEventListener("click", copiar);
}

/* -------------------------- Gestión de archivos ------------------ */

function agregarArchivos(lista) {
  if (state.processing) return;
  el.uploadError.hidden = true;
  const errores = [];

  for (const file of lista) {
    const esPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
    if (!esPdf) { errores.push(`"${file.name}": solo se aceptan archivos PDF.`); continue; }
    if (file.size === 0) { errores.push(`"${file.name}": el archivo está vacío.`); continue; }
    if (file.size > CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024) {
      errores.push(`"${file.name}": supera ${CONFIG.MAX_FILE_SIZE_MB} MB.`); continue;
    }
    if (state.files.some((f) => f.file.name === file.name && f.file.size === file.size)) continue;
    if (state.files.length >= CONFIG.MAX_FILES) {
      errores.push(`Máximo ${CONFIG.MAX_FILES} archivos por procesamiento.`); break;
    }
    state.files.push({ id: `f${++state.seq}`, file, status: "pendiente", error: "" });
  }

  const total = state.files.reduce((a, f) => a + f.file.size, 0);
  if (total > CONFIG.MAX_TOTAL_SIZE_MB * 1024 * 1024) {
    errores.push(`El tamaño total supera ${CONFIG.MAX_TOTAL_SIZE_MB} MB. Quita algún archivo.`);
  }

  if (errores.length) {
    el.uploadError.textContent = errores.join(" ");
    el.uploadError.hidden = false;
  }
  renderFiles();
}

function renderFiles() {
  const n = state.files.length;
  el.filelist.hidden = n === 0;
  el.fileCount.textContent = `${n} ${n === 1 ? "archivo" : "archivos"} · ${formatoTamano(state.files.reduce((a, f) => a + f.file.size, 0))}`;
  el.btnClearFiles.disabled = state.processing;

  el.fileItems.innerHTML = "";
  for (const f of state.files) {
    const li = document.createElement("li");
    li.className = "fileitem";

    const nombre = document.createElement("span");
    nombre.className = "fileitem__name";
    nombre.textContent = f.file.name;
    nombre.title = f.file.name;

    const size = document.createElement("span");
    size.className = "fileitem__size";
    size.textContent = formatoTamano(f.file.size);

    const tag = document.createElement("span");
    tag.className = `tag tag--${f.status}`;
    tag.textContent = { pendiente: "Pendiente", procesando: "Procesando", procesado: "Procesado", error: "Error" }[f.status];

    const quitar = document.createElement("button");
    quitar.className = "iconbtn";
    quitar.type = "button";
    quitar.setAttribute("aria-label", `Quitar ${f.file.name}`);
    quitar.textContent = "×";
    quitar.disabled = state.processing;
    quitar.addEventListener("click", () => {
      state.files = state.files.filter((x) => x.id !== f.id);
      renderFiles();
    });

    li.append(nombre, size, tag, quitar);

    if (f.error) {
      const err = document.createElement("span");
      err.className = "fileitem__err";
      err.textContent = f.error;
      li.append(err);
    }
    el.fileItems.append(li);
  }

  el.btnProcess.disabled = state.processing || n === 0;
}

const formatoTamano = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/* --------------------------- Procesamiento ----------------------- */

async function procesar() {
  if (state.processing || state.files.length === 0) return;

  state.processing = true;
  state.rows = [];
  state.facturas = [];
  state.errores = [];
  el.uploadError.hidden = true;
  el.btnProcess.textContent = "Procesando...";
  el.btnProcess.disabled = true;
  el.progress.hidden = false;

  for (const f of state.files) { f.status = "pendiente"; f.error = ""; }
  renderFiles();

  const lotes = trocear(state.files, CONFIG.BATCH_SIZE);
  const totalArchivos = state.files.length;
  let hechos = 0;

  for (const lote of lotes) {
    lote.forEach((f) => { f.status = "procesando"; });
    renderFiles();
    el.progress.textContent = `Procesando factura ${Math.min(hechos + 1, totalArchivos)} de ${totalArchivos}`;

    try {
      const data = await enviarLote(lote);
      aplicarRespuesta(data, lote);
    } catch (err) {
      console.error("[lote]", err);
      for (const f of lote) {
        f.status = "error";
        f.error = err.message;
        state.errores.push({ archivo: f.file.name, message: err.message });
      }
    }

    hechos += lote.length;
    el.progress.textContent = `Procesando factura ${Math.min(hechos, totalArchivos)} de ${totalArchivos}`;
    renderFiles();
    renderResultados();
  }

  state.processing = false;
  el.btnProcess.textContent = "Procesar facturas";
  el.btnProcess.disabled = state.files.length === 0;
  el.progress.textContent = `Listo: ${totalArchivos} ${totalArchivos === 1 ? "archivo procesado" : "archivos procesados"}`;
  renderFiles();
  renderResultados();
}

async function enviarLote(lote) {
  const form = new FormData();
  for (const f of lote) form.append("files[]", f.file, f.file.name);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${API_BASE_URL}/api/facturas`, { method: "POST", body: form, signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error("El procesamiento tardó demasiado y se canceló. Prueba con menos archivos.");
    throw new Error("No se pudo contactar con el servicio. Comprueba tu conexión o que el backend esté desplegado y permita este dominio (CORS).");
  }
  clearTimeout(timer);

  let data = null;
  try { data = await res.json(); } catch (_) { /* respuesta no JSON */ }

  if (!res.ok || !data || data.success !== true) {
    const mapa = {
      403: "El servicio rechazó el origen de la petición. Revisa FRONTEND_ORIGIN en el Worker.",
      413: "Los archivos superan los límites permitidos.",
      415: "Formato de envío no admitido.",
      429: "Se alcanzó el límite de peticiones. Inténtalo de nuevo en unos minutos.",
    };
    throw new Error((data && data.message) || mapa[res.status] || `El servicio respondió con un error (${res.status}).`);
  }
  return data;
}

function aplicarRespuesta(data, lote) {
  const porNombre = new Map(lote.map((f) => [f.file.name, f]));

  for (const factura of data.facturas || []) {
    state.facturas.push(factura);
    const f = porNombre.get(factura.archivo);
    if (f) f.status = "procesado";
  }
  for (const err of data.errores || []) {
    state.errores.push({ archivo: err.archivo, message: err.message });
    const f = porNombre.get(err.archivo);
    if (f) { f.status = "error"; f.error = err.message; }
  }
  for (const r of data.registros || []) {
    state.rows.push({
      id: `r${++state.seq}`,
      archivo: r.archivo,
      fecha: r.fecha,
      fuente: r.fuente,
      tipo: r.tipo,
      descripcion: r.descripcion,
      total: r.total,
      revision: Boolean(r.requiere_revision),
      edited: new Set(),
    });
  }
  // Cualquier archivo del lote sin resultado ni error explícito
  for (const f of lote) {
    if (f.status === "procesando") { f.status = "error"; f.error = "El servicio no devolvió resultado para este archivo."; }
  }
}

const trocear = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/* ---------------------------- Resultados ------------------------- */

function renderResultados() {
  const hay = state.rows.length > 0 || state.errores.length > 0 || state.facturas.length > 0;
  el.resultsPanel.hidden = !hay;
  el.exportPanel.hidden = state.rows.length === 0;

  el.sumFacturas.textContent = state.facturas.length;
  el.sumProductos.textContent = state.rows.length;
  el.sumRevision.textContent = state.facturas.filter((f) => f.requiere_revision).length;
  el.sumErrores.textContent = state.errores.length;

  renderNotices();
  renderGrid();
}

function renderNotices() {
  el.notices.innerHTML = "";

  for (const e of state.errores) {
    const div = document.createElement("div");
    div.className = "notice notice--error";
    div.innerHTML = `<strong>${escapar(e.archivo)}</strong> — no se pudo procesar. `;
    div.append(document.createTextNode(e.message || ""));
    el.notices.append(div);
  }

  for (const f of state.facturas.filter((x) => x.requiere_revision)) {
    const div = document.createElement("div");
    div.className = "notice notice--warn";
    const dif = f.diferencia_total === null || f.diferencia_total === undefined
      ? "total de la factura no legible"
      : `diferencia ${Number(f.diferencia_total).toFixed(2)}`;
    div.innerHTML = `⚠ Revisión manual · <strong>${escapar(f.archivo)}</strong> — `;
    div.append(document.createTextNode(
      `suma de líneas ${Number(f.suma_lineas).toFixed(2)} vs total ${f.total_factura === null ? "—" : Number(f.total_factura).toFixed(2)} (${dif}). ${f.observacion || ""}`
    ));
    el.notices.append(div);
  }
}

function filasVisibles() {
  const q = el.search.value.trim().toLowerCase();
  const fuente = el.filterFuente.value;
  const soloRev = el.filterRevision.checked;

  let rows = state.rows.filter((r) => {
    if (fuente && r.fuente !== fuente) return false;
    if (soloRev && !r.revision) return false;
    if (!q) return true;
    return [r.fecha, r.fuente, r.tipo, r.descripcion, r.archivo, String(r.total)]
      .join(" ").toLowerCase().includes(q);
  });

  const { key, dir } = state.sort;
  if (key) {
    rows = [...rows].sort((a, b) => {
      if (key === "total") return (a.total - b.total) * dir;
      if (key === "fecha") return (claveFecha(a.fecha) - claveFecha(b.fecha)) * dir;
      return String(a[key]).localeCompare(String(b[key]), "es") * dir;
    });
  }
  return rows;
}

function claveFecha(f) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(f || "");
  return m ? Number(`${m[3]}${m[2]}${m[1]}`) : 0;
}

function renderGrid() {
  const rows = filasVisibles();
  el.gridBody.innerHTML = "";

  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.revision) tr.classList.add("is-revision");
    if (r.edited.size) tr.classList.add("is-edited");
    tr.title = r.archivo;

    tr.append(
      celda(r, "fecha"),
      celda(r, "fuente"),
      celda(r, "tipo"),
      celda(r, "descripcion", true),
      celda(r, "total")
    );
    el.gridBody.append(tr);
  }

  const suma = rows.reduce((a, r) => a + (Number(r.total) || 0), 0);
  el.visibleTotal.textContent = suma.toFixed(2);
  el.rowCount.textContent = `${rows.length} de ${state.rows.length} filas`;
}

function celda(row, campo, marcarRevision = false) {
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.className = "cell" + (campo === "total" ? " cell--num" : "");
  input.value = campo === "total" ? Number(row.total).toFixed(2) : row[campo];
  input.setAttribute("aria-label", `${COLUMNAS[campo]} de ${row.descripcion}`);
  if (row.edited.has(campo)) input.classList.add("cell--edited");

  if (campo === "fuente") input.setAttribute("list", "fuentes-list");

  input.addEventListener("change", () => {
    const valor = input.value.trim();
    const { ok, limpio, mensaje } = validarCampo(campo, valor);
    if (!ok) {
      input.classList.add("cell--invalid");
      input.title = mensaje;
      mostrarToast(mensaje);
      return;
    }
    input.classList.remove("cell--invalid");
    input.title = "";
    row[campo] = limpio;
    row.edited.add(campo);
    input.classList.add("cell--edited");
    input.closest("tr").classList.add("is-edited");
    if (campo === "total") {
      input.value = Number(limpio).toFixed(2);
      const suma = filasVisibles().reduce((a, r) => a + (Number(r.total) || 0), 0);
      el.visibleTotal.textContent = suma.toFixed(2);
    }
  });

  td.append(input);

  if (marcarRevision && row.revision) {
    const flag = document.createElement("span");
    flag.className = "rowflag";
    flag.textContent = "⚠ revisión";
    td.append(flag);
  }
  if (campo === "total") td.classList.add("td-num");
  return td;
}

function validarCampo(campo, valor) {
  if (campo === "fecha") {
    if (valor === REVISION) return { ok: true, limpio: valor };
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(valor);
    if (!m) return { ok: false, mensaje: "La fecha debe tener el formato DD/MM/AAAA." };
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCDate() !== d || dt.getUTCMonth() !== mo - 1) return { ok: false, mensaje: "Esa fecha no existe." };
    return { ok: true, limpio: valor };
  }
  if (campo === "fuente") {
    const encontrado = FUENTES.find((f) => f.toLowerCase() === valor.toLowerCase());
    if (!encontrado) return { ok: false, mensaje: `La fuente debe ser ${FUENTES.join(", ")}.` };
    return { ok: true, limpio: encontrado };
  }
  if (campo === "total") {
    const n = Number(valor.replace(",", "."));
    if (!Number.isFinite(n)) return { ok: false, mensaje: "El total debe ser un número." };
    return { ok: true, limpio: Math.round(n * 100) / 100 };
  }
  if (campo === "descripcion") {
    if (!valor) return { ok: false, mensaje: "La descripción no puede quedar vacía." };
    return { ok: true, limpio: valor };
  }
  return { ok: true, limpio: valor }; // tipo
}

// Sugerencias para la columna Fuente
const datalist = document.createElement("datalist");
datalist.id = "fuentes-list";
for (const f of FUENTES) {
  const opt = document.createElement("option");
  opt.value = f;
  datalist.append(opt);
}
document.body.append(datalist);

/* --------------------------- Exportación ------------------------- */

function camposSeleccionados() {
  return [...el.exportFields.querySelectorAll("input[type=checkbox]")]
    .filter((c) => c.checked)
    .map((c) => c.value);
}

function toggleCampos(valor) {
  el.exportFields.querySelectorAll("input[type=checkbox]").forEach((c) => { c.checked = valor; });
}

function construirTSV() {
  const campos = camposSeleccionados();
  const rows = filasVisibles();
  const lineas = [];

  if (el.withHeaders.checked) lineas.push(campos.map((c) => COLUMNAS[c]).join("\t"));

  for (const r of rows) {
    lineas.push(campos.map((c) => {
      if (c === "total") return Number(r.total).toFixed(2);
      return String(r[c]).replace(/[\t\r\n]+/g, " ");
    }).join("\t"));
  }
  return lineas.join("\n");
}

async function copiar() {
  const campos = camposSeleccionados();
  if (campos.length === 0) { mostrarToast("Selecciona al menos un campo para exportar."); return; }
  const rows = filasVisibles();
  if (rows.length === 0) { mostrarToast("No hay filas visibles para copiar."); return; }

  const texto = construirTSV();

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(texto);
      el.fallbackArea.hidden = true;
      mostrarToast("Datos copiados al portapapeles.");
      return;
    }
    throw new Error("clipboard-no-disponible");
  } catch (err) {
    console.error("[clipboard]", err);
    // Fallback 1: textarea temporal + execCommand
    try {
      const ta = document.createElement("textarea");
      ta.value = texto;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (ok) { mostrarToast("Datos copiados al portapapeles."); return; }
    } catch (_) { /* sigue al fallback 2 */ }

    // Fallback 2: mostrar el texto para copiarlo a mano
    el.fallbackArea.hidden = false;
    el.fallbackArea.value = texto;
    el.fallbackArea.select();
    mostrarToast("Tu navegador bloqueó el copiado. Copia el texto del cuadro con Ctrl+C.");
  }
}

/* ----------------------------- Utilidades ------------------------ */

let toastTimer = null;
function mostrarToast(mensaje) {
  el.toast.textContent = mensaje;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

function escapar(s) {
  const div = document.createElement("div");
  div.textContent = String(s);
  return div.innerHTML;
}
