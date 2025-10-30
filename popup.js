/**
 * This is the logic for the popup page. The popup prefills fields from the current vendor page or Kanopy queue,
 * Loads Alma data (funds, reporting codes, and user search),
 * Collects user input for the PO line,
 * Sends CREATE_PO_LINE to the background script
 * Handles locking/unlocking states depending on whether the API key is available
 * 
 * @author Alana Bregman
 *
 */

// helper
const $ = (id) => document.getElementById(id);

/**
 * If the given form field is currently blank, fill it with val.
 * If the user already typed something, we leave it alone.
 * @param {*} id field id
 * @param {*} val  default val
 * @returns 
 */
function setValueIfEmpty(id, val) {
  const el = $(id);
  if (!el) return;
  if (!el.value && val != null && val !== "") el.value = String(val);
}

/**
 * convert x to number with a fallback
 * @param {} x the thing to be converted to number
 * @param {*} fallback the fallback number
 * @returns x converted to a number, or the fallback
 */
function toNumber(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Attach Select2 to a <select> by ID, if jQuery/Select2 are available.
 * @param {*} id is the id of the <select>
 * @param {*} opts are the options that will be in the dropdown
 * @returns the select2 dropdown
 */
function select2Init(id, opts = {}) {
  if (!window.jQuery) return null;
  const $el = window.jQuery("#" + id);
  if (!$el.length) return null;
  $el.select2(Object.assign({ width: "100%" }, 
  opts));
  return $el;
}

/**
 * Open the options page in a new window
 */
function openOptions() {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("options.html"));
}

/**
 * Shows/hides a banner at the top of the popup informing user that no API key is available.
 * Called if background says no unlocked key.
 * @param {*} show whether we should show or not
 * @param {*} msg message to be shown in banner
 * @returns nothing
 */
function paintNoKeyBanner(show, msg) {
  const b = document.getElementById("apiKeyBanner");
  if (!b) return;
  if (show) {
    b.style.display = "block";
    b.innerHTML = `<strong>${msg || "No API Key set."}</strong> `;
    const btn = document.createElement("button");
    btn.textContent = "Open Options";
    btn.setAttribute("data-allow-when-locked","true");
    btn.onclick = openOptions;
    b.appendChild(btn);
  } else {
    b.style.display = "none";
    b.innerHTML = "";
  }
}

/**
 * If there are queued vendor items in background, return them. Else return null.
 * @returns null if no queued items, or a list of the queued items.
 */
async function getVendorPrefill() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_VENDOR_PREFILL" }, (res) => {
      resolve(res?.data || null);
    });
  });
}

/**
 * Fallback for Kanopy
 * @returns the electronic title one time fall back
 */
async function getFallbackEOneTime() {
  return "ELECTRONIC_TITLE_OT";
}

/**
 * If background has a Kanopy queue item, pulls the first item and pre-populates title, price, quantity,
 * currency, supplier ("Kanopy"), default PO line type = "electronic title - one time", 
 * default material type = "streaming", and receiving note (license, Kanopy ID)
 */
