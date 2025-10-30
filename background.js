/**
 * background.js is responsible for (with options.js) encrypting, storing, and decrypting the API key, getting Alma endpoints,
 * deciding routing logic, responding to popup and content script messages, and building PO line objects
 * recogniseable by Alma
 * 
 * @author Alana Bregman
 *
 */

// Hardcoded institution scope
const INSTITUTION_CODE = "01BRAND_INST";
const FALLBACK_E_ONE_TIME = "ELECTRONIC_TITLE_OT";
// Config from chrome.storage.local (not sync); current runtime config for the extension
let CONFIG = {
    ALMA_API_KEY: null,
    ALMA_REGION: "NA",
};

// items scraped from Kanopy
let VENDOR_QUEUE = [];
let VENDOR_VENDOR = "";

// Profile we're using (it was set to default in Alma)
CONFIG.ALMA_NEW_ORDER_PROFILE = "ORDER_IT_API_PROFILE";

/**
 * pulls currently stored settings and updates config in memory
 */
async function refreshConfig() {
    const prev = CONFIG.ALMA_API_KEY;
    const obj = await chrome.storage.local.get(["ALMA_REGION"]);
    CONFIG.ALMA_REGION = obj.ALMA_REGION || CONFIG.ALMA_REGION;
    CONFIG.ALMA_API_KEY = prev;
    console.log("[Alma] Config refreshed. Region:", CONFIG.ALMA_REGION, "Key set:", !!CONFIG.ALMA_API_KEY, "Inst:", INSTITUTION_CODE);
}

/**
 * If an encrypted key is stored, attempts to decrypt it and return the decrypted key, or null otherwise
 * If we already have a decrypted key in config just returns that
 * @returns null or the decrypted key
 */
async function getUsableKey() {
    if (CONFIG.ALMA_API_KEY) return CONFIG.ALMA_API_KEY;
    const ok = await tryAutoUnlockFromKEK();
    return ok ? CONFIG.ALMA_API_KEY : null;
}

// Make sure we've refreshed config before doing anything else so it's synced with storage changes
chrome.runtime.onInstalled.addListener(refreshConfig);
chrome.runtime.onStartup.addListener(refreshConfig);
// updates based on changes
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
        if (changes.ALMA_API_KEY) CONFIG.ALMA_API_KEY = changes.ALMA_API_KEY.newValue || null;
        if (changes.ALMA_REGION) CONFIG.ALMA_REGION = changes.ALMA_REGION.newValue || "NA";
    }
});

/**
 * If the extension already has saved encrypted key material, try to decrypt
 * the Alma API key without asking the user for a password.
 * @returns true if unlock succeeded, false otherwise
 */
async function tryAutoUnlockFromKEK() {
    try {
        const {
            ALMA_API_KEY_C,
            ALMA_API_KEY_IV,
            ALMA_KEK_B64
        } =
        await chrome.storage.local.get(["ALMA_API_KEY_C", "ALMA_API_KEY_IV", "ALMA_KEK_B64"]);

        if (!ALMA_API_KEY_C || !ALMA_API_KEY_IV || !ALMA_KEK_B64) {
            console.log("[Alma] Auto-unlock: missing material", {
                hasCipher: !!ALMA_API_KEY_C,
                hasIV: !!ALMA_API_KEY_IV,
                hasKEK: !!ALMA_KEK_B64
            });
            return false;
        }

        const ub64 = (s) => {
            s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
            while (s.length % 4) s += "=";
            const bin = atob(s),
                out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        };

        const kekRaw = ub64(ALMA_KEK_B64);
        const iv = ub64(ALMA_API_KEY_IV);
        const ct = ub64(ALMA_API_KEY_C);

        const kekKey = await crypto.subtle.importKey("raw", kekRaw, {
            name: "AES-GCM"
        }, false, ["decrypt"]);
        const buf = await crypto.subtle.decrypt({
            name: "AES-GCM",
            iv
        }, kekKey, ct);
        CONFIG.ALMA_API_KEY = new TextDecoder().decode(buf);
        console.log("[Alma] Auto-unlocked (KEK). Key set:", true);
        return true;
    } catch (e) {
        console.warn("[Alma] Auto-unlock failed:", e && (e.stack || e.message || e));
        CONFIG.ALMA_API_KEY = null; // keep state honest
        return false;
    }
}

// Call once on startup so we have the key on startup, if it exists
tryAutoUnlockFromKEK();

/**
 * Ensure we have CONFIG filled
 */
