import { supabase } from "../db/client";
import { sendWhatsAppMessage } from "../whatsapp/client";

// GST filing deadlines (day of month) — regular (monthly) taxpayers
const REGULAR_DEADLINES = {
  gstr1_due: 11,    // GSTR-1 due 11th of the following month
  gstr3b_due: 20,   // GSTR-3B due 20th of the following month
};

// QRMP scheme deadlines (quarterly filers under ₹5Cr turnover)
// IFF (Invoice Furnishing Facility): 13th of M1 and M2 within the quarter
// GSTR-3B quarterly: 22nd (Cat X states) or 24th (Cat Y states) of month after quarter-end
// PMT-06 (tax payment): 25th of each month
const QRMP_DEADLINES = {
  iff_due: 13,       // IFF for month 1 & 2 of quarter
  pmt06_due: 25,     // Monthly tax payment via PMT-06
};

// ── Run daily alert check (call this from a cron or scheduler) ────────────────
export async function runDailyAlerts(): Promise<void> {
  const now = new Date();
  const day = now.getDate();

  // Send reminders 3 days before and 1 day before deadline
  const regularAlerts: Array<{ type: string; daysUntil: number }> = [];
  for (const [alertType, dueDay] of Object.entries(REGULAR_DEADLINES)) {
    if (day === dueDay - 3 || day === dueDay - 1 || day === dueDay) {
      regularAlerts.push({ type: alertType, daysUntil: dueDay - day });
    }
  }

  const qrmpAlerts: Array<{ type: string; daysUntil: number }> = [];
  for (const [alertType, dueDay] of Object.entries(QRMP_DEADLINES)) {
    if (day === dueDay - 3 || day === dueDay - 1 || day === dueDay) {
      qrmpAlerts.push({ type: alertType, daysUntil: dueDay - day });
    }
  }

  if (!regularAlerts.length && !qrmpAlerts.length) return;

  // Get all active businesses with phone numbers
  const { data: businesses } = await supabase
    .from("businesses")
    .select("id, phone, legal_name, plan, trial_ends_at, ca_id, taxpayer_type")
    .not("phone", "is", null)
    .or("plan.neq.trial,trial_ends_at.gt." + now.toISOString());

  if (!businesses?.length) return;

  const today = now.toISOString().split("T")[0]!;

  for (const business of businesses) {
    const isQrmp = business.taxpayer_type === "qrmp";
    const alerts = isQrmp ? qrmpAlerts : regularAlerts;

    for (const alert of alerts) {
      const { data: existing } = await supabase
        .from("alerts_sent")
        .select("id")
        .eq("business_id", business.id)
        .eq("alert_type", alert.type)
        .gte("sent_at", `${today}T00:00:00Z`)
        .single();

      if (existing) continue;

      const message = buildAlertMessage(alert.type, alert.daysUntil, business.legal_name, isQrmp);
      await sendWhatsAppMessage(business.phone!, message);

      await supabase.from("alerts_sent").insert({
        business_id: business.id,
        alert_type: alert.type,
      });
    }
  }
}

function buildAlertMessage(alertType: string, daysUntil: number, businessName: string | null, isQrmp = false): string {
  const name = businessName ?? "Business";
  const timing = daysUntil === 0 ? "*TODAY*" : daysUntil === 1 ? "*TOMORROW*" : `in *${daysUntil} days*`;

  if (alertType === "gstr1_due") {
    return `🔔 *GST Reminder — ${name}*\n\nGSTR-1 (Sales Return) is due ${timing}!\n\n📋 Ensure all sales invoices are uploaded on the GST portal.\n\n_Reply HELP for assistance_`;
  }
  if (alertType === "gstr3b_due") {
    return `🔔 *GST Reminder — ${name}*\n\nGSTR-3B (Tax Payment) is due ${timing}!\n\n💳 Ensure sufficient balance in your GST cash ledger.\n\nSend me an invoice photo to check your ITC balance first.\n\n_Reply HELP for assistance_`;
  }
  if (alertType === "iff_due") {
    return `🔔 *GST Reminder — ${name}* (QRMP Scheme)\n\nIFF (Invoice Furnishing Facility) is due ${timing}!\n\n📋 Upload B2B invoices for this month via the GST portal → Returns → IFF.\n\n_Reply HELP for assistance_`;
  }
  if (alertType === "pmt06_due") {
    return `🔔 *GST Reminder — ${name}* (QRMP Scheme)\n\nPMT-06 (Monthly Tax Payment) is due ${timing}!\n\n💳 Pay your GST liability via PMT-06 on the GST portal before the deadline to avoid interest.\n\n_Reply HELP for assistance_`;
  }
  return `🔔 GST deadline ${timing} for ${name}`;
}

// ── Notify CA when mismatches are found ───────────────────────────────────────
export async function notifyCAOfMismatches(
  businessId: string,
  period: string,
  mismatchCount: number,
  itcAtRisk: number
): Promise<void> {
  const { data: business } = await supabase
    .from("businesses")
    .select("legal_name, ca_id")
    .eq("id", businessId)
    .single();

  if (!business?.ca_id) return;

  const { data: ca } = await supabase
    .from("cas")
    .select("phone, name")
    .eq("id", business.ca_id)
    .single();

  if (!ca?.phone) return;

  const message = `⚠️ *ITC Mismatch Alert*\n\nClient: ${business.legal_name ?? "Unknown"}\nPeriod: ${period}\n\n🚨 ${mismatchCount} invoice(s) not found in GSTR-2B\n💰 ITC at Risk: ₹${itcAtRisk.toFixed(2)}\n\nPlease review on the CA Dashboard.`;
  await sendWhatsAppMessage(ca.phone, message);
}