(async function maybePrefillFromVendor() {
  const pre = await getVendorPrefill();
  if (!pre || !pre.items?.length) return;

  const it = pre.items[0];

  // Basic text/number fields
  setValueIfEmpty("title", it.title || "");
  if (it.price != null) {
    const p = typeof it.price === "string" ? parseFloat(it.price.replace(/[^0-9.]/g, "")) : it.price;
    if (Number.isFinite(p)) setValueIfEmpty("price", p);
  }
  setValueIfEmpty("quantity", String(it.quantity || 1));
  if (it.currency) {
    const c = document.getElementById("currency");
    if (c && !c.value) c.value = it.currency;
  }

  setValueIfEmpty("url", "Kanopy");

  //Default PO Line Type to Electronic Title - One Time
{
  const poSel = document.getElementById("poType");
  if (poSel && !poSel.dataset.prefilledByKanopy) {
    const want = "electronic title - one time";
    const opt = Array.from(poSel.options).find(o => (o.value || "").toLowerCase() === want);
    if (opt) {
      poSel.value = opt.value;
      poSel.dataset.prefilledByKanopy = "1";
      if (window.jQuery && window.jQuery("#poType").data("select2")) {
        window.jQuery("#poType").trigger("change");
      }
    }
  }
}

//Default Material Type to Streaming video (label "streaming")
{
  const mt = document.getElementById("materialType");
  if (mt && !mt.dataset.prefilledByKanopy) {
    const opt = Array.from(mt.options).find(o => (o.value || "").toLowerCase() === "streaming");
    if (opt) {
      mt.value = opt.value;
      mt.dataset.prefilledByKanopy = "1";
      if (window.jQuery && window.jQuery("#materialType").data("select2")) {
        window.jQuery("#materialType").trigger("change");
      }
    }
  }
}


  // Default Reporting Code to Streaming Video 
  const rcSel = document.getElementById("reportCodeSelect");
if (rcSel) {
  const opt = Array.from(rcSel.options).find(o =>
    (o.value || "").toUpperCase() === "Streaming Video"
  );
  if (opt) {
    rcSel.value = opt.value;
  } else {
    const alt = Array.from(rcSel.options).find(o => /streaming/i.test(o.textContent || ""));
    if (alt) rcSel.value = alt.value;
  }
}

  // Receiving note
  const rn = [];
  if (it.license)   rn.push(`License: ${it.license}`);
  if (it.kanopy_id) rn.push(`Kanopy ID: ${it.kanopy_id}`);
  if (rn.length) setValueIfEmpty("receivingNote", rn.join("\n"));

  // Optional toast
  if (typeof showToast === "function") showToast("Loaded details from Kanopy cart");
})();




function paintRemaining() {
  chrome.storage.local.get(["ALMA_REMAINING"], ({ ALMA_REMAINING }) => {
    const pill = document.getElementById("usagePill");
    if (!pill) return;
    const n = Number(ALMA_REMAINING);
    pill.textContent = `Remaining queries: ${Number.isFinite(n) ? n : "—"}`;
  });
}

async function waitForApiKey(timeoutMs = 5000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      chrome.runtime.sendMessage({ type: "HAS_API_KEY" }, (res) => {
        if (res?.hasKey) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, intervalMs);
      });
    };
    tick();
  });
}

document.addEventListener("DOMContentLoaded", paintRemaining);
chrome.storage.onChanged.addListener((c,a)=>{ if(a==="local" && ("ALMA_REMAINING" in c)) paintRemaining(); });

window.__LOCKED__ = false;

window.__LOCKED__ = false;

function lockPopupUI(locked) {
  window.__LOCKED__ = !!locked;

  // 1) Toggle native controls
  document.querySelectorAll("input, select, textarea, button").forEach(el => {
    if (el.dataset.allowWhenLocked === "true") return;
    el.disabled = !!locked;
    el.classList.toggle("is-locked", !!locked);
  });

  // 2) Toggle Select2 widgets (correct IDs)
  if (window.jQuery) {
    const ids = ["#fundSelect", "#reportCodeSelect", "#interestedUsers", "#poType"];
    ids.forEach(sel => {
      const $el = window.jQuery(sel);
      if ($el.length) $el.prop("disabled", !!locked).trigger("change.select2");
    });

    // 3) Safety net: any other select2 on the page
    window.jQuery("select.select2").each(function () {
      window.jQuery(this).prop("disabled", !!locked).trigger("change.select2");
    });
  }
}


// Query background for key presence
function checkApiKeyAndGate() {
  chrome.runtime.sendMessage({ type: "HAS_API_KEY" }, (res) => {
    if (res?.hasKey) {
      paintNoKeyBanner(false);
      lockPopupUI(false);
      return;
    }
    chrome.runtime.sendMessage({ type: "HAS_ENCRYPTED_KEY" }, (r2) => {
      const hasSaved = !!r2?.hasEncrypted;
      if (hasSaved) {
        // key is saved; keep UI enabled and let background auto-unlock
        paintNoKeyBanner(false);
        lockPopupUI(false);
      } else {
        // truly no key — show banner and lock
        paintNoKeyBanner(true, "No API key set. Please add it in Options:");
        lockPopupUI(true);
      }
    });
  });
}


