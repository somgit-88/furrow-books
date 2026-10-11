# Cloudinary setup

## Book covers — public, simple
Upload normally (`type: "upload"`, the Cloudinary default). Use the resulting
secure URL directly in your Books sheet's `cover_image_url` column, exactly
as you do today. No special handling needed — covers are meant to be public.

## Ebook PDFs — private, never a permanent public URL
When uploading each PDF, set:
```
type: "authenticated"
resource_type: "raw"
```
Either via the Cloudinary dashboard's upload widget (set "Access control" to
"Authenticated") or via the API:
```bash
curl https://api.cloudinary.com/v1_1/<cloud_name>/raw/upload \
  -F "file=@mastering-agro-exports.pdf" \
  -F "type=authenticated" \
  -F "public_id=books/mastering-agro-exports" \
  -F "api_key=<your_api_key>" \
  -F "timestamp=<unix_timestamp>" \
  -F "signature=<computed_signature>"
```

After uploading, put the **public ID only** (e.g. `books/mastering-agro-exports`)
into your Books sheet's new `cloudinary_pdf_id` column. Never put a
Cloudinary delivery URL there — an authenticated asset has no working public
URL to put, by design. The Worker generates a short-lived signed URL at
download time (see `worker/worker.js (see streamCloudinaryFile)`), and that's the only way the
file is ever reachable.

## Verify it's actually private
After uploading, try opening `https://res.cloudinary.com/<cloud>/raw/upload/v1/<public_id>.pdf`
directly in a browser. It should fail (403/404) — if it loads the PDF, the
asset was uploaded as public `upload` type by mistake, not `authenticated`.
