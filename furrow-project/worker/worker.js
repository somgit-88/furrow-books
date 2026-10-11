/**
 * FURROW — Cloudflare Worker
 * Handles: order creation, Razorpay payment verification, Wise order
 * recording, one-time download tokens, and Cloudinary file proxying.
 *
 * ------------------------------------------------------------------
 * REQUIRED SECRETS (set with `wrangler secret put <NAME>` — never in code,
 * never in the Sheet, never in frontend JS):
 *   RAZORPAY_KEY_ID          — also used client-side; not secret by itself,
 *                              but kept here so one place controls it
 *   RAZORPAY_KEY_SECRET      — secret. Used only server-side to verify signatures.
 *   RAZORPAY_WEBHOOK_SECRET  — secret. Set in Razorpay dashboard's webhook config.
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET    — secret. Used to sign authenticated Cloudinary requests.
 *   ADMIN_API_KEY            — secret. Protects /api/admin/* routes (manual
 *                              Wise confirmation, reissues, product sync).
 *   BOOKS_CSV_URL            — your published Books sheet CSV link (same one
 *                              the frontend uses), used by the product sync job.
 *
 * REQUIRED BINDINGS (wrangler.toml):
 *   DB   — D1 database binding, schema.sql applied
 *
 * ------------------------------------------------------------------
 * WISE — IMPORTANT HONEST NOTE
 * Razorpay's signature verification below is real, standard, and safe to
 * run in production as written. Wise does not offer an equivalent
 * signature-verified webhook to small/individual sellers without going
 * through Wise's Business/Platform API approval process — that's a
 * business relationship with Wise, not something code alone can add.
 * Until you have that access, Wise orders are created in
 * `pending_manual_review` status: the customer pays via your Wise payment
 * link, then you (or they, via the message form) confirm it, and an admin
 * calls POST /api/admin/confirm-wise-payment to issue the token exactly
 * the same secure way a Razorpay order would get one. The download
 * mechanism itself is equally strong for both providers — only *how a
 * payment is confirmed* differs.
 * ------------------------------------------------------------------
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function randomToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateOrderId() {
  return "ord_" + crypto.randomUUID().replace(/-/g, "");
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// ============================================================
// Route: POST /api/create-order
// Body: { product_id, email, currency, provider }
// Creates a D1 order row with a server-trusted price (never trust a
// client-sent amount), and for Razorpay also creates a Razorpay Order.
// ============================================================
async function handleCreateOrder(request, env) {
  const body = await request.json();
  const { product_id, email, currency, provider } = body;

  if (!product_id || !email || !currency || !provider) {
    return json({ error: "Missing required fields" }, 400);
  }
  if (!["razorpay", "wise"].includes(provider)) {
    return json({ error: "Unknown payment provider" }, 400);
  }

  const product = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND visible = 'Yes'")
    .bind(product_id)
    .first();
  if (!product) return json({ error: "Product not found or unavailable" }, 404);

  const amount = currency === "INR" ? product.price_inr : product.price_usd;
  if (!amount) return json({ error: "No price set for this currency" }, 400);

  const order_id = generateOrderId();
  let razorpay_order_id = null;

  if (provider === "razorpay") {
    const rpResp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(env.RAZORPAY_KEY_ID + ":" + env.RAZORPAY_KEY_SECRET),
      },
      body: JSON.stringify({
        amount: currency === "INR" ? amount * 100 : amount * 100, // Razorpay wants paise/cents
        currency,
        receipt: order_id,
      }),
    });
    if (!rpResp.ok) {
      const errText = await rpResp.text();
      return json({ error: "Razorpay order creation failed", detail: errText }, 502);
    }
    const rpData = await rpResp.json();
    razorpay_order_id = rpData.id;
  }

  const initialStatus = provider === "razorpay" ? "created" : "pending_manual_review";

  await env.DB.prepare(
    `INSERT INTO orders (order_id, product_id, customer_email, amount, currency, payment_provider, payment_status, razorpay_order_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(order_id, product_id, email, amount, currency, provider, initialStatus, razorpay_order_id)
    .run();

  return json({
    order_id,
    razorpay_order_id,
    razorpay_key_id: provider === "razorpay" ? env.RAZORPAY_KEY_ID : undefined,
    amount,
    currency,
    provider,
  });
}

// ============================================================
// Route: POST /api/verify-razorpay
// Body: { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature }
// This is the real security check for Razorpay: HMAC-SHA256 of
// "order_id|payment_id" using your key secret must match what Razorpay sent.
// ============================================================
async function handleVerifyRazorpay(request, env) {
  const { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = await request.json();

  if (!order_id || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return json({ error: "Missing verification fields" }, 400);
  }

  const order = await env.DB.prepare("SELECT * FROM orders WHERE order_id = ?").bind(order_id).first();
  if (!order) return json({ error: "Order not found" }, 404);
  if (order.razorpay_order_id !== razorpay_order_id) return json({ error: "Order mismatch" }, 400);
  if (order.payment_status === "paid") {
    // Already processed (e.g. the webhook beat us to it) — idempotent success.
    return await issueOrReturnToken(env, order);
  }

  const expectedSignature = await hmacSha256Hex(
    env.RAZORPAY_KEY_SECRET,
    razorpay_order_id + "|" + razorpay_payment_id
  );
  if (!timingSafeEqual(expectedSignature, razorpay_signature)) {
    return json({ error: "Signature verification failed" }, 400);
  }

  await env.DB.prepare(
    `UPDATE orders SET payment_status = 'paid', payment_id = ?, paid_at = datetime('now') WHERE order_id = ?`
  )
    .bind(razorpay_payment_id, order_id)
    .run();

  return await issueOrReturnToken(env, { ...order, payment_status: "paid" });
}

// ============================================================
// Route: POST /api/razorpay-webhook
// The authoritative confirmation path — verify Razorpay's own webhook
// signature (different secret from the checkout signature above) and mark
// the order paid even if the customer's browser never returns from checkout.
// ============================================================
async function handleRazorpayWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get("X-Razorpay-Signature");
  if (!signature) return json({ error: "Missing signature" }, 400);

  const expected = await hmacSha256Hex(env.RAZORPAY_WEBHOOK_SECRET, rawBody);
  if (!timingSafeEqual(expected, signature)) {
    return json({ error: "Invalid webhook signature" }, 400);
  }

  const event = JSON.parse(rawBody);
  if (event.event === "payment.captured") {
    const payment = event.payload.payment.entity;
    const order = await env.DB.prepare("SELECT * FROM orders WHERE razorpay_order_id = ?")
      .bind(payment.order_id)
      .first();
    if (order && order.payment_status !== "paid") {
      await env.DB.prepare(
        `UPDATE orders SET payment_status = 'paid', payment_id = ?, paid_at = datetime('now') WHERE order_id = ?`
      )
        .bind(payment.id, order.order_id)
        .run();
      await issueOrReturnToken(env, { ...order, payment_status: "paid" });
    }
  }
  return json({ received: true });
}

// ============================================================
// Issue a one-time download token for a paid order (or return the existing
// unused one, so retries don't mint duplicate live tokens).
// ============================================================
async function issueOrReturnToken(env, order) {
  const existing = await env.DB.prepare(
    `SELECT * FROM download_tokens WHERE order_id = ? AND used_at IS NULL AND expires_at > datetime('now')`
  )
    .bind(order.order_id)
    .first();
  if (existing) {
    return json({ download_url: "/download/" + existing.token, expires_at: existing.expires_at });
  }

  const token = randomToken();
  const expiryMinutes = parseInt(env.TOKEN_EXPIRY_MINUTES || "30", 10);
  const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();

  await env.DB.prepare(
    `INSERT INTO download_tokens (token, order_id, product_id, expires_at) VALUES (?, ?, ?, ?)`
  )
    .bind(token, order.order_id, order.product_id, expiresAt)
    .run();

  return json({ download_url: "/download/" + token, expires_at: expiresAt });
}

// ============================================================
// Route: GET /download/:token
// THE core security mechanism: one atomic UPDATE claims the token. If zero
// rows are affected, it was already used, expired, or never existed — there
// is no separate "check" step that a race condition could slip between.
// ============================================================
async function handleDownload(request, env, token) {
  const claim = await env.DB.prepare(
    `UPDATE download_tokens
     SET used_at = datetime('now')
     WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')
     RETURNING order_id, product_id`
  )
    .bind(token)
    .first();

  if (!claim) {
    return friendlyErrorPage(env,
      "This download link has already been used or has expired.",
      "Each link works once. If you haven't downloaded your book yet, use the reissue link below."
    );
  }

  const product = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(claim.product_id).first();
  if (!product || !product.cloudinary_pdf_id) {
    return friendlyErrorPage(env, "We couldn't locate this file.", "Please contact support with your order ID: " + claim.order_id);
  }

  return await streamCloudinaryFile(env, product.cloudinary_pdf_id, product.title);
}

// ============================================================
// Route: GET /sample/:product_id
// Free preview — no payment needed, but still proxied server-side so no
// Cloudinary URL of any kind ever reaches the browser.
// ============================================================
async function handleSample(request, env, productId) {
  const product = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND visible = 'Yes'")
    .bind(productId)
    .first();
  if (!product || !product.cloudinary_sample_id) {
    return friendlyErrorPage(env, "No sample available for this title yet.", "");
  }
  return await streamCloudinaryFile(env, product.cloudinary_sample_id, product.title + " (Sample)");
}

// ============================================================
// Fetch the file from Cloudinary server-side using a short-lived signed
// request, then stream the bytes straight to the client. The Cloudinary
// URL itself — signed or not — never appears in any response to the browser.
// ============================================================
async function streamCloudinaryFile(env, publicId, filenameHint) {
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = `public_id=${publicId}&timestamp=${timestamp}${env.CLOUDINARY_API_SECRET}`;
  const signatureBuf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(paramsToSign));
  const signature = [...new Uint8Array(signatureBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const cloudinaryUrl =
    `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/auto/download` +
    `?public_id=${encodeURIComponent(publicId)}&timestamp=${timestamp}` +
    `&api_key=${env.CLOUDINARY_API_KEY}&signature=${signature}`;

  const fileResp = await fetch(cloudinaryUrl);
  if (!fileResp.ok) {
    return friendlyErrorPage(env, "We couldn't retrieve this file right now.", "Please contact support — this is on our end, not yours.");
  }

  const safeFilename = (filenameHint || "download").replace(/[^a-z0-9\-_ ]/gi, "").trim() + ".pdf";
  return new Response(fileResp.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "Cache-Control": "no-store",
    },
  });
}

function friendlyErrorPage(env, heading, subtext) {
  const site = env.SITE_URL || "";
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Download — Furrow</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#141b12;color:#f4ecd8;font-family:Georgia,serif;text-align:center;padding:40px;}
  .box{max-width:440px;}
  h1{font-size:1.5rem;margin-bottom:12px;}
  p{opacity:0.75;line-height:1.6;}
  a{color:#ecc36c;}
</style></head>
<body><div class="box">
  <h1>${heading}</h1>
  <p>${subtext}</p>
  <p><a href="${site}/contact/">Need help? Contact support</a> or
     <a href="${site}/download-help/">read about reissuing a link</a>.</p>
</div></body></html>`;
  return new Response(html, { status: 410, headers: { "Content-Type": "text/html" } });
}

// ============================================================
// Route: POST /api/admin/confirm-wise-payment  (requires ADMIN_API_KEY)
// Body: { order_id }
// Manual confirmation path for Wise until Business API webhooks exist.
// ============================================================
async function handleConfirmWisePayment(request, env) {
  if (request.headers.get("X-Admin-Key") !== env.ADMIN_API_KEY) {
    return json({ error: "Unauthorized" }, 401);
  }
  const { order_id, payment_reference } = await request.json();
  const order = await env.DB.prepare("SELECT * FROM orders WHERE order_id = ?").bind(order_id).first();
  if (!order) return json({ error: "Order not found" }, 404);

  await env.DB.prepare(
    `UPDATE orders SET payment_status = 'paid', payment_id = ?, paid_at = datetime('now') WHERE order_id = ?`
  )
    .bind(payment_reference || "manual-wise", order_id)
    .run();

  return await issueOrReturnToken(env, { ...order, payment_status: "paid" });
}

// ============================================================
// Route: POST /api/reissue
// Body: { order_id, email }
// Self-serve reissue: only works if the email matches the paying customer,
// and only for orders that are actually paid.
// ============================================================
async function handleReissue(request, env) {
  const { order_id, email } = await request.json();
  const order = await env.DB.prepare(
    "SELECT * FROM orders WHERE order_id = ? AND customer_email = ? AND payment_status = 'paid'"
  )
    .bind(order_id, email)
    .first();

  if (!order) {
    return json({ error: "We couldn't find a paid order matching that order ID and email." }, 404);
  }

  await env.DB.prepare(`INSERT INTO reissue_requests (order_id, requested_email) VALUES (?, ?)`)
    .bind(order_id, email)
    .run();

  return await issueOrReturnToken(env, order);
}

// ============================================================
// Route: POST /api/admin/sync-products  (requires ADMIN_API_KEY)
// Pulls your published Books CSV and upserts into D1, so checkout always
// prices against a server-controlled value, not anything the browser sends.
// Call this on a schedule (Cron Trigger) or manually after editing the Sheet.
// ============================================================
async function handleSyncProducts(request, env) {
  if (request.headers.get("X-Admin-Key") !== env.ADMIN_API_KEY) {
    return json({ error: "Unauthorized" }, 401);
  }
  const csvResp = await fetch(env.BOOKS_CSV_URL);
  const csvText = await csvResp.text();
  const rows = parseCsv(csvText);

  let count = 0;
  for (const row of rows) {
    if (!row.id) continue;
    await env.DB.prepare(
      `INSERT INTO products (id, title, author, category, description, cover_image_url, cloudinary_pdf_id, cloudinary_sample_id,
        price_inr, price_usd, pages, language, format, published_date, best_seller, new_release, visible, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, author=excluded.author, category=excluded.category, description=excluded.description,
        cover_image_url=excluded.cover_image_url, cloudinary_pdf_id=excluded.cloudinary_pdf_id,
        cloudinary_sample_id=excluded.cloudinary_sample_id, price_inr=excluded.price_inr, price_usd=excluded.price_usd,
        pages=excluded.pages, language=excluded.language, format=excluded.format, published_date=excluded.published_date,
        best_seller=excluded.best_seller, new_release=excluded.new_release, visible=excluded.visible, updated_at=datetime('now')`
    )
      .bind(
        row.id, row.title, row.author, row.category, row.full_description || row.short_description,
        row.cover_image_url, row.cloudinary_pdf_id, row.cloudinary_sample_id,
        parseInt(row.price_inr) || null, parseInt(row.price_usd) || null,
        parseInt(row.pages) || null, row.language, row.format, row.published_date,
        row.best_seller || "No", row.new_release || "No", row.visible || "Yes"
      )
      .run();
    count++;
  }
  return json({ synced: count });
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => (obj[h] = values[i] || ""));
    return obj;
  });
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

// ============================================================
// Router
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
        },
      });
    }

    try {
      if (url.pathname === "/api/create-order" && request.method === "POST") {
        return await handleCreateOrder(request, env);
      }
      if (url.pathname === "/api/verify-razorpay" && request.method === "POST") {
        return await handleVerifyRazorpay(request, env);
      }
      if (url.pathname === "/api/razorpay-webhook" && request.method === "POST") {
        return await handleRazorpayWebhook(request, env);
      }
      if (url.pathname === "/api/admin/confirm-wise-payment" && request.method === "POST") {
        return await handleConfirmWisePayment(request, env);
      }
      if (url.pathname === "/api/reissue" && request.method === "POST") {
        return await handleReissue(request, env);
      }
      if (url.pathname === "/api/admin/sync-products" && request.method === "POST") {
        return await handleSyncProducts(request, env);
      }
      if (url.pathname.startsWith("/download/")) {
        const token = url.pathname.split("/download/")[1];
        return await handleDownload(request, env, token);
      }
      if (url.pathname.startsWith("/sample/")) {
        const productId = url.pathname.split("/sample/")[1];
        return await handleSample(request, env, productId);
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: "Internal error", detail: String(err) }, 500);
    }
  },
};
