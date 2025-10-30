/**
 * Opens automatically on the Kanopy cart page, scrapes for price, title, license type and ID, and sends this to
 * the background script so the popup can autofill one item's popup page at a time.
 * 
 * @author Christopher Luce and Alana Bregman
 *
 */

/**
 * Checks whether the current page is Kanopy's cart page
 */
(function () {
  function isKanopyCartPage() {
    return location.hostname === "www.kanopy.com" && location.pathname === "/kart";
  }
  if (!isKanopyCartPage()) return;

  /**
   * Scrapes the title, price, license, and id for each item in the cart, normalises and cleans them,
   * and then returns them in an array
   * @returns the array of cleaned and normalised item objects with scraped information
   */
  function extractCartItems() {
    const rows = document.querySelectorAll("table.ui.table.inverted tbody tr");
    const items = [];
    rows.forEach((row) => {
      const titleEl = row.querySelector("td:nth-child(2) .header");
      const priceEl = row.querySelector("td.right.aligned");
      const kanopyIdEl = row.querySelector("td:nth-child(4)");
      if (!titleEl || !priceEl || !kanopyIdEl) return;

      const title = (titleEl.textContent || "").trim() || "Untitled";
      const license = row.querySelector(".license-duration option[selected]")?.textContent.trim() || "";
      const kanopyId = (kanopyIdEl.textContent || "").trim() || "";
      const priceRaw = (priceEl.textContent || "").trim();
      const price = priceRaw.replace(/[^0-9.]/g, ""); 

      items.push({
        title,
        price,                
        quantity: 1,
        currency: "USD",       
        vendor_system: "KANOPY",
        vendor_hint: "KANOPY", 
        license,
        kanopy_id: kanopyId
      });
    });
    return items;
  }

  const items = extractCartItems();
  if (!items.length) return;

  // Send to background to store + pop open popup
  chrome.runtime.sendMessage({ type: "VENDOR_PREFILL", vendor: "KANOPY", items }, () => {});
})();
