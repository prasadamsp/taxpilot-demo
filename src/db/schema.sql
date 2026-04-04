-- Run this in your Supabase SQL editor
-- dashboard.supabase.com → SQL Editor → paste and run

-- ── CAs (Chartered Accountants — your distribution channel) ──────────────
create table if not exists cas (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text unique not null,
  email       text unique,
  city        text,
  icai_number text,
  commission_rate numeric default 0.20,  -- 20% of subscription revenue
  status      text default 'active',
  created_at  timestamptz default now()
);

-- ── Businesses (MSME clients of CAs) ─────────────────────────────────────
create table if not exists businesses (
  id            uuid primary key default gen_random_uuid(),
  ca_id         uuid references cas(id),
  gstin         text unique not null,
  legal_name    text,
  trade_name    text,
  phone         text,
  email         text,
  state_code    text,
  plan          text default 'trial',   -- trial | starter | professional
  trial_ends_at timestamptz default now() + interval '60 days',
  created_at    timestamptz default now()
);

-- ── Invoices (parsed via Claude Vision) ──────────────────────────────────
create table if not exists invoices (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses(id),
  whatsapp_msg_id text,
  image_url       text,                 -- stored in Supabase Storage
  raw_text        text,                 -- Claude's raw response
  parsed          jsonb,                -- structured extracted data
  -- Key extracted fields (also in parsed jsonb, duplicated for easy querying)
  seller_gstin    text,
  buyer_gstin     text,
  invoice_number  text,
  invoice_date    date,
  taxable_amount  numeric,
  cgst            numeric,
  sgst            numeric,
  igst            numeric,
  total_amount    numeric,
  hsn_codes       text[],
  status          text default 'parsed', -- parsed | reconciled | error
  parse_error     text,
  created_at      timestamptz default now()
);

-- ── GST Reconciliation results ───────────────────────────────────────────
create table if not exists reconciliation_runs (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses(id),
  period          text not null,        -- e.g. "2026-03"
  gstr2a_count    int,
  gstr2b_count    int,
  matched_count   int,
  mismatches      jsonb,                -- array of mismatched invoice details
  itc_claimable   numeric,
  itc_at_risk     numeric,
  run_at          timestamptz default now()
);

-- ── Deadline alerts log ───────────────────────────────────────────────────
create table if not exists alerts_sent (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid references businesses(id),
  alert_type   text,                   -- gstr1_due | gstr3b_due | itc_mismatch
  sent_at      timestamptz default now(),
  whatsapp_msg_id text
);

-- ── Indexes ───────────────────────────────────────────────────────────────
create index if not exists idx_invoices_business on invoices(business_id);
create index if not exists idx_invoices_buyer_gstin on invoices(buyer_gstin);
create index if not exists idx_businesses_ca on businesses(ca_id);
create index if not exists idx_businesses_gstin on businesses(gstin);
