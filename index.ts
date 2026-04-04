import { handleVerification, handleWebhook } from "./src/whatsapp/webhook";
import { handleApiRoute } from "./src/routes/api";
import { handleDemoRoute } from "./src/routes/demo";
import index from "./frontend/index.html";

const PORT = Number(Bun.env.PORT ?? 3000);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

Bun.serve({
  port: PORT,
  routes: {
    // ── Frontend ────────────────────────────────────────────────────────────
    "/": index,

    // ── Demo routes (no auth, CORS open) ────────────────────────────────────
    "/demo/*": {
      GET: (req) => handleDemoRoute(req),
      POST: (req) => handleDemoRoute(req),
      OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders }),
    },

    // ── WhatsApp Webhook ────────────────────────────────────────────────────
    // GET: Meta verifies the webhook URL on setup
    // POST: Incoming messages from WhatsApp users
    "/webhook": {
      GET: (req) => {
        return handleVerification(new URL(req.url));
      },
      POST: async (req) => {
        try {
          const body = await req.json() as Parameters<typeof handleWebhook>[0];
          // Process async, return 200 immediately (WhatsApp requires < 5s response)
          handleWebhook(body).catch((err) => console.error("Webhook handler error:", err));
        } catch {
          // Ignore malformed payloads silently
        }
        return new Response("OK", { status: 200 });
      },
    },

    // ── REST API ────────────────────────────────────────────────────────────
    "/api/*": {
      GET: (req) => handleApiRoute(req),
      POST: (req) => handleApiRoute(req),
    },

    // ── Health check ────────────────────────────────────────────────────────
    "/health": {
      GET: () => new Response(JSON.stringify({ ok: true, ts: new Date().toISOString() }), {
        headers: { "Content-Type": "application/json" },
      }),
    },
  },

  // 404 fallback
  fetch(req) {
    return new Response("Not found", { status: 404 });
  },

  error(err) {
    console.error("Server error:", err);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`🚀 TaxPilot GST SaaS running on http://localhost:${PORT}`);
console.log(`   GET  /            — Demo frontend`);
console.log(`   POST /demo/parse  — AI invoice parsing`);
console.log(`   GET  /demo/dashboard — CA dashboard mock`);
console.log(`   GET  /demo/stats  — Platform stats`);
console.log(`   POST /webhook     — WhatsApp messages`);
console.log(`   GET  /api/*       — REST API`);
console.log(`   GET  /health      — Health check`);
