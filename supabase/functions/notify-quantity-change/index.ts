// notify-quantity-change/index.ts
// Supabase Edge Function (Deno)
//
// Called from the dashboard when an operator modifies an order's quantity.
// 1. If a reason was given → uses Groq to rewrite it into a short, polite
//    customer-facing WhatsApp message.
// 2. If no reason → sends a generic default message.
// 3. Sends the message via Twilio (same pattern as whatsapp-webhook).
// 4. Logs success/failure to stdout (visible in Supabase Function logs).
//
// Required secrets (already set for whatsapp-webhook):
//   GROQ_API_KEY
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_WHATSAPP_FROM   (e.g. "whatsapp:+14155238886")
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Twilio send helper (mirrors whatsapp-webhook pattern) ──────────────────
async function sendWhatsAppMessage(to: string, body: string): Promise<string> {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const from = Deno.env.get("TWILIO_WHATSAPP_FROM") ?? "whatsapp:+14155238886";

  const toNumber = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;

  const params = new URLSearchParams({
    To: toNumber,
    From: from,
    Body: body,
  });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      },
      body: params.toString(),
    }
  );

  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Twilio error: ${json.message ?? JSON.stringify(json)}`);
  }

  console.log(`[notify-quantity-change] WhatsApp sent. SID=${json.sid} to=${toNumber}`);
  return json.sid as string;
}

// ── Groq AI rewrite helper ─────────────────────────────────────────────────
async function rewriteReasonForCustomer(
  customerName: string,
  item: string,
  newQty: number,
  reason: string
): Promise<string> {
  const groqApiKey = Deno.env.get("GROQ_API_KEY")!;

  const systemPrompt = `You are a polite, professional customer service assistant for a wholesale distributor.
Your job is to write a short WhatsApp message (2-3 sentences max) informing a customer that their order quantity has been updated by the team.
Be warm, clear, and professional. Do not use emojis excessively. Do not reveal internal business details.`;

  const userPrompt = `Customer name: ${customerName}
Item ordered: ${item}
New quantity: ${newQty}
Internal reason for change: ${reason}

Write a short, polite WhatsApp message to the customer explaining the quantity change. Address them by first name if possible.`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens: 200,
    }),
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Groq error: ${json.error?.message ?? JSON.stringify(json)}`);
  }

  const message = json.choices?.[0]?.message?.content?.trim();
  if (!message) throw new Error("Groq returned empty message");

  console.log(`[notify-quantity-change] Groq rewrote reason into: "${message}"`);
  return message;
}

// ── Main handler ───────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      orderId,
      newQty,
      reason,
      item,
      customerName,
    }: {
      orderId: number;
      newQty: number;
      reason: string;
      item: string;
      customerName: string;
    } = await req.json();

    if (!orderId || !newQty || !item || !customerName) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(
      `[notify-quantity-change] Processing orderId=${orderId} newQty=${newQty} item="${item}" customer="${customerName}" hasReason=${!!reason}`
    );

    // ── Look up customer phone server-side (safe: uses service role key) ──
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { data: orderRow, error: orderErr } = await supabaseAdmin
      .from("orders")
      .select("customer_id, customers(phone)")
      .eq("id", orderId)
      .single();

    if (orderErr) {
      console.error(`[notify-quantity-change] Failed to fetch order: ${orderErr.message}`);
      return new Response(
        JSON.stringify({ ok: false, error: "Could not fetch order details" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const customerPhone = (orderRow?.customers as any)?.phone;
    if (!customerPhone) {
      console.warn(
        `[notify-quantity-change] No phone number on file for orderId=${orderId} — skipping WhatsApp send`
      );
      return new Response(
        JSON.stringify({ ok: false, error: "No customer phone number on file" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Build the WhatsApp message body ────────────────────────────────────
    let messageBody: string;
    const trimmedReason = reason?.trim() ?? "";

    if (trimmedReason.length > 0) {
      // AI rewrite
      messageBody = await rewriteReasonForCustomer(customerName, item, newQty, trimmedReason);
    } else {
      // Generic default
      messageBody = `Hi${customerName ? ` ${customerName.split(" ")[0]}` : ""}, just a quick update — your order quantity for *${item}* has been updated to *${newQty}*. You'll be informed of the reason shortly. Thank you for your patience.`;
    }

    // ── Send via Twilio ────────────────────────────────────────────────────
    const messageSid = await sendWhatsAppMessage(customerPhone, messageBody);

    console.log(
      `[notify-quantity-change] Done. orderId=${orderId} messageSid=${messageSid}`
    );

    return new Response(
      JSON.stringify({ ok: true, messageSid, messageBody }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error(`[notify-quantity-change] Unhandled error: ${err.message}`);
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
