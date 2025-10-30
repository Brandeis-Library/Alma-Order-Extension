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
 * Attach Select2 to a <select> by ID, if jQuery/Select2 are available.
 * @param {*} id is the id of the <select>
 * @param {*} opts are the options that will be in the dropdown
 * @returns the select2 dropdown
 */
function select2Init(id, opts = {}) {
    if (!window.jQuery) return null;
    const $el = window.jQuery("#" + id);
    if (!$el.length) return null;
    $el.select2(Object.assign({
            width: "100%"
        },
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
        btn.setAttribute("data-allow-when-locked", "true");
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
        chrome.runtime.sendMessage({
            type: "GET_VENDOR_PREFILL"
        }, (res) => {
            resolve(res?.data || null);
        });
    });
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

    // Receiving note
    const rn = [];
    if (it.license) rn.push(`License: ${it.license}`);
    if (it.kanopy_id) rn.push(`Kanopy ID: ${it.kanopy_id}`);
    if (rn.length) setValueIfEmpty("receivingNote", rn.join("\n"));

    // Optional toast
    if (typeof showToast === "function") showToast("Loaded details from Kanopy cart");
})();

/**
 * Puts number of remaining queries for the day for the API key at top of popup.
 */
function paintRemaining() {
    chrome.storage.local.get(["ALMA_REMAINING"], ({
        ALMA_REMAINING
    }) => {
        const pill = document.getElementById("usagePill");
        if (!pill) return;
        const n = Number(ALMA_REMAINING);
        pill.textContent = `Remaining queries: ${Number.isFinite(n) ? n : "—"}`;
    });
}

/**
 * Checks if background has the decrypted API key in memory within a certain time.
 * @param {*} timeoutMs deadline
 * @param {*} intervalMs time interval we increase by
 * @returns true if key shows up in time, false otherwise.
 */
async function waitForApiKey(timeoutMs = 5000, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
        const tick = () => {
            chrome.runtime.sendMessage({
                type: "HAS_API_KEY"
            }, (res) => {
                if (res?.hasKey) return resolve(true);
                if (Date.now() >= deadline) return resolve(false);
                setTimeout(tick, intervalMs);
            });
        };
        tick();
    });
}

// Put remaining calls on load and keep updated if background changes ALMA_REMAINING.
document.addEventListener("DOMContentLoaded", paintRemaining);
chrome.storage.onChanged.addListener((c, a) => {
    if (a === "local" && ("ALMA_REMAINING" in c)) paintRemaining();
});

window.__LOCKED__ = false;

/**
 * If the popup is locked, disable dropdowns and inpputs
 * @param {*} locked whether the popup is locked or not
 */
function lockPopupUI(locked) {
    window.__LOCKED__ = !!locked;

    document.querySelectorAll("input, select, textarea, button").forEach(el => {
        if (el.dataset.allowWhenLocked === "true") return;
        el.disabled = !!locked;
        el.classList.toggle("is-locked", !!locked);
    });

    if (window.jQuery) {
        const ids = ["#fundSelect", "#reportCodeSelect", "#interestedUsers", "#poType"];
        ids.forEach(sel => {
            const $el = window.jQuery(sel);
            if ($el.length) $el.prop("disabled", !!locked).trigger("change.select2");
        });

        window.jQuery("select.select2").each(function() {
            window.jQuery(this).prop("disabled", !!locked).trigger("change.select2");
        });
    }
}

/**
 * If background has the decrypted API key in memory, then don't lock popup, and hide banner
 * If there is an encrypted API key, still don't lock
 * If no API key, then lock and show banner
 */
