import { ThemeEvents } from '@theme/events';
import { Component } from '@theme/component';
import { formatMoney } from '@theme/money-formatting';

/**
 * @typedef {Object} ProductPriceRefs
 * @property {HTMLElement} priceContainer
 * @property {HTMLElement} [volumePricingNote]
 * @property {HTMLElement} [tagPricingMeta]
 */

/**
 * A custom element that displays a product price.
 * This component listens for variant update events and updates the price display accordingly.
 * It handles price updates from two different sources:
 * 1. Variant picker (in quick add modal or product page)
 * 2. Swatches variant picker (in product cards)
 *
 * @extends {Component<ProductPriceRefs>}
 */
class ProductPrice extends Component {
  connectedCallback() {
    super.connectedCallback();
    const closestSection = this.closest('.shopify-section, dialog');
    if (!closestSection) return;
    closestSection.addEventListener(ThemeEvents.variantUpdate, this.updatePrice);
    requestAnimationFrame(() => this.#initTagPricingSubscription(closestSection));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    const closestSection = this.closest('.shopify-section, dialog');
    if (!closestSection) return;
    closestSection.removeEventListener(ThemeEvents.variantUpdate, this.updatePrice);
  }

  /**
   * Re-applies tag pricing when subscription / one-time mode changes (e.g. Appstle widget).
   */
  refreshTagPricing() {
    this.#applyTagPricingFromSellingPlan();
  }

  /**
   * Updates the price and volume pricing note.
   * @param {Event} event - The variant update event.
   */
  updatePrice = (event) => {
    if (event.detail.data.newProduct) {
      this.dataset.productId = event.detail.data.newProduct.id;
    } else if (event.target instanceof HTMLElement && event.target.dataset.productId !== this.dataset.productId) {
      return;
    }

    const { priceContainer, volumePricingNote } = this.refs;
    // Find the new product-price element in the updated HTML
    const newProductPrice = event.detail.data.html.querySelector(
      `product-price[data-block-id="${this.dataset.blockId}"]`
    );
    if (!newProductPrice) return;

    // Update price container
    const newPrice = newProductPrice.querySelector('[ref="priceContainer"]');
    if (newPrice && priceContainer) {
      priceContainer.replaceWith(newPrice);
    }

    // Update volume pricing note
    const newNote = newProductPrice.querySelector('[ref="volumePricingNote"]');

    if (!newNote) {
      volumePricingNote?.remove();
    } else if (!volumePricingNote) {
      // Use newPrice since priceContainer was just replaced and now points to the detached element
      newPrice?.insertAdjacentElement('afterend', /** @type {Element} */ (newNote.cloneNode(true)));
    } else {
      volumePricingNote.replaceWith(newNote);
    }

    // Update installments (SPI banner) variant ID to trigger payment terms re-render
    const input_selector = `#product-form-installment-${this.dataset.blockId} input[name="id"]`;
    const installmentsInput = /** @type {HTMLInputElement|null} */ (this.querySelector(input_selector));
    if (installmentsInput) {
      installmentsInput.value = event.detail.resource?.id ?? '';
      installmentsInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    requestAnimationFrame(() => this.#applyTagPricingFromSellingPlan());
  };

  /**
   * @param {Element} section
   */
  #initTagPricingSubscription(section) {
    this.#applyTagPricingFromSellingPlan();

    const tp = window.themeTagPricing;
    if (!tp?.enabled) return;

    if (section.dataset.tagPricingSellPlanBound) return;
    section.dataset.tagPricingSellPlanBound = 'true';

    const run = () => {
      requestAnimationFrame(() => {
        section.querySelectorAll('product-price').forEach((el) => {
          if (el instanceof ProductPrice) el.#applyTagPricingFromSellingPlan();
        });
      });
    };

    section.addEventListener('change', run);
    section.addEventListener('input', run);

    const widget = section.querySelector('[id*="appstle_subscription"]');
    if (widget) {
      new MutationObserver(run).observe(widget, { childList: true, subtree: true, attributes: true });
      setTimeout(run, 150);
    }
  }

  /**
   * True only when a real Shopify selling plan is active — not one-time / OTP.
   * Appstle (and similar) often give the one-time row a non-empty value; we must not treat that as a plan.
   */
  #isCommittedSellingPlanValue(raw, selectedOption) {
    if (raw == null) return false;
    const v = String(raw).trim();
    if (v === '') return false;

    const lower = v.toLowerCase();
    if (
      lower === '0' ||
      lower === '-1' ||
      lower === 'false' ||
      lower === 'null' ||
      lower === 'none' ||
      lower === 'undefined' ||
      lower === 'no' ||
      lower === 'one-time' ||
      lower === 'onetime' ||
      lower === 'one_time' ||
      lower === 'otp' ||
      lower.startsWith('otp_') ||
      lower.includes('one-time-purchase')
    ) {
      return false;
    }

    const label =
      selectedOption?.textContent?.trim() ||
      selectedOption?.getAttribute?.('label') ||
      selectedOption?.innerText?.trim() ||
      '';
    if (label && /one[-\s]?time|single\s*purchase|purchase\s*once|pay\s*as\s*you\s*go|one\s*time\s*only/i.test(label)) {
      return false;
    }

    if (selectedOption?.dataset?.sellingPlanId === '' || selectedOption?.dataset?.oneTime === 'true') {
      return false;
    }

    return true;
  }

  #getSellingPlanSelected() {
    const section = this.closest('.shopify-section, dialog');
    if (!section) return false;

    const form =
      this.closest('form[action*="/cart/add"]') ||
      section.querySelector('product-form-component form') ||
      section.querySelector('form[action*="/cart/add"]') ||
      section.querySelector('form.shopify-product-form');

    /** @type {Element | null} */
    let el =
      form?.querySelector('input[type="hidden"][name="selling_plan"]') ||
      form?.querySelector('select[name="selling_plan"]') ||
      form?.querySelector('[name="selling_plan"]:checked');

    if (!el) {
      el = section.querySelector('[name="selling_plan"]:checked');
    }
    if (!el) {
      el = section.querySelector('select[name="selling_plan"]');
    }
    if (!el) {
      el = section.querySelector('input[name="selling_plan"]:not([type="radio"]):not([type="checkbox"])');
    }

    let selectedOption = null;
    if (el instanceof HTMLSelectElement) {
      selectedOption = el.selectedOptions[0] ?? null;
      return this.#isCommittedSellingPlanValue(el.value, selectedOption);
    }

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return this.#isCommittedSellingPlanValue(el.value, null);
    }

