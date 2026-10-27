/* =============================================================================
 *  MINI-WAZE DE EMERGENCIAS · PERÚ
 *  app.js — Lógica del frontend (Vanilla JS, ES2020+)
 *
 *  Flujo general
 *  ─────────────
 *   1. Se cargan establecimientos y unidades desde Supabase (o datos demo).
 *   2. El operador marca el punto de emergencia (clic, coordenadas, GPS o dirección).
 *   3. PostGIS (RPC hospitales_cercanos) preselecciona los N establecimientos
 *      más cercanos en línea recta que cumplen los filtros.
 *   4. OSRM /table estima el tiempo por red vial a cada candidato; se quedan
 *      los mejores y a cada uno se le pide /route con rutas alternativas.
 *   5. Cada ruta se reevalúa tramo por tramo con un modelo de tiempos para
 *      vehículos de emergencia: tipo de vía × congestión × sirena × vehículo.
 *   6. Se elige el destino de menor costo = ETA + espera estimada por saturación.
 *   7. Al despachar, la RPC despachar_unidad registra la ruta y marca la unidad
 *      "en_servicio" en una sola transacción; luego se simula la navegación.
 * ========================================================================== */
'use strict';

/* =============================================================================
 * 1. CONFIGURACIÓN
 * ========================================================================== */
const CONFIG = {
  // ⚠️ Datos de su proyecto: Supabase → Project Settings → API.
  //    Use la "Project URL" y la clave pública (publishable / anon), NUNCA la service_role.
  //    Si se dejan vacíos, la app funciona en MODO DEMO con datos locales.
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',

  OSRM_URL: 'https://router.project-osrm.org',
  OSRM_INTERVALO_MS: 1100,  // servidor demo de OSRM: uso justo ≈ 1 solicitud/segundo
  OSRM_TIMEOUT_MS: 15000,
  NOMINATIM_URL: 'https://nominatim.openstreetmap.org/search',

  CENTRO_INICIAL: [-12.0621, -77.0365], // Lima Metropolitana
  ZOOM_INICIAL: 12,

  CANDIDATOS_MAX: 6,      // preselección por cercanía (PostGIS KNN)
  RUTAS_DETALLADAS: 3,    // destinos a los que se traza ruta completa con alternativas
  SNAP_MAX_M: 300,        // si un punto está a más de esto de una vía, se considera no ruteable
  ISOCRONAS_MIN: [5, 10, 15],
  SIM_ACELERACION: 20,    // la navegación simulada corre 20× más rápido que el ETA
};

/* =============================================================================
 * 2. PARÁMETROS DEL MODELO DE TIEMPOS
 *    OSRM (servidor demo) calcula tiempos para un auto particular a velocidad
 *    de flujo libre, sin tráfico. Estos factores lo adaptan a la realidad de
 *    un vehículo de emergencia en Lima. Son heurísticos: calibrarlos con los
 *    tiempos reales registrados en rutas_emergencia.
 * ========================================================================== */
const PERFILES = {
  ambulancia: {
    etiqueta: 'Ambulancia',
    factorBase: 1.0,    // vehículo ligero: desempeño similar a un auto
    factorSirena: 0.78, // en avenidas con berma el tráfico cede el paso
    penalAngosta: 1.25, // calles angostas: maniobras más lentas
    penalPasaje: 1.6,
    velMaxKmh: 90,      // tope físico de velocidad promedio
  },
  bombero: {
    etiqueta: 'Camión de Bomberos',
    factorBase: 1.18,   // vehículo pesado: aceleración y frenado lentos
    factorSirena: 0.85,
    penalAngosta: 1.55, // radio de giro amplio
    penalPasaje: 2.4,   // pasajes: muchas veces intransitables
    velMaxKmh: 70,
  },
};

// Peso adicional SOLO para elegir la ruta cuando se prioriza avenidas
// (no altera el ETA mostrado, solo la preferencia entre alternativas).
const PESO_PRIORIDAD = { principal: 0.9, secundaria: 1.25, angosta: 2.0 };

const NIVELES_CONGESTION = {
  baja:  { factor: 1.0,  etiqueta: 'Tráfico fluido' },
  media: { factor: 1.3,  etiqueta: 'Tráfico moderado' },
  alta:  { factor: 1.65, etiqueta: 'Hora punta' },
};

const COLOR_VIA = { principal: '#22d3ee', secundaria: '#fbbf24', angosta: '#f43f5e' };
const COLOR_ISO = { 5: '#22c55e', 10: '#f59e0b', 15: '#ef4444' };

// Clasificación de vías a partir del nombre que OSM/OSRM devuelve en cada tramo.
// En Perú la nomenclatura es muy indicativa del ancho: Avenida > Jirón/Calle > Pasaje.
const RE_VIA_PRINCIPAL  = /^(av(enida)?\.?\s|v[ií]a\s+expresa|autopista|carretera|panamericana|circunvalaci[oó]n|paseo\s+de\s+la\s+rep|costa\s+verde|v[ií]a\s+de\s+evitamiento|[oó]valo|intercambio\s+vial|puente)/i;
const RE_VIA_SECUNDARIA = /^(jir[oó]n|jr\.?\s|calle|malec[oó]n|alameda|prolongaci[oó]n)/i;
const RE_VIA_PASAJE     = /^(pasaje|psje\.?|pje\.?|callej[oó]n|sendero|trocha)/i;

/* =============================================================================
 * 3. DATOS DEMO (mismos registros que la semilla de schema.sql)
 *    Coordenadas y categorías referenciales; validar con RENIPRESS (SUSALUD).
 * ========================================================================== */
const DEMO_HOSPITALES = [
  { id: 1,  nombre: 'Hospital Nacional Arzobispo Loayza',                categoria: 'III-1', institucion: 'MINSA',       latitud: -12.0496, longitud: -77.0425, nivel_saturacion: 92 },
  { id: 2,  nombre: 'Hospital Nacional Dos de Mayo',                     categoria: 'III-1', institucion: 'MINSA',       latitud: -12.0575, longitud: -77.0156, nivel_saturacion: 78 },
  { id: 3,  nombre: 'Hospital Nacional Cayetano Heredia',                categoria: 'III-1', institucion: 'MINSA',       latitud: -12.0228, longitud: -77.0569, nivel_saturacion: 88 },
  { id: 4,  nombre: 'Hospital Nacional Hipólito Unanue',                 categoria: 'III-1', institucion: 'MINSA',       latitud: -12.0440, longitud: -76.9987, nivel_saturacion: 74 },
  { id: 5,  nombre: 'Hospital Nacional Sergio E. Bernales',              categoria: 'III-1', institucion: 'MINSA',       latitud: -11.9207, longitud: -77.0432, nivel_saturacion: 81 },
  { id: 6,  nombre: 'Hospital María Auxiliadora',                        categoria: 'III-1', institucion: 'MINSA',       latitud: -12.1617, longitud: -76.9594, nivel_saturacion: 86 },
  { id: 7,  nombre: 'Hospital de Emergencias José Casimiro Ulloa',       categoria: 'III-E', institucion: 'MINSA',       latitud: -12.1279, longitud: -77.0178, nivel_saturacion: 69 },
  { id: 8,  nombre: 'Hospital de Emergencias Villa El Salvador',         categoria: 'II-E',  institucion: 'MINSA',       latitud: -12.2128, longitud: -76.9345, nivel_saturacion: 63 },
  { id: 9,  nombre: 'Hospital Santa Rosa',                               categoria: 'III-1', institucion: 'MINSA',       latitud: -12.0757, longitud: -77.0637, nivel_saturacion: 58 },
  { id: 10, nombre: 'Hospital Nacional Docente Madre Niño San Bartolomé', categoria: 'III-1', institucion: 'MINSA',      latitud: -12.0520, longitud: -77.0410, nivel_saturacion: 55 },
  { id: 11, nombre: 'Instituto Nacional de Salud del Niño - Breña',      categoria: 'III-2', institucion: 'MINSA',       latitud: -12.0634, longitud: -77.0458, nivel_saturacion: 77 },
  { id: 12, nombre: 'Hospital Nacional Daniel Alcides Carrión',          categoria: 'III-1', institucion: 'GORE Callao', latitud: -12.0597, longitud: -77.1180, nivel_saturacion: 83 },
  { id: 13, nombre: 'Hospital de Emergencias Pediátricas',               categoria: 'II-E',  institucion: 'MINSA',       latitud: -12.0598, longitud: -77.0287, nivel_saturacion: 66 },
  { id: 14, nombre: 'Hospital de Vitarte',                               categoria: 'II-2',  institucion: 'MINSA',       latitud: -12.0268, longitud: -76.9198, nivel_saturacion: 71 },
  { id: 15, nombre: 'Hospital Carlos Lanfranco La Hoz',                  categoria: 'II-2',  institucion: 'MINSA',       latitud: -11.8650, longitud: -77.0745, nivel_saturacion: 64 },
  { id: 16, nombre: 'Hospital San Juan de Lurigancho',                   categoria: 'II-2',  institucion: 'MINSA',       latitud: -11.9705, longitud: -77.0003, nivel_saturacion: 90 },
  { id: 17, nombre: 'Hospital de Huaycán',                               categoria: 'II-1',  institucion: 'MINSA',       latitud: -12.0179, longitud: -76.8185, nivel_saturacion: 52 },
  { id: 18, nombre: 'Hospital Nacional Edgardo Rebagliati Martins',      categoria: 'III-2', institucion: 'EsSalud',     latitud: -12.0790, longitud: -77.0406, nivel_saturacion: 95 },
  { id: 19, nombre: 'Hospital Nacional Guillermo Almenara Irigoyen',     categoria: 'III-1', institucion: 'EsSalud',     latitud: -12.0592, longitud: -77.0232, nivel_saturacion: 89 },
];