function checkApiKeyAndGate() {
    chrome.runtime.sendMessage({
        type: "HAS_API_KEY"
    }, (res) => {
        if (res?.hasKey) {
            paintNoKeyBanner(false);
            lockPopupUI(false);
            return;
        }
        chrome.runtime.sendMessage({
            type: "HAS_ENCRYPTED_KEY"
        }, (r2) => {
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

// Runs when popup loads.
document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("openOptionsBtn")?.addEventListener("click", openOptions);
    checkApiKeyAndGate();
});

// When background changes API key, recheck lock state
chrome.storage.onChanged.addListener((chg, area) => {
    if (area === "local" && "ALMA_API_KEY" in chg) checkApiKeyAndGate();
});

/**
 * Used when scraping vendor pages.
 * Takes in raw price and return numeric price and currency
 * @param {*} raw raw price
 * @returns numeric price and currency
 */
function parsePriceAndCurrency(raw) {
    if (raw == null) return {
        amount: null,
        currency: null
    };
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return {
            amount: raw,
            currency: null
        };
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
    return {
        amount: Number.isFinite(amount) ? amount : null,
        currency
    };
}

/**
 * Adds scraped data to the popup
 * Doesn't override user's manual edits
 * @param {*} d the scraped data to be added
 */
function applyScrape(d = {}) {
    // Title
    if (d.title) setValueIfEmpty("title", d.title);

    // Price (sanitized to pure number)
    if (typeof d.price !== "undefined" && d.price !== null && d.price !== "") {
        const {
            amount,
            currency
        } = parsePriceAndCurrency(d.price);
        if (amount !== null) setValueIfEmpty("price", amount);
        const curEl = $("currency");
        if (currency && curEl && !curEl.value) curEl.value = currency;
    }

    // Supplier/vendor host
    if (d.vendor || d.supplier) setValueIfEmpty("url", d.vendor || d.supplier);

    // Currency
    if (d.currency) {
        const curEl = $("currency");
        if (curEl && !curEl.value) curEl.value = d.currency;
    }
}

/**
 * Fallback scraper
 * Injected directly into page through chrome.scripting if the content script doesn't respond
 * Scrapes price, currency, and title.
 * @param {} tabId is the page to be scraped
 */
function inlineScrape(tabId) {
    chrome.scripting.executeScript({
            target: {
                tabId
            },
            func: () => {
                const out = {
                    title: "",
                    price: "",
                    currency: "",
                    vendor: location.hostname
                };

                // Title
                const t1 = document.querySelector("#productTitle");
                out.title = (t1?.textContent || document.title || "").trim();

                // Price text
                const priceNode =
                    document.querySelector("#corePrice_feature_div .a-offscreen") ||
                    document.querySelector(".a-price .a-offscreen") ||
                    document.querySelector("[data-a-color='price'] .a-offscreen");
                const txt = priceNode?.textContent?.trim() || "";
                out.price = txt;

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

/**
 * Scrapes the current page, at first through trying content script's scrape and then falling back to inlineScrape
 * if that fails.
 */
function prefillFromPage() {
    chrome.tabs.query({
        active: true,
        currentWindow: true
    }, (tabs) => {
        const tabId = tabs && tabs[0] && tabs[0].id;
        if (!tabId) return;

        chrome.tabs.sendMessage(tabId, {
            type: "SCRAPE_BOOK_INFO"
        }, (resp) => {
            if (chrome.runtime.lastError || !resp) {
                // content script not reachable -> fallback inject
                inlineScrape(tabId);
                return;
            }
            applyScrape(resp);
        });
    });
}

/**
 * Asks background for the list of funds received from Alma
 * Populates the fund dropdown with those fund names, or no funds available if we didn't receive funds.
 * 
 * @returns nothing
 */
function loadFunds() {
    const id = "fundSelect";
    const sel = document.getElementById(id);
    if (!sel) return;

    function initS2(placeholder) {
        if (!window.jQuery) return;
        const $el = window.jQuery("#" + id);
        if ($el.data("select2")) $el.select2("destroy");
        $el.select2({
            width: "100%",
            minimumInputLength: 0,
            allowClear: true,
            placeholder: placeholder || "Select a fund...",
            language: {
                searching: () => "Searching...",
                noResults: () => "No funds found"
            }
        });
    }


    chrome.runtime.sendMessage({
        type: "GET_FUNDS"
    }, (res) => {
        const list = Array.isArray(res?.funds) ? res.funds : [];

        // Clear existing options
        sel.innerHTML = "";

        if (!list.length) {
            sel.disabled = true;
            initS2("No funds available");
            return;
        }

        sel.disabled = false;

        // Add an option for each fund code
        list.forEach(f => {
            if (!f?.code) return;
            const o = document.createElement("option");
            o.value = f.code;
            o.textContent = f.name ? `${f.code} - ${f.name}` : f.code;
            sel.appendChild(o);
        });

        // Force no selection so placeholder shows in Select2
        sel.value = "";

        initS2("Select a fund...");
    });
}

/**
 * Asks background for the list of reporting codes received from Alma
 * Populates the reporting code dropdown with those reporting code names, 
 * or reporting codes not available if we didn't receive any.
 * @returns 
 */
function loadReportingCodes() {
    const id = "reportCodeSelect";
    const sel = document.getElementById(id);
    if (!sel) return;

    function initS2(placeholder) {
        if (!window.jQuery) return;
        const $el = window.jQuery("#" + id);

        if ($el.data("select2")) {
            $el.select2("destroy");
        }

        $el.select2({
            width: "100%",
            minimumInputLength: 0,
            placeholder: placeholder || "Choose reporting code...",
            allowClear: true
        });
    }

    // Save currently selected value
    const prev = sel.value;

    chrome.runtime.sendMessage({
        type: "GET_REPORTING_CODES",
        level: 1
    }, (res) => {
        const list = Array.isArray(res?.reportingCodes) ? res.reportingCodes : [];
        const hadError = !!res?.error;

        // Reset dropdown
        sel.innerHTML = "";

        if (!list.length) {
            const msg = hadError ? "Reporting codes not available" : "No reporting codes found";
            sel.disabled = true;
            initS2(msg);
            return;
        }

        // Add option for each reporting code
        sel.disabled = false;
        for (const rc of list) {
            const opt = document.createElement("option");
            opt.value = rc.code;
            opt.textContent = rc.description || rc.code;
            sel.appendChild(opt);
        }

        // Restore previous selection if it still exists
        if (prev && list.some(x => x.code === prev)) {
            sel.value = prev;
        } else {
            sel.value = ""; // otherwise leave empty so placeholder shows
        }

        initS2("Choose reporting code...");
    });
}

// Maps UI choices to Alma material_type codes.
const MATERIAL_CODE_MAP = {
    "book": "BOOK",
    "dvd": "DVD",
    "ebook": "EBOOK",
    "streaming": "STREAMING_VIDEO"
};

/**
 * Applies Select2 to the material type dropdown
 * @returns nothing
 */
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

/**
 * Convert UI selection to Alma material_type code (defaults to BOOK if empty)
 * @returns  the code
 */
function getMaterialTypeCode() {
    const raw = (document.getElementById("materialType")?.value || "").trim();
    if (!raw) return "BOOK"; // default if user didn’t pick
    const code = MATERIAL_CODE_MAP[raw.toLowerCase()];
    return code || "BOOK";
}

/**
 * Asks background if current vendor queue exists and is from Kanopy, 
 * and store anwer to inform electronic/streaming default logic
 * @returns whether the current vendor queue exists and is from Kanopy
 */
async function isKanopyVendorPrefill() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({
            type: "GET_VENDOR_PREFILL"
        }, (res) => {
            const v = res?.data?.vendor || "";
            resolve(String(v).toUpperCase().includes("KANOPY"));
        });
    });
}

/**
 * After successfully creating a PO line from one Kanopy cart item,
 * tell background to advance the queue to the next item and open a new popup for it.
 */
function advanceKanopyQueue() {
    chrome.runtime.sendMessage({
        type: "ADVANCE_VENDOR_PREFILL"
    }, () => {});
}


/**
 * Turns interestedUsers into a Select2 multi-select that:
 *   - lets you type part of a name / ID,
 *   - calls background SEARCH_USERS,
 *   - shows matches from Alma patron records,
 *   - allows multiple selections.
 *
 * After selection, validates the picked user by asking
 * GET_USER_BY_ID. If Alma says "not found", removes it and alerts.
 * @returns nothing
 */
function initInterestedUsers() {
    const id = "interestedUsers";
    const el = document.getElementById(id);
    if (!el || !window.jQuery) return;

    // Always enable the control
    el.disabled = false;

    const $el = window.jQuery("#" + id);

    // Destroy any previous Select2 instance
    if ($el.data("select2")) $el.select2("destroy");

    $el.select2({
        width: "100%",
        allowClear: true,
        placeholder: "Search Alma users",
        minimumInputLength: 1,
        ajax: {
            delay: 300,
            transport: function(params, success, failure) {
                const term = (params?.data?.term || "").trim();
                const page = Math.max(1, Number(params?.data?.page || 1));

                chrome.runtime.sendMessage({
                        type: "SEARCH_USERS",
                        term,
                        page,
                        limit: 20
                    },
                    (res) => {
                        if (!res || res.error) return failure(res?.error || "search error");
                        success({
                            results: res.users || [],
                            pagination: {
                                more: !!res.more
                            } // Tell Select2 if more pages exist
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
            loadingMore: () => "Loading more results...",
            inputTooShort: function() {
                return "Type name or unique identifier.";
            }
        }
    });

    // Validate selection against Alma; if invalid, remove it and notify
    $el.on("select2:select", (e) => {
        const pickedId = e?.params?.data?.id;
        if (!pickedId) return;

        chrome.runtime.sendMessage({
            type: "GET_USER_BY_ID",
            id: pickedId
        }, (res) => {
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
                    $el.trigger("change");
                }
            }
        });
    });
}

/**
 * Reads the selected interested users from interestedUsers
 * and converts them into the shape background.js expects.
 * @returns the interested users in the shape background.js expects.
 */
function gatherInterestedUsers() {
    const sel = document.getElementById("interestedUsers");
    if (!sel) return [];
    return Array.from(sel.selectedOptions).map(o => ({
        primary_id: o.value,
        hold_item: true,
        notify_receiving_activation: true
    }));
}

/**
 * Reads all user inputs from the popup form and normalises them so they are ready to send to the background.
 * @returns the normalised values.
 */
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
        if (/^[A-Z0-9_]+$/.test(val)) return val;
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
        owner: "MAIN",
        location_code: "MSTCK"
    };
}

/**
 * Ensure all required fields are present before trying to create the PO line.
 * @param {*} f is the form we have.
 * @returns any missing fields.
 */
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

/**
 * Collects form values, validates them, and sends CREATE_PO_LINE to background.
 * If successful, shows the new PO line number, tell background to advance Kanopy queue, and closes the popup.
 * @returns nothing
 */
function submitForm() {
    const payload = collectForm();
    const missing = validateForm(payload);
    if (missing.length) {
        alert("Please fill required fields: " + missing.join(", "));
        // If Fund is missing, focus it so the user knows what to do.
        if (missing.includes("Fund")) {
            const el = document.getElementById("fundSelect");
            if (el) {
                if (window.jQuery && window.jQuery("#fundSelect").data("select2")) {
                    window.jQuery("#fundSelect").select2("open");
                } else {
                    el.focus();
                }
            }
        }
        return;
    }

    chrome.runtime.sendMessage({
        type: "CREATE_PO_LINE",
        payload
    }, (res) => {
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
            navigator.clipboard.writeText(n).catch(() => {});
        }

        alert("PO line created.\nNumber: " + n);
        advanceKanopyQueue();
        window.close();
    });
}

// Runs when popup loads; initialises dropdowns and popup settings
document.addEventListener("DOMContentLoaded", async () => {
    lockPopupUI(true);
    paintNoKeyBanner(false);

    // Wait briefly to see if background has the decrypted key stored in memory, or can auto-unlock it
    const hasKey = await waitForApiKey(6000);
    if (!hasKey) {
        paintNoKeyBanner(true);
        return;
    }
    paintNoKeyBanner(false);
    lockPopupUI(false);

    // Init Select2 on dropdowns
    select2Init("fundSelect");
    select2Init("reportCodeSelect");
    select2Init("interestedUsers");
    select2Init("poType");
    initMaterialTypeSelect();

    // Figure out if we're on Kanopy
    window.__KANOPY__ = false;
    window.__KANOPY__ = await isKanopyVendorPrefill();

    // Load Alma-backed data after we know the vendor
    loadFunds();
    loadReportingCodes();
    initInterestedUsers();

    // Prefill from current browser tab
    prefillFromPage();

    $("submit")?.addEventListener("click", submitForm);
    $("cancel")?.addEventListener("click", () => window.close());
});

// Keyboard shortcut to open options page, even though it's no longer hidden.
document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "o") {
        chrome.runtime.sendMessage({
            type: "OPEN_HIDDEN_OPTIONS"
        });
    }
});
