const SETTINGS_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vThBy96JRuzGQF43IeOV9EnIfH1tJsAKosE_cKMmP6cMUbDlX_rK9IgOevynDQWp8WBZ65oqAPW8wiq/pub?gid=693120599&single=true&output=csv";
let WORKER_BASE_URL = "";
Papa.parse(SETTINGS_CSV_URL, {
  download: true, header: true,
  complete: (results) => {
    const map = {};
    results.data.forEach(r => { if(r.setting_key) map[r.setting_key.trim()] = (r.setting_value || "").trim(); });
    WORKER_BASE_URL = map.worker_base_url || "";
  }
});

document.getElementById("reissueBtn").addEventListener("click", async () => {
  const order_id = document.getElementById("reissueOrderId").value.trim();
  const email = document.getElementById("reissueEmail").value.trim();
  const status = document.getElementById("reissueStatus");
  if(!order_id || !email){ status.textContent = "Please fill in both fields."; return; }
  if(!WORKER_BASE_URL){ status.textContent = "Reissue service isn't connected yet — contact support directly."; return; }

  status.textContent = "Checking…";
  try{
    const resp = await fetch(WORKER_BASE_URL + "/api/reissue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id, email })
    });
    const result = await resp.json();
    if(resp.ok && result.download_url){
      status.innerHTML = 'New link ready: <a href="' + WORKER_BASE_URL + result.download_url + '">Download now</a> (expires soon, use it right away).';
    } else {
      status.textContent = result.error || "Couldn't find a matching paid order.";
    }
  } catch(err){
    status.textContent = "Something went wrong — please try again or contact support.";
  }
});
