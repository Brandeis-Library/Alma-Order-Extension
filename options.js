/**
 * This is the logic for the options page, which along with background is responsible for encrypting/decrypting the 
 * API key, and also controls user access to the current API key and allows for setting the key and testing Alma 
 * connection.
 * 
 * @author Alana Bregman
 *
 */

// Uses local storage (per machine)
const store = chrome.storage.local;
let __apiKeyRevealed = false;

// encryption/decryption helpers
const enc = new TextEncoder()

function b64u(bytes) {
    // bytes: ArrayBuffer or Uint8Array
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function ub64(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
}

function u8ToB64u(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function aesGcmEncrypt(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({
        name: "AES-GCM",
        iv
    }, key, enc.encode(plaintext));
    return {
        iv,
        ct
    };
}

// Shows a bullet mask for the API key equal to the saved key length (without decrypting)
function paintMaskedIfEncrypted() {
    chrome.storage.local.get(["ALMA_API_KEY_C", "ALMA_API_KEY_IV", "ALMA_API_KEY_LEN"], (res) => {
        const el = document.getElementById("apiKey");
        const tog = document.getElementById("toggleKey");
        if (!el) return;
        const hasCipher = !!(res && res.ALMA_API_KEY_C && res.ALMA_API_KEY_IV);

        if (hasCipher) {
            const len = Math.max(1, Number(res.ALMA_API_KEY_LEN || 10));
            el.value = "•".repeat(len);
            el.type = "password";
            el.dataset.masked = "1";
            if (tog) tog.textContent = "Show";
        } else {
            el.value = "";
            el.type = "password";
            delete el.dataset.masked;
            if (tog) tog.textContent = "Show";
        }
    });
}


// UI helpers

/**
 * Shows a status message
 * @param {} id of the DOM element to be updated
 * @param {*} msg txt to show to user
 * @param {*} kind visual style
 */
function setStatus(id, msg, kind = "muted") {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.classList.remove("ok", "err", "muted");
    el.classList.add(kind);
}

/**
 * If locked (correct password not input) then disable api key viewing or editing for user
 * @param {*} locked whether the page is locked or not
 */
function setLockedUI(locked) {
    const card = document.getElementById("settingsCard");
    if (locked) {
        card.classList.add("disabled");
        setStatus("status", "Locked.", "muted");
    } else {
        card.classList.remove("disabled");
        setStatus("status", "Unlocked. You may edit settings.", "ok");
    }
}

/**
 * Runs once when the html loads
 * Doesn't auto reveal API key, but populates the Alma region from storage
 * UI is locked by default
 */
async function loadDisplayValues() {
    store.get(["ALMA_API_KEY_C", "ALMA_REGION"], (res) => {
        document.getElementById("region").value = res.ALMA_REGION || "NA";
    });
    setStatus("lockStatus", "Locked.", "muted");
    setLockedUI(true);
}

document.addEventListener("DOMContentLoaded", () => {
    loadDisplayValues();
    paintMaskedIfEncrypted(); // shows dots if an encrypted key exists
});

/**
 *  After user enters admin password, sends {type:"UNLOCK_ALMA_KEY", password} to background.js
 *  Background tries to derive the KEK, verify password, and decrypt the API key
 *  into its own CONFIG.ALMA_API_KEY in memory.
 *  If successful, marks UI as unlocked so user can edit settings.
 */
document.getElementById("unlock").addEventListener("click", async () => {
    const password = (document.getElementById("adminPassword").value || "").trim();
    if (!password) return setStatus("lockStatus", "Enter a password.", "err");

    chrome.runtime.sendMessage({
        type: "UNLOCK_ALMA_KEY",
        password
    }, (res) => {
        if (chrome.runtime.lastError) {
            setStatus("lockStatus", "Service worker error: " + chrome.runtime.lastError.message, "err");
            return;
        }
        if (res?.ok) {
            setLockedUI(false);
            setStatus("lockStatus", "Unlocked.", "ok");
        } else {
            setStatus("lockStatus", res?.error || "Unlock failed.", "err");
        }
    });
});

// First time password setup.
document.getElementById("setPassword").addEventListener("click", async () => {
    const password = (document.getElementById("adminPassword").value || "").trim();
    if (!password) return setStatus("lockStatus", "Enter a password to set.", "err");

    // If already set, prevent resetting silently
    const existing = await store.get(["ALMA_KEK_B64", "ALMA_PW_SALT", "ALMA_KDF_ITERS"]);
    const haveK = !!existing.ALMA_KEK_B64;
    const haveS = !!existing.ALMA_PW_SALT;
    const haveI = !!existing.ALMA_KDF_ITERS;

    if (haveK && haveS && haveI) {
        setStatus("lockStatus", "Password already set. Use Unlock to edit.", "err");
        return;
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iters = 200_000;

    // Derive KEK and store a verifier (raw KEK bytes)
    const base = await crypto.subtle.importKey("raw", enc.encode(password), {
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
    const KEK64 = u8ToB64u(raw);

    // store password metadata so later password attempts can be verified
    await store.set({
        ALMA_PW_SALT: b64u(salt),
        ALMA_KDF_ITERS: iters,
        ALMA_KEK_B64: KEK64
    });

    setStatus("lockStatus", "Password set. You can now Unlock and Save the API key.", "ok");
});

// Encrypts and saves the new input API key (only changeable if page is unlocked); saves region
document.getElementById("save")?.addEventListener("click", async () => {
    if (document.getElementById("settingsCard").classList.contains("disabled")) {
        setStatus("status", "Unlock first.", "err");
        return;
    }

    const apiKey = (document.getElementById("apiKey").value || "").trim();
    const region = document.getElementById("region").value || "NA";

    // allow region-only save
    if (!apiKey) {
        await store.set({
            ALMA_REGION: region
        });
        setStatus("status", "Saved region.", "ok");
        chrome.runtime.sendMessage({
            type: "REFRESH_CONFIG"
        }, () => {});
        return;
    }

    // Must have password (we derive using stored PW salt/iters)
    const pw = (document.getElementById("adminPassword").value || "").trim();
    if (!pw) {
        setStatus("status", "Enter password in Admin unlock to encrypt.", "err");
        return;
    }

    const meta = await store.get(["ALMA_PW_SALT", "ALMA_KDF_ITERS", "ALMA_KEK_B64"]);
    if (!meta || !meta.ALMA_PW_SALT || !meta.ALMA_KDF_ITERS || !meta.ALMA_KEK_B64) {
        setStatus("status", "Set password first (Admin unlock → Set Password).", "err");
        return;
    }

    try {
        // derive the same KEK using password salt/iters
        const salt = new Uint8Array(ub64(meta.ALMA_PW_SALT));
        const iters = Number(meta.ALMA_KDF_ITERS || 200000);

        const base = await crypto.subtle.importKey("raw", enc.encode(pw), {
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
        const probe = u8ToB64u(raw);
        if (probe !== meta.ALMA_KEK_B64) {
            setStatus("status", "Wrong password for encryption.", "err");
            return;
        }

        // encrypt API key with KEK derived above
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({
            name: "AES-GCM",
            iv
        }, key, enc.encode(apiKey));

        await store.set({
            ALMA_API_KEY_C: b64u(ct),
            ALMA_API_KEY_IV: b64u(iv),
            ALMA_API_KEY_LEN: apiKey.length,
            ALMA_REGION: region
        });

        __apiKeyRevealed = false;
        paintMaskedIfEncrypted();
        setStatus("status", "Saved settings (encrypted).", "ok");
        chrome.runtime.sendMessage({
            type: "REFRESH_CONFIG"
        }, () => {});
    } catch (e) {
        console.error("Save failed:", e);
        setStatus("status", "Save failed. See console.", "err");
    }
});

// When user begins typing in the API key box, get rid of the masking dots
document.getElementById("apiKey")?.addEventListener("input", (e) => {
    const el = e.currentTarget;
    if (el.dataset.masked === "1") {
        el.value = el.value.replace(/•+/g, "");
        delete el.dataset.masked;
    }
});

/**
 * Requires unlocked
 * Show: If background has API key saved in memory, then this retrieves it and replaces the masking dots with the
 * plaintext key.
 * Hide: replace visible API key text with masking dots.
 */
document.getElementById("toggleKey")?.addEventListener("click", () => {
    const el = document.getElementById("apiKey");
    const btn = document.getElementById("toggleKey");
    if (!el || !btn) return;

    if (!__apiKeyRevealed) {
        chrome.runtime.sendMessage({
            type: "REVEAL_ALMA_KEY"
        }, (res) => {
            if (chrome.runtime.lastError) {
                setStatus("status", chrome.runtime.lastError.message, "err");
                return;
            }
            if (!res?.ok || !(res.key || res.apiKey)) {
                setStatus("status", res?.error || "Key is locked.", "err");
                return;
            }
            el.type = "text";
            el.value = res.key || res.apiKey;
            delete el.dataset.masked;
            __apiKeyRevealed = true;
            btn.textContent = "Hide";
        });
        return;
    }

    // Re-mask without decrypting
    chrome.storage.local.get(["ALMA_API_KEY_C", "ALMA_API_KEY_LEN"], (r) => {
        if (r?.ALMA_API_KEY_C) {
            const len = Math.max(1, Number(r.ALMA_API_KEY_LEN || 10));
            el.type = "password";
            el.value = "•".repeat(len);
            el.dataset.masked = "1";
        } else {
            el.type = "password";
            el.value = "";
            delete el.dataset.masked;
        }
        __apiKeyRevealed = false;
        btn.textContent = "Show";
    });
});

// Removes all stored sensitive information (requires unlocked)
document.getElementById("clear").addEventListener("click", async () => {
    if (document.getElementById("settingsCard").classList.contains("disabled"))
        return setStatus("status", "Unlock first.", "err");

    await store.remove(["ALMA_API_KEY", "ALMA_API_KEY_C", "ALMA_API_KEY_IV", "ALMA_KDF_ITERS", "ALMA_PW_SALT", "ALMA_KEK_B64"]);
    document.getElementById("apiKey").value = "";
    setStatus("status", "Cleared API key.", "ok");
    chrome.runtime.sendMessage({
        type: "REFRESH_CONFIG"
    }, () => {});
});

// Tests whether the saved API key can connect to Alma (requires unlocked)
document.getElementById("test").addEventListener("click", () => {
    if (document.getElementById("settingsCard").classList.contains("disabled"))
        return setStatus("status", "Unlock first.", "err");

    setStatus("status", "Testing connection…", "muted");
    chrome.runtime.sendMessage({
        type: "TEST_ALMA_CONNECTIVITY"
    }, (resp) => {
        if (chrome.runtime.lastError) {
            setStatus("status", "Service worker error: " + chrome.runtime.lastError.message, "err");
            return;
        }
        if (resp?.ok) setStatus("status", "Success! Able to reach Alma.", "ok");
        else setStatus("status", `Failed: ${resp?.status || ""} ${resp?.error || ""}`, "err");
    });
});
