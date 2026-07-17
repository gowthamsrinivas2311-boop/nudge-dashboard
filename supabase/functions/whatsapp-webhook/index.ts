import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Customer = {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
};

type OrderDraft = {
  customerName?: string;
  item?: string;
  quantity?: number;
  address?: string;
};

type ConversationState = {
  phone: string;
  step: "ask_name" | "ask_order" | "ask_address";
  partial_data: OrderDraft;
};

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

function twiml(message: string) {
  return new Response(`<Response><Message>${escapeXml(message)}</Message></Response>`, {
    headers: { ...corsHeaders, "Content-Type": "text/xml" },
  });
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function sendWhatsAppMessage(to: string, body: string) {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const from = Deno.env.get("TWILIO_WHATSAPP_FROM") ?? "whatsapp:+14155238886";
  const toNumber = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;

  const params = new URLSearchParams({ To: toNumber, From: from, Body: body });
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

  const responseText = await response.text();
  const json = responseText ? JSON.parse(responseText) : {};
  if (!response.ok) {
    throw new Error(`Twilio error: ${json.message ?? JSON.stringify(json)}`);
  }

  console.log(`[whatsapp-webhook] WhatsApp sent. SID=${json.sid} to=${toNumber}`);
}

function normalizePhone(phone: string) {
  return phone.trim();
}

function isOrderIntent(message: string) {
  return /\b(order|place an order|buy|purchase|need|want)\b/i.test(message);
}

function looksLikeAddress(message: string) {
  const value = message.trim();
  return value.length >= 12 && /[a-zA-Z]{3,}/.test(value) && /[\d,/-]|\b(street|road|lane|nagar|apt|apartment|block|sector|city)\b/i.test(value);
}

function cleanName(message: string) {
  return message
    .replace(/^(my name is|i am|i'm|this is)\s+/i, "")
    .trim()
    .replace(/[.!,]+$/g, "");
}

async function extractOrderData(message: string): Promise<OrderDraft & { hasOrderIntent: boolean }> {
  const groqApiKey = Deno.env.get("GROQ_API_KEY")!;
  const fallback = heuristicExtractOrder(message);

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0,
        max_tokens: 180,
        messages: [
          {
            role: "system",
            content:
              "Extract WhatsApp order details. Return only compact JSON with keys: hasOrderIntent boolean, customerName string|null, item string|null, quantity number|null. If the user only expresses intent to order, set hasOrderIntent true and leave missing fields null.",
          },
          { role: "user", content: message },
        ],
      }),
    });

    const responseText = await response.text();
    const json = responseText ? JSON.parse(responseText) : {};
    if (!response.ok) throw new Error(json.error?.message ?? JSON.stringify(json));
    const content = json.choices?.[0]?.message?.content?.trim() ?? "{}";
    const parsed = JSON.parse(content.replace(/^```json\s*/i, "").replace(/```$/i, ""));

    return {
      hasOrderIntent: Boolean(parsed.hasOrderIntent) || fallback.hasOrderIntent,
      customerName: parsed.customerName || fallback.customerName,
      item: parsed.item || fallback.item,
      quantity: Number(parsed.quantity) || fallback.quantity,
    };
  } catch (err) {
    console.error(`[whatsapp-webhook] Groq extraction failed, using heuristic: ${(err as Error).message}`);
    return fallback;
  }
}

function heuristicExtractOrder(message: string): OrderDraft & { hasOrderIntent: boolean } {
  const normalized = message.trim();
  const wantsMatch = normalized.match(/^(.+?)\s+wants?\s+(\d+)\s+(.+)$/i);
  const qtyItemMatch = normalized.match(/\b(?:order|buy|need|want)\s+(\d+)\s+(.+)$/i);
  const plainQtyItemMatch = normalized.match(/^(\d+)\s+(.+)$/i);

  if (wantsMatch) {
    return {
      hasOrderIntent: true,
      customerName: wantsMatch[1].trim(),
      quantity: Number(wantsMatch[2]),
      item: wantsMatch[3].trim(),
    };
  }

  if (qtyItemMatch) {
    return {
      hasOrderIntent: true,
      quantity: Number(qtyItemMatch[1]),
      item: qtyItemMatch[2].trim(),
    };
  }

  if (plainQtyItemMatch) {
    return {
      hasOrderIntent: true,
      quantity: Number(plainQtyItemMatch[1]),
      item: plainQtyItemMatch[2].trim(),
    };
  }

  return { hasOrderIntent: isOrderIntent(normalized) };
}