document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("openOptionsBtn")?.addEventListener("click", openOptions);
  checkApiKeyAndGate();
});

chrome.storage.onChanged.addListener((chg, area) => {
  if (area === "local" && "ALMA_API_KEY" in chg) checkApiKeyAndGate();
});

// -------------------- price sanitization --------------------
function parsePriceAndCurrency(raw) {
  if (raw == null) return { amount: null, currency: null };
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { amount: raw, currency: null };
  }
  const s = String(raw).trim();
  let currency = null;
  if (/\$/.test(s)) currency = "USD";
  else if (/£/.test(s)) currency = "GBP";
  else if (/€/.test(s)) currency = "EUR";

  const digits = s.replace(/[^0-9.,-]/g, "");
  const hasDot = /\./.test(digits);
  const hasComma = /,/.test(digits);
  let normalized;
  if (hasDot && hasComma) normalized = digits.replace(/,/g, "");
  else if (!hasDot && hasComma) normalized = digits.replace(/,/g, ".");
  else normalized = digits.replace(/,/g, "");
  const amount = parseFloat(normalized);
  return { amount: Number.isFinite(amount) ? amount : null, currency };
}

// -------------------- page scrape (prefill) --------------------
function applyScrape(d = {}) {
  // Title
  if (d.title) setValueIfEmpty("title", d.title);

  // Price (sanitize to pure number)
  if (typeof d.price !== "undefined" && d.price !== null && d.price !== "") {
    const { amount, currency } = parsePriceAndCurrency(d.price);
    if (amount !== null) setValueIfEmpty("price", amount);
    const curEl = $("currency");
    if (currency && curEl && !curEl.value) curEl.value = currency;
  }

  // Supplier/vendor host
  if (d.vendor || d.supplier) setValueIfEmpty("url", d.vendor || d.supplier);

  // Explicit currency from content script wins if field still empty
  if (d.currency) {
    const curEl = $("currency");
    if (curEl && !curEl.value) curEl.value = d.currency;
  }
}

function inlineScrape(tabId) {
  chrome.scripting.executeScript(
    {
      target: { tabId },
      func: () => {
        const out = { title: "", price: "", currency: "", vendor: location.hostname };

        // Title
        const t1 = document.querySelector("#productTitle");
        out.title = (t1?.textContent || document.title || "").trim();

        // Price text
        const priceNode =
          document.querySelector("#corePrice_feature_div .a-offscreen") ||
          document.querySelector(".a-price .a-offscreen") ||
          document.querySelector("[data-a-color='price'] .a-offscreen");
        const txt = priceNode?.textContent?.trim() || "";
        out.price = txt; // keep raw; we'll sanitize in popup

        // Infer currency from symbols
        if (txt.includes("$")) out.currency = "USD";
        else if (txt.includes("£")) out.currency = "GBP";
        else if (txt.includes("€")) out.currency = "EUR";

        return out;
      }
    },
    (res) => {
      const data = res && res[0] && res[0].result;
      if (data) applyScrape(data);
    }
  );
}

function prefillFromPage() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs && tabs[0] && tabs[0].id;
    if (!tabId) return;

    // Your existing content.js listens for SCRAPE_BOOK_INFO
    chrome.tabs.sendMessage(tabId, { type: "SCRAPE_BOOK_INFO" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        // content script not reachable -> fallback inject
        inlineScrape(tabId);
        return;
      }
      applyScrape(resp);
    });
  });
}

