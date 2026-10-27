-- =============================================================================
--  MINI-WAZE DE EMERGENCIAS · PERÚ
--  Esquema Supabase (PostgreSQL 15+ / PostGIS 3)
--
--  Uso: Supabase Dashboard → SQL Editor → pegar TODO el script → Run.
--  El script es idempotente: puede ejecutarse varias veces sin duplicar datos.
--
--  Contenido
--    0. Extensiones
--    1. Tablas (establecimientos_salud, vehiculos_emergencia, rutas_emergencia)
--    2. Triggers de auditoría
--    3. Funciones RPC (hospitales_cercanos, despachar_unidad, liberar_unidad)
--    4. Row Level Security (RLS) y políticas
--    5. Permisos (GRANT / REVOKE)
--    6. Realtime
--    7. Datos semilla (Lima Metropolitana y Callao)
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. EXTENSIONES
--    Supabase recomienda instalar PostGIS en el esquema "extensions".
-- -----------------------------------------------------------------------------
create extension if not exists postgis with schema extensions;


-- -----------------------------------------------------------------------------
-- 1. TABLAS
-- -----------------------------------------------------------------------------

-- 1.1 Establecimientos de salud
--     Fuente oficial recomendada: RENIPRESS (SUSALUD), sucesor del RENAES-MINSA,
--     que publica código IPRESS, categoría y coordenadas de cada establecimiento.
--     Nota: por Ley N.º 27604 todo establecimiento debe atender emergencias,
--     por eso se incluyen también EsSalud y Gobiernos Regionales.
create table if not exists public.establecimientos_salud (
  id                bigint generated always as identity primary key,
  codigo_renipress  text unique,
  nombre            text not null unique,
  categoria         text not null
                    check (categoria in ('I-1','I-2','I-3','I-4',
                                         'II-1','II-2','II-E',
                                         'III-1','III-2','III-E')),
  institucion       text not null default 'MINSA',
  latitud           double precision not null check (latitud  between -18.5 and 0.1),
  longitud          double precision not null check (longitud between -81.5 and -68.5),
  nivel_saturacion  smallint not null default 0 check (nivel_saturacion between 0 and 100),
  tiene_emergencia  boolean not null default true,
  -- Punto geográfico calculado automáticamente desde latitud/longitud (WGS84).
  ubicacion         extensions.geometry(Point, 4326)
                    generated always as (
                      extensions.st_setsrid(extensions.st_makepoint(longitud, latitud), 4326)
                    ) stored,
  actualizado_en    timestamptz not null default now()
);

comment on table  public.establecimientos_salud is 'IPRESS con servicio de emergencia (RENIPRESS/SUSALUD, ex-RENAES).';
comment on column public.establecimientos_salud.nivel_saturacion is 'Ocupación de emergencia en % (0-100). Penaliza la elección del destino.';
comment on column public.establecimientos_salud.ubicacion is 'Columna generada: POINT(longitud latitud) SRID 4326.';

create index if not exists establecimientos_salud_ubicacion_gix
  on public.establecimientos_salud using gist (ubicacion);
create index if not exists establecimientos_salud_categoria_idx
  on public.establecimientos_salud (categoria);


-- 1.2 Vehículos de emergencia
create table if not exists public.vehiculos_emergencia (
  id              bigint generated always as identity primary key,
  tipo            text not null check (tipo in ('ambulancia', 'bombero')),
  placa           text not null unique,
  base            text,
  latitud         double precision not null check (latitud  between -18.5 and 0.1),
  longitud        double precision not null check (longitud between -81.5 and -68.5),
  estado          text not null default 'disponible'
                  check (estado in ('disponible', 'en_servicio')),
  ubicacion       extensions.geometry(Point, 4326)
                  generated always as (
                    extensions.st_setsrid(extensions.st_makepoint(longitud, latitud), 4326)
                  ) stored,
  actualizado_en  timestamptz not null default now()
);

comment on table public.vehiculos_emergencia is 'Flota de ambulancias y unidades de bomberos.';

create index if not exists vehiculos_emergencia_ubicacion_gix
  on public.vehiculos_emergencia using gist (ubicacion);
create index if not exists vehiculos_emergencia_tipo_estado_idx
  on public.vehiculos_emergencia (tipo, estado);


-- 1.3 Rutas de emergencia (bitácora de despachos)
create table if not exists public.rutas_emergencia (
  id                   bigint generated always as identity primary key,
  vehiculo_id          bigint not null references public.vehiculos_emergencia(id) on delete restrict,
  hospital_id          bigint not null references public.establecimientos_salud(id) on delete restrict,
  origen_lat           double precision not null check (origen_lat between -18.5 and 0.1),
  origen_lng           double precision not null check (origen_lng between -81.5 and -68.5),
  tiempo_estimado_min  numeric(6,1) not null check (tiempo_estimado_min >= 0),
  distancia_km         numeric(7,2) not null check (distancia_km >= 0),
  prioridad_avenidas   boolean not null default false,
  estado               text not null default 'en_curso'
                       check (estado in ('en_curso', 'completada', 'cancelada')),
  geometria            extensions.geometry(LineString, 4326),
  fecha_registro       timestamptz not null default now(),
  fecha_cierre         timestamptz
);

