// Furrow — homepage logic. Data comes from the published Google Sheets CSV links defined at the top.
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vThBy96JRuzGQF43IeOV9EnIfH1tJsAKosE_cKMmP6cMUbDlX_rK9IgOevynDQWp8WBZ65oqAPW8wiq/pub?gid=1932584247&single=true&output=csv";
const BLOG_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vThBy96JRuzGQF43IeOV9EnIfH1tJsAKosE_cKMmP6cMUbDlX_rK9IgOevynDQWp8WBZ65oqAPW8wiq/pub?gid=664655369&single=true&output=csv";
const SETTINGS_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vThBy96JRuzGQF43IeOV9EnIfH1tJsAKosE_cKMmP6cMUbDlX_rK9IgOevynDQWp8WBZ65oqAPW8wiq/pub?gid=693120599&single=true&output=csv";
const PAGE_SIZE = 12;

// ---- AdSense, driven entirely by the Settings sheet — no code edits needed ----
let ADSENSE_CONFIG = null;

function loadAdSettings(cacheBust){
  const url = SETTINGS_CSV_URL + (cacheBust ? "&cb=" + Date.now() : "");
  Papa.parse(url, {
    download: true,
    header: true,
    complete: (results) => {
      const map = {};
      results.data.forEach(r => { if(r.setting_key) map[r.setting_key.trim()] = (r.setting_value || "").trim(); });

      if(map.adsense_client_id){
        ADSENSE_CONFIG = {
          client: map.adsense_client_id,
          slots: {
            leaderboard: map.adsense_slot_leaderboard,
            infeed: map.adsense_slot_infeed,
            article: map.adsense_slot_article
          }
        };
        if(!document.getElementById("adsenseScript")){
          const s = document.createElement("script");
          s.id = "adsenseScript";
          s.async = true;
          s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + ADSENSE_CONFIG.client;
          s.crossOrigin = "anonymous";
          document.head.appendChild(s);
        }
        injectAds();
      }
    },
    error: () => {}
  });
}

