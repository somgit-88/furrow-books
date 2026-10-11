# Furrow — Project Structure

Live site: https://furrow-books.pages.dev/

```
furrow-project/
├── website/                    ← the ONLY folder you upload to Cloudflare Pages
│   ├── index.html              Homepage                         → /
│   ├── 404.html                Page-not-found                   (served automatically)
│   ├── about/index.html                                         → /about/
│   ├── contact/index.html                                       → /contact/
│   ├── book/index.html         Product page (reads ?id=)        → /book/?id=bk001
│   ├── terms-and-conditions/index.html
│   ├── privacy-policy/index.html
│   ├── refund-policy/index.html
│   ├── digital-delivery/index.html
│   ├── payment-help/index.html
│   ├── download-help/index.html
│   ├── assets/
│   │   ├── css/   home.css · book.css · pages.css (shared by all info pages)
│   │   ├── js/    home.js · book.js · download-help.js
│   │   └── images/ favicon.svg (put logos / banners here)
│   ├── _headers                Security + cache headers
│   ├── _redirects              Old *.html URLs → clean URLs (301)
│   ├── robots.txt
│   └── sitemap.xml
├── worker/                     Cloudflare Worker: payments, D1, secure downloads
├── cloudinary/                 How to upload covers (public) vs PDFs (private)
├── payment-config/             List of every secret the Worker needs
└── google-sheets/              Sheet column templates + apps-script.gs (NOT public)
```

Nothing in `google-sheets/`, `worker/` or `payment-config/` is uploaded to
Pages, so templates, scripts and docs are never exposed on the public site.

## Deploy / update the website
- **Dashboard:** Workers & Pages → furrow-books → *Create deployment* →
  upload the **`website`** folder (the folder itself, not the project root).
- **Git:** set *Build command* = (empty), *Build output directory* = `website`.

## Where to change what
| I want to change… | Edit… |
|---|---|
| Colors / fonts of the homepage | `website/assets/css/home.css` (variables at top of `:root`) |
| Colors of About, Contact, policy and help pages | `website/assets/css/pages.css` |
| Book page look | `website/assets/css/book.css` |
| Homepage behaviour (filters, rails, currency, hero text) | `website/assets/js/home.js` |
| Checkout behaviour | `website/assets/js/book.js` (real logic lives in `worker/worker.js`) |
| Books, prices, categories, blog, reviews, ads, `worker_base_url` | Your Google Sheet — no code change |
| Business name, address, email, phone, GSTIN | the highlighted `[placeholders]` (list below) |
| Add a new page | copy any folder (e.g. `about/`), rename it, edit its `index.html`, add the URL to `sitemap.xml` |

## Placeholders still waiting for real information
Search the `website/` folder for `class="placeholder"` — each highlighted
`[...]` is one. Fill them in place; the structure stays the same.
- `about/` — business name, business type, address, GSTIN
- `contact/` — support email, phone, address, support hours
- `terms-and-conditions/` — business name, last-updated date, liability clause (have a lawyer review)
- `privacy-policy/` — last-updated date
- `refund-policy/` — last-updated date, refund request window, response time

Pages with visible brackets will fail payment-gateway KYC review, so fill
these before submitting Razorpay/Wise verification.

## Restore / rollback
- **Bad deploy:** Pages → Deployments → pick an earlier deployment → *Rollback*.
- **Lost files:** keep this whole folder zipped (or in a private Git repo); re-upload `website/` to restore.
- Every page is a plain file, so any single page can be restored by copying
  back its own folder.

## Notes
- Old links like `/about.html` or `/book.html?id=bk001` still work through `_redirects`.
- Book pages come from your Sheet, so they are not in `sitemap.xml`.
- Redeploy the Worker once (`cd worker && wrangler deploy`) to pick up the new
  `SITE_URL` setting, which fixes the links on download error pages.
- Payment and download setup is documented in `worker/` and `payment-config/`.
