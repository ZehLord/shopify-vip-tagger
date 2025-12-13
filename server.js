import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.raw({ type: "application/json" }));

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOP = process.env.SHOP;
const ADMIN_ACCESS_TOKEN = process.env.ADMIN_ACCESS_TOKEN;
const VIP_VARIANT_ID = process.env.VIP_VARIANT_ID;

function verifyShopifyHmac(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest("base64");

  if (digest.length !== hmacHeader.length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

function orderHasVipVariant(order) {
  return (order.line_items || []).some(
    (li) => String(li.variant_id) === String(VIP_VARIANT_ID)
  );
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
  const res = await fetch(`https://${SHOP}/admin/api/2025-07/${path}`, {
    method,
    headers: {
      "X-Shopify-Access-Token": ADMIN_ACCESS_TOKEN,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

app.post("/webhooks/orders-paid", async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.sendStatus(401);

  const order = JSON.parse(req.body.toString());
  if (order.financial_status !== "paid") return res.sendStatus(200);
  if (!order.customer?.id) return res.sendStatus(200);
  if (!orderHasVipVariant(order)) return res.sendStatus(200);

  const customerId = order.customer.id;
  const customer = await shopifyFetch(`customers/${customerId}.json`, "GET");
  const tags = addTag(customer.customer.tags, "VIP");

  await shopifyFetch(`customers/${customerId}.json`, "PUT", {
    customer: { id: customerId, tags }
  });

  res.sendStatus(200);
});

app.get("/", (_req, res) => res.send("OK"));

app.listen(process.env.PORT || 3000);
