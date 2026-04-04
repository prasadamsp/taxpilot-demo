import { supabase } from "../db/client";

const MASTERS_INDIA_BASE = Bun.env.MASTERS_INDIA_BASE_URL ?? "https://commonapi.mastersindia.co";
const MASTERS_API_KEY = Bun.env.MASTERS_INDIA_API_KEY!;

interface GSTR2BEntry {
  ctin: string;          // supplier GSTIN
  inum: string;          // invoice number
  dt: string;            // invoice date (DD-MM-YYYY)
  val: number;           // invoice value
  itms: Array<{
    rt: number;          // tax rate
    txval: number;       // taxable value
    igst?: number;
    cgst?: number;
    sgst?: number;
  }>;
}

interface ReconciliationResult {
  matched_count: number;
  mismatches: MismatchEntry[];
  itc_claimable: number;
  itc_at_risk: number;
}

interface MismatchEntry {
  invoice_id: string;
  invoice_number: string | null;
  seller_gstin: string | null;
  our_total: number | null;
  gstr2b_total: number | null;
  reason: string;
}

// ── Fetch GSTR-2B from Masters India API ─────────────────────────────────────
async function fetchGSTR2B(gstin: string, period: string): Promise<GSTR2BEntry[]> {
  // period format: "2026-03" → Masters India expects "032026"
  const [year, month] = period.split("-");
  const miPeriod = `${month}${year}`;

  const res = await fetch(`${MASTERS_INDIA_BASE}/commonapi/v1.0/gstr2b?gstin=${gstin}&ret_period=${miPeriod}`, {
    headers: {
      "client_id": MASTERS_API_KEY,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`GSTR-2B fetch failed for ${gstin}/${period}: ${await res.text()}`);
  }

  const data = await res.json() as { data?: { docdata?: { b2b?: Array<{ inv?: GSTR2BEntry[] }> } } };
  const b2b = data.data?.docdata?.b2b ?? [];
  return b2b.flatMap((supplier) => supplier.inv ?? []);
}

// ── Run reconciliation for a business for a given period ─────────────────────
export async function runReconciliation(businessId: string, period: string): Promise<ReconciliationResult> {
  // Get business GSTIN
  const { data: business, error: bizError } = await supabase
    .from("businesses")
    .select("gstin")
    .eq("id", businessId)
    .single();

  if (bizError || !business) throw new Error("Business not found");

  // Get our parsed invoices for the period
  const startDate = `${period}-01`;
  const parts = period.split("-").map(Number);
  const year = parts[0]!;
  const month = parts[1]!;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const endDate = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

  const { data: ourInvoices, error: invError } = await supabase
    .from("invoices")
    .select("id, seller_gstin, invoice_number, invoice_date, total_amount, cgst, sgst, igst")
    .eq("business_id", businessId)
    .gte("invoice_date", startDate)
    .lt("invoice_date", endDate)
    .eq("status", "parsed");

  if (invError) throw invError;
  if (!ourInvoices?.length) {
    return { matched_count: 0, mismatches: [], itc_claimable: 0, itc_at_risk: 0 };
  }

  // Fetch GSTR-2B from government
  let gstr2bEntries: GSTR2BEntry[] = [];
  try {
    gstr2bEntries = await fetchGSTR2B(business.gstin, period);
  } catch (err) {
    console.error("GSTR-2B fetch error:", err);
    // Continue with empty 2B — all invoices will show as "missing in 2B"
  }

  // Build lookup map: seller_gstin + invoice_number → GSTR2B entry
  const gstr2bMap = new Map<string, GSTR2BEntry>();
  for (const entry of gstr2bEntries) {
    const key = `${entry.ctin}::${entry.inum}`.toLowerCase();
    gstr2bMap.set(key, entry);
  }

  // Reconcile
  const mismatches: MismatchEntry[] = [];
  let matched_count = 0;
  let itc_claimable = 0;
  let itc_at_risk = 0;

  for (const inv of ourInvoices) {
    const invoiceITC = (inv.cgst ?? 0) + (inv.sgst ?? 0) + (inv.igst ?? 0);
    const key = `${inv.seller_gstin ?? ""}::${inv.invoice_number ?? ""}`.toLowerCase();
    const gstr2bMatch = gstr2bMap.get(key);

    if (!gstr2bMatch) {
      // Missing in GSTR-2B — ITC at risk
      mismatches.push({
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        seller_gstin: inv.seller_gstin,
        our_total: inv.total_amount,
        gstr2b_total: null,
        reason: "Not found in GSTR-2B — supplier may not have filed GSTR-1",
      });
      itc_at_risk += invoiceITC;
      continue;
    }

    // Check amount match (within ₹5 tolerance)
    const gstr2bTotal = gstr2bMatch.val;
    if (Math.abs((inv.total_amount ?? 0) - gstr2bTotal) > 5) {
      mismatches.push({
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        seller_gstin: inv.seller_gstin,
        our_total: inv.total_amount,
        gstr2b_total: gstr2bTotal,
        reason: `Amount mismatch: our ₹${inv.total_amount} vs GSTR-2B ₹${gstr2bTotal}`,
      });
      itc_at_risk += invoiceITC;
    } else {
      matched_count++;
      itc_claimable += invoiceITC;
    }
  }

  // Save reconciliation run
  const { error: runError } = await supabase.from("reconciliation_runs").insert({
    business_id: businessId,
    period,
    gstr2a_count: null,
    gstr2b_count: gstr2bEntries.length,
    matched_count,
    mismatches,
    itc_claimable,
    itc_at_risk,
  });

  if (runError) console.error("Failed to save reconciliation run:", runError);

  // Update invoice statuses
  const matchedIds = ourInvoices
    .filter((inv) => {
      const key = `${inv.seller_gstin ?? ""}::${inv.invoice_number ?? ""}`.toLowerCase();
      const match = gstr2bMap.get(key);
      return match && Math.abs((inv.total_amount ?? 0) - match.val) <= 5;
    })
    .map((inv) => inv.id);

  if (matchedIds.length) {
    await supabase.from("invoices").update({ status: "reconciled" }).in("id", matchedIds);
  }

  return { matched_count, mismatches, itc_claimable, itc_at_risk };
}