function injectAds(){
  if(!ADSENSE_CONFIG) return;
  document.querySelectorAll(".ad-slot[data-ad-type]:not(.ad-processed)").forEach(el => {
    const slot = ADSENSE_CONFIG.slots[el.dataset.adType];
    if(!slot) return;
    el.classList.add("ad-processed");
    el.innerHTML = `<ins class="adsbygoogle" style="display:block;width:100%;" data-ad-client="${ADSENSE_CONFIG.client}" data-ad-slot="${slot}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch(err) {}
  });
}

const SAMPLE_POSTS = [
  {slug:"what-gulf-buyers-look-for", title:"What Buyers in the Gulf Actually Look For", category:"Export Guides",
   excerpt:"A breakdown of quality, packaging and documentation expectations across UAE agricultural importers.", visible:"Yes"},
  {slug:"reading-soil-before-planting", title:"Reading Your Soil Before You Plant", category:"Farming Basics",
   excerpt:"A simple, no-equipment method for judging soil health before committing a season to it.", visible:"Yes"},
];

const SAMPLE = [
  {id:"bk001", title:"Mastering Agro Exports", author:"Furrow Press", category:"Farming, Export Guides",
   cover_image_url:"", price_inr:"299", price_usd:"5.99", visible:"Yes", featured:"Yes"},
  {id:"bk002", title:"Organic Farming Basics", author:"Furrow Press", category:"Farming, Beginners",
   cover_image_url:"", price_inr:"199", price_usd:"3.99", visible:"Yes", featured:"No"},
];

let ALL_BOOKS = [];
let VISIBLE_BOOKS = [];
let RENDER_COUNT = 0;
let ACTIVE_TYPE = "all";
let ACTIVE_CAT = "all";
let CURRENCY = "inr";
let CURRENCY_AUTO_SET = false; // becomes true once location detection sets it, so manual toggle can still override
let observer;

// ---- Hero rotator ----
const HERO_SLIDES = [
  { eyebrow: "Field-tested knowledge, in ebook form", title: 'Grown from the soil.<br><em>Written for the world.</em>',
    lede: "Practical agricultural ebooks for farmers, exporters and agribusiness owners — delivered instantly, read anywhere, from India to the US, UK, UAE and Australia." },
  { eyebrow: "New this season", title: 'Fresh reads.<br><em>Ready in seconds.</em>',
    lede: "Browse new arrivals across farming, export guides, and more — every title downloads instantly after checkout." },
  { eyebrow: "Trusted by readers worldwide", title: 'Knowledge that<br><em>pays for itself.</em>',
    lede: "Practical, field-tested guides written to help you work smarter — not theory, but what actually works." },
];
let heroSlideIndex = 0;
function showHeroSlide(i){
  const s = HERO_SLIDES[i];
  document.getElementById("heroEyebrow").textContent = s.eyebrow;
  document.getElementById("heroTitle").innerHTML = s.title;
  document.getElementById("heroLede").textContent = s.lede;
  document.querySelectorAll("#heroDots button").forEach((b, idx) => b.classList.toggle("active", idx === i));
  heroSlideIndex = i;
}
document.getElementById("heroDots").addEventListener("click", e => {
  if(e.target.tagName !== "BUTTON") return;
  showHeroSlide(parseInt(e.target.dataset.slide, 10));
});
setInterval(() => showHeroSlide((heroSlideIndex + 1) % HERO_SLIDES.length), 6000);

function normalizeRow(r){
  return {
    id: r.id || "",
    product_type: (r.product_type || "Ebook").trim(),
    title: r.title || "Untitled",
    author: r.author || "",
    category: (r.category || "Uncategorized"),
    cover_image_url: r.cover_image_url || "",
    price_inr: r.price_inr || "",
    price_usd: r.price_usd || "",
    original_price_inr: r.original_price_inr || "",
    original_price_usd: r.original_price_usd || "",
    rating: r.rating || "",
    review_count: r.review_count || "",
    best_seller: (r.best_seller || "No").trim().toLowerCase(),
    new_release: (r.new_release || "No").trim().toLowerCase(),
    wise_payment_link: r.wise_payment_link || "",
    cloudinary_sample_id: r.cloudinary_sample_id || "",
    visible: (r.visible || "Yes").trim().toLowerCase(),
    featured: (r.featured || "No").trim().toLowerCase(),
  };
}

function renderTypeChips(books){
  const types = new Set(books.map(b => b.product_type).filter(Boolean));
  const row = document.getElementById("typeChips");
  row.innerHTML = '<button class="chip active" data-type="all">All Types</button>';
  [...types].sort().forEach(t => {
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.dataset.type = t;
    btn.textContent = t;
    row.appendChild(btn);
  });
  if(!row.dataset.listenerAttached){
    row.addEventListener("click", e => {
      if(e.target.tagName !== "BUTTON") return;
      ACTIVE_TYPE = e.target.dataset.type;
      ACTIVE_CAT = "all"; // reset category when switching type
      row.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      e.target.classList.add("active");
      renderChips(ALL_BOOKS.filter(b => b.visible === "yes" && (ACTIVE_TYPE === "all" || b.product_type === ACTIVE_TYPE)));
      applyFilters();
    });
    row.dataset.listenerAttached = "true";
  }
}

function renderChips(books){
  const cats = new Set();
  books.forEach(b => b.category.split(",").forEach(c => c.trim() && cats.add(c.trim())));
  const row = document.getElementById("categoryChips");
  row.innerHTML = '<button class="chip active" data-cat="all">All Books</button>';
  [...cats].sort().forEach(cat => {
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.dataset.cat = cat;
    btn.textContent = cat;
    row.appendChild(btn);
  });
  if(!row.dataset.listenerAttached){
    row.addEventListener("click", e => {
      if(e.target.tagName !== "BUTTON") return;
      ACTIVE_CAT = e.target.dataset.cat;
      row.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      e.target.classList.add("active");
      applyFilters();
    });
    row.dataset.listenerAttached = "true";
  }
  document.getElementById("statCats").textContent = cats.size;
}

const CATEGORY_ICONS = ["&#127811;","&#9968;","&#127793;","&#128188;","&#127968;","&#127902;","&#128214;","&#128221;","&#129521;"];

function renderCategoryCircles(books){
  const cats = new Set();
  books.forEach(b => b.category.split(",").forEach(c => c.trim() && cats.add(c.trim())));
  const row = document.getElementById("categoryCircles");
  const sorted = [...cats].sort();
  row.innerHTML = sorted.map((cat, i) => `
    <button class="category-circle" data-cat="${cat}">
      <span class="ring glass">${CATEGORY_ICONS[i % CATEGORY_ICONS.length]}</span>
      <span>${cat}</span>
      <small>Shop Now</small>
    </button>
  `).join("");
  if(!row.dataset.listenerAttached){
    row.addEventListener("click", e => {
      const btn = e.target.closest(".category-circle");
      if(!btn) return;
      ACTIVE_TYPE = "all";
      ACTIVE_CAT = btn.dataset.cat;
      document.querySelectorAll("#categoryChips .chip").forEach(c => c.classList.remove("active"));
      const matchingChip = [...document.querySelectorAll("#categoryChips .chip")].find(c => c.dataset.cat === ACTIVE_CAT);
      if(matchingChip) matchingChip.classList.add("active");
      applyFilters();
      document.getElementById("catalog").scrollIntoView({ behavior: "smooth" });
    });
    row.dataset.listenerAttached = "true";
  }
}

function renderBestSellerRail(books){
  const rail = document.getElementById("bestSellerRail");
  const bestSellers = books.filter(b => b.best_seller === "yes" || b.featured === "yes").slice(0, 12);
  const toShow = bestSellers.length > 0 ? bestSellers : books.slice(0, 8);
  rail.innerHTML = toShow.map(b => cardHTML(b)).join("");
}

function renderNewReleaseRail(books){
  const rail = document.getElementById("newReleaseRail");
  const newOnes = books.filter(b => b.new_release === "yes").slice(0, 12);
  const toShow = newOnes.length > 0 ? newOnes : [...books].reverse().slice(0, 8);
  rail.innerHTML = toShow.map(b => cardHTML(b)).join("");
}

function coverBlock(b){
  if(b.cover_image_url) return `<img src="${b.cover_image_url}" alt="${b.title} cover" loading="lazy">`;
  return b.title;
}

function priceLabel(b){
  return CURRENCY === "inr" ? `₹${b.price_inr || "—"}` : `$${b.price_usd || "—"}`;
}

function originalPriceLabel(b){
  const orig = CURRENCY === "inr" ? b.original_price_inr : b.original_price_usd;
  if(!orig) return "";
  const symbol = CURRENCY === "inr" ? "₹" : "$";
  return `<span class="old-price">${symbol}${orig}</span>`;
}

function ratingHTML(b){
  if(!b.rating) return "";
  const full = Math.round(parseFloat(b.rating));
  const stars = "★".repeat(Math.min(full, 5)) + "☆".repeat(Math.max(0, 5 - full));
  return `<div class="rating">${stars}${b.review_count ? ` (${b.review_count})` : ""}</div>`;
}

function cardHTML(b){
  return `
    <a class="card glass" href="/book/?id=${encodeURIComponent(b.id)}" target="_blank" rel="noopener">
      <div class="cover">${coverBlock(b)}</div>
      <div class="card-body">
        <span class="card-cat">${b.category.split(",")[0].trim()}</span>
        <div class="card-title">${b.title}</div>
        <div class="card-author">${b.author}</div>
        ${ratingHTML(b)}
        <div class="card-foot">
          <span class="price">${originalPriceLabel(b)}${priceLabel(b)}</span>
          <span class="buy-btn">View Book</span>
        </div>
      </div>
    </a>`;
}

function applyFilters(){
  const q = (document.getElementById("searchInput").value || "").toLowerCase().trim();
  VISIBLE_BOOKS = ALL_BOOKS.filter(b => b.visible === "yes");
  if(ACTIVE_TYPE !== "all"){
    VISIBLE_BOOKS = VISIBLE_BOOKS.filter(b => b.product_type === ACTIVE_TYPE);
  }
  if(ACTIVE_CAT !== "all"){
    VISIBLE_BOOKS = VISIBLE_BOOKS.filter(b => b.category.split(",").map(c=>c.trim()).includes(ACTIVE_CAT));
  }
  if(q){
    VISIBLE_BOOKS = VISIBLE_BOOKS.filter(b => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q));
  }
  RENDER_COUNT = 0;
  loadBatchCount = 0;
  const grid = document.getElementById("bookGrid");
  grid.innerHTML = "";
  if(VISIBLE_BOOKS.length === 0){
    grid.innerHTML = '<div class="empty">No books match — try a different category or search term.</div>';
    return;
  }
  loadMore();
}

let loadBatchCount = 0;

function loadMore(){
  const grid = document.getElementById("bookGrid");
  const existingSentinel = document.getElementById("scrollSentinel");
  if(existingSentinel) existingSentinel.remove();

  const next = VISIBLE_BOOKS.slice(RENDER_COUNT, RENDER_COUNT + PAGE_SIZE);
  next.forEach(b => grid.insertAdjacentHTML("beforeend", cardHTML(b)));
  RENDER_COUNT += next.length;
  loadBatchCount++;

  // Native in-feed ad every 2 batches (~every 24 books) as the user scrolls —
  // spans the full grid width so it doesn't look like a book card.
  if(next.length > 0 && loadBatchCount % 2 === 0 && RENDER_COUNT < VISIBLE_BOOKS.length){
    grid.insertAdjacentHTML("beforeend",
      '<div class="ad-slot in-feed glass" data-ad-type="infeed"><span class="ad-label">Advertisement</span></div>');
  }

  if(RENDER_COUNT < VISIBLE_BOOKS.length){
    const sentinel = document.createElement("div");
    sentinel.id = "scrollSentinel";
    sentinel.textContent = "Loading more titles…";
    grid.appendChild(sentinel);
    if(observer) observer.disconnect();
    observer = new IntersectionObserver(entries => {
      if(entries[0].isIntersecting) loadMore();
    }, {rootMargin:"400px"});
    observer.observe(sentinel);
  }
  injectAds();
}

function refreshPricesOnly(){
  document.querySelectorAll("#bookGrid .card").forEach((card, i) => {
    const b = VISIBLE_BOOKS[i];
    if(!b) return;
    const priceEl = card.querySelector(".price");
    if(priceEl) priceEl.innerHTML = originalPriceLabel(b) + priceLabel(b);
  });
}

function boot(books){
  ALL_BOOKS = books.map(normalizeRow);
  const visibleBooks = ALL_BOOKS.filter(b=>b.visible==="yes");
  document.getElementById("statCount").textContent = visibleBooks.length;
  renderTypeChips(visibleBooks);
  renderChips(visibleBooks.filter(b => ACTIVE_TYPE==="all" || b.product_type===ACTIVE_TYPE));
  renderCategoryCircles(visibleBooks);
  renderBestSellerRail(visibleBooks);
  renderNewReleaseRail(visibleBooks);
  applyFilters();
  const searchInput = document.getElementById("searchInput");
  if(!searchInput.dataset.listenerAttached){
    searchInput.addEventListener("input", applyFilters);
    searchInput.dataset.listenerAttached = "true";
  }
}

function normalizePost(p){
  return {
    slug: p.slug || "",
    title: p.title || "Untitled",
    category: p.category || "Journal",
    excerpt: p.excerpt || "",
    date_published: p.date_published || "",
    visible: (p.visible || "Yes").trim().toLowerCase(),
    featured: (p.featured || "No").trim().toLowerCase(),
  };
}

function postCardHTML(p){
  return `
    <div class="glass blog-card">
      <span class="eyebrow">${p.category}</span>
      <h3>${p.title}</h3>
      <p>${p.excerpt}</p>
      <a class="read-more" href="#blog-${p.slug}">Read the piece</a>
    </div>`;
}

function bootBlog(posts){
  const grid = document.getElementById("blogGrid");
  let visiblePosts = posts.map(normalizePost).filter(p => p.visible === "yes" && p.title);
  // newest first when a date is provided
  visiblePosts.sort((a, b) => (b.date_published || "").localeCompare(a.date_published || ""));

  if(visiblePosts.length === 0){
    grid.innerHTML = '<div class="empty">No posts published yet — check back soon.</div>';
    return;
  }

  let html = "";
  visiblePosts.forEach((p, i) => {
    html += postCardHTML(p);
    // native ad every 6 posts, spanning the row
    if((i + 1) % 6 === 0 && i !== visiblePosts.length - 1){
      html += '<div class="ad-slot in-feed glass" data-ad-type="infeed" style="grid-column:1/-1;"><span class="ad-label">Advertisement</span></div>';
    }
  });
  grid.innerHTML = html;
  injectAds();
}

document.getElementById("currencyToggle").addEventListener("click", e => {
  if(e.target.tagName !== "BUTTON") return;
  CURRENCY_AUTO_SET = false; // manual choice always wins from here on
  CURRENCY = e.target.dataset.cur;
  document.querySelectorAll("#currencyToggle button").forEach(b => b.classList.remove("active"));
  e.target.classList.add("active");
  refreshPricesOnly();
  renderBestSellerRail(ALL_BOOKS.filter(b => b.visible === "yes"));
});

document.getElementById("railLeft").addEventListener("click", () => {
  document.getElementById("bestSellerRail").scrollBy({ left: -440, behavior: "smooth" });
});
document.getElementById("railRight").addEventListener("click", () => {
  document.getElementById("bestSellerRail").scrollBy({ left: 440, behavior: "smooth" });
});
document.getElementById("railLeftNew").addEventListener("click", () => {
  document.getElementById("newReleaseRail").scrollBy({ left: -440, behavior: "smooth" });
});
document.getElementById("railRightNew").addEventListener("click", () => {
  document.getElementById("newReleaseRail").scrollBy({ left: 440, behavior: "smooth" });
});

// ---- Auto-detect region for default currency (manual toggle always overrides) ----
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
        CURRENCY_AUTO_SET = true;
        document.querySelectorAll("#currencyToggle button").forEach(b => {
          b.classList.toggle("active", b.dataset.cur === detected);
        });
        resolve();
      })
      .catch(() => { clearTimeout(timeout); resolve(); });
  });
}

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbysLss-DsGPcDeDVGpec2vhyYtQCDCve1LILMpVyjuTWE3asAfyILZ2T2SDvL8vA_QeuQ/exec";

document.getElementById("emailForm").addEventListener("submit", function(e){
  e.preventDefault();
  const email = document.getElementById("emailInput").value;
  const note = document.getElementById("captureNote");

  if(!APPS_SCRIPT_URL){
    note.textContent = "Thanks — " + email + " is on the list. (Backend not connected yet — see setup guide.)";
    document.getElementById("emailInput").value = "";
    return;
  }

  note.textContent = "Sending…";
  fetch(APPS_SCRIPT_URL, {
    method: "POST",
    mode: "no-cors", // Apps Script won't return CORS headers; this stops the browser
                      // from wrongly treating a successful save as a failed request
    body: JSON.stringify({ type: "subscribe", email: email, source: "website_signup_form" }),
    headers: { "Content-Type": "text/plain;charset=utf-8" }
  })
  .then(() => {
    note.textContent = "Thanks — you're on the list!";
    document.getElementById("emailInput").value = "";
  })
  .catch(() => {
    note.textContent = "Something went wrong — please try again in a moment.";
  });
});

// ---- Feedback / testimonials ----
const MESSAGES_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vThBy96JRuzGQF43IeOV9EnIfH1tJsAKosE_cKMmP6cMUbDlX_rK9IgOevynDQWp8WBZ65oqAPW8wiq/pub?gid=1945752266&single=true&output=csv";

const SAMPLE_MESSAGES = [
  {name:"Priya S.", message:"The export guide saved me weeks of guessing on documentation. Clear and practical.", visible:"Yes"},
  {name:"Daniel K.", message:"Good content, would love more case studies from Australian buyers specifically.", visible:"Yes"},
];

function renderTestimonials(rows){
  const grid = document.getElementById("testimonialGrid");
  const visible = rows.filter(r => (r.visible || "").trim().toLowerCase() === "yes" && r.message);
  if(visible.length === 0){
    grid.innerHTML = '<div class="empty">No messages featured yet.</div>';
    return;
  }
  grid.innerHTML = visible.map(r => `
    <div class="glass blog-card">
      <span class="eyebrow">${r.name || "A Reader"}</span>
      <p>${r.message}</p>
    </div>
  `).join("");
}

loadMessages();

document.getElementById("messageForm").addEventListener("submit", function(e){
  e.preventDefault();
  const name = document.getElementById("msgName").value;
  const email = document.getElementById("msgEmail").value;
  const message = document.getElementById("msgText").value;
  const note = document.getElementById("msgNote");
  const form = this;

  if(!APPS_SCRIPT_URL){
    note.textContent = "Thanks — your message has been sent. (Backend not connected yet — see setup guide.)";
    form.reset();
    return;
  }

  note.textContent = "Sending…";
  fetch(APPS_SCRIPT_URL, {
    method: "POST",
    mode: "no-cors",
    body: JSON.stringify({ type: "message", name: name, email: email, message: message }),
    headers: { "Content-Type": "text/plain;charset=utf-8" }
  })
  .then(() => {
    note.textContent = "Thanks — your message has been sent. We read every one.";
    form.reset();
  })
  .catch(() => {
    note.textContent = "Something went wrong — please try again in a moment.";
  });
});

function loadBooks(cacheBust){
  const url = SHEET_CSV_URL + (cacheBust ? "&cb=" + Date.now() : "");
  Papa.parse(url, {
    download: true,
    header: true,
    complete: (results) => boot(results.data.filter(r => r.title)),
    error: () => boot(SAMPLE),
  });
}

function loadBlog(cacheBust){
  const url = BLOG_CSV_URL + (cacheBust ? "&cb=" + Date.now() : "");
  Papa.parse(url, {
    download: true,
    header: true,
    complete: (results) => bootBlog(results.data.filter(r => r.title)),
    error: () => bootBlog(SAMPLE_POSTS),
  });
}

function loadMessages(cacheBust){
  const url = MESSAGES_CSV_URL + (cacheBust ? "&cb=" + Date.now() : "");
  if(MESSAGES_CSV_URL){
    Papa.parse(url, {
      download: true, header: true,
      complete: (results) => renderTestimonials(results.data),
      error: () => renderTestimonials(SAMPLE_MESSAGES),
    });
  } else {
    renderTestimonials(SAMPLE_MESSAGES);
  }
}

document.getElementById("refreshBtn").addEventListener("click", function(){
  const btn = this;
  btn.style.transition = "transform 0.6s ease";
  btn.style.transform = "rotate(360deg)";
  setTimeout(() => { btn.style.transform = "rotate(0deg)"; }, 600);
  loadBooks(true);
  loadBlog(true);
  loadMessages(true);
  loadAdSettings(true);
});

detectRegionCurrency().then(() => {
  loadBooks();
  loadBlog();
  loadAdSettings();
});
