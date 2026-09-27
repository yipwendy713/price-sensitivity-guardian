// app/bloomreach.server.js  (version 2: trackEvent reports success or failure)
// Records events on a customer in Bloomreach using the Tracking API.
// Credentials come from your .env file. Never put them in this file.

// Sets properties (email, name) on the customer so they're searchable
// and so Bloomreach can send them emails.
export async function updateCustomer(email, properties = {}) {
  const { BLOOMREACH_API_BASE, BLOOMREACH_PROJECT_TOKEN, BLOOMREACH_KEY_ID, BLOOMREACH_KEY_SECRET } = process.env;
  if (!email || !BLOOMREACH_API_BASE) return;

  const url = `${BLOOMREACH_API_BASE}/track/v2/projects/${BLOOMREACH_PROJECT_TOKEN}/customers`;
  const auth = Buffer.from(`${BLOOMREACH_KEY_ID}:${BLOOMREACH_KEY_SECRET}`).toString("base64");

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      customer_ids: { email_id: email.toLowerCase() },
      properties: { email: email.toLowerCase(), ...properties },
    }),
  });

  if (!response.ok) {
    console.error(`Bloomreach: customer update failed (${response.status}): ${await response.text()}`);
  }
}

export async function trackEvent(email, eventType, properties = {}) {
  const {
    BLOOMREACH_API_BASE,
    BLOOMREACH_PROJECT_TOKEN,
    BLOOMREACH_KEY_ID,
    BLOOMREACH_KEY_SECRET,
  } = process.env;

  if (!BLOOMREACH_API_BASE || !BLOOMREACH_PROJECT_TOKEN || !BLOOMREACH_KEY_ID || !BLOOMREACH_KEY_SECRET) {
    console.error("Bloomreach: missing credentials. Check your .env file.");
    return { ok: false, error: "missing credentials" };
  }

  if (!email) {
    console.warn(`Bloomreach: no email, skipped ${eventType}`);
    return { ok: false, error: "no email" };
  }

  const url = `${BLOOMREACH_API_BASE}/track/v2/projects/${BLOOMREACH_PROJECT_TOKEN}/customers/events`;
  const auth = Buffer.from(`${BLOOMREACH_KEY_ID}:${BLOOMREACH_KEY_SECRET}`).toString("base64");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      customer_ids: { email_id: email.toLowerCase() },
      event_type: eventType,
      timestamp: Date.now() / 1000, // Bloomreach expects seconds
      properties,
    }),
  });

  const text = await response.text();
  if (response.ok) {
    console.log(`Bloomreach: recorded ${eventType} for ${email}`);
    return { ok: true };
  }
  console.error(`Bloomreach: ${eventType} failed (${response.status}): ${text}`);
  return { ok: false, error: `${response.status}: ${text}` };
}
