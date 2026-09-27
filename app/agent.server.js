// app/agent.server.js  (agent version 2: saves traces, reports failures honestly)
// The Price-Sensitivity Guardian agent. Gemini gets the abandoned cart,
// uses tools to look up the customer's history, then records its decision.
import { GoogleGenAI } from "@google/genai";
import { mkdir, writeFile } from "node:fs/promises";
import { unauthenticated } from "./shopify.server";
import { trackEvent } from "./bloomreach.server";

const MAX_DISCOUNT_PERCENT = 20; // Guardrail: enforced in code, not just in the prompt.
const MAX_STEPS = 6;             // Safety limit on how many tool rounds the agent can take.

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION,
});

// ---------------------------------------------------------------------------
// 1. The instructions: who the agent is and how it should decide.
// ---------------------------------------------------------------------------
const SYSTEM_INSTRUCTION = `
You are the Price-Sensitivity Guardian, an agent for an online store.
A customer has abandoned their checkout. Decide the single best intervention
to win them back without giving away margin unnecessarily.

Shopper types and the intervention each should get:
- price_sensitive: past orders mostly used discount codes or were low-priced.
  Intervention: "discount" (use the smallest discount likely to work, 5-15%).
- high_intent: past orders at full price with no discount codes, especially
  in the same category. Intervention: "scarcity" (remind them it may sell out;
  never discount).
- comparison: few or no past orders. Intervention: "alternative" (suggest a
  similar product that might fit better; no discount).

Process:
1. Call get_order_history for the customer's email.
2. Classify the shopper using the evidence.
3. Call record_decision exactly once with your decision and a short rationale
   that cites the evidence (e.g. "3 of 3 past orders used SAVE15").
4. Reply with a one-sentence summary of the decision you recorded.
   Don't claim a message was sent; another system sends it.
   If record_decision returns recorded: false, say the decision could not be recorded.
`;

// ---------------------------------------------------------------------------
// 2. The tools: descriptions Gemini reads, plus the code that runs them.
// ---------------------------------------------------------------------------
const toolDeclarations = [
  {
    name: "get_order_history",
    description: "Get the customer's past orders from Shopify, including totals and any discount codes used.",
    parametersJsonSchema: {
      type: "object",
      properties: { email: { type: "string", description: "Customer email" } },
      required: ["email"],
    },
  },
  {
    name: "record_decision",
    description: "Record the chosen intervention in Bloomreach, which triggers the customer message.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        email: { type: "string" },
        shopper_type: { type: "string", enum: ["price_sensitive", "high_intent", "comparison"] },
        intervention: { type: "string", enum: ["discount", "scarcity", "alternative"] },
        discount_percent: { type: "number", description: "Only for discount; 0 otherwise" },
        rationale: { type: "string", description: "One or two sentences citing the evidence" },
      },
      required: ["email", "shopper_type", "intervention", "rationale"],
    },
  },
];

async function getOrderHistory(shop, { email }) {
  const { admin } = await unauthenticated.admin(shop);
  const response = await admin.graphql(
    `#graphql
    query ($query: String!) {
      customers(first: 1, query: $query) {
        nodes {
          orders(first: 10, reverse: true) {
            nodes {
              name
              createdAt
              discountCodes
              totalPriceSet { shopMoney { amount currencyCode } }
              lineItems(first: 5) { nodes { title } }
            }
          }
        }
      }
    }`,
    { variables: { query: `email:"${email}"` } },
  );
  const json = await response.json();
  const orders = json.data?.customers?.nodes?.[0]?.orders?.nodes ?? [];
  return {
    order_count: orders.length,
    orders: orders.map((o) => ({
      order: o.name,
      date: o.createdAt.slice(0, 10),
      total: Number(o.totalPriceSet.shopMoney.amount),
      discount_codes: o.discountCodes,
      items: o.lineItems.nodes.map((i) => i.title),
    })),
  };
}

async function recordDecision(context, args) {
  // Guardrail: cap discounts in code, whatever the model asked for.
  let discount = args.intervention === "discount" ? Number(args.discount_percent ?? 10) : 0;
  const capped = discount > MAX_DISCOUNT_PERCENT;
  if (capped) discount = MAX_DISCOUNT_PERCENT;

  const result = await trackEvent(args.email, "guardian_decision", {
    shopper_type: args.shopper_type,
    intervention: args.intervention,
    discount_percent: discount,
    discount_capped: capped,
    rationale: args.rationale,
    checkout_token: context.checkoutToken,
    cart_total: context.cartTotal,
    items: context.items,
  });
  if (!result?.ok) return { recorded: false, error: result?.error ?? "unknown error" };
  return { recorded: true, discount_percent: discount, discount_capped: capped };
}

// ---------------------------------------------------------------------------
// 3. The agent loop: ask Gemini, run the tools it requests, send back results,
//    repeat until it stops asking for tools.
// ---------------------------------------------------------------------------
export async function runAgent({ shop, email, checkoutToken, cartTotal, items }) {
  const context = { checkoutToken, cartTotal, items };
  const contents = [
    {
      role: "user",
      parts: [{
        text: `Abandoned checkout.\nCustomer email: ${email}\nCart total: ${cartTotal}\nItems: ${JSON.stringify(items)}`,
      }],
    },
  ];

  const trace = { email, cartTotal, items, startedAt: new Date().toISOString(), steps: [] };
  console.log(`\n[agent] Starting for ${email}`);

  for (let step = 1; step <= MAX_STEPS; step++) {
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: [{ functionDeclarations: toolDeclarations }],
        temperature: 0.2, // Low temperature = more consistent decisions.
      },
    });

    const calls = response.functionCalls ?? [];
    if (calls.length === 0) {
      console.log(`[agent] Done: ${response.text}`);
      trace.summary = response.text;
      await saveTrace(trace);
      return response.text;
    }

    // Keep the model's turn in the conversation, then answer each tool call.
    contents.push(response.candidates[0].content);
    const results = [];
    for (const call of calls) {
      console.log(`[agent] Step ${step}: calling ${call.name}`, JSON.stringify(call.args));
      let result;
      try {
        if (call.name === "get_order_history") result = await getOrderHistory(shop, call.args);
        else if (call.name === "record_decision") result = await recordDecision(context, call.args);
        else result = { error: `Unknown tool ${call.name}` };
      } catch (error) {
        result = { error: String(error) };
      }
      console.log(`[agent] Result:`, JSON.stringify(result));
      trace.steps.push({ tool: call.name, args: call.args, result });
      results.push({ functionResponse: { name: call.name, response: result } });
    }
    contents.push({ role: "user", parts: results });
  }

  console.warn("[agent] Stopped: reached the step limit.");
  trace.summary = "Stopped: reached the step limit.";
  await saveTrace(trace);
}

// Saves one JSON file per agent run in the traces/ folder (your evaluation set).
async function saveTrace(trace) {
  try {
    await mkdir("traces", { recursive: true });
    const file = `traces/${Date.now()}-${trace.email.split("@")[0]}.json`;
    await writeFile(file, JSON.stringify(trace, null, 2));
    console.log(`[agent] Trace saved to ${file}`);
  } catch (error) {
    console.error("[agent] Could not save trace:", error);
  }
}
