import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const gemini = new GoogleGenerativeAI(Bun.env.GEMINI_API_KEY ?? "");
const claude = Bun.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: Bun.env.ANTHROPIC_API_KEY })
  : null;

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export interface InvoiceData {
  seller_gstin: string | null;
  buyer_gstin: string | null;
  invoice_number: string | null;
  invoice_date: string | null;  // ISO date YYYY-MM-DD
  taxable_amount: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  total_amount: number | null;
  hsn_codes: string[];
  irn: string | null;           // e-Invoice Reference Number (64-char hex, mandatory for turnover >₹5Cr)
  confidence: number;           // 0-1
}

export interface ParseResult {
  data: InvoiceData;
  model: "gemini" | "claude";
  cost_paise: number;  // approximate cost in Indian paise
  raw_text: string;
}

const EXTRACTION_PROMPT = `Extract GST invoice data and return ONLY valid JSON matching this schema:
{
  "seller_gstin": "string or null",
  "buyer_gstin": "string or null",
  "invoice_number": "string or null",
  "invoice_date": "YYYY-MM-DD or null",
  "taxable_amount": number or null,
  "cgst": number or null,
  "sgst": number or null,
  "igst": number or null,
  "total_amount": number or null,
  "hsn_codes": ["array", "of", "strings"],
  "irn": "64-character hex string or null",
  "confidence": 0.0 to 1.0
}

Rules:
- All amounts in rupees (numbers, not strings)
- GSTIN must be 15 characters if present
- invoice_date in YYYY-MM-DD format
- irn: the e-Invoice Reference Number printed as a QR code or plain text (64-char hex); null if not present
- confidence: 0.9+ if all major fields clear, 0.7-0.9 if some fields unclear, <0.7 if image quality poor
- Return ONLY the JSON object, no explanation`;

async function parseWithGemini(imageBase64: string, mimeType: string): Promise<{ text: string; cost_paise: number }> {
  const model = gemini.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent([
    EXTRACTION_PROMPT,
    {
      inlineData: {
        data: imageBase64,
        mimeType,
      },
    },
  ]);
  const text = result.response.text();
  // Gemini 2.0 Flash: ~$0.0001/1k tokens input, ~$0.0004/1k output
  // Rough estimate: 500 input tokens + 200 output = ~₹0.05 = 5 paise
  return { text, cost_paise: 5 };
}

async function parseWithClaude(imageBase64: string, mimeType: string): Promise<{ text: string; cost_paise: number }> {
  const response = await claude!.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: imageBase64,
            },
          },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      },
    ],
  });
  const text = (response.content[0] as { text: string }).text;
  // Claude Haiku 4.5: ~$0.80/1M input, $4/1M output tokens
  // Rough estimate: 2000 input (image) + 300 output = ~₹0.15 = 15 paise
  return { text, cost_paise: 15 };
}

function extractJson(text: string): InvoiceData | null {
  // Strip markdown code blocks if present
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return JSON.parse(cleaned) as InvoiceData;
  } catch {
    // Try to find JSON object in response
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as InvoiceData;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function isValid(data: InvoiceData): boolean {
  // Confidence check
  if (data.confidence < 0.85) return false;

  // GSTIN format validation (at least one must be present and valid)
  const sellerOk = !data.seller_gstin || GSTIN_REGEX.test(data.seller_gstin);
  const buyerOk = !data.buyer_gstin || GSTIN_REGEX.test(data.buyer_gstin);
  if (!sellerOk || !buyerOk) return false;

  // At least one GSTIN must be present for a GST invoice
  if (!data.seller_gstin && !data.buyer_gstin) return false;

  // Date sanity check (must be within last 3 years)
  if (data.invoice_date) {
    const invoiceDate = new Date(data.invoice_date);
    const now = new Date();
    const threeYearsAgo = new Date(now.getFullYear() - 3, now.getMonth(), now.getDate());
    if (invoiceDate > now || invoiceDate < threeYearsAgo) return false;
  }

  // Math check: taxable_amount + taxes should roughly equal total (within ₹2)
  if (data.taxable_amount !== null && data.total_amount !== null) {
    const taxTotal = (data.cgst ?? 0) + (data.sgst ?? 0) + (data.igst ?? 0);
    const calculatedTotal = data.taxable_amount + taxTotal;
    if (Math.abs(calculatedTotal - data.total_amount) > 2) return false;
  }

  // Total amount must be positive
  if (data.total_amount !== null && data.total_amount <= 0) return false;

  return true;
}

export async function parseInvoice(
  imageBase64: string,
  mimeType = "image/jpeg"
): Promise<ParseResult> {
  // Step 1: Try Gemini (cheap — ~₹0.03/invoice at scale)
  let geminiText: string;
  let geminiFailed = false;

  let geminiResult: { data: InvoiceData; cost_paise: number } | null = null;

  try {
    const { text, cost_paise } = await parseWithGemini(imageBase64, mimeType);
    geminiText = text;

    const parsed = extractJson(text);
    if (parsed) {
      geminiResult = { data: parsed, cost_paise };
      if (isValid(parsed)) {
        return { data: parsed, model: "gemini", cost_paise, raw_text: text };
      }
    }
  } catch (err) {
    console.error("Gemini parse failed:", err);
    geminiText = "";
    geminiFailed = true;
  }

  // Step 2: Fallback to Claude (better accuracy, ~10% of invoices)
  console.log(geminiFailed ? "Gemini API error, falling back to Claude" : "Gemini validation failed, falling back to Claude");

  if (!claude) {
    // No Claude configured — return Gemini's best effort (even if low confidence)
    if (geminiResult) {
      return { data: geminiResult.data, model: "gemini", cost_paise: geminiResult.cost_paise, raw_text: geminiText };
    }
    throw new Error("No AI provider available — set GEMINI_API_KEY or ANTHROPIC_API_KEY");
  }

  const { text: claudeText, cost_paise: claudeCost } = await parseWithClaude(imageBase64, mimeType);
  const parsed = extractJson(claudeText);

  if (!parsed) {
    // Both failed — return empty result with error marker
    return {
      data: {
        seller_gstin: null,
        buyer_gstin: null,
        invoice_number: null,
        invoice_date: null,
        taxable_amount: null,
        cgst: null,
        sgst: null,
        igst: null,
        total_amount: null,
        hsn_codes: [],
        irn: null,
        confidence: 0,
      },
      model: "claude",
      cost_paise: claudeCost,
      raw_text: claudeText,
    };
  }

  return {
    data: parsed,
    model: "claude",
    cost_paise: claudeCost,
    raw_text: claudeText,
  };
}
