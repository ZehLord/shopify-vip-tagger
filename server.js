import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.raw({ type: "application/json" }));

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOP = process.env.SHOP; // e.g. "your-store.myshopify.com"
const ADMIN_ACCESS_TOKEN = process.env.ADMIN_ACCESS_TOKEN;
const VIP_VARIANT_ID = process.env.VIP_VARIANT_ID; // recommended
const VIP_PRODUCT_ID = process.env.VIP_PRODUCT_ID; // optional fallback
const VIP_SKU = process.env.VIP_SKU; // optional fallback

function verifyShopifyHmac(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET || "")
    .update(req.body)
    .digest("base64");

  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);

  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function orderHasVipLine(order) {
  const lines = order?.line_items || [];

  // Primary: variant_id match
  if (VIP_VARIANT_ID && lines.some(li => String(li.variant_id) === String(VIP_VARIANT_ID))) {
    return true;
  }

  // Fallback: product_id match
  if (VIP_PRODUCT_ID && lines.some(li => String(li.product_id) === String(VIP_PRODUCT_ID))) {
    return true;
  }

  // Fallback: SKU match (only if you set SKU on the VIP variant)
  if (VIP_SKU && lines.some(li => String(li.sku || "").trim() === String(VIP_SKU).trim())) {
    return true;
  }

  return false;
}

function addTag(existingTags, tag) {
  const tags = (existingTags || "")
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);

  if (!tags.includes(tag)) tags.push(tag);
  return tags.join(", ");
}

async function shopifyFetch(path, method, body) {
  const url = `https://${SHOP}/admin/api/2025-07/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-Shopify-Access-Token": ADMIN_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // If Shopify returns non-2xx, we want to see it in logs.
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Shopify API error ${res.status}`);
    err.details = json;
    throw err;
  }

  return json;
}

// Health endpoint
app.get("/", (_req, res) => res.status(200).send("OK"));

app.post("/webhooks/orders-paid", async (req, res) => {
  const topic = req.get("X-Shopify-Topic");
  const shopDomain = req.get("X-Shopify-Shop-Domain");
  const webhookId = req.get("X-Shopify-Webhook-Id");

  console.log("---- Webhook received ----");
  console.log("Topic:", topic, "| Shop:", shopDomain, "| WebhookId:", webhookId);

  // 1) Verify HMAC
  const hmacOk = verifyShopifyHmac(req);
  console.log("HMAC valid:", hmacOk);

  if (!hmacOk) {
    // Return 401 so Shopify treats it as failure
    return res.status(401).send("Invalid HMAC");
  }

  // 2) Parse order
  let order;
  try {
    order = JSON.parse(req.body.toString("utf8"));
  } catch (e) {
    console.error("Failed to parse JSON body:", e);
    return res.status(400).send("Bad JSON");
  }

  console.log("Order id:", order.id, "| financial_status:", order.financial_status);

  // 3) Only for truly paid orders
  if (order.financial_status !== "paid") {
    console.log("Ignored: not paid");
    return res.status(200).send("Ignored: not paid");
  }

  // 4) Must have customer
  const customerId = order.customer?.id;
  if (!customerId) {
    console.log("Ignored: no customer on order");
    return res.status(200).send("Ignored: no customer");
  }

  // 5) Must be VIP line item
  const lineVariantIds = (order.line_items || []).map(li => li.variant_id);
  const lineProductIds = (order.line_items || []).map(li => li.product_id);
  const lineSkus = (order.line_items || []).map(li => li.sku);

  console.log("Line variant_ids:", lineVariantIds);
  console.log("Line product_ids:", lineProductIds);
  console.log("Line skus:", lineSkus);
  console.log("Configured VIP_VARIANT_ID:", VIP_VARIANT_ID || "(not set)");
  console.log("Configured VIP_PRODUCT_ID:", VIP_PRODUCT_ID || "(not set)");
  console.log("Configured VIP_SKU:", VIP_SKU || "(not set)");

  if (!orderHasVipLine(order)) {
    console.log("Ignored: VIP product not found in line items");
    return res.status(200).send("Ignored: not VIP");
  }

  // 6) Tag customer VIP
  try {
    console.log("Tagging customer:", customerId);

    const customerResp = await shopifyFetch(`customers/${customerId}.json`, "GET");
    const currentTags = customerResp.customer?.tags || "";
    const updatedTags = addTag(currentTags, "VIP");

    await shopifyFetch(`customers/${customerId}.json`, "PUT", {
      customer: { id: customerId, tags: updatedTags },
    });

    console.log("Success. Customer tags now:", updatedTags);
    return res.status(200).send("Tagged VIP");
  } catch (err) {
    console.error("Failed to update customer tags:", err.message, err.details || "");
    // Return 500 so Shopify retries the webhook
    return res.status(500).send("Failed to tag customer");
  }
});

const port = process.env.PORT || 3000;

// Prevent double-listen on Render
if (!globalThis.__serverStarted) {
  globalThis.__serverStarted = true;

  app.listen(port, () => {
    console.log(`Listening on :${port}`);
  });
}



