-- ============================================================
-- FURROW — D1 Database Schema
-- Run with: wrangler d1 execute furrow-db --file=./schema.sql
-- ============================================================

-- Mirrors the Google Sheets catalog, synced in by /api/admin/sync-products
-- (pulls your published Books CSV and upserts rows here). The Sheet stays
-- your source of truth for editing; D1 stays the source of truth for price
-- integrity at checkout time, so a price can never be tampered with
-- client-side between "view product" and "pay".
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,                 -- matches the Sheet's `id` column, e.g. "bk001"
  title TEXT NOT NULL,
  author TEXT,
  category TEXT,
  description TEXT,
  cover_image_url TEXT,                -- Cloudinary cover image, public
  cloudinary_pdf_id TEXT,              -- Cloudinary PRIVATE asset public_id — never a URL
  cloudinary_sample_id TEXT,           -- optional free sample/preview asset
  price_inr INTEGER,                   -- store as integer paise-equivalent (rupees here; see note below)
  price_usd INTEGER,                   -- store as integer cents
  pages INTEGER,
  language TEXT,
  format TEXT,
  published_date TEXT,
  best_seller TEXT DEFAULT 'No',
  new_release TEXT DEFAULT 'No',
  visible TEXT DEFAULT 'Yes',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- One row per checkout attempt, regardless of outcome.
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,           -- our own generated id, e.g. "ord_" + uuid
  product_id TEXT NOT NULL REFERENCES products(id),
  customer_email TEXT NOT NULL,
  amount INTEGER NOT NULL,             -- smallest currency unit (paise or cents) — never trust a client-sent amount
  currency TEXT NOT NULL,              -- "INR" or "USD"
  payment_provider TEXT NOT NULL,      -- "razorpay" or "wise"
  payment_id TEXT,                     -- the provider's own payment/transaction id, once known
  payment_status TEXT NOT NULL DEFAULT 'created', -- created | pending_manual_review | paid | failed | refunded
  razorpay_order_id TEXT,              -- Razorpay's order id, created server-side before checkout opens
  created_at TEXT DEFAULT (datetime('now')),
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(payment_status);

-- The one-time download token. This table, and the atomic UPDATE used
-- against it in the Worker, is the actual security mechanism — not the
-- token's randomness or its expiry alone.
CREATE TABLE IF NOT EXISTS download_tokens (
  token TEXT PRIMARY KEY,              -- long random token, URL-safe
  order_id TEXT NOT NULL REFERENCES orders(order_id),
  product_id TEXT NOT NULL REFERENCES products(id),
  expires_at TEXT NOT NULL,            -- ISO datetime; configurable 15/30/60 min at issue time
  used_at TEXT,                        -- NULL until consumed; set atomically on first valid download
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tokens_order ON download_tokens(order_id);

-- Lets a customer or support agent reissue a fresh token for a paid order
-- whose token expired or was already used, without re-selling the book.
CREATE TABLE IF NOT EXISTS reissue_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(order_id),
  requested_email TEXT NOT NULL,       -- must match orders.customer_email before a reissue is granted
  created_at TEXT DEFAULT (datetime('now')),
  fulfilled_at TEXT
);
