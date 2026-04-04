const PHONE_NUMBER_ID = Bun.env.WHATSAPP_PHONE_NUMBER_ID!;
const TOKEN = Bun.env.WHATSAPP_TOKEN!;
const API_BASE = `https://graph.facebook.com/v19.0`;

// ── Send a text message ───────────────────────────────────────────────────────
export async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  const res = await fetch(`${API_BASE}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WhatsApp send failed: ${err}`);
  }
}

// ── Download a media file (image/document) as base64 ─────────────────────────
export async function downloadMediaFile(mediaId: string): Promise<{ base64: string; mimeType: string }> {
  // Step 1: Get the media URL
  const metaRes = await fetch(`${API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!metaRes.ok) throw new Error(`Failed to get media URL: ${await metaRes.text()}`);
  const meta = await metaRes.json() as { url: string; mime_type: string };

  // Step 2: Download the actual file
  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!fileRes.ok) throw new Error(`Failed to download media: ${await fileRes.text()}`);

  const buffer = await fileRes.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  return { base64, mimeType: meta.mime_type };
}
