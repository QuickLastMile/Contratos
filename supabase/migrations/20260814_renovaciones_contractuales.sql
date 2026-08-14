-- Gestión contractual: contactos, renovación automática y aprobaciones.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

alter table public.contratos
  add column if not exists renovacion_automatica boolean not null default false,
  add column if not exists periodo_meses integer,
  add column if not exists plantilla_path text;

create table if not exists public.contrato_contactos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  rol text not null check (rol in ('lider','jefe','cliente')),
  nombre text,
  cedula text,
  email text not null,
  creado_en timestamptz not null default now(),
  unique(cliente_id, rol, email)
);

create table if not exists public.contrato_renovaciones (
  id uuid primary key default gen_random_uuid(),
  contrato_id uuid not null references public.contratos(id) on delete cascade,
  fecha_inicio_anterior date not null,
  fecha_fin_anterior date not null,
  fecha_inicio_nueva date not null,
  fecha_fin_nueva date not null,
  documento_path text,
  estado text not null default 'pendiente_aprobacion'
    check (estado in ('pendiente_aprobacion','aprobado','rechazado','aplicado')),
  token_lider uuid not null default gen_random_uuid(),
  token_jefe uuid not null default gen_random_uuid(),
  aprobacion_lider boolean,
  aprobacion_jefe boolean,
  aprobado_lider_en timestamptz,
  aprobado_jefe_en timestamptz,
  procesado_en timestamptz,
  notificado_en timestamptz,
  creado_en timestamptz not null default now(),
  unique(contrato_id, fecha_fin_anterior)
);
create table if not exists public.contrato_notificaciones (
  id uuid primary key default gen_random_uuid(),
  contrato_id uuid not null references public.contratos(id) on delete cascade,
  tipo text not null,
  fecha_vencimiento date not null,
  enviado_en timestamptz not null default now(),
  unique(contrato_id,tipo,fecha_vencimiento)
);

insert into public.contrato_contactos(cliente_id,rol,nombre,email)
select cliente_id,'cliente',nombre,email from public.contrato_responsables
on conflict (cliente_id,rol,email) do nothing;

alter table public.contrato_contactos enable row level security;
alter table public.contrato_renovaciones enable row level security;

drop policy if exists "contactos autenticados" on public.contrato_contactos;
create policy "contactos autenticados" on public.contrato_contactos
  for all to authenticated using (true) with check (true);
drop policy if exists "renovaciones autenticadas" on public.contrato_renovaciones;
create policy "renovaciones autenticadas" on public.contrato_renovaciones
  for select to authenticated using (true);

create or replace function public.meses_contrato(inicio date, fin date)
returns integer language sql immutable as $$
  select greatest(1, round((fin-inicio)::numeric / 30.4375)::int);
$$;

create or replace function public.registrar_aprobacion(token uuid, decision boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.contrato_renovaciones; actor text;
begin
  select * into r from public.contrato_renovaciones
  where token_lider=token or token_jefe=token for update;
  if not found then raise exception 'Enlace de aprobación inválido'; end if;
  if r.estado not in ('pendiente_aprobacion','aprobado') then
    return jsonb_build_object('ok',false,'estado',r.estado);
  end if;
  actor := case when r.token_lider=token then 'lider' else 'jefe' end;
  if actor='lider' then
    update public.contrato_renovaciones set aprobacion_lider=decision, aprobado_lider_en=now() where id=r.id;
  else
    update public.contrato_renovaciones set aprobacion_jefe=decision, aprobado_jefe_en=now() where id=r.id;
  end if;
  if not decision then
    update public.contrato_renovaciones set estado='rechazado' where id=r.id;
  elsif (actor='lider' and r.aprobacion_jefe is true) or (actor='jefe' and r.aprobacion_lider is true) then
    update public.contrato_renovaciones set estado='aprobado' where id=r.id;
  end if;
  return jsonb_build_object('ok',true,'actor',actor,'decision',decision);
end; $$;
grant execute on function public.registrar_aprobacion(uuid,boolean) to anon, authenticated;

create or replace view public.v_contratos_v2 with (security_invoker=true) as
select c.*,
  cl.nombre as proyecto,
  (c.fecha_vencimiento-current_date)::int as dias_restantes,
  case
    when c.estado = 'terminado' then c.estado
    when c.fecha_vencimiento < current_date then 'vencido'
    when c.fecha_vencimiento <= current_date+7 then 'critico'
    when c.fecha_vencimiento <= current_date+15 then 'urgente'
    when c.fecha_vencimiento <= current_date+30 then 'por_vencer'
    else 'vigente'
  end as estado_visual
from public.contratos c join public.clientes cl on cl.id=c.cliente_id;
grant select on public.v_contratos_v2 to authenticated;

-- Después de desplegar la Edge Function, guarde project_url y automation_key en Vault
-- y active este job desde SQL Editor:
-- select cron.schedule('renovaciones-contractuales','*/15 * * * *',$$
--   select net.http_post(
--     url := (select decrypted_secret from vault.decrypted_secrets where name='project_url') || '/functions/v1/renovaciones-contractuales',
--     headers := jsonb_build_object('Content-Type','application/json','apikey',(select decrypted_secret from vault.decrypted_secrets where name='automation_key')),
--     body := '{}'::jsonb
--   );
-- $$);