    const appstleSelect = section.querySelector(
      '[id*="appstle_subscription"] select, #appstle_subscription_widget0 select'
    );
    if (appstleSelect instanceof HTMLSelectElement) {
      selectedOption = appstleSelect.selectedOptions[0] ?? null;
      return this.#isCommittedSellingPlanValue(appstleSelect.value, selectedOption);
    }

    return false;
  }

  #applyTagPricingFromSellingPlan() {
    const meta = this.refs.tagPricingMeta ?? this.querySelector('[ref="tagPricingMeta"]');
    const priceContainer = this.refs.priceContainer ?? this.querySelector('[ref="priceContainer"]');
    const tp = window.themeTagPricing;

    if (!meta || !priceContainer || !tp?.enabled || meta.dataset.hasVolume === '1') return;

    const basePrice = Number(meta.dataset.basePrice);
    const baseCompare = Number(meta.dataset.baseCompare || 0);
    if (Number.isNaN(basePrice)) return;

    const subscriptionSelected = this.#getSellingPlanSelected();
    const useCurrency = meta.dataset.useCurrency === '1';
    const format = useCurrency ? tp.moneyWithCurrencyFormat : tp.moneyFormat;
    const currency = tp.currency;

    let pct = 0;
    let active = false;
    if (subscriptionSelected) {
      pct = Number(meta.dataset.subscriptionPct || 0);
      active = meta.dataset.subscriptionOn === '1';
    } else {
      pct = Number(meta.dataset.purchasePct || 0);
      active = meta.dataset.purchaseOn === '1';
    }

    let displayPriceCents = basePrice;
    let displayCompareCents = baseCompare;
    let showCompare = false;

    if (active && pct > 0 && pct < 100) {
      showCompare = true;
      displayCompareCents = basePrice;
      displayPriceCents = Math.round((basePrice * (100 - pct)) / 100);
    } else if (baseCompare > basePrice) {
      showCompare = true;
      displayCompareCents = baseCompare;
      displayPriceCents = basePrice;
    }

    const saleStr = formatMoney(displayPriceCents, format, currency);
    const compareStr = formatMoney(displayCompareCents, format, currency);

    priceContainer.querySelectorAll('.price').forEach((el) => {
      el.textContent = saleStr;
    });
    priceContainer.querySelectorAll('.compare-at-price').forEach((el) => {
      el.textContent = compareStr;
    });

    const regular = priceContainer.querySelector('.price__regular');
    const saleBlock = priceContainer.querySelector('.price__sale');
    if (regular && saleBlock) {
      if (showCompare) {
        regular.classList.add('price__hidden');
        saleBlock.classList.remove('price__hidden');
      } else {
        regular.classList.remove('price__hidden');
        saleBlock.classList.add('price__hidden');
      }
    }
  }
}

if (!customElements.get('product-price')) {
  customElements.define('product-price', ProductPrice);
}
