import { supabase } from "../db/client";
import { sendWhatsAppMessage } from "../whatsapp/client";

// GST filing deadlines (day of month)
const DEADLINES = {
  gstr1_due: 11,    // GSTR-1 due on 11th of next month
  gstr3b_due: 20,   // GSTR-3B due on 20th of next month
};

// ── Run daily alert check (call this from a cron or scheduler) ────────────────
export async function runDailyAlerts(): Promise<void> {
  const now = new Date();
  const day = now.getDate();
  const month = now.getMonth() + 1; // 1-12
  const year = now.getFullYear();

  // Send reminders 3 days before deadline
  const alertsToSend: Array<{ type: string; daysUntil: number }> = [];

  for (const [alertType, dueDay] of Object.entries(DEADLINES)) {
    if (day === dueDay - 3 || day === dueDay - 1 || day === dueDay) {
      alertsToSend.push({ type: alertType, daysUntil: dueDay - day });
    }
  }

  if (!alertsToSend.length) return;

  // Get all active businesses with phone numbers
  const { data: businesses } = await supabase
    .from("businesses")
    .select("id, phone, legal_name, plan, trial_ends_at, ca_id")
    .not("phone", "is", null)
    .or("plan.neq.trial,trial_ends_at.gt." + now.toISOString());

  if (!businesses?.length) return;

  for (const business of businesses) {
    for (const alert of alertsToSend) {
      // Check if we already sent this alert today
      const today = now.toISOString().split("T")[0];
      const { data: existing } = await supabase
        .from("alerts_sent")
        .select("id")
        .eq("business_id", business.id)
        .eq("alert_type", alert.type)
        .gte("sent_at", `${today}T00:00:00Z`)
        .single();

      if (existing) continue; // Already sent today

      const message = buildAlertMessage(alert.type, alert.daysUntil, business.legal_name);
      await sendWhatsAppMessage(business.phone!, message);

      await supabase.from("alerts_sent").insert({
        business_id: business.id,
        alert_type: alert.type,
      });
    }
  }
}

function buildAlertMessage(alertType: string, daysUntil: number, businessName: string | null): string {
  const name = businessName ?? "Business";
  const timing = daysUntil === 0 ? "*TODAY*" : daysUntil === 1 ? "*TOMORROW*" : `in *${daysUntil} days*`;

  if (alertType === "gstr1_due") {
    return `🔔 *GST Reminder — ${name}*\n\nGSTR-1 (Sales Return) is due ${timing}!\n\n📋 Ensure all sales invoices are uploaded on GST portal.\n\n_Reply HELP for assistance_`;
  }
  if (alertType === "gstr3b_due") {
    return `🔔 *GST Reminder — ${name}*\n\nGSTR-3B (Tax Payment) is due ${timing}!\n\n💳 Ensure sufficient balance in your GST cash ledger.\n\nSend me an invoice photo to check your ITC balance first.\n\n_Reply HELP for assistance_`;
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
