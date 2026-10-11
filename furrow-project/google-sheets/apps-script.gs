/**
 * FURROW — Apps Script backend
 * Attach this to the SAME Google Sheet as your Books / Blog / Settings /
 * Subscribers / Messages / Manual Orders / Payments Log tabs.
 *
 * WHAT THIS SCRIPT DOES
 * 1. doPost()      — receives website form submissions (email signup,
 *                     customer messages) and appends them as new rows.
 * 2. onEditReply()  — when you type into the "your_reply" column on the
 *                     Messages tab, emails that reply to the customer.
 * 3. onEditOrder()  — when you type "Yes" into the "paid" column on the
 *                     Manual Orders tab, emails the customer a temporary
 *                     download link (built from your S3 bucket).
 *
 * ------------------------------------------------------------------
 * SETUP — do this once
 * ------------------------------------------------------------------
 * 1. Open your Google Sheet → Extensions → Apps Script.
 * 2. Delete any starter code, paste this whole file in.
 * 3. Go to Project Settings (gear icon) → Script Properties → add:
 *      AWS_ACCESS_KEY   = your AWS access key
 *      AWS_SECRET_KEY   = your AWS secret key
 *      AWS_REGION       = e.g. ap-south-1
 *      S3_BUCKET        = your bucket name
 *      LINK_EXPIRY_SECS = e.g. 1800  (30 minutes)
 *    Never paste these directly into the code — Script Properties keeps
 *    them out of the visible script body.
 * 4. Click Deploy → New deployment → type: Web app.
 *      - Execute as: Me
 *      - Who has access: Anyone
 * 5. Copy the Web App URL it gives you — paste it into index.html as
 *    APPS_SCRIPT_URL.
 * 6. In the Apps Script editor, go to Triggers (clock icon) → Add Trigger:
 *      - Function: onEditReply     Event: On edit
 *      - Function: onEditOrder     Event: On edit
 *    (Two separate triggers, both "On edit", both on this spreadsheet.)
 * 7. The first time it runs, Google will ask you to authorize the script
 *    (it needs permission to send email on your behalf). Approve it.
 * ------------------------------------------------------------------
 */

// ---- CONFIG: matched to your actual tab names ----
const SHEET_SUBSCRIBERS = "Subscribers";
const SHEET_MESSAGES = "messages-template"; // rename this constant's value if you rename this tab later
const SHEET_MANUAL_ORDERS = "Manual Order";
const SHEET_BOOKS = "BOOKS";
const SHEET_PAYMENTS_LOG = "Payments-log";
const YOUR_STORE_NAME = "Furrow";
const YOUR_REPLY_FROM_NAME = "Furrow Support";

// ============================================================
// 1. RECEIVE WEBSITE FORM SUBMISSIONS
// ============================================================
function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (data.type === "subscribe") {
    const sheet = ss.getSheetByName(SHEET_SUBSCRIBERS);
    sheet.appendRow([data.email, new Date(), data.source || "website"]);
  }

  if (data.type === "message") {
    const sheet = ss.getSheetByName(SHEET_MESSAGES);
    const id = "msg" + new Date().getTime();
    // columns: message_id, name, email, message, date, visible, category, your_reply, reply_sent
    sheet.appendRow([id, data.name, data.email, data.message, new Date(), "No", "", "", ""]);
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// 2. AUTO-EMAIL WHEN YOU REPLY TO A CUSTOMER MESSAGE
// ============================================================
function onEditReply(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_MESSAGES) return;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const replyCol = headers.indexOf("your_reply") + 1;
  const sentCol = headers.indexOf("reply_sent") + 1;
  const emailCol = headers.indexOf("email") + 1;
  const nameCol = headers.indexOf("name") + 1;

  if (e.range.getColumn() !== replyCol) return; // only react to edits in your_reply

  const row = e.range.getRow();
  if (row === 1) return; // header row

  const replyText = sheet.getRange(row, replyCol).getValue();
  const alreadySent = sheet.getRange(row, sentCol).getValue();
  const customerEmail = sheet.getRange(row, emailCol).getValue();
  const customerName = sheet.getRange(row, nameCol).getValue();

  if (!replyText || alreadySent === "Yes" || !customerEmail) return;

  MailApp.sendEmail({
    to: customerEmail,
    subject: "A reply from " + YOUR_STORE_NAME,
    body: "Hi " + customerName + ",\n\n" + replyText + "\n\n— " + YOUR_REPLY_FROM_NAME
  });

  sheet.getRange(row, sentCol).setValue("Yes");
}