const DEMO_VEHICULOS = [
  { id: 1, tipo: 'ambulancia', placa: 'EUA-101', base: 'Base SAMU Cercado de Lima',            latitud: -12.0560, longitud: -77.0300, estado: 'disponible' },
  { id: 2, tipo: 'ambulancia', placa: 'EUA-102', base: 'Base SAMU San Isidro',                 latitud: -12.0970, longitud: -77.0360, estado: 'disponible' },
  { id: 3, tipo: 'ambulancia', placa: 'EUA-103', base: 'Base SAMU San Juan de Miraflores',     latitud: -12.1550, longitud: -76.9700, estado: 'disponible' },
  { id: 4, tipo: 'ambulancia', placa: 'EUA-104', base: 'Base SAMU Comas',                      latitud: -11.9400, longitud: -77.0500, estado: 'en_servicio' },
  { id: 5, tipo: 'ambulancia', placa: 'EUA-105', base: 'Base SAMU Ate',                        latitud: -12.0300, longitud: -76.9300, estado: 'disponible' },
  { id: 6, tipo: 'bombero',    placa: 'CBP-201', base: 'Cía. de Bomberos Lima',                latitud: -12.0480, longitud: -77.0330, estado: 'disponible' },
  { id: 7, tipo: 'bombero',    placa: 'CBP-202', base: 'Cía. de Bomberos Miraflores',          latitud: -12.1210, longitud: -77.0290, estado: 'disponible' },
  { id: 8, tipo: 'bombero',    placa: 'CBP-203', base: 'Cía. de Bomberos Callao',              latitud: -12.0600, longitud: -77.1350, estado: 'disponible' },
  { id: 9, tipo: 'bombero',    placa: 'CBP-204', base: 'Cía. de Bomberos San Martín de Porres', latitud: -12.0100, longitud: -77.0700, estado: 'disponible' },
];

/* =============================================================================
 * 4. ESTADO GLOBAL DE LA APLICACIÓN
 * ========================================================================== */
const state = {
  sb: null,               // cliente Supabase
  modoDemo: true,
  demo: { vehiculos: [], despachos: [], seq: 0 },

  map: null,
  capas: {},              // grupos de capas Leaflet
  marcadoresHosp: new Map(),
  marcadoresVeh: new Map(),
  marcadorOrigen: null,

  hospitales: [],
  vehiculos: [],
  tipo: 'ambulancia',
  vehiculoId: null,
  origen: null,           // { lat, lng }
  modoMarcar: false,

  resultados: [],         // destinos evaluados, ordenados por costo
  seleccion: null,        // resultado activo
  coberturaActiva: false,
  nav: null,              // navegación simulada en curso
};

/* =============================================================================
 * 5. UTILIDADES
 * ========================================================================== */
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const fmtMin = (m) => (m < 10 ? m.toFixed(1) : String(Math.round(m)));
const msgError = (e) => e?.message || e?.error_description || String(e);

/** Escapa texto antes de insertarlo como HTML (los nombres vienen de la BD). */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Distancia en línea recta (km) usando Turf. */
function kmEntre(lat1, lng1, lat2, lng2) {
  return turf.distance(turf.point([lng1, lat1]), turf.point([lng2, lat2]), { units: 'kilometers' });
}

/** Hora y tipo de día en Lima, sin importar la zona horaria del navegador. */
function horaLima(fecha = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Lima', hour: 'numeric', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(fecha);
  const hora = Number(partes.find((p) => p.type === 'hour').value);
  const dia = partes.find((p) => p.type === 'weekday').value;
  return { hora, finDeSemana: dia === 'Sat' || dia === 'Sun' };
}

function horaEstimada(minutos) {
  return new Date(Date.now() + minutos * 60000).toLocaleTimeString('es-PE', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima',
  });
}

/** fetch con timeout que devuelve JSON (también para respuestas 4xx con cuerpo JSON). */
async function fetchJSON(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    let cuerpo = null;
    try { cuerpo = await res.json(); } catch { /* sin JSON */ }
    if (!res.ok) {
      const err = new Error(cuerpo?.message || `HTTP ${res.status}`);
      err.codigo = cuerpo?.code;
      throw err;
    }
    return cuerpo;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Tiempo de espera agotado');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Notificación flotante. tipo: info | ok | warn | error */
function toast(mensaje, tipo = 'info') {
  const colores = {
    info: 'border-vital/40', ok: 'border-ok/50', warn: 'border-alerta/50', error: 'border-emergencia/60',
  };
  const iconos = { info: 'ℹ', ok: '✓', warn: '⚠', error: '✕' };
  const el = document.createElement('div');
  el.className = `toast pointer-events-auto flex gap-2.5 rounded-xl border ${colores[tipo]} bg-panel/95 px-3.5 py-3 text-sm text-slate-100 shadow-2xl backdrop-blur`;
  el.innerHTML = `<span class="font-bold">${iconos[tipo]}</span><span></span>`;
  el.lastChild.textContent = mensaje;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 4800);
  setTimeout(() => el.remove(), 5200);
}

/** Indicadores de estado de la cabecera. */
function setEstado(servicio, estado, texto) {
  const color = { ok: '#22c55e', demo: '#f59e0b', error: '#ef4444', espera: '#64748b' }[estado];
  if (servicio === 'db') {
    $('pillDbDot').style.background = color;
    if (texto) $('pillDbTxt').textContent = texto;
  } else {
    $('pillOsrmDot').style.background = color;
  }
}

/* =============================================================================
 * 6. CAPA DE DATOS (Supabase o modo demo con la misma interfaz)
 * ========================================================================== */
const db = {
  /** Crea el cliente y verifica que el esquema exista. */
  async init() {
    state.demo.vehiculos = structuredClone(DEMO_VEHICULOS);
    const configurado = CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY && window.supabase;
    if (!configurado) {
      state.modoDemo = true;
      setEstado('db', 'demo', 'Modo demo');
      return;
    }
    try {
      state.sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
      const { error } = await state.sb
        .from('establecimientos_salud')
        .select('id', { count: 'exact', head: true });
      if (error) throw error;
      state.modoDemo = false;
      setEstado('db', 'ok', 'Supabase');
    } catch (e) {
      console.warn('Supabase no disponible, se usa modo demo:', e);
      state.modoDemo = true;
      setEstado('db', 'error', 'Modo demo');
      toast(`No se pudo conectar a Supabase (${msgError(e)}). Se usan datos demo.`, 'warn');
    }
  },

  async hospitales() {
    if (state.modoDemo) return structuredClone(DEMO_HOSPITALES);
    const { data, error } = await state.sb
      .from('establecimientos_salud')
      .select('id,nombre,categoria,institucion,latitud,longitud,nivel_saturacion')
      .eq('tiene_emergencia', true)
      .order('nombre');
    if (error) throw error;
    return data;
  },

  async vehiculos() {
    if (state.modoDemo) return state.demo.vehiculos.map((v) => ({ ...v }));
    const { data, error } = await state.sb
      .from('vehiculos_emergencia')
      .select('id,tipo,placa,base,latitud,longitud,estado')
      .order('tipo')
      .order('placa');
    if (error) throw error;
    return data;
  },

  /** Preselección espacial: RPC PostGIS con índice KNN, o Turf en modo demo. */
  async hospitalesCercanos(lat, lng, categorias, saturacionMax, limite) {
    if (state.modoDemo) {
      return state.hospitales
        .filter((h) => categorias.includes(h.categoria) && h.nivel_saturacion <= saturacionMax)
        .map((h) => ({ ...h, distancia_km: kmEntre(lat, lng, h.latitud, h.longitud) }))
        .sort((a, b) => a.distancia_km - b.distancia_km)
        .slice(0, limite);
    }
    const { data, error } = await state.sb.rpc('hospitales_cercanos', {
      p_lat: lat,
      p_lng: lng,
      p_categorias: categorias,
      p_saturacion_max: saturacionMax,
      p_limite: limite,
    });
    if (error) throw error;
    return data;
  },

  /** Registra el despacho (ruta + unidad en servicio) de forma atómica. */
  async despachar(p) {
    if (state.modoDemo) {
      const v = state.demo.vehiculos.find((x) => x.id === p.p_vehiculo_id);
      if (!v || v.estado !== 'disponible') throw new Error('La unidad no está disponible');
      v.estado = 'en_servicio';
      const h = state.hospitales.find((x) => x.id === p.p_hospital_id);
      const reg = {
        id: ++state.demo.seq,
        vehiculo_id: v.id,
        tiempo_estimado_min: p.p_tiempo_estimado_min,
        distancia_km: p.p_distancia_km,
        estado: 'en_curso',
        fecha_registro: new Date().toISOString(),
        vehiculo: { placa: v.placa, tipo: v.tipo },
        hospital: { nombre: h?.nombre ?? '—' },
      };
      state.demo.despachos.unshift(reg);
      return { ruta_id: reg.id, fecha_registro: reg.fecha_registro };
    }
    const { data, error } = await state.sb.rpc('despachar_unidad', p);
    if (error) throw error;
    return data;
  },

  /** Cierra la ruta activa y devuelve la unidad a "disponible". */
  async liberar(vehiculoId, estadoFinal = 'completada') {
    if (state.modoDemo) {
      const v = state.demo.vehiculos.find((x) => x.id === vehiculoId);
      if (v) v.estado = 'disponible';
      state.demo.despachos
        .filter((d) => d.vehiculo_id === vehiculoId && d.estado === 'en_curso')
        .forEach((d) => { d.estado = estadoFinal; });
      return;
    }
    const { error } = await state.sb.rpc('liberar_unidad', {
      p_vehiculo_id: vehiculoId,
      p_estado_final: estadoFinal,
    });
    if (error) throw error;
  },

  async ultimosDespachos() {
    if (state.modoDemo) return state.demo.despachos.slice(0, 8);
    const { data, error } = await state.sb
      .from('rutas_emergencia')
      .select('id,tiempo_estimado_min,distancia_km,estado,fecha_registro,vehiculo:vehiculos_emergencia(placa,tipo),hospital:establecimientos_salud(nombre)')
      .order('fecha_registro', { ascending: false })
      .limit(8);
    if (error) throw error;
    return data;
  },

  /** Realtime: refresca flota y saturación cuando cambian en la BD. */
  suscribir() {
    if (state.modoDemo) return;
    const recargarVeh = debounce(async () => {
      try {
        state.vehiculos = await db.vehiculos();
        renderVehiculos();
        actualizarSelectUnidad();
      } catch (e) { console.warn(e); }
    }, 400);
    const recargarHosp = debounce(async () => {
      try {
        state.hospitales = await db.hospitales();
        renderHospitales();
      } catch (e) { console.warn(e); }
    }, 400);
    state.sb
      .channel('central-emergencias')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vehiculos_emergencia' }, recargarVeh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'establecimientos_salud' }, recargarHosp)
      .subscribe();
  },
};

