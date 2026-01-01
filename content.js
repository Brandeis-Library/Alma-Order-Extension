/**
 * Opens when popup is opened; scrapes for price, title, currency, and vendor, packages the data, and sends 
 * it to the popup.
 * 
 * @author Alana Bregman
 *
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "SCRAPE_BOOK_INFO") {
        try {
            let title = "";
            let price = "";
            let currency = "";
            let isbn = "";
            const vendor = window.location.hostname;

            // AMAZON
            if (vendor.includes("amazon.")) {
                const amazonTitle = document.getElementById("productTitle");
                if (amazonTitle) {
                    title = amazonTitle.textContent.trim();
                }

                // New Amazon price structure
                const whole = document.querySelector(".a-price .a-price-whole");
                const fraction = document.querySelector(".a-price .a-price-fraction");
                if (whole && fraction) {
                    price = `$${whole.textContent.replace(/[^\d]/g, "")}.${fraction.textContent}`;
                    currency = "USD";
                }

                // ISBN scrape on Amazon 

                let isbn13 = "";
                let isbn10 = "";

                const rows = document.querySelectorAll(
                    "#productDetails_detailBullets_sections1 tr, " +
                    "#detailBullets_feature_div li, " +
                    "#detailBulletsWrapper_feature_div li"
                );

                rows.forEach((row) => {
                    const label = (row.querySelector("th")?.textContent ||
                        row.querySelector("span.a-text-bold")?.textContent ||
                        row.firstChild?.textContent ||
                        "").trim();

                    const value = (row.querySelector("td")?.textContent ||
                        row.textContent ||
                        "").trim();

                    const txt = (label + " " + value).replace(/\s+/g, " ");

                    if (!isbn13 && /ISBN-13/i.test(txt)) {
                        const m = txt.match(/([0-9Xx\- ]{10,})/);
                        if (m) {
                            isbn13 = m[1].replace(/[^0-9Xx]/g, "");
                            if (isbn13.length > 13) isbn13 = isbn13.slice(-13);
                        }
                    }

                    if (!isbn10 && /ISBN-10/i.test(txt)) {
                        const m = txt.match(/([0-9Xx\- ]{9,})/);
                        if (m) {
                            isbn10 = m[1].replace(/[^0-9Xx]/g, "");
                            if (isbn10.length > 10) isbn10 = isbn10.slice(-10);
                        }
                    }
                });

                // Fallback: scan full page text for ISBN labels
                if (!isbn13 || isbn13.length < 13 || !isbn10 || isbn10.length < 10) {
                    const full = (document.body.innerText || "").replace(/\s+/g, " ");

                    if (!isbn13 || isbn13.length < 13) {
                        const m13 = full.match(/ISBN[-\s]*13[^0-9Xx]+([0-9Xx\- ]{10,})/i);
                        if (m13) {
                            isbn13 = m13[1].replace(/[^0-9Xx]/g, "");
                            if (isbn13.length > 13) isbn13 = isbn13.slice(-13);
                        }
                    }

                    if (!isbn10 || isbn10.length < 10) {
                        const m10 = full.match(/ISBN[-\s]*10[^0-9Xx]+([0-9Xx\- ]{9,})/i);
                        if (m10) {
                            isbn10 = m10[1].replace(/[^0-9Xx]/g, "");
                            if (isbn10.length > 10) isbn10 = isbn10.slice(-10);
                        }
                    }
                }

                isbn = isbn13 || isbn10 || "";
                console.log("[AlmaExt] Amazon ISBN scrape:", {
                    isbn13,
                    isbn10,
                    isbn
                });

            }

            // ABEBOOKS
            else if (vendor.includes("abebooks.com")) {
                const abebooksTitle = document.querySelector("h1[itemprop='name'], h1[itemprop='headline']");
                if (abebooksTitle) {
                    title = abebooksTitle.textContent.trim();
                }

                const priceEl =
                    document.querySelector("[itemprop='price']") ||
                    document.querySelector("meta[itemprop='price']") ||
                    document.querySelector("[data-cy*='price']") ||
                    document.querySelector("[class*='price']") ||
                    document.querySelector(".price");

                if (priceEl) {
                    price = (priceEl.getAttribute("content") || priceEl.textContent || "").trim();
                }

                currency = "USD";
              }

            // Fallback for title
            if (!title) {
                title = document.title.split("|")[0].trim();
            }

            sendResponse({
                title,
                price,
                currency,
                vendor,
                isbn
            });
        } catch (e) {
            console.error("Scraping failed:", e);
            sendResponse({});
        }
    }

    return true;
});