comment on table public.rutas_emergencia is 'Registro de cada despacho: origen, destino, ETA y trazado.';

create index if not exists rutas_emergencia_fecha_idx    on public.rutas_emergencia (fecha_registro desc);
create index if not exists rutas_emergencia_vehiculo_idx on public.rutas_emergencia (vehiculo_id);
create index if not exists rutas_emergencia_hospital_idx on public.rutas_emergencia (hospital_id);
create index if not exists rutas_emergencia_geom_gix     on public.rutas_emergencia using gist (geometria);
-- Una unidad no puede tener dos rutas activas a la vez.
create unique index if not exists rutas_emergencia_una_activa_uix
  on public.rutas_emergencia (vehiculo_id) where estado = 'en_curso';


-- -----------------------------------------------------------------------------
-- 2. TRIGGERS DE AUDITORÍA
-- -----------------------------------------------------------------------------
create or replace function public.tg_set_actualizado_en()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;

drop trigger if exists set_actualizado_en on public.establecimientos_salud;
create trigger set_actualizado_en
  before update on public.establecimientos_salud
  for each row execute function public.tg_set_actualizado_en();

drop trigger if exists set_actualizado_en on public.vehiculos_emergencia;
create trigger set_actualizado_en
  before update on public.vehiculos_emergencia
  for each row execute function public.tg_set_actualizado_en();


-- -----------------------------------------------------------------------------
-- 3. FUNCIONES RPC
-- -----------------------------------------------------------------------------

-- 3.1 hospitales_cercanos
--     Preselección por distancia en línea recta usando el índice GiST (KNN "<->").
--     El frontend luego refina con tiempos reales de red vial (OSRM).
create or replace function public.hospitales_cercanos(
  p_lat             double precision,
  p_lng             double precision,
  p_categorias      text[]  default null,
  p_saturacion_max  integer default 100,
  p_limite          integer default 6
)
returns table (
  id                bigint,
  nombre            text,
  categoria         text,
  institucion       text,
  latitud           double precision,
  longitud          double precision,
  nivel_saturacion  smallint,
  distancia_km      double precision
)
language sql
stable
set search_path = public, extensions
as $$
  with origen as (
    select st_setsrid(st_makepoint(p_lng, p_lat), 4326) as geom
  )
  select e.id, e.nombre, e.categoria, e.institucion, e.latitud, e.longitud,
         e.nivel_saturacion,
         st_distance(e.ubicacion::geography, o.geom::geography) / 1000.0 as distancia_km
  from public.establecimientos_salud e
  cross join origen o
  where e.tiene_emergencia
    and (p_categorias is null or e.categoria = any (p_categorias))
    and e.nivel_saturacion <= coalesce(p_saturacion_max, 100)
  order by e.ubicacion <-> o.geom
  limit greatest(1, least(coalesce(p_limite, 6), 25));
$$;

comment on function public.hospitales_cercanos is
  'Devuelve los N establecimientos con emergencia más cercanos (línea recta) que cumplen filtros de categoría y saturación.';


-- 3.2 despachar_unidad
--     Registra la ruta y marca la unidad "en_servicio" en UNA transacción.
--     SECURITY DEFINER: el cliente nunca escribe directamente en las tablas.
create or replace function public.despachar_unidad(
  p_vehiculo_id          bigint,
  p_hospital_id          bigint,
  p_origen_lat           double precision,
  p_origen_lng           double precision,
  p_tiempo_estimado_min  numeric,
  p_distancia_km         numeric,
  p_prioridad_avenidas   boolean default false,
  p_geometria            jsonb   default null   -- GeoJSON LineString devuelto por OSRM
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_estado  text;
  v_id      bigint;
  v_fecha   timestamptz;
  v_geom    geometry;
begin
  -- Bloquea la fila de la unidad para evitar doble despacho concurrente.
  select estado into v_estado
  from public.vehiculos_emergencia
  where id = p_vehiculo_id
  for update;

  if not found then
    raise exception 'La unidad % no existe', p_vehiculo_id using errcode = 'P0002';
  end if;
  if v_estado <> 'disponible' then
    raise exception 'La unidad % no está disponible (estado actual: %)', p_vehiculo_id, v_estado
      using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.establecimientos_salud where id = p_hospital_id) then
    raise exception 'El establecimiento % no existe', p_hospital_id using errcode = 'P0002';
  end if;

  if p_geometria is not null then
    if p_geometria ->> 'type' is distinct from 'LineString' then
      raise exception 'p_geometria debe ser un GeoJSON de tipo LineString' using errcode = '22023';
    end if;
    v_geom := st_setsrid(st_geomfromgeojson(p_geometria::text), 4326);
  end if;

  insert into public.rutas_emergencia (
    vehiculo_id, hospital_id, origen_lat, origen_lng,
    tiempo_estimado_min, distancia_km, prioridad_avenidas, geometria
  )
  values (
    p_vehiculo_id, p_hospital_id, p_origen_lat, p_origen_lng,
    round(p_tiempo_estimado_min, 1), round(p_distancia_km, 2),
    coalesce(p_prioridad_avenidas, false), v_geom
  )
  returning id, fecha_registro into v_id, v_fecha;

  update public.vehiculos_emergencia
  set estado = 'en_servicio'
  where id = p_vehiculo_id;

  return jsonb_build_object('ruta_id', v_id, 'fecha_registro', v_fecha);
