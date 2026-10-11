// Furrow — book page logic. Data comes from the published Google Sheets CSV links defined at the top.
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vThBy96JRuzGQF43IeOV9EnIfH1tJsAKosE_cKMmP6cMUbDlX_rK9IgOevynDQWp8WBZ65oqAPW8wiq/pub?gid=1932584247&single=true&output=csv";
const SETTINGS_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vThBy96JRuzGQF43IeOV9EnIfH1tJsAKosE_cKMmP6cMUbDlX_rK9IgOevynDQWp8WBZ65oqAPW8wiq/pub?gid=693120599&single=true&output=csv";

let ADSENSE_CONFIG = null;
let WORKER_BASE_URL = "";
function loadAdSettings(){
  Papa.parse(SETTINGS_CSV_URL, {
    download: true, header: true,
    complete: (results) => {
      const map = {};
      results.data.forEach(r => { if(r.setting_key) map[r.setting_key.trim()] = (r.setting_value || "").trim(); });
      WORKER_BASE_URL = map.worker_base_url || "";
      if(map.adsense_client_id){
        ADSENSE_CONFIG = { client: map.adsense_client_id, slots: {
          leaderboard: map.adsense_slot_leaderboard, infeed: map.adsense_slot_infeed, article: map.adsense_slot_article
        }};
        const s = document.createElement("script");
        s.async = true; s.crossOrigin = "anonymous";
        s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + ADSENSE_CONFIG.client;
        document.head.appendChild(s);
        document.querySelectorAll(".ad-slot[data-ad-type]").forEach(el => {
          const slot = ADSENSE_CONFIG.slots[el.dataset.adType];
          if(!slot) return;
          el.innerHTML = `<ins class="adsbygoogle" style="display:block;width:100%;" data-ad-client="${ADSENSE_CONFIG.client}" data-ad-slot="${slot}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;
          try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch(e) {}
        });
      }
    },
    error: () => {}
  });
}
loadAdSettings();

const params = new URLSearchParams(window.location.search);
const bookId = params.get("id");
let CURRENCY = "inr";
let CURRENT_BOOK = null;

function priceLabel(b){
  return CURRENCY === "inr" ? `₹${b.price_inr || "—"}` : `$${b.price_usd || "—"}`;
}

function renderBook(b){
  CURRENT_BOOK = b;
  document.title = b.title + " — Furrow";
  const metaDesc = document.querySelector('meta[name="description"]');
  if(metaDesc) metaDesc.content = (b.short_description || b.full_description || metaDesc.content).slice(0, 155);
  document.getElementById("bookCategory").textContent = (b.category || "").split(",")[0].trim();
  document.getElementById("bookTitle").textContent = b.title;
  document.getElementById("bookAuthor").textContent = "by " + (b.author || "Furrow Press");
  document.getElementById("bookPages").textContent = b.pages ? b.pages + " pages" : "";
  document.getElementById("bookFormat").textContent = b.format || "PDF";
  document.getElementById("bookDesc").textContent = b.full_description || b.short_description || "";
  document.getElementById("priceDisplay").textContent = priceLabel(b);

  const tagsWrap = document.getElementById("bookTags");
  tagsWrap.innerHTML = "";
  (b.category || "").split(",").forEach(c => {
    if(!c.trim()) return;
    const el = document.createElement("span");
    el.className = "tag-chip";
    el.textContent = c.trim();
    tagsWrap.appendChild(el);
  });

  // gallery: cover + any gallery_images
  const images = [b.cover_image_url].concat((b.gallery_images || "").split(",")).map(s => s.trim()).filter(Boolean);
  const mainCover = document.getElementById("mainCover");
  const thumbRow = document.getElementById("thumbRow");
  thumbRow.innerHTML = "";

  function setMain(url){
    mainCover.innerHTML = url ? `<img src="${url}" alt="${b.title}">` : b.title;
  }
  setMain(images[0]);

  if(images.length > 1){
    images.forEach((url, i) => {
      const t = document.createElement("div");
      t.className = "thumb" + (i === 0 ? " active" : "");
      t.innerHTML = `<img src="${url}" alt="preview ${i+1}">`;
      t.addEventListener("click", () => {
        setMain(url);
        thumbRow.querySelectorAll(".thumb").forEach(el => el.classList.remove("active"));
        t.classList.add("active");
      });
      thumbRow.appendChild(t);
    });
  }

  document.getElementById("samplePreviewBtn").style.display = b.cloudinary_sample_id ? "block" : "none";

  document.getElementById("loadingState").style.display = "none";
  document.getElementById("bookLayout").style.display = "grid";
  updatePaymentVisibility();
}

function setCheckoutStatus(msg, isError){
  const el = document.getElementById("checkoutStatus");
  el.textContent = msg;
  el.style.color = isError ? "#d98a7a" : "";
}

function validEmail(){
  const email = document.getElementById("checkoutEmail").value.trim();
  if(!email || !email.includes("@")){
    setCheckoutStatus("Please enter a valid email first — that's where your download link goes.", true);
    return null;
  }
  return email;
}

async function startRazorpayCheckout(){
  if(!WORKER_BASE_URL){
    setCheckoutStatus("Payment backend isn't connected yet — set worker_base_url in the Settings sheet.", true);
    return;
  }
  const email = validEmail();
  if(!email) return;

  setCheckoutStatus("Starting secure checkout…");
  try{
    const createResp = await fetch(WORKER_BASE_URL + "/api/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: bookId, email, currency: "INR", provider: "razorpay" })
    });
    const order = await createResp.json();
    if(!createResp.ok){ setCheckoutStatus(order.error || "Could not start checkout.", true); return; }

    const rzp = new Razorpay({
      key: order.razorpay_key_id,
      amount: order.amount * 100,
      currency: order.currency,
      order_id: order.razorpay_order_id,
      name: "Furrow",
      description: CURRENT_BOOK.title,
      prefill: { email },
      handler: async function(response){
        setCheckoutStatus("Verifying payment…");
        const verifyResp = await fetch(WORKER_BASE_URL + "/api/verify-razorpay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order_id: order.order_id,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature
          })
        });
        const result = await verifyResp.json();
        if(verifyResp.ok && result.download_url){
          setCheckoutStatus("Payment verified! Your download is starting…");
          window.location.href = WORKER_BASE_URL + result.download_url;
        } else {
          setCheckoutStatus(result.error || "Payment verification failed — contact support with your order ID: " + order.order_id, true);
        }
      },
      modal: { ondismiss: function(){ setCheckoutStatus(""); } }
    });
    rzp.open();
  } catch(err){
    setCheckoutStatus("Something went wrong starting checkout. Please try again.", true);
  }
}

async function startWiseCheckout(){
  if(!WORKER_BASE_URL){
    setCheckoutStatus("Payment backend isn't connected yet — set worker_base_url in the Settings sheet.", true);
    return;
  }
  const email = validEmail();
  if(!email) return;
  if(!CURRENT_BOOK.wise_payment_link){
    setCheckoutStatus("Wise checkout isn't set up for this book yet — add a link in the sheet's wise_payment_link column.", true);
    return;
  }

  setCheckoutStatus("Recording your order…");
  try{
    const createResp = await fetch(WORKER_BASE_URL + "/api/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: bookId, email, currency: "USD", provider: "wise" })
    });
    const order = await createResp.json();
    if(!createResp.ok){ setCheckoutStatus(order.error || "Could not start checkout.", true); return; }

    setCheckoutStatus("Order " + order.order_id + " recorded. Opening Wise — after paying, message us with this order ID to receive your link.");
    window.open(CURRENT_BOOK.wise_payment_link, "_blank", "noopener");
  } catch(err){
    setCheckoutStatus("Something went wrong recording your order. Please try again.", true);
  }
}

document.getElementById("buyBtnRazorpay").addEventListener("click", startRazorpayCheckout);
document.getElementById("buyBtnWise").addEventListener("click", startWiseCheckout);
document.getElementById("samplePreviewBtn").addEventListener("click", () => {
  if(!WORKER_BASE_URL){ alert("Sample downloads need the payment backend connected first."); return; }
  window.open(WORKER_BASE_URL + "/sample/" + encodeURIComponent(bookId), "_blank", "noopener");
});

function updatePaymentVisibility(){
  const isIndia = CURRENCY === "inr";
  document.getElementById("razorpaySection").style.display = isIndia ? "block" : "none";
  document.getElementById("wiseSection").style.display = isIndia ? "none" : "block";
  document.getElementById("toggleRegionLabel").textContent = isIndia ? "international payment" : "Indian payment";
}

function setCurrency(cur){
  CURRENCY = cur;
  document.querySelectorAll("#currencyToggle button").forEach(b => b.classList.toggle("active", b.dataset.cur === cur));
  if(CURRENT_BOOK) document.getElementById("priceDisplay").textContent = priceLabel(CURRENT_BOOK);
  updatePaymentVisibility();
}

document.getElementById("currencyToggle").addEventListener("click", e => {
  if(e.target.tagName !== "BUTTON") return;
  setCurrency(e.target.dataset.cur);
});

document.getElementById("togglePaymentRegion").addEventListener("click", e => {
  e.preventDefault();
  setCurrency(CURRENCY === "inr" ? "usd" : "inr");
});

function detectRegionCurrency(){
  return new Promise(resolve => {
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); resolve(); }, 1800);
    fetch("https://get.geojs.io/v1/ip/geo.json", { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        clearTimeout(timeout);
        const detected = (data.country_code === "IN") ? "inr" : "usd";
        CURRENCY = detected;
        document.querySelectorAll("#currencyToggle button").forEach(b => b.classList.toggle("active", b.dataset.cur === detected));
        if(CURRENT_BOOK) document.getElementById("priceDisplay").textContent = priceLabel(CURRENT_BOOK);
        updatePaymentVisibility();
        resolve();
      })
      .catch(() => { clearTimeout(timeout); resolve(); });
  });
}
detectRegionCurrency();

if(!bookId){
  document.getElementById("loadingState").style.display = "none";
  document.getElementById("notFoundState").style.display = "block";
} else {
  Papa.parse(SHEET_CSV_URL, {
    download: true,
    header: true,
    complete: (results) => {
      const match = results.data.find(r => (r.id || "").trim() === bookId && (r.visible || "Yes").trim().toLowerCase() === "yes");
      if(match){
        renderBook(match);
      } else {
        document.getElementById("loadingState").style.display = "none";
        document.getElementById("notFoundState").style.display = "block";
      }
    },
    error: () => {
      document.getElementById("loadingState").style.display = "none";
      document.getElementById("notFoundState").style.display = "block";
    }
  });
}
