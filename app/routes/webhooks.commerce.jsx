// app/routes/webhooks.commerce.jsx  (version 3: records events and runs the agent on abandonment)
import { authenticate } from "../shopify.server";
import { trackEvent, updateCustomer } from "../bloomreach.server";
import { runAgent } from "../agent.server";

// Checkouts already sent to Bloomreach (avoids duplicates from CHECKOUTS_UPDATE).
const recordedCheckouts = new Set();
// When each customer last placed an order, so we can tell if a checkout was abandoned.
const lastOrderAt = new Map();

const WAIT_MINUTES = Number(process.env.ABANDON_WAIT_MINUTES ?? 2);

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`\n=== ${topic} from ${shop} ===`);

  const items = payload.line_items?.map((i) => ({
    title: i.title,
    price: Number(i.price),
    quantity: i.quantity,
    product_id: i.product_id,
    variant_id: i.variant_id,
  }));

  try {
    if (topic === "CHECKOUTS_CREATE" || topic === "CHECKOUTS_UPDATE") {
      if (payload.email && !recordedCheckouts.has(payload.token)) {
        recordedCheckouts.add(payload.token);
        const email = payload.email.toLowerCase();
        const startedAt = Date.now();

        await updateCustomer(email, {
          first_name: payload.customer?.first_name ?? payload.shipping_address?.first_name,
          last_name: payload.customer?.last_name ?? payload.shipping_address?.last_name,
          shopify_id: payload.customer?.id ? String(payload.customer.id) : undefined,
        });
        await trackEvent(email, "checkout_started", {
          checkout_token: payload.token,
          cart_token: payload.cart_token,
          total_price: Number(payload.total_price),
          currency: payload.currency,
          items,
          source: "shopify",
        });

        // Abandonment check: if no order from this customer within the wait, run the agent.
        console.log(`[abandonment] Watching ${email} for ${WAIT_MINUTES} min`);
        setTimeout(() => {
          if ((lastOrderAt.get(email) ?? 0) > startedAt) {
            console.log(`[abandonment] ${email} completed an order. No action.`);
            return;
          }
          console.log(`[abandonment] ${email} abandoned checkout. Running agent.`);
          runAgent({
            shop,
            email,
            checkoutToken: payload.token,
            cartTotal: Number(payload.total_price),
            items,
          }).catch((error) => console.error("[agent] Error:", error));
        }, WAIT_MINUTES * 60 * 1000);
      }
    } else if (topic === "ORDERS_CREATE") {
      if (payload.email) lastOrderAt.set(payload.email.toLowerCase(), Date.now());
      await trackEvent(payload.email, "order_placed", {
        order_id: payload.id,
        checkout_token: payload.checkout_token,
        cart_token: payload.cart_token,
        total_price: Number(payload.total_price),
        currency: payload.currency,
        discount_codes: payload.discount_codes?.map((d) => d.code) ?? [],
        items,
        source: "shopify",
      });
    }
  } catch (error) {
    console.error("Webhook handling error:", error);
  }

  // Always answer Shopify quickly so it doesn't retry.
  return new Response();
};
