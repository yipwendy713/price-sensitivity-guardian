# Price-Sensitivity Guardian

This is an AI agent that decides how to win back each abandoned Shopify checkout based on who the shopper actually is, rather than sending everyone the same blanket discount.

Built for the Bloomreach Shopify hackathon (2026).

## The problem

Most stores answer every abandoned cart the same way, with a discount code. That can recover some sales, but it gives away margin to shoppers who would have paid full price anyway. This is an agent that looks at each shopper's purchase history and picks the cheapest intervention likely to bring them back.

| Shopper type | Evidence | Intervention |
|---|---|---|
| `price_sensitive` | Past orders mostly used discount codes or were low-priced | **Discount**, the smallest likely to work (5–15%, hard-capped at 20%) |
| `high_intent` | Past orders at full price, no discount codes | **Scarcity** reminder that the item may sell out, no discount |
| `comparison` | Few or no past orders | **Alternative** product suggestion, no discount |

The same abandoned cart can lead to three different decisions, and the agent cites the evidence behind each one (for example, "3 of 3 past orders used SAVE15").

## How it works

![Architecture](/guardian-architecture.png)

1. A shopper starts checkout on the Shopify store. Shopify sends `checkouts/create` / `checkouts/update` webhooks to the app.
2. Once the shopper's email is known, the app identifies them in Bloomreach by email, updates their customer profile and records a `checkout_started` event.
3. The app watches for an `orders/create` webhook from the same customer. If none arrives within the wait window (2 minutes by default), the checkout counts as abandoned and the agent wakes up.
4. The agent, running on Gemini via Google Cloud Vertex AI, uses tool calling to:
   - `get_order_history`: pull the customer's last 10 orders from the Shopify Admin GraphQL API, including totals, items and discount codes.
   - `record_decision`: write a `guardian_decision` event to the customer's Bloomreach profile with the shopper type, intervention, discount percent and rationale.
5. Every run is saved as a JSON trace in `traces/`.

## Design choices

- **Tool calling, not a fixed pipeline.** The agent decides what information it needs before classifying the shopper.
- **Guardrails in code, not just the prompt.** The 20% discount cap is enforced in `recordDecision`, whatever the model asks for, and capped decisions are flagged with `discount_capped: true`. The agent loop is limited to 6 tool rounds.
- **Honest failure reporting.** Tools return `recorded: false` with the error when Bloomreach rejects a write, and the agent is instructed not to claim an action it didn't complete.
- **One identity across systems.** The app connects the shopper in Shopify and Bloomreach.  The app waits until the checkout has an email, then uses the lowercased email as the Bloomreach `email_id`, so every event and decision lands on the right profile.
- **Traces as an evaluation set.** Each run's inputs, tool calls, results and summary are saved, so prompt changes can be tested against real past cases.
- **Low temperature (0.2)** for consistent decisions on similar evidence.

## Tech stack

- Shopify app (React Router template, Node.js), Admin GraphQL API, webhooks
- Gemini (`gemini-2.5-flash` by default) via `@google/genai` on Vertex AI
- Bloomreach Tracking API (customer updates and events)
- Prisma + SQLite for Shopify session storage

## Project structure

```
app/
  agent.server.js            The Guardian agent: system prompt, tools, guardrails, agent loop, traces
  bloomreach.server.js       Bloomreach Tracking API client (updateCustomer, trackEvent)
  routes/
    webhooks.commerce.jsx    Checkout/order webhooks, abandonment detection, starts the agent
  shopify.server.js          Shopify app setup and auth
shopify.app.toml             App config: access scopes and webhook subscriptions
traces/                      One JSON file per agent run (created at runtime)
```

The embedded admin page (`app/routes/app._index.jsx`) is still the Shopify template's demo page; all of the Guardian's work happens in the webhook handler and the agent.

## Demo

Here is a [demo video](https://youtu.be/6XJwN1eNGzk) of what the app does.

The demo runs three test customers through the same abandoned checkout:

- **Penny** uses a discount code with all past orders. The agent classifies her as price-sensitive and offers a discount.
- **Ian** has several past orders, all at full price. The agent chooses a scarcity reminder with no discount.
- **Cathy** has no order history. The agent classifies him as a comparison shopper and suggests an alternative product.

For each one, the terminal shows the agent's tool calls and rationale, and a `guardian_decision` event appears on the customer's Bloomreach profile.

## Running it

This was built against a hackathon sandbox, so it won't run as-is. To adapt it, you'd need a Shopify development store, a Google Cloud project with Vertex AI, and a Bloomreach project with Tracking API credentials. The code reads its configuration from these environment variables: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GEMINI_MODEL`, `BLOOMREACH_API_BASE`, `BLOOMREACH_PROJECT_TOKEN`, `BLOOMREACH_KEY_ID`, `BLOOMREACH_KEY_SECRET` and `ABANDON_WAIT_MINUTES`. Start the app with `npm run dev` through the Shopify CLI.

## Limitations

- Abandonment tracking uses in-memory state and timers, so pending checks are lost on restart and the app must run as a single instance. Production would use a queue or scheduled job with persisted state.


## What's next


- Using Bloomreach event history as the agent's memory, so it learns which interventions worked for each shopper

## Author

Wendy Yip
