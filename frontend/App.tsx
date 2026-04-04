import React, { useState, useRef, useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";

// ── Types ─────────────────────────────────────────────────────────────────────

interface InvoiceData {
  seller_gstin: string | null;
  buyer_gstin: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  taxable_amount: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  total_amount: number | null;
  hsn_codes: string[];
  confidence: number;
}

interface ParseResult {
  data: InvoiceData;
  model: "gemini" | "claude";
  cost_paise: number;
  raw_text: string;
  processing_seconds?: number;
  demo_mode?: boolean;
  error_note?: string;
}

type Tab = "scanner" | "dashboard" | "howto";

type LoadStep = "idle" | "uploading" | "analysing" | "validating" | "done";

// ── Constants ─────────────────────────────────────────────────────────────────

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const API_BASE = "";  // Same origin

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatINR(amount: number | null): string {
  if (amount === null) return "—";
  return "₹" + amount.toLocaleString("en-IN");
}

function isValidGSTIN(gstin: string | null): boolean {
  if (!gstin) return false;
  return GSTIN_REGEX.test(gstin);
}

function confidenceClass(c: number): "high" | "medium" | "low" {
  if (c >= 0.85) return "high";
  if (c >= 0.70) return "medium";
  return "low";
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix: "data:image/jpeg;base64,"
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Nav ───────────────────────────────────────────────────────────────────────

function Nav() {
  return (
    <nav className="nav">
      <div className="nav-brand">
        <div className="nav-brand-icon">✈</div>
        TaxPilot
      </div>
      <div className="nav-badge">Demo MVP</div>
    </nav>
  );
}

// ── Hero ──────────────────────────────────────────────────────────────────────

interface HeroProps {
  activeTab: Tab;
  onTabChange: (t: Tab) => void;
  demoMode: boolean;
}

function Hero({ activeTab, onTabChange, demoMode }: HeroProps) {
  return (
    <div className="hero">
      <div className="hero-eyebrow">
        <span>🇮🇳</span>
        Built for India's 63 million GST-registered businesses
      </div>
      <h1>
        GST on <span className="gradient">autopilot</span>
        <br />for modern CAs
      </h1>
      <p className="hero-tagline">
        AI reads your invoices in seconds. Validates GSTINs, catches mismatches,
        and protects your ITC — automatically.
      </p>

      <div className="stat-pills">
        <div className="stat-pill">
          <div className="stat-pill-dot" />
          <span className="stat-pill-value">1,247</span> invoices parsed
        </div>
        <div className="stat-pill">
          <div className="stat-pill-dot" />
          <span className="stat-pill-value">₹28.4L</span> ITC recovered
        </div>
        <div className="stat-pill">
          <div className="stat-pill-dot" />
          <span className="stat-pill-value">98.3%</span> accuracy
        </div>
      </div>

      <div className="tabs">
        <button
          className={`tab-btn ${activeTab === "scanner" ? "active" : ""}`}
          onClick={() => onTabChange("scanner")}
        >
          📸 Live Demo
        </button>
        <button
          className={`tab-btn ${activeTab === "dashboard" ? "active" : ""}`}
          onClick={() => onTabChange("dashboard")}
        >
          📊 CA Dashboard
        </button>
        <button
          className={`tab-btn ${activeTab === "howto" ? "active" : ""}`}
          onClick={() => onTabChange("howto")}
        >
          💬 How It Works
        </button>
      </div>

      {demoMode && (
        <div className="demo-banner">
          <span className="demo-banner-icon">🔑</span>
          <span>
            Connect your API keys to enable live parsing.
            Set <code>GEMINI_API_KEY</code> in <code>.env</code> for AI-powered results.
            Currently showing sample data.
          </span>
        </div>
      )}
    </div>
  );
}

// ── Invoice Scanner Tab ───────────────────────────────────────────────────────

const STEPS: { id: LoadStep; label: string; icon: string }[] = [
  { id: "uploading",  label: "Uploading image",         icon: "⬆️"  },
  { id: "analysing",  label: "Gemini analysing invoice", icon: "🤖"  },
  { id: "validating", label: "Validating fields & math", icon: "🔍"  },
  { id: "done",       label: "Extraction complete",      icon: "✅"  },
];

const STEP_ORDER: LoadStep[] = ["uploading", "analysing", "validating", "done"];

function stepStatus(step: LoadStep, current: LoadStep): "done" | "active" | "pending" {
  const si = STEP_ORDER.indexOf(step);
  const ci = STEP_ORDER.indexOf(current);
  if (current === "idle") return "pending";
  if (si < ci) return "done";
  if (si === ci) return "active";
  return "pending";
}

interface ScannerTabProps {
  onDemoModeDetected: () => void;
}

function ScannerTab({ onDemoModeDetected }: ScannerTabProps) {
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loadStep, setLoadStep] = useState<LoadStep>("idle");
  const [result, setResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((f: File) => {
    if (!f.type.startsWith("image/")) {
      setError("Please upload an image file (JPEG, PNG, WebP, etc.)");
      return;
    }
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setResult(null);
    setError(null);
    setLoadStep("idle");
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const handleParse = useCallback(async () => {
    if (!file) return;
    setError(null);
    setResult(null);

    try {
      setLoadStep("uploading");
      const base64 = await fileToBase64(file);

      setLoadStep("analysing");
      const res = await fetch(`${API_BASE}/demo/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64, mimeType: file.type || "image/jpeg" }),
      });

      setLoadStep("validating");
      const data = await res.json() as ParseResult;

      // Small delay to show the validating step
      await new Promise(r => setTimeout(r, 400));
      setLoadStep("done");
      setResult(data);

      if (data.demo_mode) onDemoModeDetected();
    } catch (err) {
      setError("Failed to connect to the server. Is it running on localhost:3000?");
      setLoadStep("idle");
    }
  }, [file, onDemoModeDetected]);

  const cLevel = result ? confidenceClass(result.data.confidence) : "high";
  const confPct = result ? Math.round(result.data.confidence * 100) : 0;

  return (
    <div className="section">
      <div className="section-title">Live Invoice Scanner</div>
      <p className="section-subtitle">
        Drop any GST invoice photo. AI extracts all 10 fields in seconds.
      </p>

      {/* Upload Zone */}
      <div
        className={`upload-zone ${dragOver ? "drag-over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <span className="upload-icon">📄</span>
        <div className="upload-title">Drop an invoice photo here or click to upload</div>
        <div className="upload-subtitle">Supports photos, scans, or screenshots of GST invoices</div>
        <div className="upload-formats">
          {["JPEG", "PNG", "WebP", "HEIC", "PDF photo"].map(fmt => (
            <span key={fmt} className="upload-format-pill">{fmt}</span>
          ))}
        </div>
        <input
          ref={inputRef}
          className="upload-input"
          type="file"
          accept="image/*"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
      </div>

      {/* Preview + Parse Button */}
      {file && previewUrl && loadStep === "idle" && (
        <div>
          <div className="preview-container">
            <img src={previewUrl} alt="Invoice preview" className="preview-image" />
            <div className="preview-info">
              <div className="preview-name">{file.name}</div>
              <div className="preview-meta">
                {(file.size / 1024).toFixed(0)} KB · {file.type}
              </div>
            </div>
          </div>
          <button className="btn-parse mt-4" onClick={handleParse}>
            <span>🚀</span> Parse Invoice with AI
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="alert-banner mt-4">
          ⚠️ {error}
        </div>
      )}

      {/* Loading Steps */}
      {loadStep !== "idle" && loadStep !== "done" && (
        <div className="loading-steps">
          <div className="loading-title">🤖 AI reading invoice...</div>
          <div className="step-list">
            {STEPS.map(s => {
              const status = stepStatus(s.id, loadStep);
              return (
                <div key={s.id} className={`step-item ${status}`}>
                  {status === "active" ? (
                    <div className="spinner" />
                  ) : (
                    <span className="step-icon">
                      {status === "done" ? "✅" : s.icon}
                    </span>
                  )}
                  {s.label}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="mt-6">
          {result.demo_mode && (
            <div className="demo-banner" style={{ marginLeft: 0, marginRight: 0, marginBottom: 16 }}>
              <span className="demo-banner-icon">ℹ️</span>
              Sample output — connect API keys for live parsing.
              {result.error_note && <span> {result.error_note}</span>}
            </div>
          )}

          <div className="results-header">
            <div className="results-title">
              ✅ Invoice Parsed
              <span className={`model-badge ${result.model}`}>
                {result.model === "gemini" ? "⚡ Gemini Flash" : "🎯 Claude claude-opus-4-6"}
              </span>
            </div>
            <div className="cost-badge">
              {result.model === "gemini"
                ? `~₹${(result.cost_paise / 100).toFixed(2)} cost`
                : `~₹${(result.cost_paise / 100).toFixed(2)} cost (fallback)`}
            </div>
          </div>

          <div className="results-grid">
            {/* Total Amount — highlighted */}
            <div className="result-field highlight">
              <div className="field-label">Total Amount</div>
              <div className="field-value large">{formatINR(result.data.total_amount)}</div>
            </div>

            {/* Seller GSTIN */}
            <div className="result-field">
              <div className="field-label">Seller GSTIN</div>
              <div className="field-value mono">
                {result.data.seller_gstin ?? "—"}
                {result.data.seller_gstin && (
                  <span className={`gstin-check ${isValidGSTIN(result.data.seller_gstin) ? "valid" : "invalid"}`}>
                    {isValidGSTIN(result.data.seller_gstin) ? "✓ Valid" : "✗ Invalid"}
                  </span>
                )}
              </div>
            </div>

            {/* Buyer GSTIN */}
            <div className="result-field">
              <div className="field-label">Buyer GSTIN</div>
              <div className="field-value mono">
                {result.data.buyer_gstin ?? "—"}
                {result.data.buyer_gstin && (
                  <span className={`gstin-check ${isValidGSTIN(result.data.buyer_gstin) ? "valid" : "invalid"}`}>
                    {isValidGSTIN(result.data.buyer_gstin) ? "✓ Valid" : "✗ Invalid"}
                  </span>
                )}
              </div>
            </div>

            {/* Invoice Number */}
            <div className="result-field">
              <div className="field-label">Invoice Number</div>
              <div className="field-value">{result.data.invoice_number ?? "—"}</div>
            </div>

            {/* Invoice Date */}
            <div className="result-field">
              <div className="field-label">Invoice Date</div>
              <div className="field-value">
                {result.data.invoice_date
                  ? new Date(result.data.invoice_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
                  : "—"}
              </div>
            </div>

            {/* Taxable Amount */}
            <div className="result-field">
              <div className="field-label">Taxable Amount</div>
              <div className="field-value">{formatINR(result.data.taxable_amount)}</div>
            </div>

            {/* CGST */}
            <div className="result-field">
              <div className="field-label">CGST</div>
              <div className="field-value">{formatINR(result.data.cgst)}</div>
            </div>

            {/* SGST */}
            <div className="result-field">
              <div className="field-label">SGST</div>
              <div className="field-value">{formatINR(result.data.sgst)}</div>
            </div>

            {/* IGST */}
            <div className="result-field">
              <div className="field-label">IGST</div>
              <div className="field-value">{formatINR(result.data.igst)}</div>
            </div>

            {/* HSN Codes */}
            <div className="result-field">
              <div className="field-label">HSN Codes</div>
              {result.data.hsn_codes.length > 0 ? (
                <div className="hsn-pills">
                  {result.data.hsn_codes.map((code, i) => (
                    <span key={i} className="hsn-pill">{code}</span>
                  ))}
                </div>
              ) : (
                <div className="field-value">—</div>
              )}
            </div>
          </div>

          {/* Confidence */}
          <div className="card">
            <div className="card-title">Extraction Confidence</div>
            <div className="confidence-row">
              <div className="confidence-bar-track">
                <div
                  className={`confidence-bar-fill ${cLevel}`}
                  style={{ width: `${confPct}%` }}
                />
              </div>
              <span className={`confidence-label ${cLevel}`}>{confPct}%</span>
            </div>
            <div className="processing-meta">
              <span>
                {result.model === "gemini" ? "⚡ Processed by Gemini Flash" : "🎯 Processed by Claude claude-opus-4-6 (fallback)"}
              </span>
              {result.processing_seconds !== undefined && (
                <span>⏱ {result.processing_seconds}s</span>
              )}
              <span>
                💸 Cost: ~₹{(result.cost_paise / 100).toFixed(2)}
                {result.model === "claude" ? " (fallback)" : ""}
              </span>
            </div>
          </div>

          {/* Parse another */}
          <button
            className="btn-parse mt-4"
            style={{ background: "var(--bg-card2)", color: "var(--text)", boxShadow: "none", border: "1px solid var(--border-light)" }}
            onClick={() => { setFile(null); setPreviewUrl(null); setResult(null); setLoadStep("idle"); }}
          >
            ↩ Parse Another Invoice
          </button>
        </div>
      )}
    </div>
  );
}

// ── CA Dashboard Tab ──────────────────────────────────────────────────────────

interface Client {
  id: string;
  name: string;
  gstin: string;
  plan: string;
  invoices_this_month: number;
  itc_claimable: number;
  status: string;
  mismatches?: number;
  trial_days_left?: number;
  last_reconciled: string | null;
}

function PlanBadge({ plan }: { plan: string }) {
  const cls = plan === "professional" ? "badge-plan-professional"
    : plan === "starter" ? "badge-plan-starter"
    : "badge-plan-trial";
  const label = plan.charAt(0).toUpperCase() + plan.slice(1);
  return <span className={`badge ${cls}`}>{label}</span>;
}

function StatusBadge({ client }: { client: Client }) {
  if (client.status === "reconciled") return <span className="status-badge status-reconciled">✅ Reconciled</span>;
  if (client.status === "mismatch") return <span className="status-badge status-mismatch">⚠️ {client.mismatches} mismatches</span>;
  if (client.status === "pending") return <span className="status-badge status-pending">🔄 Pending</span>;
  if (client.status === "trial") return <span className="status-badge status-trial">⏰ Trial ({client.trial_days_left}d left)</span>;
  return null;
}

function ActionBtn({ client }: { client: Client }) {
  if (client.status === "reconciled") return <button className="action-btn">View</button>;
  if (client.status === "mismatch") return <button className="action-btn primary">Fix</button>;
  if (client.status === "pending") return <button className="action-btn primary">Reconcile</button>;
  if (client.status === "trial") return <button className="action-btn primary">Upgrade</button>;
  return null;
}

function DashboardTab() {
  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });

  const clients: Client[] = [
    { id: "1", name: "Sharma Textiles Pvt Ltd",     gstin: "29AABCS1234A1Z5", plan: "professional", invoices_this_month: 47, itc_claimable: 38400,  status: "reconciled", last_reconciled: "2026-03-28" },
    { id: "2", name: "Patel Pharma Distributors",   gstin: "24AAECP5678B1Z2", plan: "starter",      invoices_this_month: 23, itc_claimable: 128000, status: "mismatch",   mismatches: 2, last_reconciled: "2026-03-25" },
    { id: "3", name: "Krishna Auto Spares",          gstin: "27AACKM9012C1Z8", plan: "professional", invoices_this_month: 61, itc_claimable: 52100,  status: "reconciled", last_reconciled: "2026-03-29" },
    { id: "4", name: "Gupta Steel Works",            gstin: "06AACFG3456D1Z4", plan: "starter",      invoices_this_month: 8,  itc_claimable: 6200,   status: "pending",    last_reconciled: null },
    { id: "5", name: "Mehta Electronics",            gstin: "33AABCM7890E1Z1", plan: "trial",        invoices_this_month: 15, itc_claimable: 9800,   status: "trial",      trial_days_left: 42, last_reconciled: "2026-03-20" },
  ];

  const totalITC = clients.reduce((s, c) => s + c.itc_claimable, 0);

  return (
    <div className="section">
      <div className="dashboard-header">
        <div>
          <div className="dashboard-greeting">Good morning, CA Sharma 👋</div>
          <div className="dashboard-date">{today}</div>
        </div>
      </div>

      {/* Summary */}
      <div className="summary-grid">
        <div className="summary-card">
          <div className="summary-value text-gold">5</div>
          <div className="summary-label">Active Clients</div>
        </div>
        <div className="summary-card">
          <div className="summary-value" style={{ color: "var(--blue)" }}>3</div>
          <div className="summary-label">Pending Reconciliation</div>
        </div>
        <div className="summary-card">
          <div className="summary-value text-green">₹{(totalITC / 100000).toFixed(1)}L</div>
          <div className="summary-label">Total ITC This Month</div>
        </div>
        <div className="summary-card">
          <div className="summary-value" style={{ color: "var(--red)" }}>2</div>
          <div className="summary-label">Deadlines This Week</div>
        </div>
      </div>

      {/* Alert Banner */}
      <div className="alert-banner">
        ⚠️ GSTR-1 due in 7 days (11th April). 3 clients not yet filed.
      </div>

      {/* Client Table */}
      <div className="table-container">
        <div className="table-header">
          <span>Client Portfolio</span>
          <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 400 }}>March 2026</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Business</th>
              <th>Plan</th>
              <th>Invoices</th>
              <th>ITC Claimable</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {clients.map(c => (
              <tr key={c.id}>
                <td data-label="Business">
                  <div className="business-name">{c.name}</div>
                  <div className="business-gstin">{c.gstin}</div>
                </td>
                <td data-label="Plan"><PlanBadge plan={c.plan} /></td>
                <td data-label="Invoices">
                  <span className="font-bold">{c.invoices_this_month}</span>
                  <span className="text-muted" style={{ fontSize: 12 }}> this month</span>
                </td>
                <td data-label="ITC Claimable">
                  <span className="font-bold text-green">{formatINR(c.itc_claimable)}</span>
                </td>
                <td data-label="Status"><StatusBadge client={c} /></td>
                <td data-label="Action"><ActionBtn client={c} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="disclaimer">All data is sample data for demo purposes only.</div>
    </div>
  );
}

// ── How It Works Tab ──────────────────────────────────────────────────────────

interface WaBubble {
  type: "sent" | "received";
  text: string;
  time: string;
}

const WA_MESSAGES: WaBubble[] = [
  { type: "sent",     text: "📎 [Invoice Image]",                                                                                   time: "10:14 AM" },
  { type: "received", text: "Got it! Analysing your invoice... ⏳",                                                                 time: "10:14 AM" },
  { type: "received", text: "✅ Invoice Parsed\n📄 Invoice #INV-2024-892\n📅 Date: 15-Mar-2026\n🏢 Seller: 29AABCS1234A1Z5\n💰 Taxable: ₹32,400\n🧾 CGST: ₹2,916 | SGST: ₹2,916\n💳 Total: ₹38,232\nConfidence: 97%", time: "10:14 AM" },
  { type: "sent",     text: "reconcile",                                                                                             time: "10:15 AM" },
  { type: "received", text: "🔄 Running reconciliation... This takes ~30 seconds.",                                                  time: "10:15 AM" },
  { type: "received", text: "✅ Reconciliation Complete (2026-03)\n✅ Matched: 21\n⚠️ Mismatches: 2\n💰 ITC Claimable: ₹1,24,800\n🚨 ITC at Risk: ₹12,400\nYour CA has been notified.", time: "10:15 AM" },
];

function HowItWorksTab() {
  const [visibleMessages, setVisibleMessages] = useState<number>(0);
  const [started, setStarted] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !started) {
          setStarted(true);
        }
      },
      { threshold: 0.2 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [started]);

  useEffect(() => {
    if (!started) return;
    if (visibleMessages >= WA_MESSAGES.length) return;

    const delay = visibleMessages === 0 ? 600 : 800;
    const timer = setTimeout(() => {
      setVisibleMessages(v => v + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [started, visibleMessages]);

  return (
    <div className="section" ref={sectionRef}>
      <div className="section-title">How TaxPilot Works</div>
      <p className="section-subtitle">
        Three steps. Ten seconds. Zero spreadsheets.
      </p>

      {/* Steps */}
      <div className="how-steps">
        <div className="step-card">
          <span className="step-emoji">📸</span>
          <div className="step-number">1</div>
          <div className="step-title">Photo</div>
          <div className="step-desc">
            Business owner WhatsApps an invoice photo. Any format. Any quality.
          </div>
          <div className="step-time">10 seconds</div>
        </div>

        <div className="step-arrow">→</div>

        <div className="step-card">
          <span className="step-emoji">🤖</span>
          <div className="step-number">2</div>
          <div className="step-title">AI Reads</div>
          <div className="step-desc">
            Gemini extracts all 10 GST fields. Validates GSTIN format,
            checks math, verifies dates.
          </div>
          <div className="step-time">98.3% accuracy</div>
        </div>

        <div className="step-arrow">→</div>

        <div className="step-card">
          <span className="step-emoji">✅</span>
          <div className="step-number">3</div>
          <div className="step-title">CA Notified</div>
          <div className="step-desc">
            Mismatch? CA gets a WhatsApp alert instantly.
            ITC safe. No surprises at month-end.
          </div>
          <div className="step-time">₹28.4L ITC saved</div>
        </div>
      </div>

      {/* WhatsApp Simulation */}
      <div className="section-title" style={{ marginBottom: 20 }}>Live WhatsApp Demo</div>
      <div className="whatsapp-container">
        <div className="whatsapp-header">
          <div className="wa-avatar">🤖</div>
          <div>
            <div className="wa-name">TaxPilot Bot</div>
            <div className="wa-status">● online</div>
          </div>
        </div>
        <div className="whatsapp-body">
          {WA_MESSAGES.slice(0, visibleMessages).map((msg, i) => (
            <div key={i} className={`wa-bubble ${msg.type}`}>
              {msg.text}
              <span className="wa-time">{msg.time}</span>
            </div>
          ))}
          {/* Typing indicator — show between messages */}
          {started && visibleMessages > 0 && visibleMessages < WA_MESSAGES.length &&
            WA_MESSAGES[visibleMessages]?.type === "received" && (
            <div className="wa-bubble typing">
              <div className="typing-dot" />
              <div className="typing-dot" />
              <div className="typing-dot" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("scanner");
  const [demoMode, setDemoMode] = useState(false);

  return (
    <>
      <Nav />
      <Hero
        activeTab={activeTab}
        onTabChange={setActiveTab}
        demoMode={demoMode}
      />

      {activeTab === "scanner" && (
        <ScannerTab onDemoModeDetected={() => setDemoMode(true)} />
      )}
      {activeTab === "dashboard" && <DashboardTab />}
      {activeTab === "howto" && <HowItWorksTab />}

      <footer className="footer">
        <strong>TaxPilot</strong> · Demo MVP ·
        GST SaaS for India's 63 million businesses ·
        Powered by Gemini + Claude AI
      </footer>
    </>
  );
}

// ── Mount ─────────────────────────────────────────────────────────────────────

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