async function getCustomerByPhone(phone: string): Promise<Customer | null> {
  const { data, error } = await supabaseAdmin
    .from("customers")
    .select("id, name, phone, address")
    .eq("phone", phone)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data as Customer | null;
}

async function getOrCreateCustomer(phone: string, name: string, address?: string): Promise<Customer> {
  const existing = await getCustomerByPhone(phone);
  if (existing) {
    const updates: Partial<Customer> = {};
    if (!existing.name && name) updates.name = name;
    if (!existing.address && address) updates.address = address;

    if (Object.keys(updates).length > 0) {
      const { data, error } = await supabaseAdmin
        .from("customers")
        .update(updates)
        .eq("id", existing.id)
        .select("id, name, phone, address")
        .single();
      if (error) throw error;
      return data as Customer;
    }

    return existing;
  }

  const { data, error } = await supabaseAdmin
    .from("customers")
    .insert({ name, phone, address: address ?? null })
    .select("id, name, phone, address")
    .single();

  if (error) throw error;
  return data as Customer;
}

async function saveConversation(phone: string, step: ConversationState["step"], partialData: OrderDraft) {
  const { error } = await supabaseAdmin.from("conversation_state").upsert({
    phone,
    step,
    partial_data: partialData,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function getConversation(phone: string): Promise<ConversationState | null> {
  const { data, error } = await supabaseAdmin
    .from("conversation_state")
    .select("phone, step, partial_data")
    .eq("phone", phone)
    .maybeSingle();
  if (error) throw error;
  return data as ConversationState | null;
}

async function clearConversation(phone: string) {
  const { error } = await supabaseAdmin.from("conversation_state").delete().eq("phone", phone);
  if (error) throw error;
}

async function setCustomerAddress(customerId: number, address: string) {
  const { error } = await supabaseAdmin.from("customers").update({ address }).eq("id", customerId);
  if (error) throw error;
}

async function processResolvedOrder(phone: string, draft: Required<OrderDraft>, rawMessage: string) {
  const customer = await getOrCreateCustomer(phone, draft.customerName, draft.address);
  if (!customer.address) await setCustomerAddress(customer.id, draft.address);

  const { data: history, error: historyErr } = await supabaseAdmin
    .from("orders")
    .select("quantity, status, flagged")
    .eq("customer_id", customer.id)
    .ilike("item", draft.item)
    .order("created_at", { ascending: true });
  if (historyErr) throw historyErr;

  const baselineOrders = (history ?? []).filter(
    (order: any) => order.status !== "flagged" && order.status !== "rejected" && order.flagged !== true
  );
  const average =
    baselineOrders.length > 0
      ? baselineOrders.reduce((sum: number, order: any) => sum + Number(order.quantity), 0) / baselineOrders.length
      : null;
  const isFlagged = average !== null && baselineOrders.length >= 1 && (draft.quantity > average * 2 || draft.quantity < average * 0.5);
  const flagReason = isFlagged
    ? `Unusual quantity for ${draft.item}: ${draft.quantity} vs average ${average!.toFixed(1)}`
    : null;
  const estimatedDeliveryDate = estimateDeliveryDate(draft.item);

  const { data: order, error: orderErr } = await supabaseAdmin
    .from("orders")
    .insert({
      customer_id: customer.id,
      raw_message: rawMessage,
      item: draft.item,
      quantity: draft.quantity,
      flagged: isFlagged,
      flag_reason: flagReason,
      status: isFlagged ? "flagged" : "confirmed",
      estimated_delivery_date: estimatedDeliveryDate,
    })
    .select("id")
    .single();
  if (orderErr) throw orderErr;

  if (isFlagged) {
    await sendWhatsAppMessage(
      phone,
      `This order looks unusual compared with the customer's usual pattern and has been flagged for review. Reply APPROVE, REJECT, or WHY.`
    );
  } else {
    await sendWhatsAppMessage(
      phone,
      `Order confirmed: ${draft.quantity} ${draft.item}. Estimated delivery: ${formatDate(estimatedDeliveryDate)}.`
    );
  }

  console.log(`[whatsapp-webhook] Processed orderId=${order.id} flagged=${isFlagged}`);
}

function estimateDeliveryDate(item: string) {
  const days = /electronics/i.test(item) ? 5 : /stationery|office/i.test(item) ? 3 : 2;
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDate(dateString: string) {
  return new Date(`${dateString}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

async function handleStatusCommand(phone: string, message: string) {
  const command = message.trim().toUpperCase();
  if (!["APPROVE", "REJECT", "WHY"].includes(command)) return null;

  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("id, item, quantity, flag_reason, status, customers(phone)")
    .eq("status", "flagged")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!order) return "No flagged order is waiting for review.";

  if (command === "WHY") {
    return order.flag_reason || "This order was flagged because it differs from the customer's usual order pattern.";
  }

  const nextStatus = command === "APPROVE" ? "approved" : "rejected";
  const { error: updateErr } = await supabaseAdmin.from("orders").update({ status: nextStatus }).eq("id", order.id);
  if (updateErr) throw updateErr;

  return command === "APPROVE"
    ? `Order approved: ${order.quantity} ${order.item}.`
    : `Order rejected: ${order.quantity} ${order.item}.`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const formData = await req.formData();
    const phone = normalizePhone(String(formData.get("From") ?? ""));
    const message = String(formData.get("Body") ?? "").trim();

    if (!phone || !message) return twiml("Sorry, I couldn't read that message. Please try again.");

    const statusReply = await handleStatusCommand(phone, message);
    if (statusReply) return twiml(statusReply);

    const existingState = await getConversation(phone);
    const customer = await getCustomerByPhone(phone);
    let draft: OrderDraft = { ...(existingState?.partial_data ?? {}) };

    if (existingState?.step === "ask_name") {
      draft.customerName = cleanName(message);
    } else if (existingState?.step === "ask_address") {
      if (!looksLikeAddress(message)) {
        await saveConversation(phone, "ask_address", draft);
        return twiml("Please share your full delivery address so we can complete the order.");
      }
      draft.address = message;
    } else {
      const extracted = await extractOrderData(message);
      draft = {
        ...draft,
        customerName: draft.customerName ?? extracted.customerName ?? customer?.name,
        item: draft.item ?? extracted.item,
        quantity: draft.quantity ?? extracted.quantity,
        address: draft.address ?? customer?.address ?? undefined,
      };

      if (!extracted.hasOrderIntent && !draft.item && !draft.quantity) {
        return twiml("Hi! Just tell us what you'd like to order and we'll take it from there.");
      }
    }

    if (!draft.customerName) {
      await saveConversation(phone, "ask_name", draft);
      return twiml("Sure, I can help with your order. May I have your name?");
    }

    if (!draft.item || !draft.quantity) {
      const extracted = existingState?.step === "ask_order" ? await extractOrderData(message) : null;
      draft.item = draft.item ?? extracted?.item;
      draft.quantity = draft.quantity ?? extracted?.quantity;

      if (!draft.item || !draft.quantity) {
        await saveConversation(phone, "ask_order", draft);
        return twiml(`Thanks ${draft.customerName}. What item and quantity would you like to order?`);
      }
    }

    if (!draft.address) {
      await saveConversation(phone, "ask_address", draft);
      return twiml("Please share your delivery address for this order.");
    }

    await processResolvedOrder(phone, draft as Required<OrderDraft>, message);
    await clearConversation(phone);
    return new Response("<Response></Response>", {
      headers: { ...corsHeaders, "Content-Type": "text/xml" },
    });
  } catch (err) {
    const error = err as Error;
    console.error(
      `[whatsapp-webhook] Unhandled error processing ${req.method} ${new URL(req.url).pathname}: ${
        error.stack ?? error.message
      }`
    );
    return twiml("Sorry, something went wrong while processing your message. Please try again.");
  }
});
