import { parseInvoice } from "../parser/invoice-parser";
import { supabase } from "../db/client";
import { sendWhatsAppMessage, downloadMediaFile } from "./client";
import { runReconciliation } from "../gst/reconciliation";

const VERIFY_TOKEN = Bun.env.WHATSAPP_VERIFY_TOKEN!;

// ── Webhook verification (GET) ────────────────────────────────────────────────
export function handleVerification(url: URL): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("WhatsApp webhook verified");
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// ── Incoming message handler (POST) ──────────────────────────────────────────
export async function handleWebhook(body: WhatsAppWebhookBody): Promise<void> {
  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  if (!value?.messages?.length) return;

  for (const message of value.messages) {
    const from = message.from; // sender's WhatsApp number (with country code, no +)
    const msgId = message.id;

    // Look up the business by phone number
    const { data: business } = await supabase
      .from("businesses")
      .select("id, plan, trial_ends_at, legal_name")
      .eq("phone", from)
      .single();

    if (!business) {
      await sendWhatsAppMessage(from, `Hi! Your number isn't registered. Please ask your CA to add you, or WhatsApp us at this number to get started.`);
      continue;
    }

    // Check if trial has expired
    if (business.plan === "trial" && new Date(business.trial_ends_at) < new Date()) {
      await sendWhatsAppMessage(from, `Your 60-day free trial has ended. Please ask your CA to upgrade your plan to continue.`);
      continue;
    }

    // Route by message type
    if (message.type === "image") {
      await handleInvoiceMedia(message.image!.id, message.image!.mime_type ?? "image/jpeg", business, from, msgId);
    } else if (message.type === "document") {
      const doc = message.document!;
      if (doc.mime_type === "application/pdf") {
        await handleInvoiceMedia(doc.id, "application/pdf", business, from, msgId);
      } else {
        await sendWhatsAppMessage(from, `Please send invoices as a *photo* or *PDF*. Other file types are not supported.`);
      }
    } else if (message.type === "text") {
      await handleTextMessage(message.text!.body, business, from);
    } else {
      await sendWhatsAppMessage(from, `Send me a *photo* or *PDF of an invoice* and I'll extract all the GST details automatically.`);
    }
  }
}

// ── Invoice media: parse image or PDF ────────────────────────────────────────
async function handleInvoiceMedia(
  mediaId: string,
  mimeTypeHint: string,
  business: { id: string; legal_name: string | null },
  from: string,
  msgId: string
): Promise<void> {
  await sendWhatsAppMessage(from, `Got it! Analysing your invoice... ⏳`);

  try {
    // Download the media file from WhatsApp
    const { base64, mimeType } = await downloadMediaFile(mediaId);

    // Parse with AI cascade (Gemini → Claude fallback)
    const result = await parseInvoice(base64, mimeType);
    const d = result.data;

    // Store file in Supabase Storage
    const ext = mimeType === "application/pdf" ? "pdf" : "jpg";
    const filename = `${business.id}/${Date.now()}.${ext}`;
    const imageBytes = Buffer.from(base64, "base64");
    await supabase.storage.from("invoices").upload(filename, imageBytes, {
      contentType: mimeType,
      upsert: false,
    });
    const { data: urlData } = supabase.storage.from("invoices").getPublicUrl(filename);

    // Save invoice to database
    const { data: invoice, error } = await supabase
      .from("invoices")
      .insert({
        business_id: business.id,
        whatsapp_msg_id: msgId,
        image_url: urlData.publicUrl,
        raw_text: result.raw_text,
        parsed: d,
        seller_gstin: d.seller_gstin,
        buyer_gstin: d.buyer_gstin,
        invoice_number: d.invoice_number,
        invoice_date: d.invoice_date,
        taxable_amount: d.taxable_amount,
        cgst: d.cgst,
        sgst: d.sgst,
        igst: d.igst,
        total_amount: d.total_amount,
        hsn_codes: d.hsn_codes,
        irn: d.irn,
        status: d.confidence > 0 ? "parsed" : "error",
        parse_error: d.confidence === 0 ? "Could not extract data from image" : null,
      })
      .select("id")
      .single();

    if (error) throw error;

    // Send success reply
    if (d.confidence === 0) {
      await sendWhatsAppMessage(from, `❌ Couldn't read this invoice clearly. Please try:
• Better lighting
• Hold phone steady
• Capture full invoice including corners`);
    } else {
      const taxType = d.igst ? `IGST: ₹${d.igst}` : `CGST: ₹${d.cgst ?? 0} | SGST: ₹${d.sgst ?? 0}`;
      const reply = `✅ *Invoice Parsed* (via ${result.model === "gemini" ? "AI" : "AI+"})\n\n` +
        `📄 Invoice #${d.invoice_number ?? "—"}\n` +
        `📅 Date: ${d.invoice_date ?? "—"}\n` +
        `🏢 Seller GSTIN: ${d.seller_gstin ?? "—"}\n` +
        `💰 Taxable: ₹${d.taxable_amount?.toFixed(2) ?? "—"}\n` +
        `🧾 ${taxType}\n` +
        `💳 Total: ₹${d.total_amount?.toFixed(2) ?? "—"}\n` +
        (d.hsn_codes.length ? `🔖 HSN: ${d.hsn_codes.join(", ")}\n` : "") +
        (d.irn ? `🔏 e-Invoice: ✓ IRN verified\n` : "") +
        `\n_Confidence: ${Math.round(d.confidence * 100)}%_`;
      await sendWhatsAppMessage(from, reply);
    }
  } catch (err) {
    console.error("Invoice processing error:", err);
    await sendWhatsAppMessage(from, `⚠️ Something went wrong. Please try again or send a clearer photo.`);
  }
}