// -------------------- Alma: Funds --------------------
function loadFunds() {
  const id = "fundSelect";
  const sel = document.getElementById(id);
  if (!sel) return;

  // (Re)init Select2 with consistent options
  function initS2(placeholder) {
    if (!window.jQuery) return;
    const $el = window.jQuery("#" + id);
    if ($el.data("select2")) $el.select2("destroy");
    $el.select2({
      width: "100%",
      minimumInputLength: 0,
      allowClear: true,                       // enables placeholder when empty
      placeholder: placeholder || "Select a fund...",
      language: {
        searching: () => "Searching...",
        noResults: () => "No funds found"
      }
    });
  }

  chrome.runtime.sendMessage({ type: "GET_FUNDS" }, (res) => {
    const list = Array.isArray(res?.funds) ? res.funds : [];

    // Reset options
    sel.innerHTML = "";

    if (!list.length) {
      sel.disabled = true;
      // No dummy <option>; Select2 will show the placeholder
      initS2("No funds available");
      return;
    }

    sel.disabled = false;

    // Add only real fund options
    list.forEach(f => {
      if (!f?.code) return;
      const o = document.createElement("option");
      o.value = f.code;
      o.textContent = f.name ? `${f.code} - ${f.name}` : f.code;
      sel.appendChild(o);
    });

    // Force empty so the placeholder shows until the user picks one
    sel.value = "";

    initS2("Select a fund...");
  });
}

// -------------------- Alma: Reporting Codes (Level 1) --------------------
// Populates the Reporting Code <select> from the background script.
// Expects items like { code, description } and renders the description (or code if missing).
function loadReportingCodes() {
  const id = "reportCodeSelect";
  const sel = document.getElementById(id);
  if (!sel) return;

  // Helper: (re)initialize Select2 with consistent options
  function initS2(placeholder) {
    if (!window.jQuery) return;
    const $el = window.jQuery("#" + id);

    // Destroy previous Select2 if already attached
    if ($el.data("select2")) {
      $el.select2("destroy");
    }

    $el.select2({
      width: "100%",
      minimumInputLength: 0,
      placeholder: placeholder || "Choose reporting code...",
      allowClear: true            // enables the placeholder when no selection
    });
  }

  // Remember current selection to restore if list reloads
  const prev = sel.value;

  chrome.runtime.sendMessage({ type: "GET_REPORTING_CODES", level: 1 }, (res) => {
    const list = Array.isArray(res?.reportingCodes) ? res.reportingCodes : [];
    const hadError = !!res?.error;

    // Reset dropdown
    sel.innerHTML = "";

    if (!list.length) {
      // Empty/error state
      const msg = hadError ? "Reporting codes not available" : "No reporting codes found";
      sel.disabled = true;
      initS2(msg);
      return;
    }

    // Populate with valid options
    sel.disabled = false;
    for (const rc of list) {
      const opt = document.createElement("option");
      opt.value = rc.code;
      opt.textContent = rc.description || rc.code;
      sel.appendChild(opt);
    }

    // Restore previous selection if still valid
    if (prev && list.some(x => x.code === prev)) {
      sel.value = prev;
    } else {
      sel.value = ""; // force empty so placeholder shows
    }

    // Init Select2 with placeholder
    initS2("Choose reporting code...");
  });
}

const MATERIAL_CODE_MAP = {
  "book":  "BOOK",
  "dvd":   "DVD",
  "ebook": "EBOOK",
  "streaming": "STREAMING_VIDEO"
};

// Initialize the Select2 control
function initMaterialTypeSelect() {
  if (!window.jQuery) return;
  const $mt = window.jQuery("#materialType");
  if ($mt.data("select2")) $mt.select2("destroy");
  $mt.select2({
    width: "100%",
    minimumInputLength: 0,
    placeholder: "Choose material type…"
  });
}

// Convert UI selection to Alma code (defaults to BOOK if empty)
function getMaterialTypeCode() {
  const raw = (document.getElementById("materialType")?.value || "").trim();
  if (!raw) return "BOOK"; // default if user didn’t pick
  const code = MATERIAL_CODE_MAP[raw.toLowerCase()];
  return code || "BOOK";
}
// --- Vendor prefill flag (so loadPoLineTypes can default properly) ---
async function isKanopyVendorPrefill() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_VENDOR_PREFILL" }, (res) => {
      const v = res?.data?.vendor || "";
      resolve(String(v).toUpperCase().includes("KANOPY"));
    });
  });
}