async function ensureConfigLoaded() {
    if (!CONFIG.ALMA_API_KEY || !CONFIG.ALMA_REGION) {
        await refreshConfig();
    }
}

/**
 * Chooses correct Alma API host name based on region
 * @returns correct Alma API host name
 */
function almaBaseUrl() {
    const host = CONFIG.ALMA_REGION === "NA" ?
        "https://api-na.hosted.exlibrisgroup.com" :
        "https://api-eu.hosted.exlibrisgroup.com";
    return `${host}/almaws/v1`;
}

/**
 * builds a full Alma API URL
 * @param {*} path the REST path
 * @param {*} params query params
 * @returns the full Alma API URL, including base path, REST path, query params, and API key
 */
function buildUrl(path, params = {}) {
    // path may already include a query string
    const url = new URL(`${almaBaseUrl()}/${path}`);

    // Start with any existing query params in the path
    const usp = new URLSearchParams(url.search);

    // Always includes apikey
    if (!usp.has("apikey")) usp.set("apikey", CONFIG.ALMA_API_KEY);

    // Merge/append caller-supplied params
    for (const [k, v] of Object.entries(params)) {
        if (v == null) continue;
        if (Array.isArray(v)) {
            v.forEach(item => usp.append(k, String(item)));
        } else {
            usp.set(k, String(v));
        }
    }

    url.search = usp.toString();
    return url.toString();
}

/**
 * Ensures we have usable and unlocked API key, then builds url with the given path and params, attaches application/json
 * also keeps track of # queries remaining for API key for the day
 * @param {*} path REST path
 * @param {*} params query params
 * @returns the json body from Alma
 */