// ============================================================
// 3. AUTO-EMAIL A TEMPORARY DOWNLOAD LINK ON MANUAL "PAID = YES"
// ============================================================
function onEditOrder(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_MANUAL_ORDERS) return;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const paidCol = headers.indexOf("paid") + 1;
  const sentCol = headers.indexOf("link_sent") + 1;
  const emailCol = headers.indexOf("customer_email") + 1;
  const bookIdCol = headers.indexOf("book_id") + 1;
  const dateCol = headers.indexOf("date") + 1;

  if (e.range.getColumn() !== paidCol) return;

  const row = e.range.getRow();
  if (row === 1) return;

  const paidValue = sheet.getRange(row, paidCol).getValue();
  const alreadySent = sheet.getRange(row, sentCol).getValue();
  const customerEmail = sheet.getRange(row, emailCol).getValue();
  const bookId = sheet.getRange(row, bookIdCol).getValue();

  if (paidValue !== "Yes" || alreadySent === "Yes" || !customerEmail || !bookId) return;

  const bookRow = findBookById(bookId);
  if (!bookRow) {
    MailApp.sendEmail(Session.getActiveUser().getEmail(),
      "Furrow: manual order error",
      "Could not find book_id " + bookId + " for order to " + customerEmail);
    return;
  }

  const props = PropertiesService.getScriptProperties();
  const expirySecs = parseInt(props.getProperty("LINK_EXPIRY_SECS") || "1800", 10);
  const downloadUrl = generatePresignedUrl(bookRow.s3_file_key, expirySecs);

  MailApp.sendEmail({
    to: customerEmail,
    subject: "Your download: " + bookRow.title,
    body: "Hi,\n\nThanks for your payment. Here is your download link for \"" +
      bookRow.title + "\":\n\n" + downloadUrl +
      "\n\nThis link expires in " + Math.round(expirySecs / 60) +
      " minutes and can only be used once, so please download it right away.\n\n— " + YOUR_STORE_NAME
  });

  sheet.getRange(row, sentCol).setValue("Yes");
  sheet.getRange(row, dateCol).setValue(new Date());

  // log it
  const logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYMENTS_LOG);
  if (logSheet) {
    logSheet.appendRow([
      "ord_" + new Date().getTime(), new Date(), customerEmail, bookId, bookRow.title,
      "", "", "manual", "success", new Date(Date.now() + expirySecs * 1000), "No"
    ]);
  }
}

function findBookById(bookId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BOOKS);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idCol = headers.indexOf("id");
  const titleCol = headers.indexOf("title");
  const keyCol = headers.indexOf("s3_file_key");

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]).trim() === String(bookId).trim()) {
      return { title: values[i][titleCol], s3_file_key: values[i][keyCol] };
    }
  }
  return null;
}

// ============================================================
// AWS S3 PRE-SIGNED URL GENERATOR (Signature Version 4)
// ============================================================
function generatePresignedUrl(objectKey, expiresInSeconds) {
  const props = PropertiesService.getScriptProperties();
  const accessKey = props.getProperty("AWS_ACCESS_KEY");
  const secretKey = props.getProperty("AWS_SECRET_KEY");
  const region = props.getProperty("AWS_REGION");
  const bucket = props.getProperty("S3_BUCKET");

  const now = new Date();
  const amzDate = Utilities.formatDate(now, "UTC", "yyyyMMdd'T'HHmmss'Z'");
  const dateStamp = Utilities.formatDate(now, "UTC", "yyyyMMdd");
  const host = bucket + ".s3." + region + ".amazonaws.com";
  const credentialScope = dateStamp + "/" + region + "/s3/aws4_request";
  const encodedKey = encodeS3Key(objectKey);

  const queryParams = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": accessKey + "/" + credentialScope,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": "host"
  };

  const sortedKeys = Object.keys(queryParams).sort();
  const canonicalQuery = sortedKeys
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(queryParams[k]))
    .join("&");

  const canonicalRequest = [
    "GET",
    "/" + encodedKey,
    canonicalQuery,
    "host:" + host + "\n",
    "host",
    "UNSIGNED-PAYLOAD"
  ].join("\n");

  const hashedCanonicalRequest = toHex(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, canonicalRequest, Utilities.Charset.UTF_8));

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashedCanonicalRequest
  ].join("\n");

  const signingKey = getSignatureKey(secretKey, dateStamp, region, "s3");
  const signature = toHex(Utilities.computeHmacSha256Signature(
    Utilities.newBlob(stringToSign).getBytes(), signingKey));

  return "https://" + host + "/" + encodedKey + "?" + canonicalQuery +
    "&X-Amz-Signature=" + signature;
}

function getSignatureKey(key, dateStamp, region, service) {
  const kDate = hmac("AWS4" + key, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function hmac(key, data) {
  const keyBytes = (typeof key === "string") ? Utilities.newBlob(key).getBytes() : key;
  return Utilities.computeHmacSha256Signature(Utilities.newBlob(data).getBytes(), keyBytes);
}

function toHex(bytes) {
  return bytes.map(b => {
    const v = (b < 0) ? b + 256 : b;
    return ("0" + v.toString(16)).slice(-2);
  }).join("");
}

function encodeS3Key(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}
