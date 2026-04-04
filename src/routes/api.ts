import { supabase } from "../db/client";
import { runReconciliation } from "../gst/reconciliation";
import { runDailyAlerts } from "../gst/alerts";

// ── Route handler: returns Response ──────────────────────────────────────────
export async function handleApiRoute(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // ── CA Dashboard API ──────────────────────────────────────────────────────

  // GET /api/ca/:caId/dashboard — summary for a CA
  if (method === "GET" && path.match(/^\/api\/ca\/[\w-]+\/dashboard$/)) {
    const caId = path.split("/")[3] ?? "";
    return casDashboard(caId);
  }

  // GET /api/ca/:caId/businesses — list all businesses for a CA
  if (method === "GET" && path.match(/^\/api\/ca\/[\w-]+\/businesses$/)) {
    const caId = path.split("/")[3] ?? "";
    return caBusinesses(caId);
  }

  // ── Business API ──────────────────────────────────────────────────────────

  // GET /api/business/:id/invoices?period=2026-03
  if (method === "GET" && path.match(/^\/api\/business\/[\w-]+\/invoices$/)) {
    const businessId = path.split("/")[3] ?? "";
    const period = url.searchParams.get("period");
    return businessInvoices(businessId, period);
  }

  // GET /api/business/:id/reconciliation?period=2026-03
  if (method === "GET" && path.match(/^\/api\/business\/[\w-]+\/reconciliation$/)) {
    const businessId = path.split("/")[3] ?? "";
    const period = url.searchParams.get("period");
    return businessReconciliation(businessId, period);
  }

  // POST /api/business/:id/reconcile — trigger reconciliation run
  if (method === "POST" && path.match(/^\/api\/business\/[\w-]+\/reconcile$/)) {
    const businessId = path.split("/")[3] ?? "";
    const body = await req.json().catch(() => ({})) as { period?: string };
    const period = body.period ?? getCurrentPeriod();
    return triggerReconciliation(businessId, period);
  }

  // ── Admin API ─────────────────────────────────────────────────────────────

  // POST /api/admin/run-alerts — trigger daily alert job
  if (method === "POST" && path === "/api/admin/run-alerts") {
    return runAlertsJob(req);
  }

  // POST /api/businesses — register a new business
  if (method === "POST" && path === "/api/businesses") {
    const body = await req.json() as BusinessRegistration;
    return registerBusiness(body);
  }

  return json({ error: "Not found" }, 404);
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function casDashboard(caId: string): Promise<Response> {
  const { data: businesses, error } = await supabase
    .from("businesses")
    .select("id, legal_name, gstin, plan, trial_ends_at")
    .eq("ca_id", caId);

  if (error) return json({ error: error.message }, 500);

  const businessIds = businesses?.map((b) => b.id) ?? [];

  // Get recent invoice counts per business
  const { data: invoiceCounts } = await supabase
    .from("invoices")
    .select("business_id")
    .in("business_id", businessIds)
    .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

  const countsByBusiness = (invoiceCounts ?? []).reduce((acc, inv) => {
    acc[inv.business_id] = (acc[inv.business_id] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Get latest reconciliation per business
  const { data: latestRecs } = await supabase
    .from("reconciliation_runs")
    .select("business_id, period, matched_count, itc_claimable, itc_at_risk, run_at")
    .in("business_id", businessIds)
    .order("run_at", { ascending: false });

  const latestRecByBusiness = (latestRecs ?? []).reduce((acc, rec) => {
    if (!acc[rec.business_id]) acc[rec.business_id] = rec;
    return acc;
  }, {} as Record<string, typeof latestRecs extends (infer T)[] | null ? T : never>);

  const dashboard = businesses?.map((b) => ({
    ...b,
    invoices_this_month: countsByBusiness[b.id] ?? 0,
    latest_reconciliation: latestRecByBusiness[b.id] ?? null,
    trial_expires_in_days: b.plan === "trial"
      ? Math.ceil((new Date(b.trial_ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      : null,
  }));

  return json({ data: dashboard });
}

async function caBusinesses(caId: string): Promise<Response> {
  const { data, error } = await supabase
    .from("businesses")
    .select("*")
    .eq("ca_id", caId)
    .order("created_at", { ascending: false });

  if (error) return json({ error: error.message }, 500);
  return json({ data });
}

async function businessInvoices(businessId: string, period: string | null): Promise<Response> {
  let query = supabase
    .from("invoices")
    .select("id, invoice_number, invoice_date, seller_gstin, total_amount, cgst, sgst, igst, status, created_at")
    .eq("business_id", businessId)
    .order("invoice_date", { ascending: false });

  if (period) {
    query = query
      .gte("invoice_date", `${period}-01`)
      .lt("invoice_date", nextMonth(period));
  }

  const { data, error } = await query.limit(100);
  if (error) return json({ error: error.message }, 500);
  return json({ data });
}

async function businessReconciliation(businessId: string, period: string | null): Promise<Response> {
  const p = period ?? getCurrentPeriod();
  const { data, error } = await supabase
    .from("reconciliation_runs")
    .select("*")
    .eq("business_id", businessId)
    .eq("period", p)
    .order("run_at", { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== "PGRST116") return json({ error: error.message }, 500);
  return json({ data: data ?? null });
}

async function triggerReconciliation(businessId: string, period: string): Promise<Response> {
  try {
    const result = await runReconciliation(businessId, period);
    return json({ data: result });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

async function runAlertsJob(req: Request): Promise<Response> {
  const adminKey = req.headers.get("x-admin-key");
  if (adminKey !== Bun.env.ADMIN_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  try {
    await runDailyAlerts();
    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

interface BusinessRegistration {
  ca_id?: string;
  gstin: string;
  legal_name?: string;
  phone?: string;
  email?: string;
}

async function registerBusiness(body: BusinessRegistration): Promise<Response> {
  if (!body.gstin || !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(body.gstin)) {
    return json({ error: "Invalid GSTIN format" }, 400);
  }

  const { data, error } = await supabase
    .from("businesses")
    .insert({
      ca_id: body.ca_id,
      gstin: body.gstin,
      legal_name: body.legal_name,
      phone: body.phone,
      email: body.email,
    })
    .select()
    .single();

  if (error) return json({ error: error.message }, 500);
  return json({ data }, 201);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getCurrentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function nextMonth(period: string): string {
  const parts = period.split("-").map(Number);
  const year = parts[0]!;
  const month = parts[1]!;
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
  return `${next}-01`;
}