function advanceKanopyQueue() {
  chrome.runtime.sendMessage({ type: "ADVANCE_VENDOR_PREFILL" }, () => {});
}


// -------------------- Alma: Interested Users (Select2 AJAX) --------------------
function initInterestedUsers() {
  const id = "interestedUsers";
  const el = document.getElementById(id);
  if (!el || !window.jQuery) return;

  // Always enable the control
  el.disabled = false;

  const $el = window.jQuery("#" + id);

  // Destroy any previous Select2 instance to avoid double-binding
  if ($el.data("select2")) $el.select2("destroy");

  $el.select2({
    width: "100%",
    allowClear: true,
    placeholder: "Search Alma users",
    minimumInputLength: 1,  // change to 1 if you want earlier partials
    ajax: {
      delay: 300,
      transport: function (params, success, failure) {
        const term = (params?.data?.term || "").trim();
        const page = Math.max(1, Number(params?.data?.page || 1));
      
        chrome.runtime.sendMessage(
          { type: "SEARCH_USERS", term, page, limit: 20 },  // <= add page (+ optional limit)
          (res) => {
            if (!res || res.error) return failure(res?.error || "search error");
            success({
              results: res.users || [],
              pagination: { more: !!res.more }               // <= tell Select2 if more pages exist
            });
          }
        );
      },
      processResults: (data) => data
    },
    templateResult: (item) => item.label || item.text || item.id,
    templateSelection: (item) => item.label || item.text || item.id,
    language: {
      searching: () => "Searching...",
      noResults: () => "No users found",
      loadingMore:   () => "Loading more results...",
      inputTooShort: function () {
        return "Type name or unique identifier.";
      }
    }
  });

  // Validate selection against Alma; if invalid, remove it and notify
  $el.on("select2:select", (e) => {
    const pickedId = e?.params?.data?.id;
    if (!pickedId) return;

    chrome.runtime.sendMessage({ type: "GET_USER_BY_ID", id: pickedId }, (res) => {
      if (!res?.ok) {
        // Remove the invalid option
        const opt = Array.from(el.options).find(o => o.value === pickedId);
        if (opt) opt.remove();
        $el.trigger("change");
        alert(`User "${pickedId}" is not valid in Alma (${res?.status || "error"}).`);
        return;
      }

      // If background returns a nicer display label ("Last, First (id)"), apply it
      const label = res.user?.label;
      if (label) {
        const opt = Array.from(el.options).find(o => o.value === pickedId);
        if (opt) {
          opt.textContent = label;
          $el.trigger("change"); // refresh chip text
        }
      }
    });
  });
}








// -------------------- Submit --------------------
function gatherInterestedUsers() {
  const sel = document.getElementById("interestedUsers");
  if (!sel) return [];
  return Array.from(sel.selectedOptions).map(o => ({
    primary_id: o.value,
    hold_item: true,
    notify_receiving_activation: true
  }));
}

// --- in popup.js ---

