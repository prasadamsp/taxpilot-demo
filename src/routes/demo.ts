import { parseInvoice } from "../parser/invoice-parser";

// ── CORS headers for demo routes (no auth) ───────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

// ── Mock data ─────────────────────────────────────────────────────────────────

const MOCK_PARSE_RESULT = {
  demo_mode: true,
  data: {
    seller_gstin: "29AABCS1234A1Z5",
    buyer_gstin: "27AACKM9012C1Z8",
    invoice_number: "INV-2024-892",
    invoice_date: "2026-03-15",
    taxable_amount: 32400,
    cgst: 2916,
    sgst: 2916,
    igst: null,
    total_amount: 38232,
    hsn_codes: ["6006", "5208"],
    confidence: 0.97,
  },
  model: "gemini" as const,
  cost_paise: 5,
  raw_text: "(sample data — connect GEMINI_API_KEY for live parsing)",
  processing_seconds: 2.1,
};

const MOCK_DASHBOARD = {
  ca_name: "CA Sharma",
  period: "2026-03",
  summary: {
    total_clients: 5,
    pending_reconciliation: 3,
    total_itc_this_month: 419300,
    deadlines_this_week: 2,
  },
  clients: [
    {
      id: "1",
      name: "Sharma Textiles Pvt Ltd",
      gstin: "29AABCS1234A1Z5",
      plan: "professional",
      invoices_this_month: 47,
      itc_claimable: 38400,
      status: "reconciled",
      last_reconciled: "2026-03-28",
    },
    {
      id: "2",
      name: "Patel Pharma Distributors",
      gstin: "24AAECP5678B1Z2",
      plan: "starter",
      invoices_this_month: 23,
      itc_claimable: 128000,
      status: "mismatch",
      mismatches: 2,
      last_reconciled: "2026-03-25",
    },
    {
      id: "3",
      name: "Krishna Auto Spares",
      gstin: "27AACKM9012C1Z8",
      plan: "professional",
      invoices_this_month: 61,
      itc_claimable: 52100,
      status: "reconciled",
      last_reconciled: "2026-03-29",
    },
    {
      id: "4",
      name: "Gupta Steel Works",
      gstin: "06AACFG3456D1Z4",
      plan: "starter",
      invoices_this_month: 8,
      itc_claimable: 6200,
      status: "pending",
      last_reconciled: null,
    },
    {
      id: "5",
      name: "Mehta Electronics",
      gstin: "33AABCM7890E1Z1",
      plan: "trial",
      invoices_this_month: 15,
      itc_claimable: 9800,
      status: "trial",
      trial_days_left: 42,
      last_reconciled: "2026-03-20",
    },
  ],
};

const MOCK_STATS = {
  invoices_parsed: 1247,
  itc_recovered: 2840000,
  time_saved_hours: 312,
  accuracy: 98.3,
};

// ── Route handler ─────────────────────────────────────────────────────────────

export async function handleDemoRoute(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // GET /demo/dashboard
  if (method === "GET" && path === "/demo/dashboard") {
    return json(MOCK_DASHBOARD);
  }

  // GET /demo/stats
  if (method === "GET" && path === "/demo/stats") {
    return json(MOCK_STATS);
  }

  // POST /demo/parse
  if (method === "POST" && path === "/demo/parse") {
    // If no API key is set, return mock data
    if (!Bun.env.GEMINI_API_KEY && !Bun.env.ANTHROPIC_API_KEY) {
      return json(MOCK_PARSE_RESULT);
    }

    let body: { image?: string; mimeType?: string };
    try {
      body = await req.json() as { image?: string; mimeType?: string };
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.image) {
      return json({ error: "Missing required field: image (base64 string)" }, 400);
    }

    const mimeType = body.mimeType ?? "image/jpeg";
    const start = Date.now();

    try {
      const result = await parseInvoice(body.image, mimeType);
      const processing_seconds = ((Date.now() - start) / 1000).toFixed(1);
      return json({ ...result, processing_seconds: Number(processing_seconds) });
    } catch (err) {
      console.error("Demo parse error:", err);
      // Graceful fallback: return mock data with error note
      return json({
        ...MOCK_PARSE_RESULT,
        demo_mode: true,
        error_note: "Live parsing failed — showing sample data. Check API keys.",
      });
    }
  }

  return json({ error: "Not found" }, 404);
}