end;
$$;

comment on function public.despachar_unidad is
  'Despacha una unidad disponible: inserta en rutas_emergencia y cambia la unidad a en_servicio (atómico).';


-- 3.3 liberar_unidad
--     Cierra la ruta activa de la unidad y la devuelve a "disponible".
create or replace function public.liberar_unidad(
  p_vehiculo_id   bigint,
  p_estado_final  text default 'completada'
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_estado_final not in ('completada', 'cancelada') then
    raise exception 'Estado final inválido: % (use completada o cancelada)', p_estado_final
      using errcode = '22023';
  end if;

  update public.rutas_emergencia
  set estado = p_estado_final, fecha_cierre = now()
  where vehiculo_id = p_vehiculo_id and estado = 'en_curso';

  update public.vehiculos_emergencia
  set estado = 'disponible'
  where id = p_vehiculo_id;

  if not found then
    raise exception 'La unidad % no existe', p_vehiculo_id using errcode = 'P0002';
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY
--    Lectura permitida; ninguna política de INSERT/UPDATE/DELETE para clientes:
--    toda escritura pasa por las funciones SECURITY DEFINER de la sección 3.
-- -----------------------------------------------------------------------------
alter table public.establecimientos_salud enable row level security;
alter table public.vehiculos_emergencia   enable row level security;
alter table public.rutas_emergencia       enable row level security;

drop policy if exists "lectura establecimientos" on public.establecimientos_salud;
create policy "lectura establecimientos"
  on public.establecimientos_salud for select
  to anon, authenticated
  using (true);

drop policy if exists "lectura vehiculos" on public.vehiculos_emergencia;
create policy "lectura vehiculos"
  on public.vehiculos_emergencia for select
  to anon, authenticated
  using (true);

drop policy if exists "lectura rutas" on public.rutas_emergencia;
create policy "lectura rutas"
  on public.rutas_emergencia for select
  to anon, authenticated
  using (true);


-- -----------------------------------------------------------------------------
-- 5. PERMISOS
-- -----------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
-- hospitales_cercanos se ejecuta con el rol del cliente y usa funciones PostGIS.
grant usage on schema extensions to anon, authenticated;

grant select on public.establecimientos_salud,
                public.vehiculos_emergencia,
                public.rutas_emergencia
  to anon, authenticated;

-- Defensa en profundidad: aunque RLS ya bloquea escrituras, se retiran los privilegios.
revoke insert, update, delete, truncate on public.establecimientos_salud,
                                          public.vehiculos_emergencia,
                                          public.rutas_emergencia
  from anon, authenticated;

revoke execute on function public.hospitales_cercanos(double precision, double precision, text[], integer, integer) from public;
revoke execute on function public.despachar_unidad(bigint, bigint, double precision, double precision, numeric, numeric, boolean, jsonb) from public, anon;
revoke execute on function public.liberar_unidad(bigint, text) from public, anon;

grant execute on function public.hospitales_cercanos(double precision, double precision, text[], integer, integer) to anon, authenticated;
grant execute on function public.despachar_unidad(bigint, bigint, double precision, double precision, numeric, numeric, boolean, jsonb) to authenticated;
grant execute on function public.liberar_unidad(bigint, text) to authenticated;

-- ⚠️ MODO DEMO (sin pantalla de login): permite despachar con la clave anon/publishable.
--    En PRODUCCIÓN elimine estas dos líneas, agregue Supabase Auth al frontend
--    y deje el despacho solo para usuarios autenticados de la central.
grant execute on function public.despachar_unidad(bigint, bigint, double precision, double precision, numeric, numeric, boolean, jsonb) to anon;
grant execute on function public.liberar_unidad(bigint, text) to anon;


-- -----------------------------------------------------------------------------
-- 6. REALTIME
--    El mapa se actualiza solo cuando cambia el estado de una unidad
--    o la saturación de un hospital.
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['vehiculos_emergencia', 'establecimientos_salud'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- 7. DATOS SEMILLA
--    Coordenadas y categorías REFERENCIALES para pruebas en Lima/Callao.
--    Antes de operar, reemplácelas con la data oficial de RENIPRESS (SUSALUD).
--    Las placas de las unidades son ficticias.
-- -----------------------------------------------------------------------------
insert into public.establecimientos_salud
  (nombre, categoria, institucion, latitud, longitud, nivel_saturacion)
values
  ('Hospital Nacional Arzobispo Loayza',               'III-1', 'MINSA',       -12.0496, -77.0425, 92),
  ('Hospital Nacional Dos de Mayo',                    'III-1', 'MINSA',       -12.0575, -77.0156, 78),
  ('Hospital Nacional Cayetano Heredia',               'III-1', 'MINSA',       -12.0228, -77.0569, 88),
  ('Hospital Nacional Hipólito Unanue',                'III-1', 'MINSA',       -12.0440, -76.9987, 74),
  ('Hospital Nacional Sergio E. Bernales',             'III-1', 'MINSA',       -11.9207, -77.0432, 81),
  ('Hospital María Auxiliadora',                       'III-1', 'MINSA',       -12.1617, -76.9594, 86),
  ('Hospital de Emergencias José Casimiro Ulloa',      'III-E', 'MINSA',       -12.1279, -77.0178, 69),
  ('Hospital de Emergencias Villa El Salvador',        'II-E',  'MINSA',       -12.2128, -76.9345, 63),
  ('Hospital Santa Rosa',                              'III-1', 'MINSA',       -12.0757, -77.0637, 58),
  ('Hospital Nacional Docente Madre Niño San Bartolomé','III-1','MINSA',       -12.0520, -77.0410, 55),
  ('Instituto Nacional de Salud del Niño - Breña',     'III-2', 'MINSA',       -12.0634, -77.0458, 77),
  ('Hospital Nacional Daniel Alcides Carrión',         'III-1', 'GORE Callao', -12.0597, -77.1180, 83),
  ('Hospital de Emergencias Pediátricas',              'II-E',  'MINSA',       -12.0598, -77.0287, 66),
  ('Hospital de Vitarte',                              'II-2',  'MINSA',       -12.0268, -76.9198, 71),
  ('Hospital Carlos Lanfranco La Hoz',                 'II-2',  'MINSA',       -11.8650, -77.0745, 64),
  ('Hospital San Juan de Lurigancho',                  'II-2',  'MINSA',       -11.9705, -77.0003, 90),
  ('Hospital de Huaycán',                              'II-1',  'MINSA',       -12.0179, -76.8185, 52),
  ('Hospital Nacional Edgardo Rebagliati Martins',     'III-2', 'EsSalud',     -12.0790, -77.0406, 95),
  ('Hospital Nacional Guillermo Almenara Irigoyen',    'III-1', 'EsSalud',     -12.0592, -77.0232, 89)
on conflict (nombre) do nothing;

insert into public.vehiculos_emergencia (tipo, placa, base, latitud, longitud, estado)
values
  ('ambulancia', 'EUA-101', 'Base SAMU Cercado de Lima',          -12.0560, -77.0300, 'disponible'),
  ('ambulancia', 'EUA-102', 'Base SAMU San Isidro',               -12.0970, -77.0360, 'disponible'),
  ('ambulancia', 'EUA-103', 'Base SAMU San Juan de Miraflores',   -12.1550, -76.9700, 'disponible'),
  ('ambulancia', 'EUA-104', 'Base SAMU Comas',                    -11.9400, -77.0500, 'en_servicio'),
  ('ambulancia', 'EUA-105', 'Base SAMU Ate',                      -12.0300, -76.9300, 'disponible'),
  ('bombero',    'CBP-201', 'Cía. de Bomberos Lima',              -12.0480, -77.0330, 'disponible'),
  ('bombero',    'CBP-202', 'Cía. de Bomberos Miraflores',        -12.1210, -77.0290, 'disponible'),
  ('bombero',    'CBP-203', 'Cía. de Bomberos Callao',            -12.0600, -77.1350, 'disponible'),
  ('bombero',    'CBP-204', 'Cía. de Bomberos San Martín de Porres', -12.0100, -77.0700, 'disponible')
on conflict (placa) do nothing;


-- -----------------------------------------------------------------------------
-- Pruebas rápidas (descomente para ejecutar)
-- -----------------------------------------------------------------------------
-- select * from public.hospitales_cercanos(-12.0464, -77.0428, array['III-1','III-E'], 90, 5);
-- select public.despachar_unidad(1, 2, -12.0464, -77.0428, 12.5, 4.3, true, null);
-- select public.liberar_unidad(1);