function collectForm() {
  // normalize only; do not shape Alma JSON here
  const normalizePoType = (val) => {
    const s = String(val || "").trim().toLowerCase();
    if (!s) return "PRINT_OT";
    const map = {
      "print book - one time": "PRINT_OT",
      "physical - one time": "PRINT_OT",
      "print journal - one time": "PRINT_JNL_OT",
      "electronic book - one time": "E_BOOK_OT",
      "electronic journal - one time": "E_JOURNAL_OT",
      "electronic collection - one time": "E_COLLECTION_OT",
      "electronic title - one time": "ELECTRONIC_TITLE_OT",
      "database service - one time": "DB_SERVICE_OT",
      "physical computer file - one time": "PHYS_COMPFILE_OT",
      "remote computer file - one time": "REM_COMPFILE_OT"
    };
    if (/^[A-Z0-9_]+$/.test(val)) return val;  // already a code
    return map[s] || "PRINT_OT";
  };

  return {
    title: document.getElementById("title")?.value?.trim() || "",
    price: Number(document.getElementById("price")?.value || 0),
    currency: document.getElementById("currency")?.value || "USD",
    quantity: Math.max(1, Number(document.getElementById("quantity")?.value || 1)),
    supplier: document.getElementById("url")?.value?.trim() || "",
    po_line_type: normalizePoType(document.getElementById("poType")?.value),
    material_type: getMaterialTypeCode(),
    fund: document.getElementById("fundSelect")?.value || "",
    reporting_code: document.getElementById("reportCodeSelect")?.value || "",
    receiving_note: document.getElementById("receivingNote")?.value?.trim() || "",
    interested_users: gatherInterestedUsers(),
    manual_packaging: false,
    owner: "MAIN",          // simple string, not {value:…}
    location_code: "MSTCK"  // simple string; background will wrap properly
  };
}



function validateForm(f) {
  const miss = [];
  if (!f.title) miss.push("Title");
  if (!f.po_line_type) miss.push("PO Line Type");
  if (!f.fund) miss.push("Fund");
  if (!f.material_type) miss.push("Material Type");
  if (!(f.quantity > 0)) miss.push("Quantity");
  if (f.price < 0) miss.push("List Price");
  return miss;
}

function submitForm() {
  const payload = collectForm();
  const missing = validateForm(payload);
if (missing.length) {
  alert("Please fill required fields: " + missing.join(", "));
  // If Fund is missing, focus it so the user knows what to do.
  if (missing.includes("Fund")) {
    const el = document.getElementById("fundSelect");
    if (el) {
      // Open Select2 if present
      if (window.jQuery && window.jQuery("#fundSelect").data("select2")) {
        window.jQuery("#fundSelect").select2("open");
      } else {
        el.focus();
      }
    }
  }
  return;
}

  chrome.runtime.sendMessage({ type: "CREATE_PO_LINE", payload }, (res) => {
    if (!res || res.error) {
      console.error("CREATE_PO_LINE error:", res?.error || res);
      alert("Failed to create PO line: " + (res?.error || "unknown error"));
      return;
    }
    const n =
    res.po_line_number ||
    res?.raw?.number ||
    res?.raw?.po_line_number ||
    res?.raw?.po_line?.po_line_number ||
    "(not returned)";

    if (n && n !== "(not returned)" && navigator.clipboard) {
      navigator.clipboard.writeText(n).catch(()=>{});
    }  

    alert("PO line created.\nNumber: " + n);
    advanceKanopyQueue();
    window.close();
  });
}

// -------------------- Init --------------------
document.addEventListener("DOMContentLoaded", async () => {
  lockPopupUI(true);
  paintNoKeyBanner(false);

  const hasKey = await waitForApiKey(6000);
  if (!hasKey) { paintNoKeyBanner(true); return; }
  paintNoKeyBanner(false);
  lockPopupUI(false);

  // Init Select2
  select2Init("fundSelect");
  select2Init("reportCodeSelect");
  select2Init("interestedUsers");
  select2Init("poType");
  select2Init("materialType");

  // Default: not Kanopy; compute flag before loading POL types
  window.__KANOPY__ = false;
  window.__KANOPY__ = await isKanopyVendorPrefill();

  // Load Alma-backed data (types last, so flag is known)
  loadFunds();
  loadReportingCodes();

  initInterestedUsers();
  initMaterialTypeSelect();

  // Prefill from page (won't override user's later changes)
  prefillFromPage();

  $("submit")?.addEventListener("click", submitForm);
  $("cancel")?.addEventListener("click", () => window.close());
});


document.addEventListener("keydown", (e) => {
  // Example: Ctrl+Shift+O opens the hidden options page
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "o") {
    chrome.runtime.sendMessage({ type: "OPEN_HIDDEN_OPTIONS" });
  }
});
