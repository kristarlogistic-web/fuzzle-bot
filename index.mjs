import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SECRET_KEY = process.env.CONTROL_SECRET || "";
const API_VER = "2024-10";
const PORT = process.env.PORT || 3000;

const BASE = `https://${SHOP}/admin/api/${API_VER}`;
async function shopify(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
  if (!res.ok) throw new Error(`Shopify ${res.status} ${init.method || "GET"} ${path}: ${await res.text()}`);
  return res.json();
}

function buildDescription(p) {
  return `
<p><strong>${p.title}</strong> — designed for happy, healthy pets.</p>
<h3>Key Benefits</h3>
<ul>
<li>Supports healthy posture</li>
<li>Reduces mess & choking</li>
<li>Durable for daily use</li>
<li>Easy to clean</li>
</ul>
<h3>Product Details</h3>
<ul>
<li>Brand: ${p.vendor || "FuzzleToys"}</li>
<li>Material: Pet-safe materials</li>
</ul>
<h3>Shipping & Returns</h3>
<p>Fast US shipping. 30-day hassle-free returns.</p>
`.trim();
}

async function updateAllDescriptions({ apply = false }) {
  let sinceId = 0, updated = 0, preview = [];
  while (true) {
    const data = await shopify(`/products.json?limit=250&since_id=${sinceId}`);
    const products = data.products || [];
    if (!products.length) break;
    for (const p of products) {
      sinceId = p.id;
      const nextHtml = buildDescription(p);
      const curHtml = (p.body_html || "").trim();
      if (curHtml.slice(0,160).replace(/\s+/g," ") === nextHtml.slice(0,160).replace(/\s+/g," ")) continue;
      if (apply) {
        await shopify(`/products/${p.id}.json`, {
          method: "PUT",
          body: JSON.stringify({ product: { id: p.id, body_html: nextHtml } })
        });
        updated++;
      } else {
        preview.push({ id: p.id, title: p.title });
      }
    }
  }
  return apply ? { updated } : { preview_count: preview.length, preview };
}

async function hideOutOfStock() {
  let sinceId = 0, hidden = 0;
  while (true) {
    const data = await shopify(`/products.json?limit=250&since_id=${sinceId}&fields=id,title,variants,status`);
    const products = data.products || [];
    if (!products.length) break;
    for (const p of products) {
      sinceId = p.id;
      const allZero = (p.variants || []).every(v => (v.inventory_quantity ?? 0) <= 0 && v.inventory_management);
      if (allZero && p.status !== "draft") {
        await shopify(`/products/${p.id}.json`, { method: "PUT", body: JSON.stringify({ product: { id: p.id, status: "draft" } }) });
        hidden++;
      }
    }
  }
  return { hidden };
}

async function simpleReprice({ percent = 0 }) {
  let sinceId = 0, changed = 0;
  const factor = 1 + (percent/100);
  while (true) {
    const data = await shopify(`/products.json?limit=100&since_id=${sinceId}&fields=id,title,variants`);
    const products = data.products || [];
    if (!products.length) break;
    for (const p of products) {
      sinceId = p.id;
      for (const v of (p.variants || [])) {
        const price = parseFloat(v.price);
        if (!isFinite(price)) continue;
        const newPrice = (price * factor).toFixed(2);
        if (newPrice !== v.price) {
          await shopify(`/variants/${v.id}.json`, { method: "PUT", body: JSON.stringify({ variant: { id: v.id, price: newPrice } }) });
          changed++;
        }
      }
    }
  }
  return { changed };
}

const app = express();
app.use(express.json());
function guard(req, res, next) {
  if (!SECRET_KEY) return res.status(500).json({ error: "Missing CONTROL_SECRET" });
  const k = (req.query.key || req.headers["x-control-key"] || "").toString();
  if (k !== SECRET_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/health", (req, res) => res.json({ ok: true, shop: SHOP }));
app.post("/run/update-descriptions", guard, async (req, res) => {
  try { res.json(await updateAllDescriptions({ apply: !!req.query.apply })); }
  catch(e){ res.status(500).json({ error: e.message }); }
});
app.post("/run/hide-oos", guard, async (req, res) => {
  try { res.json(await hideOutOfStock()); }
  catch(e){ res.status(500).json({ error: e.message }); }
});
app.post("/run/reprice", guard, async (req, res) => {
  try { res.json(await simpleReprice({ percent: Number(req.query.percent || 0) })); }
  catch(e){ res.status(500).json({ error: e.message }); }
});

app.post("/webhooks/products/update", express.raw({type:"application/json"}), (req,res)=>{
  res.status(200).end();
});

app.listen(PORT, () => console.log(`✅ Bot up on :${PORT}`));