/* =============================================================================
 * 7. MAPA (Leaflet)
 * ========================================================================== */
function initMapa() {
  const map = L.map('map', { zoomControl: false }).setView(CONFIG.CENTRO_INICIAL, CONFIG.ZOOM_INICIAL);
  state.map = map;

  // 7.1 Capas base (ninguna exige API key)
  //  - Por defecto: Esri "Dark Gray Canvas" (fondo + etiquetas de calles). No pide
  //    API key ni encabezado Referer, así que funciona incluso abriendo index.html
  //    con doble clic (file://).
  //  - OpenStreetMap: sus servidores responden 403 "Access blocked" a páginas sin
  //    Referer (file://). Solo funciona si la app se sirve por http(s).
  //  - CARTO Dark Matter no se usa: ahora exige API key.
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
  const ATRIB_ESRI = 'Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap';
  const ATRIB_OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const URL_OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  const fondoGris = L.tileLayer(`${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
    attribution: ATRIB_ESRI, maxNativeZoom: 16, maxZoom: 19,
  });
  const etiquetasGris = L.tileLayer(`${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, {
    maxNativeZoom: 16, maxZoom: 19,
  });
  const oscuroEsri = L.layerGroup([fondoGris, etiquetasGris]);
  const callesEsri = L.tileLayer(`${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, {
    attribution: ATRIB_ESRI, maxNativeZoom: 18, maxZoom: 19,
  });
  const osmOscuro = L.tileLayer(URL_OSM, { attribution: ATRIB_OSM, maxZoom: 19, className: 'tiles-oscuras' });
  const osm = L.tileLayer(URL_OSM, { attribution: ATRIB_OSM, maxZoom: 19 });
  oscuroEsri.addTo(map);

  const capasBase = {
    'Oscuro (Esri)': oscuroEsri,
    'Calles (Esri)': callesEsri,
    'Oscuro (OpenStreetMap)': osmOscuro,
    OpenStreetMap: osm,
  };

  // Respaldo: si el mapa oscuro de Esri falla varias veces, se pasa al de calles.
  let errores = 0;
  fondoGris.on('tileload', () => { errores = 0; });
  fondoGris.on('tileerror', () => {
    if (++errores < 6 || !map.hasLayer(oscuroEsri)) return;
    map.removeLayer(oscuroEsri);
    callesEsri.addTo(map);
    toast('El mapa oscuro no cargó; se cambió a "Calles (Esri)".', 'warn');
  });

  // Aviso si se elige OpenStreetMap con la página abierta como archivo local
  const esArchivoLocal = location.protocol === 'file:';
  map.on('baselayerchange', (e) => {
    if (esArchivoLocal && (e.layer === osm || e.layer === osmOscuro)) {
      toast('OpenStreetMap bloquea páginas abiertas con doble clic (file://). Sirva la carpeta con "npx serve ." o "python -m http.server".', 'warn');
    }
  });

  // Leaflet mide el contenedor al crearse; Tailwind (CDN) aplica los estilos un
  // instante después, así que se recalcula el tamaño cada vez que cambie.
  new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById('map'));
  window.addEventListener('load', () => {
    map.invalidateSize();
    if (!state.origen) map.setView(CONFIG.CENTRO_INICIAL, CONFIG.ZOOM_INICIAL);
  });

  // 7.2 Panes para controlar el orden de dibujo (cobertura < ruta < marcadores)
  map.createPane('cobertura').style.zIndex = 350;
  map.createPane('ruta').style.zIndex = 420;

  state.capas = {
    cobertura: L.layerGroup().addTo(map),
    ruta: L.layerGroup().addTo(map),
    hospitales: L.layerGroup().addTo(map),
    vehiculos: L.layerGroup().addTo(map),
    origen: L.layerGroup().addTo(map),
    navegacion: L.layerGroup().addTo(map),
  };

  // 7.3 Controles
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
  L.control.layers(
    capasBase,
    {
      'Establecimientos de salud': state.capas.hospitales,
      'Unidades de emergencia': state.capas.vehiculos,
      'Cobertura (isócronas)': state.capas.cobertura,
    },
    { position: 'topright' },
  ).addTo(map);

  // 7.4 Eventos: clic (modo marcar) y clic derecho / pulsación larga (atajo)
  map.on('click', (e) => {
    if (!state.modoMarcar) return;
    setOrigen(e.latlng.lat, e.latlng.lng);
    setModoMarcar(false);
  });
  map.on('contextmenu', (e) => setOrigen(e.latlng.lat, e.latlng.lng));

  // 7.5 Botones dentro de los popups
  map.on('popupopen', (e) => {
    e.popup.getElement().querySelectorAll('[data-accion]').forEach((b) => {
      b.addEventListener('click', () => manejarAccionPopup(b.dataset.accion, Number(b.dataset.id)));
    });
  });
}

/* ---------- 7.6 Íconos (SVG embebido, sin imágenes externas) ---------- */
const SVG_AMBULANCIA = `
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <rect x="2" y="9" width="18" height="13" rx="2" fill="#f8fafc"/>
    <path d="M20 12h5.2l4.3 5v5H20z" fill="#e2e8f0"/>
    <path d="M22 13.5h3l2.5 3H22z" fill="#38bdf8"/>
    <rect x="9.5" y="11.5" width="3" height="9" rx=".5" fill="#ef4444"/>
    <rect x="6.5" y="14.5" width="9" height="3" rx=".5" fill="#ef4444"/>
    <rect x="7" y="6.5" width="7" height="2.5" rx="1" fill="#3b82f6"/>
    <circle cx="8" cy="23" r="2.6" fill="#0f172a" stroke="#f8fafc" stroke-width="1.2"/>
    <circle cx="24" cy="23" r="2.6" fill="#0f172a" stroke="#f8fafc" stroke-width="1.2"/>
  </svg>`;

const SVG_BOMBERO = `
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <rect x="1.5" y="11" width="20" height="11" rx="1.5" fill="#dc2626"/>
    <path d="M21.5 13h4l4.5 4.5V22h-8.5z" fill="#ef4444"/>
    <path d="M23 14.5h2.4l3 3H23z" fill="#fde68a"/>
    <path d="M2.5 9.5l17-2.5M3.5 9.4l.5 1.6M7.5 8.8l.5 1.8M11.5 8.2l.5 2M15.5 7.6l.5 2.2" stroke="#e2e8f0" stroke-width="1.3" stroke-linecap="round"/>
    <rect x="3.5" y="15" width="16" height="1.6" fill="#fde68a"/>
    <circle cx="7" cy="23" r="2.6" fill="#0f172a" stroke="#f8fafc" stroke-width="1.2"/>
    <circle cx="25" cy="23" r="2.6" fill="#0f172a" stroke="#f8fafc" stroke-width="1.2"/>
  </svg>`;

const SVG_CRUZ = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" fill="#ef4444"/></svg>';

function colorSaturacion(s) {
  if (s >= 85) return '#ef4444';
  if (s >= 70) return '#f59e0b';
  return '#22c55e';
}

function iconoHospital(h, { atenuado = false, destacado = false } = {}) {
  return L.divIcon({
    className: '',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -18],
    html: `<div class="mk-hosp ${atenuado ? 'mk-atenuado' : ''} ${destacado ? 'mk-destacado' : ''}" style="--sat:${colorSaturacion(h.nivel_saturacion)}">
             ${SVG_CRUZ}<span class="mk-sat">${Number(h.nivel_saturacion)}%</span>
           </div>`,
  });
}

function iconoUnidad(tipo, { activa = true, navegando = false } = {}) {
  const color = tipo === 'bombero' ? '#ef4444' : '#38bdf8';
  return L.divIcon({
    className: '',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -20],
    html: `<div class="mk-unidad ${activa ? '' : 'mk-inactiva'} ${navegando ? 'mk-navegando' : ''}" style="--c:${color}">
             ${tipo === 'bombero' ? SVG_BOMBERO : SVG_AMBULANCIA}
           </div>`,
  });
}

const ICONO_ORIGEN = L.divIcon({
  className: '',
  iconSize: [46, 46],
  iconAnchor: [23, 23],
  html: '<div class="mk-origen"><span class="mk-origen-pulso"></span><span class="mk-origen-nucleo">!</span></div>',
});

/* ---------- 7.7 Render de establecimientos ---------- */
function popupHospital(h) {
  const c = colorSaturacion(h.nivel_saturacion);
  return `
    <p class="font-bold text-white">${esc(h.nombre)}</p>
    <p class="text-xs text-slate-400">Categoría ${esc(h.categoria)} · ${esc(h.institucion || 'MINSA')}</p>
    <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800"><div style="width:${Number(h.nivel_saturacion)}%;background:${c}" class="h-full"></div></div>
    <p class="mt-1 text-xs" style="color:${c}">Saturación de emergencia: ${Number(h.nivel_saturacion)}%</p>
    <button data-accion="rutear-hospital" data-id="${Number(h.id)}"
      class="mt-2 w-full rounded-md bg-cyan-500/15 px-2 py-1.5 text-xs font-semibold text-cyan-200 ring-1 ring-cyan-400/40 hover:bg-cyan-500/25">
      Trazar ruta a este establecimiento
    </button>`;
}

function renderHospitales() {
  const { categorias, saturacionMax } = leerFiltros();
  const idsVigentes = new Set();
  const idDestacado = state.seleccion?.hospital.id;

  for (const h of state.hospitales) {
    idsVigentes.add(h.id);
    const cumple = categorias.includes(h.categoria) && h.nivel_saturacion <= saturacionMax;
    const icono = iconoHospital(h, { atenuado: !cumple, destacado: h.id === idDestacado });
    let m = state.marcadoresHosp.get(h.id);
    if (!m) {
      m = L.marker([h.latitud, h.longitud], { icon: icono, title: h.nombre });
      m.addTo(state.capas.hospitales);
      state.marcadoresHosp.set(h.id, m);
    } else {
      m.setLatLng([h.latitud, h.longitud]).setIcon(icono);
    }
    m.setZIndexOffset(h.id === idDestacado ? 900 : cumple ? 100 : 0);
    m.bindPopup(() => popupHospital(h));
  }
  // Eliminar marcadores de establecimientos que ya no existen
  for (const [id, m] of state.marcadoresHosp) {
    if (!idsVigentes.has(id)) { m.remove(); state.marcadoresHosp.delete(id); }
  }
}

/* ---------- 7.8 Render de unidades ---------- */
function popupVehiculo(v) {
  const disponible = v.estado === 'disponible';
  const boton = disponible
    ? `<button data-accion="seleccionar-unidad" data-id="${Number(v.id)}" class="mt-2 w-full rounded-md bg-cyan-500/15 px-2 py-1.5 text-xs font-semibold text-cyan-200 ring-1 ring-cyan-400/40 hover:bg-cyan-500/25">Seleccionar para despacho</button>`
    : `<button data-accion="liberar-unidad" data-id="${Number(v.id)}" class="mt-2 w-full rounded-md bg-slate-700/40 px-2 py-1.5 text-xs font-semibold text-slate-200 ring-1 ring-slate-500/50 hover:bg-slate-700/70">Liberar unidad</button>`;
  return `
    <p class="font-bold text-white">${esc(v.placa)} · ${esc(PERFILES[v.tipo]?.etiqueta || v.tipo)}</p>
    <p class="text-xs text-slate-400">${esc(v.base || 'Sin base asignada')}</p>
    <p class="mt-1 text-xs font-semibold" style="color:${disponible ? '#22c55e' : '#f59e0b'}">${disponible ? 'Disponible' : 'En servicio'}</p>
    ${boton}`;
}

function renderVehiculos() {
  const idsVigentes = new Set();
  for (const v of state.vehiculos) {
    idsVigentes.add(v.id);
    // La unidad que está navegando se oculta: la representa el marcador animado
    const oculta = state.nav?.vehiculo.id === v.id;
    const icono = iconoUnidad(v.tipo, { activa: v.estado === 'disponible' });
    let m = state.marcadoresVeh.get(v.id);
    if (!m) {
      m = L.marker([v.latitud, v.longitud], { icon: icono, title: v.placa });
      state.marcadoresVeh.set(v.id, m);
    } else {
      m.setLatLng([v.latitud, v.longitud]).setIcon(icono);
    }
    m.bindPopup(() => popupVehiculo(v));
    if (oculta) m.remove(); else m.addTo(state.capas.vehiculos);
  }
  for (const [id, m] of state.marcadoresVeh) {
    if (!idsVigentes.has(id)) { m.remove(); state.marcadoresVeh.delete(id); }
  }
}

async function manejarAccionPopup(accion, id) {
  state.map.closePopup();
  if (accion === 'rutear-hospital') {
    calcularRutaOptima({ hospitalId: id });
  } else if (accion === 'seleccionar-unidad') {
    const v = state.vehiculos.find((x) => x.id === id);
    if (!v) return;
    setTipo(v.tipo);
    state.vehiculoId = v.id;
    actualizarSelectUnidad();
    abrirSidebar();
  } else if (accion === 'liberar-unidad') {
    if (state.nav?.vehiculo.id === id) return finalizarNavegacion();
    try {
      await db.liberar(id);
      toast('Unidad liberada', 'ok');
      await refrescarFlota();
    } catch (e) {
      toast(`No se pudo liberar la unidad: ${msgError(e)}`, 'error');
    }
  }
}

/* =============================================================================
 * 8. PUNTO DE ORIGEN (emergencia)
 * ========================================================================== */
function setOrigen(lat, lng, { centrar = false } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -18.5 || lat > 0.1 || lng < -81.5 || lng > -68.5) {
    toast('Coordenadas fuera del territorio peruano', 'warn');
    return;
  }
  state.origen = { lat, lng };
  $('inpLat').value = lat.toFixed(6);
  $('inpLng').value = lng.toFixed(6);

  if (!state.marcadorOrigen) {
    state.marcadorOrigen = L.marker([lat, lng], {
      icon: ICONO_ORIGEN, draggable: true, zIndexOffset: 1000, title: 'Punto de emergencia',
    }).addTo(state.capas.origen);
    state.marcadorOrigen.bindTooltip('Emergencia (arrastre para ajustar)', { direction: 'top', offset: [0, -20] });
    state.marcadorOrigen.on('dragend', (e) => {
      const p = e.target.getLatLng();
      setOrigen(p.lat, p.lng);
    });
  } else {
    state.marcadorOrigen.setLatLng([lat, lng]);
  }
  if (centrar) state.map.setView([lat, lng], Math.max(state.map.getZoom(), 15));

  limpiarResultados();
  actualizarSelectUnidad(); // reordena unidades por cercanía
}

function setModoMarcar(activo) {
  state.modoMarcar = activo;
  $('btnMarcar').setAttribute('aria-pressed', String(activo));
  $('btnMarcar').classList.toggle('border-emergencia', activo);
  $('bannerMarcar').classList.toggle('hidden', !activo);
  document.body.classList.toggle('cursor-marcar', activo);
  if (activo) cerrarSidebar();
}

function usarMiUbicacion() {
  if (!navigator.geolocation) return toast('El navegador no permite geolocalización', 'warn');
  const btn = $('btnMiUbicacion');
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.disabled = false;
      setOrigen(pos.coords.latitude, pos.coords.longitude, { centrar: true });
    },
    (err) => {
      btn.disabled = false;
      toast(`No se pudo obtener la ubicación: ${err.message}`, 'warn');
    },
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

function fijarCoordenadas() {
  const lat = parseFloat($('inpLat').value.replace(',', '.'));
  const lng = parseFloat($('inpLng').value.replace(',', '.'));
  setOrigen(lat, lng, { centrar: true });
}

/* ---------- 8.1 Geocodificación (Nominatim; búsqueda explícita, sin autocompletar) ---------- */
async function buscarDireccion() {
  const q = $('inpBuscar').value.trim();
  const lista = $('listaBusqueda');
  if (q.length < 3) return;
  lista.innerHTML = '<li class="px-3 py-2 text-slate-400">Buscando…</li>';
  lista.classList.remove('hidden');
  try {
    const url = `${CONFIG.NOMINATIM_URL}?format=jsonv2&countrycodes=pe&limit=5&accept-language=es&q=${encodeURIComponent(q)}`;
    const datos = await fetchJSON(url, 10000);
    if (!datos.length) {
      lista.innerHTML = '<li class="px-3 py-2 text-slate-400">Sin resultados</li>';
      return;
    }
    lista.innerHTML = datos.map((d) => `
      <li><button class="block w-full px-3 py-2 text-left hover:bg-slate-800" data-lat="${Number(d.lat)}" data-lng="${Number(d.lon)}">
        ${esc(d.display_name)}
      </button></li>`).join('');
  } catch (e) {
    lista.innerHTML = `<li class="px-3 py-2 text-red-300">Error: ${esc(msgError(e))}</li>`;
  }
}

/* =============================================================================
 * 9. MODELO DE TIEMPOS PARA VEHÍCULOS DE EMERGENCIA
 * ========================================================================== */

/** Clasifica un tramo (step de OSRM) en principal / secundaria / angosta. */
function clasificarVia(step) {
  const nombre = (step.name || '').trim();
  const ref = (step.ref || '').trim();
  const maniobra = step.maneuver?.type || '';
  // Número de carriles (solo existe donde OSM tiene turn:lanes)
  const carriles = Math.max(0, ...(step.intersections || []).map((i) => i.lanes?.length || 0));

  if (RE_VIA_PASAJE.test(nombre)) return { clase: 'angosta', pasaje: true };
  if (RE_VIA_PRINCIPAL.test(nombre) || ref || carriles >= 3 ||
      ['on ramp', 'off ramp', 'rotary', 'roundabout'].includes(maniobra)) {
    return { clase: 'principal', pasaje: false };
  }
  if (RE_VIA_SECUNDARIA.test(nombre)) return { clase: carriles === 1 ? 'angosta' : 'secundaria', pasaje: false };
  if (!nombre) return { clase: step.distance < 120 || carriles === 1 ? 'angosta' : 'secundaria', pasaje: false };
  return { clase: 'secundaria', pasaje: false };
}

/**
 * Multiplicador sobre el tiempo de OSRM para un tramo.
 *  - Avenidas: sufren toda la congestión, pero la sirena es más efectiva (berma).
 *  - Jirones/calles: algo menos de congestión, sirena menos efectiva.
 *  - Angostas/pasajes: poca congestión, sirena casi inútil, maniobras lentas.
 */
function factorTramo({ clase, pasaje }, perfil, congestion) {
  const extra = congestion - 1;
  if (clase === 'principal') {
    return perfil.factorBase * (1 + extra) * perfil.factorSirena;
  }
  if (clase === 'secundaria') {
    return perfil.factorBase * (1 + extra * 0.8) *
      Math.min(1, perfil.factorSirena + 0.12) *
      (1 + (perfil.penalAngosta - 1) * 0.35);
  }
  return perfil.factorBase * (1 + extra * 0.6) * (pasaje ? perfil.penalPasaje : perfil.penalAngosta);
}

/** Nivel de congestión típico de Lima según hora (horas punta en días hábiles). */
function nivelCongestionPorHora(hora, finDeSemana) {
  if (hora >= 23 || hora < 5) return 'baja';
  if (!finDeSemana && ((hora >= 6 && hora < 10) || (hora >= 17 && hora < 21))) return 'alta';
  return 'media';
}

function congestionActual() {
  const modo = $('selCongestion').value;
  let nivel = modo;
  if (modo === 'auto') {
    const { hora, finDeSemana } = horaLima();
    nivel = nivelCongestionPorHora(hora, finDeSemana);
  }
  return { ...NIVELES_CONGESTION[nivel], nivel, automatica: modo === 'auto' };
}

/** Minutos de espera estimada en puerta de emergencia según saturación. */
function penalizacionSaturacion(saturacion) {
  if (saturacion < 70) return 0;
  if (saturacion < 85) return (saturacion - 70) * 0.2; // hasta +3 min
  return 3 + (saturacion - 85) * 0.6;                  // hasta +12 min
}

/** Instrucción de navegación en español a partir de un step de OSRM. */
function instruccion(step) {
  const m = step.maneuver || {};
  const via = step.name || step.ref || 'la vía sin nombre';
  const dir = {
    left: 'a la izquierda', right: 'a la derecha',
    'slight left': 'ligeramente a la izquierda', 'slight right': 'ligeramente a la derecha',
    'sharp left': 'cerrado a la izquierda', 'sharp right': 'cerrado a la derecha',
    straight: 'recto', uturn: 'en U',
  }[m.modifier] || '';
  switch (m.type) {
    case 'depart':      return `Inicie el recorrido por ${via}`;
    case 'arrive':      return 'Llegada al establecimiento de salud';
    case 'turn':
    case 'end of road': return `Gire ${dir} hacia ${via}`.replace(/\s+/g, ' ');
    case 'merge':       return `Incorpórese ${dir} a ${via}`.replace(/\s+/g, ' ');
    case 'on ramp':     return `Tome el acceso ${dir} hacia ${via}`.replace(/\s+/g, ' ');
    case 'off ramp':    return `Tome la salida ${dir} hacia ${via}`.replace(/\s+/g, ' ');
    case 'fork':        return `En la bifurcación, manténgase ${dir} hacia ${via}`.replace(/\s+/g, ' ');
    case 'roundabout':
    case 'rotary':      return m.exit ? `En el óvalo, tome la ${m.exit}.ª salida hacia ${via}` : `Ingrese al óvalo hacia ${via}`;
    case 'roundabout turn': return `En el óvalo, gire ${dir} hacia ${via}`.replace(/\s+/g, ' ');
    case 'new name':
    case 'continue':
    default:            return dir && dir !== 'recto' ? `Continúe ${dir} por ${via}` : `Continúe recto por ${via}`;
  }
}

function iconoManiobra(step) {
  const m = step.maneuver || {};
  if (m.type === 'depart') return '●';
  if (m.type === 'arrive') return '✚';
  if (m.type === 'roundabout' || m.type === 'rotary') return '⟳';
  return {
    left: '←', right: '→', 'slight left': '↖', 'slight right': '↗',
    'sharp left': '↙', 'sharp right': '↘', uturn: '↶', straight: '↑',
  }[m.modifier] || '↑';
}

/**
 * Evalúa una ruta de OSRM con el modelo de emergencia.
 * Devuelve ETA ajustado, costo de decisión, composición por tipo de vía,
 * tramos coloreables e instrucciones de navegación.
 */
function evaluarRuta(rutaOsrm, tipo, congestion, priorizarAvenidas) {
  const perfil = PERFILES[tipo];
  const metros = { principal: 0, secundaria: 0, angosta: 0 };
  const tramos = [];
  const instrucciones = [];
  let segundos = 0;
  let costo = 0;
  let acumulado = 0;

  for (const leg of rutaOsrm.legs) {
    for (const step of leg.steps) {
      instrucciones.push({
        texto: instruccion(step),
        icono: iconoManiobra(step),
        distanciaInicio: acumulado,
        distancia: step.distance,
      });
      acumulado += step.distance;
      if (!(step.distance > 0)) continue; // el step "arrive" no tiene longitud

      const via = clasificarVia(step);
      const t = step.duration * factorTramo(via, perfil, congestion);
      segundos += t;
      costo += t * (priorizarAvenidas ? PESO_PRIORIDAD[via.clase] : 1);
      metros[via.clase] += step.distance;
      tramos.push({ clase: via.clase, coords: step.geometry.coordinates });
    }
  }

  // Tope físico: no se puede ir más rápido que la velocidad máxima del vehículo
  const minimo = rutaOsrm.distance / (perfil.velMaxKmh / 3.6);
  if (segundos > 0 && segundos < minimo) {
    costo *= minimo / segundos;
    segundos = minimo;
  }

  const total = rutaOsrm.distance || 1;
  return {
    segundos,
    costoSeg: costo,
    distanciaM: rutaOsrm.distance,
    duracionOsrm: rutaOsrm.duration,
    metros,
    pctPrincipal: metros.principal / total,
    tramos,
    instrucciones,
    geometria: rutaOsrm.geometry,
  };
}

/* =============================================================================
 * 10. OSRM (API pública) — con cola para respetar ≈1 solicitud/segundo
 * ========================================================================== */
let osrmUltimaSolicitud = 0;
let osrmCola = Promise.resolve();

function osrmFetch(url) {
  const tarea = osrmCola.then(async () => {
    const espera = osrmUltimaSolicitud + CONFIG.OSRM_INTERVALO_MS - Date.now();
    if (espera > 0) await sleep(espera);
    osrmUltimaSolicitud = Date.now();
    return fetchJSON(url, CONFIG.OSRM_TIMEOUT_MS);
  });
  osrmCola = tarea.catch(() => {}); // un error no bloquea la cola
  return tarea.then(
    (datos) => {
      setEstado('osrm', 'ok');
      if (datos?.code !== 'Ok') throw new Error(`OSRM: ${datos?.message || datos?.code}`);
      return datos;
    },
    (e) => {
      // NoRoute / NoSegment son respuestas válidas del servidor, no caídas
      setEstado('osrm', e.codigo ? 'ok' : 'error');
      throw e;
    },
  );
}

const coordOsrm = ([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`;

/** Matriz de tiempos/distancias. coords: [[lng, lat], ...] */
function osrmTabla(coords, { sources, destinations }) {
  const url = `${CONFIG.OSRM_URL}/table/v1/driving/${coords.map(coordOsrm).join(';')}` +
    `?sources=${sources.join(';')}&destinations=${destinations.join(';')}&annotations=duration,distance`;
  return osrmFetch(url);
}

/** Ruta detallada con alternativas, pasos (steps) y geometría GeoJSON. */
function osrmRuta(origen, destino) {
  const url = `${CONFIG.OSRM_URL}/route/v1/driving/` +
    `${coordOsrm([origen.lng, origen.lat])};${coordOsrm([destino.longitud, destino.latitud])}` +
    '?overview=full&geometries=geojson&steps=true&alternatives=true';
  return osrmFetch(url);
}

/* =============================================================================
 * 11. ORQUESTACIÓN: CÁLCULO DE LA RUTA ÓPTIMA
 * ========================================================================== */
function leerFiltros() {
  const categorias = [...document.querySelectorAll('input[name="categoria"]:checked')].map((i) => i.value);
  const saturacionMax = Number($('rngSaturacion').value);
  return { categorias, saturacionMax };
}

function contexto() {
  return { tipo: state.tipo, congestion: congestionActual(), priorizar: $('chkAvenidas').checked };
}

/** Aplica el modelo a todas las rutas OSRM de un destino y elige la mejor. */
function evaluarResultado(base, ctx) {
  const evaluadas = base.rutasOsrm
    .map((r) => evaluarRuta(r, ctx.tipo, ctx.congestion.factor, ctx.priorizar))
    .sort((a, b) => a.costoSeg - b.costoSeg);
  const mejor = evaluadas[0];
  const penalSatMin = penalizacionSaturacion(base.hospital.nivel_saturacion);
  return {
    hospital: base.hospital,
    rutasOsrm: base.rutasOsrm,
    ruta: mejor,
    alternativas: evaluadas.slice(1),
    etaMin: mejor.segundos / 60,
    penalSatMin,
    costoMin: mejor.costoSeg / 60 + penalSatMin,
    ...ctx,
  };
}

function setCargando(activo, texto = 'Calcular ruta óptima') {
  $('btnCalcular').disabled = activo;
  $('btnCalcularSpin').classList.toggle('hidden', !activo);
  $('btnCalcularTxt').textContent = texto;
}

async function calcularRutaOptima({ hospitalId = null } = {}) {
  if (!state.origen) {
    toast('Primero marque el punto de la emergencia en el mapa', 'warn');
    setModoMarcar(true);
    return;
  }
  const { categorias, saturacionMax } = leerFiltros();
  if (!hospitalId && !categorias.length) return toast('Seleccione al menos una categoría', 'warn');

  const { lat, lng } = state.origen;
  const ctx = contexto();
  const perfil = PERFILES[ctx.tipo];

  try {
    // 11.1 Candidatos por cercanía (PostGIS) o un establecimiento forzado
    setCargando(true, 'Buscando establecimientos…');
    let candidatos;
    if (hospitalId) {
      const h = state.hospitales.find((x) => x.id === hospitalId);
      candidatos = h ? [{ ...h, distancia_km: kmEntre(lat, lng, h.latitud, h.longitud) }] : [];
    } else {
      candidatos = await db.hospitalesCercanos(lat, lng, categorias, saturacionMax, CONFIG.CANDIDATOS_MAX);
    }
    if (!candidatos.length) {
      throw new Error('Ningún establecimiento cumple los filtros. Amplíe categorías o la saturación máxima.');
    }

    // 11.2 Matriz OSRM: tiempo real por red vial desde la emergencia a cada candidato
    let seleccion = candidatos.slice(0, CONFIG.RUTAS_DETALLADAS);
    if (candidatos.length > CONFIG.RUTAS_DETALLADAS) {
      try {
        setCargando(true, 'Comparando tiempos por red vial…');
        const tabla = await osrmTabla(
          [[lng, lat], ...candidatos.map((c) => [c.longitud, c.latitud])],
          { sources: [0], destinations: candidatos.map((_, i) => i + 1) },
        );
        const snap = tabla.sources?.[0]?.distance ?? 0;
        if (snap > CONFIG.SNAP_MAX_M) {
          toast(`La emergencia está a ${Math.round(snap)} m de la vía más cercana; la ruta parte desde esa vía.`, 'warn');
        }
        const factorAprox = perfil.factorBase * ctx.congestion.factor * perfil.factorSirena;
        seleccion = candidatos
          .map((c, i) => ({ ...c, durTabla: tabla.durations[0][i] }))
          .filter((c) => c.durTabla != null)
          .sort((a, b) =>
            (a.durTabla * factorAprox) / 60 + penalizacionSaturacion(a.nivel_saturacion) -
            ((b.durTabla * factorAprox) / 60 + penalizacionSaturacion(b.nivel_saturacion)))
          .slice(0, CONFIG.RUTAS_DETALLADAS);
      } catch (e) {
        console.warn('OSRM /table falló; se usa el orden por distancia recta.', e);
      }
    }

    // 11.3 Rutas detalladas con alternativas (secuencial para respetar el límite de OSRM)
    const resultados = [];
    for (const [i, h] of seleccion.entries()) {
      setCargando(true, `Trazando ruta ${i + 1}/${seleccion.length}…`);
      try {
        const r = await osrmRuta(state.origen, h);
        resultados.push(evaluarResultado({ hospital: h, rutasOsrm: r.routes }, ctx));
      } catch (e) {
        console.warn(`Sin ruta a ${h.nombre}:`, e);
      }
    }
    if (!resultados.length) throw new Error('OSRM no encontró rutas. Verifique la conexión o mueva el punto a una vía.');

    // 11.4 Elegir el destino de menor costo (ETA + espera por saturación)
    resultados.sort((a, b) => a.costoMin - b.costoMin);
    state.resultados = resultados;
    seleccionarResultado(0, { encuadrar: true });
    toast(`Destino sugerido: ${resultados[0].hospital.nombre} · ${fmtMin(resultados[0].etaMin)} min`, 'ok');
  } catch (e) {
    toast(msgError(e), 'error');
  } finally {
    setCargando(false);
  }
}

/** Recalcula con las rutas ya descargadas (cambio de vehículo, congestión o prioridad). */
function reevaluar() {
  if (!state.resultados.length) return;
  const ctx = contexto();
  state.resultados = state.resultados
    .map((r) => evaluarResultado({ hospital: r.hospital, rutasOsrm: r.rutasOsrm }, ctx))
    .sort((a, b) => a.costoMin - b.costoMin);
  seleccionarResultado(0);
}

function seleccionarResultado(indice, { encuadrar = false } = {}) {
  state.seleccion = state.resultados[indice] || null;
  renderRuta(encuadrar);
  renderResumen();
  renderHospitales();
  if (state.coberturaActiva) calcularCobertura();
}

function limpiarResultados() {
  state.resultados = [];
  state.seleccion = null;
  state.capas.ruta.clearLayers();
  state.capas.cobertura.clearLayers();
  $('secResumen').classList.add('hidden');
  $('secVacio').classList.remove('hidden');
  renderHospitales();
}

/* =============================================================================
 * 12. RENDER DE RUTA Y TARJETA DE RESUMEN
 * ========================================================================== */
function renderRuta(encuadrar = false) {
  const capa = state.capas.ruta;
  capa.clearLayers();
  const res = state.seleccion;
  if (!res) return;

  // Alternativas descartadas (gris discontinuo)
  for (const alt of res.alternativas) {
    L.geoJSON(alt.geometria, {
      pane: 'ruta',
      style: { color: '#64748b', weight: 4, opacity: 0.7, dashArray: '6 8' },
    }).bindTooltip(`Alternativa: ${fmtMin(alt.segundos / 60)} min · ${(alt.distanciaM / 1000).toFixed(1)} km`, { sticky: true })
      .addTo(capa);
  }

  // Halo + borde para resaltar la ruta óptima
  L.geoJSON(res.ruta.geometria, { pane: 'ruta', style: { color: '#22d3ee', weight: 16, opacity: 0.16 } }).addTo(capa);
  L.geoJSON(res.ruta.geometria, { pane: 'ruta', style: { color: '#020617', weight: 9, opacity: 0.95 } }).addTo(capa);

  // Tramos coloreados según tipo de vía
  for (const t of res.ruta.tramos) {
    L.polyline(t.coords.map(([x, y]) => [y, x]), {
      pane: 'ruta', color: COLOR_VIA[t.clase], weight: 5, opacity: 1, lineCap: 'round',
    }).addTo(capa);
  }

  if (encuadrar) {
    const limites = L.geoJSON(res.ruta.geometria).getBounds();
    state.map.fitBounds(limites, { padding: [60, 60], maxZoom: 16 });
  }
}

function renderResumen() {
  const res = state.seleccion;
  if (!res) return;
  const { hospital: h, ruta } = res;

  $('secVacio').classList.add('hidden');
  $('secResumen').classList.remove('hidden');
  $('resAviso').classList.add('hidden');

  $('resHospital').textContent = h.nombre;
  $('resMeta').textContent = `Categoría ${h.categoria} · ${h.institucion || 'MINSA'} · ${Number(h.distancia_km ?? 0).toFixed(1)} km en línea recta`;

  const color = colorSaturacion(h.nivel_saturacion);
  $('resSatBar').style.width = `${h.nivel_saturacion}%`;
  $('resSatBar').style.background = color;
  $('resSatTxt').textContent = `Saturación ${h.nivel_saturacion}%` +
    (res.penalSatMin > 0 ? ` · +${fmtMin(res.penalSatMin)} min de espera estimada en puerta` : ' · sin espera adicional estimada');
  $('resSatTxt').style.color = color;

  $('resEta').textContent = fmtMin(res.etaMin);
  $('resDist').textContent = (ruta.distanciaM / 1000).toFixed(1);
  $('resPrincipal').textContent = `${Math.round(ruta.pctPrincipal * 100)}%`;
  $('resEtaHora').textContent = `Llegada estimada ≈ ${horaEstimada(res.etaMin)} (hora de Lima)`;

  const total = ruta.distanciaM || 1;
  $('compPrincipal').style.width = `${(ruta.metros.principal / total) * 100}%`;
  $('compSecundaria').style.width = `${(ruta.metros.secundaria / total) * 100}%`;
  $('compAngosta').style.width = `${(ruta.metros.angosta / total) * 100}%`;

  $('resNota').textContent =
    `${PERFILES[res.tipo].etiqueta} · ${res.congestion.etiqueta} (×${res.congestion.factor})` +
    `${res.priorizar ? ' · prioridad avenidas' : ''} · OSRM sin ajustar: ${fmtMin(ruta.duracionOsrm / 60)} min` +
    `${res.alternativas.length ? ` · ${res.alternativas.length} alternativa(s) evaluada(s)` : ''}`;

  // Comparativa de destinos
  $('listaCandidatos').innerHTML = state.resultados.map((r, i) => `
    <button class="cand ${r === res ? 'cand-activo' : ''}" data-idx="${i}">
      <span class="cand-rank">${i + 1}</span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13px] font-semibold text-slate-100">${esc(r.hospital.nombre)}</span>
        <span class="block text-[11px] text-slate-400">${esc(r.hospital.categoria)} · ${Number(r.hospital.nivel_saturacion)}% sat. · ${(r.ruta.distanciaM / 1000).toFixed(1)} km</span>
      </span>
      <span class="shrink-0 text-right">
        <span class="block font-mono text-sm font-bold text-white">${fmtMin(r.etaMin)} min</span>
        ${r.penalSatMin > 0 ? `<span class="block text-[10px] text-amber-300">+${fmtMin(r.penalSatMin)} espera</span>` : ''}
      </span>
    </button>`).join('');

  actualizarBotonDespacho();
}

function actualizarBotonDespacho() {
  const btn = $('btnDespachar');
  const listo = Boolean(state.seleccion && state.vehiculoId && !state.nav);
  btn.disabled = !listo;
  btn.title = state.nav ? 'Hay una navegación en curso'
    : !state.vehiculoId ? 'No hay unidad disponible seleccionada' : '';
}

/* =============================================================================
 * 13. ISÓCRONAS / COBERTURA (5, 10 y 15 min hacia el establecimiento)
 *     El servidor público de OSRM no ofrece isócronas, así que se aproximan:
 *     se muestrean puntos en 16 rumbos × 6 anillos, se consulta /table con el
 *     hospital como destino y, por rumbo, se interpola el radio alcanzable.
 * ========================================================================== */

/** Interpola hasta qué radio (km) se llega en T minutos a lo largo de un rumbo. */
function radioAlcanzable(muestras, T) {
  if (!muestras.length) return 0;
  let rPrevio = 0;
  let tPrevio = 0;
  for (const m of muestras) {
    if (m.min > T) {
      const f = (T - tPrevio) / Math.max(0.01, m.min - tPrevio);
      return rPrevio + (m.r - rPrevio) * clamp(f, 0, 1);
    }
    rPrevio = m.r;
    tPrevio = m.min;
  }
  return rPrevio; // todo el muestreo está dentro de T
}

async function calcularCobertura() {
  const res = state.seleccion;
  if (!res) return;
  const h = res.hospital;
  const capa = state.capas.cobertura;
  const btn = $('btnCobertura');
  btn.disabled = true;

  const perfil = PERFILES[state.tipo];
  const cong = congestionActual();
  // Factor promedio (las isócronas no distinguen tipo de vía tramo a tramo)
  const factor = perfil.factorBase * (1 + (cong.factor - 1) * 0.85) * Math.min(1, perfil.factorSirena + 0.06);
  const tMax = Math.max(...CONFIG.ISOCRONAS_MIN);
  const radioMax = clamp(((tMax / 60) * 48) / factor, 4, 14); // km
  const fracciones = [0.1, 0.22, 0.37, 0.55, 0.77, 1.0];
  const RUMBOS = 16;
  const centro = turf.point([h.longitud, h.latitud]);

  const muestras = [];
  for (let b = 0; b < RUMBOS; b++) {
    for (const f of fracciones) {
      const r = radioMax * f;
      const p = turf.destination(centro, r, (b * 360) / RUMBOS, { units: 'kilometers' });
      muestras.push({ b, r, coord: p.geometry.coordinates });
    }
  }

  let porRumbo = null;
  try {
    const tabla = await osrmTabla(
      [[h.longitud, h.latitud], ...muestras.map((m) => m.coord)],
      { sources: muestras.map((_, i) => i + 1), destinations: [0] }, // hacia el hospital
    );
    porRumbo = Array.from({ length: RUMBOS }, () => []);
    muestras.forEach((m, i) => {
      const dur = tabla.durations[i]?.[0];
      const snap = tabla.sources[i]?.distance ?? 0;
      if (dur == null || snap > CONFIG.SNAP_MAX_M) return; // mar, cerros, zonas sin vías
      porRumbo[m.b].push({ r: m.r, min: (dur * factor) / 60 });
    });
  } catch (e) {
    console.warn('Isócronas por red vial no disponibles; se usan radios estimados.', e);
    toast('Cobertura estimada por radio (OSRM no respondió)', 'warn');
  }

  // Si la selección cambió mientras se calculaba, no dibujar resultados viejos
  if (state.seleccion?.hospital.id !== h.id || !state.coberturaActiva) {
    btn.disabled = false;
    return;
  }

  capa.clearLayers();
  const tiempos = [...CONFIG.ISOCRONAS_MIN].sort((a, b) => b - a); // grande primero (debajo)
  for (const T of tiempos) {
    let anillo;
    if (porRumbo) {
      anillo = Array.from({ length: RUMBOS }, (_, b) => {
        const r = radioAlcanzable(porRumbo[b], T);
        return r > 0.02
          ? turf.destination(centro, r, (b * 360) / RUMBOS, { units: 'kilometers' }).geometry.coordinates
          : [h.longitud, h.latitud];
      });
    } else {
      const r = ((30 / factor) * T) / 60; // ≈30 km/h promedio urbano
      anillo = Array.from({ length: 64 }, (_, k) =>
        turf.destination(centro, r, (k * 360) / 64, { units: 'kilometers' }).geometry.coordinates);
    }
    const color = COLOR_ISO[T] || '#a78bfa';
    L.polygon(anillo.map(([x, y]) => [y, x]), {
      pane: 'cobertura',
      color,
      weight: 1.5,
      opacity: 0.9,
      fillColor: color,
      fillOpacity: 0.1,
      dashArray: porRumbo ? null : '4 6',
    }).bindTooltip(`≤ ${T} min hasta ${h.nombre}`, { sticky: true }).addTo(capa);
  }
  btn.disabled = false;
}

function alternarCobertura() {
  state.coberturaActiva = !state.coberturaActiva;
  $('btnCobertura').setAttribute('aria-pressed', String(state.coberturaActiva));
  $('btnCobertura').classList.toggle('border-vital', state.coberturaActiva);
  if (state.coberturaActiva) {
    if (!state.map.hasLayer(state.capas.cobertura)) state.capas.cobertura.addTo(state.map);
    calcularCobertura();
  } else {
    state.capas.cobertura.clearLayers();
  }
}

/* =============================================================================
 * 14. DESPACHO Y NAVEGACIÓN SIMULADA
 * ========================================================================== */
async function despachar() {
  const res = state.seleccion;
  const vehiculo = state.vehiculos.find((v) => v.id === state.vehiculoId);
  if (!res || !vehiculo) return toast('Seleccione una ruta y una unidad disponible', 'warn');

  const btn = $('btnDespachar');
  btn.disabled = true;
  try {
    const r = await db.despachar({
      p_vehiculo_id: vehiculo.id,
      p_hospital_id: res.hospital.id,
      p_origen_lat: state.origen.lat,
      p_origen_lng: state.origen.lng,
      p_tiempo_estimado_min: Math.round(res.etaMin * 10) / 10,
      p_distancia_km: Math.round(res.ruta.distanciaM / 10) / 100,
      p_prioridad_avenidas: res.priorizar,
      p_geometria: res.ruta.geometria,
    });
    toast(`Unidad ${vehiculo.placa} despachada · Registro #${r?.ruta_id ?? '—'}`, 'ok');
    iniciarNavegacion(res, vehiculo);
    await refrescarFlota();
  } catch (e) {
    toast(`No se pudo despachar: ${msgError(e)}`, 'error');
    actualizarBotonDespacho();
  }
}

function iniciarNavegacion(res, vehiculo) {
  detenerNavegacion();
  const coords = res.ruta.geometria.coordinates.map(([x, y]) => L.latLng(y, x));

  // Distancias acumuladas sobre la geometría para interpolar la posición
  const acum = [0];
  for (let i = 1; i < coords.length; i++) acum.push(acum[i - 1] + coords[i - 1].distanceTo(coords[i]));
  const total = acum[acum.length - 1] || 1;

  const capa = state.capas.navegacion;
  const recorrido = L.polyline([], { pane: 'ruta', color: '#475569', weight: 6, opacity: 0.95 }).addTo(capa);
  const marcador = L.marker(coords[0], {
    icon: iconoUnidad(vehiculo.tipo, { navegando: true }),
    zIndexOffset: 1200,
    title: vehiculo.placa,
  }).addTo(capa);

  state.nav = {
    res, vehiculo, coords, acum, total, marcador, recorrido,
    inicio: performance.now(),
    duracionMs: (res.ruta.segundos / CONFIG.SIM_ACELERACION) * 1000,
    indice: 0,
    instrActual: -1,
    ultimoPan: 0,
    raf: null,
  };

  // Panel de navegación
  $('navUnidad').textContent = `${vehiculo.placa} · ${PERFILES[vehiculo.tipo].etiqueta}`;
  $('navDestino').textContent = `→ ${res.hospital.nombre}`;
  $('listaInstrucciones').innerHTML = res.ruta.instrucciones.map((ins, i) => `
    <li class="instr" data-i="${i}">
      <span class="instr-icono">${ins.icono}</span>
      <span class="flex-1">${esc(ins.texto)}${ins.distancia > 0 ? `<span class="block text-[11px] text-slate-500">${ins.distancia >= 1000 ? `${(ins.distancia / 1000).toFixed(1)} km` : `${Math.round(ins.distancia)} m`}</span>` : ''}</span>
    </li>`).join('');
  $('secNav').classList.remove('hidden');
  $('secNav').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  renderVehiculos();
  actualizarBotonDespacho();
  state.nav.raf = requestAnimationFrame(cuadroNavegacion);
}

function cuadroNavegacion(ahora) {
  const nav = state.nav;
  if (!nav) return;
  const progreso = Math.min(1, (ahora - nav.inicio) / nav.duracionMs);
  const d = progreso * nav.total;

  // Segmento actual e interpolación lineal de la posición
  while (nav.indice < nav.acum.length - 2 && nav.acum[nav.indice + 1] < d) nav.indice++;
  const a = nav.coords[nav.indice];
  const b = nav.coords[Math.min(nav.indice + 1, nav.coords.length - 1)];
  const largo = nav.acum[nav.indice + 1] - nav.acum[nav.indice] || 1;
  const f = clamp((d - nav.acum[nav.indice]) / largo, 0, 1);
  const pos = L.latLng(a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f);

  nav.marcador.setLatLng(pos);
  nav.recorrido.setLatLngs([...nav.coords.slice(0, nav.indice + 1), pos]);

  // Indicadores
  $('navEta').textContent = fmtMin((nav.res.ruta.segundos * (1 - progreso)) / 60);
  $('navDist').textContent = ((nav.res.ruta.distanciaM * (1 - progreso)) / 1000).toFixed(1);
  $('navBarra').style.width = `${progreso * 100}%`;

  // Instrucción vigente (las distancias de los steps se escalan a la geometría)
  const dSteps = progreso * nav.res.ruta.distanciaM;
  let actual = 0;
  nav.res.ruta.instrucciones.forEach((ins, i) => { if (ins.distanciaInicio <= dSteps) actual = i; });
  if (progreso >= 1) actual = nav.res.ruta.instrucciones.length - 1;
  if (actual !== nav.instrActual) {
    nav.instrActual = actual;
    document.querySelectorAll('#listaInstrucciones .instr').forEach((li, i) => {
      li.classList.toggle('instr-actual', i === actual);
      li.classList.toggle('instr-hecha', i < actual);
      if (i === actual) li.scrollIntoView({ block: 'nearest' });
    });
  }

  if ($('chkSeguir').checked && ahora - nav.ultimoPan > 900) {
    nav.ultimoPan = ahora;
    state.map.panTo(pos, { animate: true, duration: 0.8 });
  }

  if (progreso < 1) {
    nav.raf = requestAnimationFrame(cuadroNavegacion);
  } else {
    nav.raf = null;
    toast(`${nav.vehiculo.placa} llegó a ${nav.res.hospital.nombre}`, 'ok');
    $('btnFinalizar').classList.add('border-ok', 'text-green-300');
  }
}

function detenerNavegacion() {
  if (state.nav?.raf) cancelAnimationFrame(state.nav.raf);
  state.capas.navegacion?.clearLayers();
  state.nav = null;
  $('secNav').classList.add('hidden');
  $('btnFinalizar').classList.remove('border-ok', 'text-green-300');
}

async function finalizarNavegacion() {
  const nav = state.nav;
  if (!nav) return;
  const completada = !nav.raf; // si aún se mueve, se registra como cancelada
  try {
    await db.liberar(nav.vehiculo.id, completada ? 'completada' : 'cancelada');
    toast(`Unidad ${nav.vehiculo.placa} liberada (${completada ? 'servicio completado' : 'servicio cancelado'})`, 'ok');
  } catch (e) {
    toast(`No se pudo liberar la unidad: ${msgError(e)}`, 'error');
    return;
  }
  detenerNavegacion();
  await refrescarFlota();
  actualizarBotonDespacho();
}

async function refrescarFlota() {
  try {
    state.vehiculos = await db.vehiculos();
    renderVehiculos();
    actualizarSelectUnidad();
    await renderDespachos();
  } catch (e) {
    console.warn(e);
  }
}

/* =============================================================================
 * 15. PANEL: UNIDADES, BITÁCORA, CONGESTIÓN
 * ========================================================================== */
function setTipo(tipo) {
  state.tipo = tipo;
  document.querySelectorAll('.seg[data-tipo]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tipo === tipo)));
  actualizarSelectUnidad();
  reevaluar();
}

function actualizarSelectUnidad() {
  const sel = $('selUnidad');
  const delTipo = state.vehiculos.filter((v) => v.tipo === state.tipo);
  const disponibles = delTipo.filter((v) => v.estado === 'disponible');
  const ocupadas = delTipo.filter((v) => v.estado !== 'disponible');
  const o = state.origen;
  const dist = (v) => (o ? kmEntre(o.lat, o.lng, v.latitud, v.longitud) : 0);
  if (o) disponibles.sort((a, b) => dist(a) - dist(b)); // la más cercana primero

  sel.innerHTML = '';
  if (!disponibles.length) sel.append(new Option('— Sin unidades disponibles —', ''));
  for (const v of disponibles) {
    sel.append(new Option(`${v.placa} · ${v.base || 'Sin base'}${o ? ` · ${dist(v).toFixed(1)} km` : ''}`, v.id));
  }
  for (const v of ocupadas) {
    const op = new Option(`${v.placa} · en servicio`, v.id);
    op.disabled = true;
    sel.append(op);
  }

  // Conserva la elección si sigue disponible; si no, la más cercana
  const vigente = disponibles.find((v) => v.id === state.vehiculoId);
  state.vehiculoId = vigente ? vigente.id : (disponibles[0]?.id ?? null);
  sel.value = state.vehiculoId ?? '';

  const v = state.vehiculos.find((x) => x.id === state.vehiculoId);
  $('txtUnidadInfo').textContent = v
    ? `${disponibles.length} disponible(s) de ${delTipo.length}${o ? ` · seleccionada a ${dist(v).toFixed(1)} km de la emergencia (línea recta)` : ''}`
    : `Todas las unidades de este tipo están en servicio (${delTipo.length}).`;
  actualizarBotonDespacho();
}

async function renderDespachos() {
  $('txtModo').textContent = state.modoDemo ? 'demo · en memoria' : 'Supabase';
  $('txtModo').className = `ml-auto normal-case tracking-normal ${state.modoDemo ? 'text-amber-300' : 'text-green-300'}`;
  const lista = $('listaDespachos');
  try {
    const filas = await db.ultimosDespachos();
    if (!filas.length) {
      lista.innerHTML = '<li class="text-slate-500">Aún no hay despachos registrados.</li>';
      return;
    }
    const badge = { en_curso: 'text-lime-300', completada: 'text-slate-400', cancelada: 'text-red-300' };
    lista.innerHTML = filas.map((f) => `
      <li class="flex items-start gap-2 rounded-lg bg-panel2/60 px-2.5 py-2">
        <span class="font-mono text-slate-500">#${Number(f.id)}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-slate-200"><b>${esc(f.vehiculo?.placa)}</b> → ${esc(f.hospital?.nombre)}</span>
          <span class="text-slate-500">${Number(f.tiempo_estimado_min).toFixed(1)} min · ${Number(f.distancia_km).toFixed(1)} km ·
            ${new Date(f.fecha_registro).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima' })}</span>
        </span>
        <span class="${badge[f.estado] || ''} shrink-0 font-semibold">${esc(String(f.estado).replace('_', ' '))}</span>
      </li>`).join('');
  } catch (e) {
    lista.innerHTML = `<li class="text-red-300">No se pudo cargar la bitácora: ${esc(msgError(e))}</li>`;
  }
}

function actualizarTextoCongestion() {
  const c = congestionActual();
  const { hora } = horaLima();
  $('txtCongestion').textContent = c.automatica
    ? `Ahora (${String(hora).padStart(2, '0')}:00 en Lima): ${c.etiqueta.toLowerCase()} · multiplicador ×${c.factor}`
    : `${c.etiqueta} · multiplicador ×${c.factor}`;
}

function iniciarReloj() {
  const tick = () => {
    $('reloj').textContent = new Date().toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour12: false });
  };
  tick();
  setInterval(tick, 1000);
  setInterval(actualizarTextoCongestion, 60000);
}

/* ---------- Panel lateral en móvil ---------- */
function abrirSidebar() {
  $('sidebar').classList.remove('-translate-x-full');
  $('backdrop').classList.remove('hidden');
  $('btnMenu').setAttribute('aria-expanded', 'true');
}
function cerrarSidebar() {
  if (window.matchMedia('(min-width: 1024px)').matches) return;
  $('sidebar').classList.add('-translate-x-full');
  $('backdrop').classList.add('hidden');
  $('btnMenu').setAttribute('aria-expanded', 'false');
}

/* =============================================================================
 * 16. ENLACE DE EVENTOS DE LA INTERFAZ
 * ========================================================================== */
function enlazarUI() {
  // Tipo de vehículo
  document.querySelectorAll('.seg[data-tipo]').forEach((b) => b.addEventListener('click', () => setTipo(b.dataset.tipo)));
  $('selUnidad').addEventListener('change', (e) => {
    state.vehiculoId = e.target.value ? Number(e.target.value) : null;
    actualizarSelectUnidad();
  });

  // Origen
  $('btnMarcar').addEventListener('click', () => setModoMarcar(!state.modoMarcar));
  $('btnMiUbicacion').addEventListener('click', usarMiUbicacion);
  $('btnFijar').addEventListener('click', fijarCoordenadas);
  [$('inpLat'), $('inpLng')].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') fijarCoordenadas(); }));
  $('btnBuscar').addEventListener('click', buscarDireccion);
  $('inpBuscar').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); buscarDireccion(); } });
  $('listaBusqueda').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lat]');
    if (!b) return;
    $('listaBusqueda').classList.add('hidden');
    setOrigen(Number(b.dataset.lat), Number(b.dataset.lng), { centrar: true });
    cerrarSidebar();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#listaBusqueda, #inpBuscar, #btnBuscar')) $('listaBusqueda').classList.add('hidden');
  });

  // Preferencias que solo requieren reevaluar (sin nuevas llamadas a OSRM)
  $('chkAvenidas').addEventListener('change', reevaluar);
  $('selCongestion').addEventListener('change', () => { actualizarTextoCongestion(); reevaluar(); });

  // Filtros: cambian el conjunto de candidatos → se pide recalcular
  const alCambiarFiltros = () => {
    $('lblSaturacion').textContent = `${$('rngSaturacion').value}%`;
    renderHospitales();
    if (state.resultados.length) {
      $('resAviso').textContent = 'Los filtros cambiaron. Presione "Calcular ruta óptima" para actualizar los destinos.';
      $('resAviso').classList.remove('hidden');
    }
  };
  $('chipsCategoria').addEventListener('change', alCambiarFiltros);
  $('rngSaturacion').addEventListener('input', alCambiarFiltros);

  // Acciones principales
  $('btnCalcular').addEventListener('click', () => { calcularRutaOptima(); cerrarSidebar(); });
  $('btnDespachar').addEventListener('click', despachar);
  $('btnCobertura').addEventListener('click', alternarCobertura);
  $('btnFinalizar').addEventListener('click', finalizarNavegacion);
  $('listaCandidatos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-idx]');
    if (b) seleccionarResultado(Number(b.dataset.idx), { encuadrar: true });
  });

  // Móvil y teclado
  $('btnMenu').addEventListener('click', () =>
    ($('sidebar').classList.contains('-translate-x-full') ? abrirSidebar() : cerrarSidebar()));
  $('backdrop').addEventListener('click', cerrarSidebar);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.modoMarcar) setModoMarcar(false); });
}

/* =============================================================================
 * 17. ARRANQUE
 * ========================================================================== */
async function iniciar() {
  initMapa();
  enlazarUI();
  iniciarReloj();
  actualizarTextoCongestion();

  await db.init();
  try {
    [state.hospitales, state.vehiculos] = await Promise.all([db.hospitales(), db.vehiculos()]);
  } catch (e) {
    toast(`No se pudieron cargar los datos: ${msgError(e)}`, 'error');
  }

  renderHospitales();
  renderVehiculos();
  actualizarSelectUnidad();
  await renderDespachos();
  db.suscribir();

  if (state.modoDemo) {
    toast('Modo demo: configure SUPABASE_URL y SUPABASE_ANON_KEY en app.js para guardar despachos.', 'info');
  }
}

document.addEventListener('DOMContentLoaded', iniciar);
