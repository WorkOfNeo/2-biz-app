-- Historical movements for Stock section per style/color/size
create table if not exists public.style_stock_movements (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.jobs(id) on delete set null,
  style_no text not null,
  color text not null,
  size text not null,
  prev_value int,
  value int not null,
  delta int not null,
  scraped_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_style_stock_movements_style_color_size on public.style_stock_movements(style_no, color, size, scraped_at);
create index if not exists idx_style_stock_movements_job on public.style_stock_movements(job_id);


