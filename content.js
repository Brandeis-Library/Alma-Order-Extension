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
      }

      // ABEBOOKS
      else if (vendor.includes("abebooks.com")) {
        const abebooksTitle = document.querySelector("h1[itemprop='name'], h1[itemprop='headline']");
        if (abebooksTitle) {
          title = abebooksTitle.textContent.trim();
        }

        // Try to get visible formatted price
        const abebooksVisiblePrice = document.querySelector(".price");
        if (abebooksVisiblePrice) {
          price = abebooksVisiblePrice.textContent.trim();
        }

        // If that fails, try structured data
        if (!price) {
          const metaPrice = document.querySelector("meta[itemprop='price']");
          if (metaPrice && metaPrice.content) {
            price = `$${Number(metaPrice.content).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
          }
        }

        currency = "USD";
      }

      // Fallback for title
      if (!title) {
        title = document.title.split("|")[0].trim();
      }

      sendResponse({ title, price, currency, vendor });
    } catch (e) {
      console.error("Scraping failed:", e);
      sendResponse({});
    }
  }

  return true;
});