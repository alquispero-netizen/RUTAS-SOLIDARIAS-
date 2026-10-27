# Mini-Waze de Emergencias · Perú

Central de monitoreo que sugiere el establecimiento de salud más conveniente y la ruta más rápida para ambulancias y bomberos.

## Archivos

| Archivo | Contenido |
|---|---|
| `schema.sql` | Tablas PostGIS, índices, RPCs (`hospitales_cercanos`, `despachar_unidad`, `liberar_unidad`), RLS, permisos, Realtime y datos semilla |
| `index.html` | Dashboard (Tailwind, modo oscuro) |
| `app.js` | Leaflet + OSRM + Turf + Supabase, comentado por secciones |

## Puesta en marcha

1. **Base de datos**: Supabase → SQL Editor → pegar `schema.sql` → Run (se puede volver a ejecutar sin duplicar datos).
2. **Credenciales**: en `app.js` → `CONFIG.SUPABASE_URL` y `CONFIG.SUPABASE_ANON_KEY` (clave *publishable/anon*, nunca la `service_role`).
   Si se dejan vacías, la app corre en **modo demo** con los mismos datos en memoria.
3. **Servir** la carpeta con cualquier servidor estático:
   ```bash
   npx serve .        # o: python -m http.server 8080
   ```

## Cómo decide la ruta

1. PostGIS preselecciona los 6 establecimientos más cercanos que cumplen categoría y saturación máxima.
2. OSRM `/table` compara el tiempo por red vial y se quedan los 3 mejores.
3. OSRM `/route` (con alternativas) traza cada uno; cada tramo se reevalúa según:
   tipo de vía (avenida / jirón-calle / pasaje, deducido del nombre OSM) × congestión por hora de Lima × efecto sirena × perfil del vehículo.
4. Destino elegido = menor **ETA + espera estimada por saturación** (0 min bajo 70 %, hasta +12 min al 100 %).

Los factores están en `PERFILES` y `NIVELES_CONGESTION` de `app.js`: son heurísticos y conviene calibrarlos con los tiempos reales que se acumulen en `rutas_emergencia`.

## Mapa base

Por defecto se usa **Esri Dark Gray Canvas** (sin API key), que funciona incluso abriendo `index.html` con doble clic. En el selector de capas también están Calles (Esri) y OpenStreetMap.
OpenStreetMap responde **403 "Access blocked"** si la página se abre como archivo (`file://`), porque exige el encabezado Referer: para usarlo, sirva la carpeta con `npx serve .` o `python -m http.server`.
CARTO Dark Matter ya no se usa porque exige API key. Para una central en producción conviene un proveedor con cuenta propia (MapTiler, Stadia, etc.).

## Antes de producción

- Reemplazar la semilla por la data oficial de **RENIPRESS (SUSALUD)**: las coordenadas incluidas son referenciales.
- Agregar **Supabase Auth** y quitar los dos `grant ... to anon` marcados como *MODO DEMO* en `schema.sql`.
- El servidor público de OSRM es de demostración (≈1 solicitud/s, sin tráfico en vivo). Para operación real, desplegar OSRM propio con el extracto de Perú de Geofabrik y cambiar `CONFIG.OSRM_URL`.