// ── Text commands ─────────────────────────────────────────────────────────────
async function handleTextMessage(
  text: string,
  business: { id: string; legal_name: string | null },
  from: string
): Promise<void> {
  const lower = text.toLowerCase().trim();

  if (lower === "hi" || lower === "hello" || lower === "start") {
    await sendWhatsAppMessage(from, `👋 Welcome ${business.legal_name ?? ""}!\n\nSend me a *photo of any purchase invoice* and I'll extract the GST details and save them for reconciliation.\n\nType *status* for your ITC summary or *reconcile* to check this month's GSTR-2B matches.`);
  } else if (lower === "status") {
    await handleStatusCommand(business.id, from);
  } else if (lower === "reconcile") {
    await handleReconcileCommand(business.id, from);
  } else if (lower === "help") {
    await sendWhatsAppMessage(from, `*GST Assistant Commands:*\n\n📸 *Photo* → Parse any invoice\n📊 *status* → ITC summary this month\n🔄 *reconcile* → Match invoices vs GSTR-2B\n❓ *help* → Show this menu`);
  } else {
    await sendWhatsAppMessage(from, `Send me a *photo of an invoice* to get started, or type *help* for all commands.`);
  }
}

async function handleStatusCommand(businessId: string, from: string): Promise<void> {
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const startOfMonth = `${period}-01`;

  const { data: invoices } = await supabase
    .from("invoices")
    .select("total_amount, cgst, sgst, igst, status")
    .eq("business_id", businessId)
    .gte("invoice_date", startOfMonth)
    .eq("status", "parsed");

  if (!invoices?.length) {
    await sendWhatsAppMessage(from, `No invoices recorded this month yet. Send me invoice photos to start tracking!`);
    return;
  }

  const totalITC = invoices.reduce((sum, inv) => sum + (inv.cgst ?? 0) + (inv.sgst ?? 0) + (inv.igst ?? 0), 0);
  const totalPurchases = invoices.reduce((sum, inv) => sum + (inv.total_amount ?? 0), 0);

  await sendWhatsAppMessage(from, `📊 *This Month (${period})*\n\n` +
    `📄 Invoices: ${invoices.length}\n` +
    `💳 Total Purchases: ₹${totalPurchases.toFixed(2)}\n` +
    `✅ ITC Claimable: ₹${totalITC.toFixed(2)}\n\n` +
    `Type *reconcile* to match against GSTR-2B.`);
}

async function handleReconcileCommand(businessId: string, from: string): Promise<void> {
  await sendWhatsAppMessage(from, `🔄 Running reconciliation... This takes ~30 seconds.`);
  try {
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const result = await runReconciliation(businessId, period);

    await sendWhatsAppMessage(from, `✅ *Reconciliation Complete (${period})*\n\n` +
      `✅ Matched: ${result.matched_count}\n` +
      `⚠️ Mismatches: ${result.mismatches.length}\n` +
      `💰 ITC Claimable: ₹${result.itc_claimable.toFixed(2)}\n` +
      `🚨 ITC at Risk: ₹${result.itc_at_risk.toFixed(2)}\n\n` +
      (result.mismatches.length > 0
        ? `Your CA has been notified of ${result.mismatches.length} mismatch(es).`
        : `All invoices matched! 🎉`));
  } catch (err) {
    console.error("Reconciliation error:", err);
    await sendWhatsAppMessage(from, `⚠️ Reconciliation failed. Your CA will be notified. Please try again later.`);
  }
}

// ── TypeScript interfaces ─────────────────────────────────────────────────────
interface WhatsAppWebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppMessage[];
      };
    }>;
  }>;
}

interface WhatsAppMessage {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string };
  document?: { id: string; mime_type: string; filename?: string };
}