async function almaGet(path, params = {}) {
    const key = await getUsableKey();
    if (!key) {
        const e = new Error("Alma key not available (locked/missing).");
        e.status = 0;
        e.body = "No plaintext key in memory";
        throw e;
    }
    if (!CONFIG.ALMA_API_KEY) {
        const err = new Error("Missing API key");
        err.status = 0;
        throw err;
    }

    const url = buildUrl(path, params);
    const res = await fetch(url, {
        method: "GET",
        headers: {
            Accept: "application/json"
        }
    });

    const remaining = Number(res.headers.get("X-Exl-Api-Remaining"));
    if (!Number.isNaN(remaining)) {
        chrome.storage.local.set({
            ALMA_REMAINING: remaining,
            ALMA_REMAINING_AT: Date.now()
        });
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
        const err = new Error(`Alma GET ${path} failed: ${res.status}`);
        err.status = res.status;
        err.body = text;
        throw err;
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * Used to create PO lines; sends JSON body
 * @param {*} path REST path
 * @param {*} body the PO line object we build in mapToAlmaPOL()
 * @param {*} params query params
 * @returns Alma's response to our PO line submission, i.e. success or error
 */
async function almaPost(path, body, params = {}) {
    const key = await getUsableKey();
    if (!key) {
        const e = new Error("Alma key not available (locked/missing).");
        e.status = 0;
        e.body = "No plaintext key in memory";
        throw e;
    }
    if (!CONFIG.ALMA_API_KEY) {
        const err = new Error("Missing API key");
        err.status = 0;
        throw err;
    }

    const url = buildUrl(path, params);
    console.log("[Alma] POST →", url);
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json"
        },
        body: JSON.stringify(body)
    });

    const remaining = Number(res.headers.get("X-Exl-Api-Remaining"));
    if (!Number.isNaN(remaining)) {
        chrome.storage.local.set({
            ALMA_REMAINING: remaining,
            ALMA_REMAINING_AT: Date.now()
        });
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
        const err = new Error(`Alma POST ${path} failed: ${res.status}`);
        err.status = res.status;
        err.body = text;
        throw err;
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * Since Alma paginates certain endpoints, we use this method to make repeated GETs and merge them into 
 * one big list, only stopping when there is nothing else to GET (we know this when a page returns fewer items 
 * than the length of a page).
 */
async function almaGetAll(path, arrayPaths = [
    ["funds", "fund"],
    ["fund"]
], pageSize = 100) {
    let offset = 0;
    let out = [];
    for (;;) {
        const page = await almaGet(path, {
            limit: String(pageSize),
            offset: String(offset)
        });
        let chunk = null;
        for (const p of arrayPaths) {
            let cur = page;
            for (const key of p) cur = cur?.[key];
            if (Array.isArray(cur)) {
                chunk = cur;
                break;
            }
        }
        const items = Array.isArray(chunk) ? chunk : [];
        out = out.concat(items);
        if (items.length < pageSize) break;
        offset += pageSize;
    }
    return out;
}

/**
 * Takes the form data from popup.js (including scraped vendor data),
 * and produces the JSON object Alma expects when creating a PO line.
 * @param {*} f is the form data from popup.js
 * @returns the JSON object Alma expects when creating a PO line.
 */
function mapToAlmaPOL(f = {}) {
    const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

    // Codes
    const ownerCode = (f.owner && f.owner.value) || "MAIN";
    const poType = (f.po_line_type || "PRINT_OT").trim();
    const matType = (f.material_type || "BOOK").trim();

    const body = {
        owner: {
            value: ownerCode
        },
        type: {
            value: poType
        },
        material_type: {
            value: matType
        },
        resource_metadata: {
            title: (f.title || "").trim()
        },
        price: {
            sum: String((Number(f.price) || 0).toFixed(2)),
            currency: {
                value: f.currency || "USD"
            }
        }
    };

    // Copies requested
    const copies = Math.max(1, Number(f.quantity) || 1);
    body.quantity = copies;

    // Physical one-time lines
    const isPhysicalOT = poType === "PRINT_OT" || poType === "PHYSICAL_OT";
    if (isPhysicalOT) {
        body.location = [{
            library: {
                value: ownerCode // "MAIN"
            }, 
            location: {
                value: f.location_code || "MSTCK"
            },
            quantity: copies,
            quantity_for_pricing: copies
        }];
    }

    const finalType = (body.type?.value || "").toUpperCase();
    const isPhysical = /^(PRINT_|PHYSICAL_|PRINT_JNL_)/.test(finalType);
    if (!isPhysical) delete body.location;

    // Reporting code
    const rcList = asArray(f.reporting_code)
        .map((s) => String(s || "").trim())
        .filter(Boolean);
    if (rcList.length) body.reporting_code = rcList[0];

    // Receiving note
    if (f.receiving_note && f.receiving_note.trim()) {
        body.receiving_note = f.receiving_note.trim();
    }

    // Fund distribution (amount = unit price * copies)
    const unit = Number(f.price) || 0;
    const total = +(unit * copies).toFixed(2);
    if (f.fund) {
        body.fund_distribution = [{
            fund_code: {
                value: f.fund
            },
            amount: {
                sum: total.toFixed(2),
                currency: {
                    value: f.currency || "USD"
                }
            }
        }];
    }

    // Interested users
    const iu = Array.isArray(f.interested_users) ? f.interested_users : [];
    if (iu.length) {
        body.interested_user = iu.map(u => ({
            primary_id: u.primary_id || u.user || u.id || String(u),
            notify_receiving_activation: !!(u.notify_receiving_activation || u.notify || u.notifyReceiving),
            hold_item: !!(u.hold_item || u.hold || u.place_hold)
        }));
    }

    // Vendor routing (Amazon / AbeBooks / Kanopy)
    if (f.supplier && f.supplier.trim()) {
        const s = f.supplier.trim().toUpperCase();

        if (s.includes("AMAZON")) {
            body.vendor = {
                value: "AMAZON.COM",
                desc: "Amazon.com, Inc."
            };
            body.vendor_account = "AMAZON.COM";

        } else if (s.includes("ABEBOOKS")) {
            body.vendor = {
                value: "ABEBOOKS.COM",
                desc: "AbeBooks.com"
            };
            body.vendor_account = "ABEBOOKS.COM";

        } else if (s.includes("KANOPY")) {
            const VENDOR_CODE = "Kanopy";
            const VENDOR_ACCOUNT = "Kanopy";

            // Set vendor
            body.vendor = {
                value: VENDOR_CODE,
                desc: "Kanopy LLC"
            };
            body.vendor_account = VENDOR_ACCOUNT;

            body.acquisition_method = {
                value: "VENDOR_SYSTEM"
            };

            // Default to electronic one-time
            if (!body.type?.value) {
                body.type = {
                    value: FALLBACK_E_ONE_TIME
                };
            }
            if (!body.material_type?.value) {
                body.material_type = {
                    value: "STREAMING_VIDEO"
                };
            }
        }
    }
    // Clean undefined
    Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
    return body;
}

/**
 * Message Handling
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
        try {
            await ensureConfigLoaded();

            // if our content script found items on the Kanopy page, then we put them in a queue
            if (request?.type === "VENDOR_PREFILL") {
                VENDOR_VENDOR = request.vendor || "";
                VENDOR_QUEUE = Array.isArray(request.items) ? request.items.slice() : [];
                if (VENDOR_QUEUE.length && chrome.action.openPopup) chrome.action.openPopup();
                sendResponse({
                    ok: true,
                    count: VENDOR_QUEUE.length
                });
                return;
            }

            // peek at and give the next item in the queue
            if (request?.type === "GET_VENDOR_PREFILL") {
                const next = VENDOR_QUEUE.length ? VENDOR_QUEUE[0] : null;
                const data = next ? {
                    vendor: VENDOR_VENDOR,
                    items: [next]
                } : null;

                // If queue is empty, clears the vendor flag so non-Kanopy pages don't inherit it
                if (!next) VENDOR_VENDOR = "";

                sendResponse({
                    ok: true,
                    data
                });
                return;
            }

            // After success, move to next item in queue and open a new popup
            if (request?.type === "ADVANCE_VENDOR_PREFILL") {
                if (VENDOR_QUEUE.length) VENDOR_QUEUE.shift();

                // If we just emptied the queue, also clear vendor flag
                if (VENDOR_QUEUE.length === 0) VENDOR_VENDOR = "";

                const hasMore = VENDOR_QUEUE.length > 0;
                if (hasMore && chrome.action.openPopup) chrome.action.openPopup();
                sendResponse({
                    ok: true,
                    remaining: VENDOR_QUEUE.length
                });
                return;
            }


            // If decrytped key not visible then tries to decrypt key
            if (request?.type === "HAS_API_KEY") {
                if (!CONFIG.ALMA_API_KEY) await tryAutoUnlockFromKEK();
                sendResponse({
                    ok: true,
                    hasKey: !!CONFIG.ALMA_API_KEY
                });
                return;
            }

            // Is an encrypted key saved on disk?
            if (request?.type === "HAS_ENCRYPTED_KEY") {
                const {
                    ALMA_API_KEY_C,
                    ALMA_API_KEY_IV
                } =
                await chrome.storage.local.get(["ALMA_API_KEY_C", "ALMA_API_KEY_IV"]);
                sendResponse({
                    ok: true,
                    hasEncrypted: !!(ALMA_API_KEY_C && ALMA_API_KEY_IV)
                });
                return;
            }

            // Attempts to decrypt Alma key, if user has permission (i.e. input the correct password)
            if (request?.type === "UNLOCK_ALMA_KEY") {
                try {
                    const {
                        ALMA_KEK_B64,
                        ALMA_PW_SALT,
                        ALMA_KDF_ITERS,
                        ALMA_API_KEY_C,
                        ALMA_API_KEY_IV
                    } =
                    await chrome.storage.local.get([
                        "ALMA_KEK_B64", "ALMA_PW_SALT", "ALMA_KDF_ITERS",
                        "ALMA_API_KEY_C", "ALMA_API_KEY_IV"
                    ]);

                    const hasK = !!ALMA_KEK_B64,
                        hasS = !!ALMA_PW_SALT,
                        hasI = !!ALMA_KDF_ITERS;
                    if (!hasK && !hasS && !hasI) {
                        sendResponse({
                            ok: false,
                            error: "No password set. Click Set Password first."
                        });
                        return;
                    }
                    if (hasK && (!hasS || !hasI)) {
                        sendResponse({
                            ok: false,
                            error: "Password setting incomplete. Click Set Password to repair."
                        });
                        return;
                    }

                    const ub64 = (s) => {
                        s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
                        while (s.length % 4) s += "=";
                        const b = atob(s),
                            u = new Uint8Array(b.length);
                        for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
                        return u;
                    };
                    const salt = ub64(ALMA_PW_SALT);
                    const iters = Number(ALMA_KDF_ITERS || 200000);

                    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(request.password || ""), {
                        name: "PBKDF2"
                    }, false, ["deriveKey"]);
                    const key = await crypto.subtle.deriveKey({
                        name: "PBKDF2",
                        salt,
                        iterations: iters,
                        hash: "SHA-256"
                    }, base, {
                        name: "AES-GCM",
                        length: 256
                    }, true, ["encrypt", "decrypt"]);
                    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));

                    // Verify password matches stored KEK
                    const toB64u = (u8) => {
                        let s = "";
                        for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
                        return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
                    };
                    if (toB64u(raw) !== ALMA_KEK_B64) {
                        sendResponse({
                            ok: false,
                            error: "Wrong password."
                        });
                        return;
                    }

                    // If an encrypted key is stored, decrypt to memory
                    if (ALMA_API_KEY_C && ALMA_API_KEY_IV) {
                        const iv = ub64(ALMA_API_KEY_IV);
                        const ct = ub64(ALMA_API_KEY_C);
                        const buf = await crypto.subtle.decrypt({
                            name: "AES-GCM",
                            iv
                        }, key, ct);
                        CONFIG.ALMA_API_KEY = new TextDecoder().decode(buf);
                    }
                    sendResponse({
                        ok: true
                    });
                } catch (e) {
                    console.error("[Alma] UNLOCK failed:", e);
                    sendResponse({
                        ok: false,
                        error: "Unlock failed."
                    });
                }
                return;
            }

            // Make key visible in options page
            if (request?.type === "REVEAL_ALMA_KEY") {
                if (!CONFIG.ALMA_API_KEY) await tryAutoUnlockFromKEK();
                if (!CONFIG.ALMA_API_KEY) {
                    sendResponse({
                        ok: false,
                        error: "Key is locked or not set."
                    });
                    return;
                }
                sendResponse({
                    ok: true,
                    key: CONFIG.ALMA_API_KEY
                });
                return;
            }

            // Lock: purge from memory
            if (request?.type === "LOCK_ALMA_KEY") {
                CONFIG.ALMA_API_KEY = null;
                sendResponse({
                    ok: true
                });
                return;
            }

            // Open options page
            if (request?.type === "OPEN_HIDDEN_OPTIONS") {
                chrome.tabs.create({
                    url: chrome.runtime.getURL("options.html")
                });
                sendResponse({
                    ok: true
                });
                return;
            }

            // refreshes config
            if (request?.type === "REFRESH_CONFIG") {
                await refreshConfig();
                sendResponse({
                    ok: true
                });
                return;
            }

            // Checks that we can connect to Alma with the current API key
            if (request?.type === "TEST_ALMA_CONNECTIVITY") {
                await almaGet("acq/funds", {
                    limit: "1"
                });
                sendResponse({
                    ok: true
                });
                return;
            }

            // Get funds list from Alma and sort them
            if (request?.type === "GET_FUNDS") {
                const list = await almaGetAll("acq/funds", [
                    ["funds", "fund"],
                    ["fund"]
                ]);
                list.sort((a, b) => String(a.code).localeCompare(String(b.code)));
                const funds = list.map(f => ({
                    code: f.code,
                    name: f.name
                }));
                sendResponse({
                    funds
                });
                return;
            }

            // Get first reporting codes from Alma
            if (request?.type === "GET_REPORTING_CODES") {
                (async () => {
                    try {
                        const primaryName = "HFundsTransactionItem.reportingCode";
                        const normalizeRows = (data) => {
                            const ct = data?.code_table || data;
                            let rows = [];
                            if (Array.isArray(ct?.row)) rows = ct.row;
                            else if (Array.isArray(ct?.rows?.row)) rows = ct.rows.row;
                            else if (Array.isArray(data?.row)) rows = data.row;
                            const enabled = (rows || []).filter(r => {
                                const e = r?.enabled;
                                const s = r?.status ?? r?.active;
                                if (typeof e === "boolean") return e;
                                if (typeof s === "boolean") return s;
                                if (typeof s === "string") return /active|enabled/i.test(s);
                                return true;
                            });
                            enabled.sort((a, b) => {
                                const pa = Number(a?.position ?? a?.order ?? 1e9);
                                const pb = Number(b?.position ?? b?.order ?? 1e9);
                                if (pa !== pb) return pa - pb;
                                const da = String(a?.description ?? "");
                                const db = String(b?.description ?? "");
                                if (da && db && da !== db) return da.localeCompare(db);
                                const ca = String(a?.code ?? a?.value ?? a?.name ?? "");
                                const cb = String(b?.code ?? b?.value ?? b?.name ?? "");
                                return ca.localeCompare(cb);
                            });
                            return enabled.map(r => ({
                                code: r?.code ?? r?.value ?? r?.name ?? "",
                                description: r?.description ?? ""
                            })).filter(x => x.code);
                        };
                        let data, rows;
                        try {
                            data = await almaGet(`conf/code-tables/${encodeURIComponent(primaryName)}`, {
                                format: "json"
                            });
                            rows = normalizeRows(data);
                        } catch (_) {
                            const list = await almaGet("conf/code-tables", {
                                scope: "INSTITUTION",
                                limit: "500",
                                format: "json"
                            });
                            const tables = list?.code_tables?.code_table || [];
                            const hit = tables.find(t => (t?.name || t?.code) === primaryName);
                            if (!hit?.link) {
                                return sendResponse({
                                    reportingCodes: [],
                                    error: "Code table not found: HFundsTransactionItem.reportingCode"
                                });
                            }
                            const rel = hit.link.replace(/^https?:\/\/[^/]+\/almaws\/v1\//, "");
                            data = await almaGet(rel, {
                                format: "json",
                                scope: "INSTITUTION"
                            });
                            rows = normalizeRows(data);
                        }
                        if (!rows?.length) {
                            return sendResponse({
                                reportingCodes: [],
                                error: "Reporting code table is empty or inaccessible."
                            });
                        }
                        sendResponse({
                            reportingCodes: rows,
                            table: primaryName,
                            how: "direct"
                        });
                    } catch (e) {
                        console.error("[Alma] GET_REPORTING_CODES error:", e);
                        sendResponse({
                            reportingCodes: [],
                            error: e.message,
                            status: e.status,
                            detail: e.body
                        });
                    }
                })();
                return true;
            }

            // Searches Alma for input users, allowing for multiple search patterns, with pagination and fallbacks
            if (request?.type === "SEARCH_USERS") {
                (async () => {
                    try {
                        const term = String(request.term || "").trim();
                        const page = Math.max(1, Number(request.page || 1));
                        const limit = Math.min(50, Math.max(10, Number(request.limit || 20)));
                        const offset = (page - 1) * limit;

                        if (term.length < 3) {
                            sendResponse({
                                users: [],
                                how: "too-short",
                                more: false
                            });
                            return;
                        }

                        const extract = (resp) => {
                            if (!resp) return [];
                            if (Array.isArray(resp?.users?.user)) return resp.users.user;
                            if (Array.isArray(resp?.user)) return resp.user;
                            if (resp?.users?.user) return [resp.users.user];
                            return [];
                        };
                        const shape = (u) => {
                            const id = u?.primary_id || u?.id || "";
                            const first = u?.first_name ?? u?.name?.first_name ?? "";
                            const last = u?.last_name ?? u?.name?.last_name ?? "";
                            const full = (u?.full_name || "").trim() || ([last, first].filter(Boolean).join(", "));
                            const label = id ? `${full || id} (${id})` : (full || id);
                            return {
                                id,
                                text: label,
                                label
                            };
                        };

                        const t = term.replace(/\s+/g, " ").trim();
                        const hasComma = t.includes(",");
                        let first = "",
                            last = "";
                        if (hasComma) {
                            [last, first] = t.split(",").map(s => s.trim());
                        } else {
                            const parts = t.split(" ");
                            if (parts.length >= 2) {
                                first = parts[0];
                                last = parts.slice(1).join(" ");
                            }
                        }

                        const tried = [];
                        const attempts = [{
                                how: "name~",
                                params: {
                                    q: `name~${t}`,
                                    view: "brief",
                                    limit: String(limit),
                                    offset: String(offset)
                                }
                            },
                            {
                                how: "all~",
                                params: {
                                    q: `all~${t}`,
                                    view: "brief",
                                    limit: String(limit),
                                    offset: String(offset)
                                }
                            },
                            {
                                how: "primary_id~",
                                params: {
                                    q: `primary_id~${t}`,
                                    view: "brief",
                                    limit: String(limit),
                                    offset: String(offset)
                                }
                            },
                            (first && last) ? {
                                how: "first_name~ AND last_name~",
                                params: {
                                    q: [`first_name~${first}`, `last_name~${last}`],
                                    op: "AND",
                                    view: "brief",
                                    limit: String(limit),
                                    offset: String(offset)
                                }
                            } : null,
                            (first && last) ? {
                                how: "last_name~ AND first_name~",
                                params: {
                                    q: [`last_name~${last}`, `first_name~${first}`],
                                    op: "AND",
                                    view: "brief",
                                    limit: String(limit),
                                    offset: String(offset)
                                }
                            } : null,
                        ].filter(Boolean);

                        // Extra patterns
                        const tokens = t.split(/\s+/).filter(Boolean);
                        if (!hasComma && tokens.length === 2) {
                            const [a, b] = tokens;
                            attempts.unshift({
                                how: "last_name~ AND first_name~ (no-comma)",
                                params: {
                                    q: [`last_name~${a}`, `first_name~${b}`],
                                    op: "AND",
                                    view: "brief",
                                    limit: String(limit),
                                    offset: String(offset)
                                }
                            });
                            attempts.unshift({
                                how: "first_name~ AND last_name~ (no-comma)",
                                params: {
                                    q: [`first_name~${a}`, `last_name~${b}`],
                                    op: "AND",
                                    view: "brief",
                                    limit: String(limit),
                                    offset: String(offset)
                                }
                            });
                        }
                        if (tokens.length >= 3) {
                            attempts.unshift({
                                how: "name~ tokens AND",
                                params: {
                                    q: tokens.map(x => `name~${x}`),
                                    op: "AND",
                                    view: "brief",
                                    limit: String(limit),
                                    offset: String(offset)
                                }
                            });
                        }

                        let raw = null,
                            arr = [],
                            how = "none";
                        for (const attempt of attempts) {
                            try {
                                const p = attempt.params;
                                const params = Array.isArray(p.q) ? {
                                        q: p.q,
                                        op: p.op || "OR",
                                        view: p.view,
                                        limit: p.limit,
                                        offset: p.offset
                                    } :
                                    p;

                                raw = await almaGet("users", params);
                                arr = extract(raw);
                                how = attempt.how;
                                tried.push({
                                    how: attempt.how,
                                    ok: true,
                                    count: arr.length
                                });
                                if (arr.length) break;
                            } catch (e) {
                                tried.push({
                                    how: attempt.how,
                                    ok: false,
                                    status: e.status,
                                    detail: (e.body || e.message || "").slice(0, 160)
                                });
                            }
                        }

                        const total = Number(raw?.total_record_count || 0);
                        const more = total ? (offset + arr.length) < total : (arr.length === limit);
                        const users = arr.map(shape).filter(x => x.id && x.text);
                        sendResponse({
                            users,
                            how,
                            more,
                            tried
                        });
                    } catch (err) {
                        console.error("[Alma] SEARCH_USERS fatal:", err);
                        sendResponse({
                            users: [],
                            how: "error",
                            error: err.message,
                            status: err.status,
                            more: false
                        });
                    }
                })();
                return true;
            }

            // Search Alma for users by id - direct GET by primary_id, fallback to search
            if (request?.type === "GET_USER_BY_ID") {
                const rawId = String(request.id || "").trim();
                if (!rawId) {
                    sendResponse({
                        ok: false,
                        status: 400,
                        error: "missing id"
                    });
                    return;
                }

                const tryDirect = async (id) => {
                    return await almaGet(`users/${encodeURIComponent(id)}`, {
                        view: "brief",
                        user_id_type: "all_unique"
                    });
                };

                try {
                    const u = await tryDirect(rawId);
                    sendResponse({
                        ok: true,
                        user: {
                            id: u?.primary_id || rawId,
                            full_name: u?.full_name || ""
                        }
                    });
                } catch (e1) {
                    try {
                        const sr = await almaGet("users", {
                            q: [
                                `primary_id~${rawId}`,
                                `user_identifier~${rawId}`,
                                `any~${rawId}`,
                                `all~${rawId}`
                            ],
                            op: "OR",
                            view: "brief",
                            limit: "1"
                        });
                        const arr = Array.isArray(sr?.users?.user) ? sr.users.user :
                            Array.isArray(sr?.user) ? sr.user :
                            sr?.users?.user ? [sr.users.user] : [];
                        const u = arr[0];
                        if (u?.primary_id) {
                            sendResponse({
                                ok: true,
                                user: {
                                    id: u.primary_id,
                                    full_name: u.full_name || ""
                                }
                            });
                        } else {
                            sendResponse({
                                ok: false,
                                status: e1.status,
                                error: e1.body || e1.message || "not found"
                            });
                        }
                    } catch (e2) {
                        sendResponse({
                            ok: false,
                            status: e2.status || e1.status,
                            error: e2.body || e1.body || e2.message || "not found"
                        });
                    }
                }
                return;
            }

            // List New Order API integration profiles
            if (request?.type === "GET_NEW_ORDER_PROFILES") {
                (async () => {
                    try {
                        const data = await almaGet("conf/integration-profiles", {
                            type: "NEW_ORDER_API",
                            format: "json"
                        });
                        const arr = Array.isArray(data?.integration_profile) ? data.integration_profile :
                            Array.isArray(data?.integration_profiles?.integration_profile) ? data.integration_profiles.integration_profile : [];
                        const profiles = arr.map(p => ({
                            code: p?.code || p?.name || "",
                            name: p?.name || p?.code || "",
                            is_default: !!p?.is_default
                        })).filter(x => x.code);
                        sendResponse({
                            ok: true,
                            profiles
                        });
                    } catch (e) {
                        sendResponse({
                            ok: false,
                            error: e.message,
                            status: e.status,
                            detail: e.body
                        });
                    }
                })();
                return true;
            }

            // Creating PO Line

            /**
             * This is how we create and send the PO line
             * We build the Alma POL JSON body with mapToAlmaPOL(), decide routing based on whether the item is electronic
             * or physical, and return which path succeeded
             */
            if (request?.type === "CREATE_PO_LINE") {
                (async () => {
                    try {
                        if (!CONFIG.ALMA_API_KEY) {
                            return sendResponse({
                                ok: false,
                                error: "Missing API key.",
                                code: "NO_API_KEY"
                            });
                        }

                        // Builds final POL body from the payload
                        const f = request.payload || {};
                        const polBody = mapToAlmaPOL(f);
                        console.log("[Alma] POL body", JSON.stringify(polBody, null, 2));

                        // Decide by the *final* type on the body (what Alma will actually see)
                        const t = String(polBody?.type?.value || "").toUpperCase();
                        const isElectronic = t.startsWith("E");

                        // Safety: e-lines must not carry a physical location block
                        if (isElectronic && polBody.location) delete polBody.location;

                        const preferred = (CONFIG.ALMA_NEW_ORDER_PROFILE || "ORDER_IT_API_PROFILE").trim();
                        const alternate = preferred === "GOBI" ? "ORDER_IT_API_PROFILE" : "GOBI";

                        let resp, used_profile = "DIRECT";

                        if (isElectronic) {
                            // Electronic lines should go direct
                            console.log("[Alma] POST (electronic) → direct");
                            resp = await almaPost("acq/po-lines", polBody);

                        } else {
                            // Physical/default: try preferred profile, then alternate, then direct
                            console.log("[Alma] POST (preferred) →", preferred);
                            try {
                                resp = await almaPost("acq/po-lines", polBody, {
                                    profile: preferred,
                                    integration_profile: preferred
                                });
                                used_profile = preferred;

                            } catch (e1) {
                                const msg = String(e1?.body || e1?.message || "");
                                const status = e1?.status || 0;

                                const isMultiProfiles =
                                    msg.includes("40188610") ||
                                    /More than one New Order API integration profiles/i.test(msg);

                                const isIllegalOr400 =
                                    status === 400 || /401872|illegal|BAD_REQUEST|400/gi.test(msg);

                                if (isMultiProfiles) {
                                    console.warn("[Alma] 40188610 on", preferred, "— retrying with", alternate);
                                    try {
                                        resp = await almaPost("acq/po-lines", polBody, {
                                            profile: alternate,
                                            integration_profile: alternate
                                        });
                                        used_profile = alternate;
                                    } catch (e2) {
                                        console.error("[Alma] CREATE_PO_LINE failed (alternate):", e2);
                                        return sendResponse({
                                            ok: false,
                                            error: e2.body || e2.message || "Unknown error",
                                            status: e2.status || 0,
                                            tried: [preferred, alternate]
                                        });
                                    }

                                } else if (isIllegalOr400) {
                                    console.warn("[Alma] Preferred route rejected (", msg, "). Retrying direct…");
                                    resp = await almaPost("acq/po-lines", polBody);
                                    used_profile = "DIRECT";

                                } else {
                                    console.error("[Alma] CREATE_PO_LINE failed (preferred):", e1);
                                    return sendResponse({
                                        ok: false,
                                        error: e1.body || e1.message || "Unknown error",
                                        status: status,
                                        tried: [preferred]
                                    });
                                }
                            }
                        }

                        const poLineNumber =
                            resp?.number || resp?.po_line_number || resp?.po_line?.po_line_number || null;

                        return sendResponse({
                            ok: true,
                            po_line_number: poLineNumber,
                            raw: resp,
                            used_profile
                        });

                    } catch (outer) {
                        console.error("[Alma] CREATE_PO_LINE failed (outer):", outer);
                        sendResponse({
                            ok: false,
                            error: outer?.body || outer?.message || "Unknown error",
                            status: outer?.status || 0
                        });
                    }
                })();
                return true; // keep the message port open for async sendResponse
            }

            // Unknown request
            sendResponse({
                ok: false,
                error: "Unknown request type"
            });
        } catch (e) {
            console.error("[Alma] Error:", e);
            sendResponse({
                ok: false,
                error: e.code || e.message,
                status: e.status,
                detail: e.body
            });
        }
        return true;
    })();

    return true; // keep channel open for async responses
});
