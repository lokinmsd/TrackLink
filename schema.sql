create table if not exists links (
  code text primary key, url text not null, owner bigint not null, created bigint not null
);
create table if not exists clicks (
  id bigserial primary key,
  code text not null references links(code) on delete cascade,
  ts bigint not null, country text, device text, src text
);
create index if not exists idx_clicks_code on clicks(code, ts);
create index if not exists idx_links_owner on links(owner);
-- Supabase открывает таблицы через публичный REST API. RLS без политик закрывает к ним доступ снаружи;
-- наш сервер подключается напрямую и RLS не мешает.
alter table links enable row level security;
alter table clicks enable row level security;
