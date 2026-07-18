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

type ResolvedOrderDraft = OrderDraft & {
  customerName: string;
  item: string;
  quantity: number;
  address: string;
};

type ConversationState = {
  phone: string;
  step: "ask_name" | "ask_order" | "ask_address" | "updating_address";
  partial_data: OrderDraft;
};

type StockDeductionResult = {
  ok: boolean;
  found: boolean;
  deducted: boolean;
  available?: number;
  itemName?: string;
};

type InventoryPreview = {
  item_name: string;
  category: string | null;
  current_stock: number | string | null;
  price_per_unit: number | string | null;
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

function looksLikeMultiItemOrder(message: string) {
  const normalized = message.trim().toLowerCase();
  const commaClauses = normalized
    .split(",")
    .map((clause) => clause.trim())
    .filter(Boolean);

  if (commaClauses.length > 1 && commaClauses.filter((clause) => /\b\d+\b/.test(clause)).length > 1) {
    return true;
  }

  const quantityItemPairs = normalized.match(/\b\d+\s+[a-z][a-z\s-]*?(?=\s+\d+\s+[a-z]|,|$)/gi) ?? [];
  return quantityItemPairs.length > 1;
}

function multiItemOrderMessage() {
  return "For now, please order one item at a time - for example, 'I want 10 candles'. You can place your next item right after this one is confirmed.";
}

function isAddressLookupIntent(message: string) {
  const normalized = message.trim().toLowerCase();
  return (
    /\b(what is|what's|show|tell me|confirm|check)\b.*\bmy\s+address\b/.test(normalized) ||
    /\bmy\s+address\b/.test(normalized) && /\b(on file|saved|registered|stored|have)\b/.test(normalized)
  );
}

function isNameLookupIntent(message: string) {
  const normalized = message.trim().toLowerCase();
  return /\b(what is|what's|show|tell me|confirm|check)\b.*\bmy\s+name\b/.test(normalized);
}

function isAddressUpdateIntent(message: string) {
  const normalized = message.trim().toLowerCase();
  return /\b(change|update|edit|replace|correct)\b.*\bmy\s+address\b/.test(normalized) || /\bi\s+moved\b/.test(normalized);
}

function addressOnFileMessage(customer: Customer | null) {
  if (!customer) return "I don't have a customer profile for this WhatsApp number yet.";
  if (!customer.address) return "I don't have an address on file for you yet.";
  return `Your address on file is: ${customer.address}`;
}

function nameOnFileMessage(customer: Customer | null) {
  if (!customer) return "I don't have a customer profile for this WhatsApp number yet.";
  if (!customer.name) return "I don't have a name on file for you yet.";
  return `Your name on file is: ${customer.name}`;
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

function normalizeInventoryLookup(value: string) {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized.endsWith("ies")) return `${normalized.slice(0, -3)}y`;
  if (/(ses|xes|zes|ches|shes)$/.test(normalized)) return normalized.slice(0, -2);
  if (normalized.endsWith("s") && !normalized.endsWith("ss")) return normalized.slice(0, -1);
  return normalized;
}

async function previewInventoryMatch(item: string): Promise<InventoryPreview | null> {
  const { data, error } = await supabaseAdmin
    .from("inventory")
    .select("item_name, category, current_stock, price_per_unit")
    .order("item_name", { ascending: true });
  if (error) throw error;

  const normalizedItem = item.trim().toLowerCase().replace(/\s+/g, " ");
  const singularItem = normalizeInventoryLookup(item);
  const rows = (data ?? []) as InventoryPreview[];

  return (
    rows.find((row) => row.item_name.trim().toLowerCase().replace(/\s+/g, " ") === normalizedItem) ??
    rows.find((row) => normalizeInventoryLookup(row.item_name) === singularItem) ??
    null
  );
}

async function checkAndDeductStock(item: string, quantity: number): Promise<StockDeductionResult> {
  const normalizedItem = normalizeInventoryLookup(item);
  const inventoryPreview = await previewInventoryMatch(item);
  console.log(
    `[whatsapp-webhook] Stock check starting item="${item}" normalizedItem="${normalizedItem}" quantity=${quantity} inventoryMatch=${
      inventoryPreview ? JSON.stringify(inventoryPreview) : "null"
    }`
  );

  const { data, error } = await supabaseAdmin.rpc("check_and_deduct_inventory", {
    p_item_name: item,
    p_quantity: quantity,
  });
  if (error) throw error;

  const result = data as {
    found?: boolean;
    deducted?: boolean;
    available?: number | string;
    itemName?: string;
  };

  if (!result.found) {
    console.warn(`[whatsapp-webhook] No inventory item found for "${item}". Skipping stock deduction.`);
    return { ok: true, found: false, deducted: false };
  }

  const available = Number(result.available ?? 0);
  return {
    ok: Boolean(result.deducted),
    found: true,
    deducted: Boolean(result.deducted),
    available,
    itemName: result.itemName,
  };
}

function stockLimitMessage(item: string, requested: number, available: number) {
  if (available <= 0) {
    return `Sorry, none of ${item} is available right now, so we can't fulfill an order of ${requested}. The maximum you can currently order is 0.`;
  }
  return `Sorry, we only have ${available} units of ${item} in stock right now, so we can't fulfill an order of ${requested}. You're welcome to place an order for up to ${available} ${item} instead.`;
}

function stockNotFoundMessage(item: string) {
  return `Sorry, I couldn't verify stock for ${item} right now, so I can't place this order yet.`;
}

function deliveryDaysForCategory(category: string | null | undefined) {
  switch ((category ?? "").trim().toLowerCase()) {
    case "groceries":
    case "toiletries":
      return 2;
    case "electronics":
      return 5;
    case "stationery":
      return 0;
    default:
      return 3;
  }
}

function estimateDeliveryDateForCategory(category: string | null | undefined, from = new Date()) {
  const istDate = new Date(from.getTime() + 5.5 * 60 * 60 * 1000);
  istDate.setUTCDate(istDate.getUTCDate() + deliveryDaysForCategory(category));
  return istDate.toISOString().slice(0, 10);
}

function formatMoney(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function orderConfirmationMessage(quantity: number, item: string, pricePerUnit: number | null, estimatedDeliveryDate: string) {
  if (pricePerUnit === null || !Number.isFinite(pricePerUnit)) {
    return `Order confirmed: ${quantity} ${item}. Estimated delivery: ${formatDate(estimatedDeliveryDate)}.`;
  }

  const total = pricePerUnit * quantity;
  return `Order confirmed: ${quantity} ${item} — ₹${formatMoney(pricePerUnit)} x ${quantity} = ₹${formatMoney(total)}. Estimated delivery: ${formatDate(estimatedDeliveryDate)}.`;
}

async function checkStockAndDeductForConfirmation(phone: string, draft: ResolvedOrderDraft) {
  const stockResult = await checkAndDeductStock(draft.item, draft.quantity);

  if (!stockResult.found) {
    await sendWhatsAppMessage(phone, stockNotFoundMessage(draft.item));
    return { canConfirm: false, itemName: draft.item };
  }

  const matchedItem = stockResult.itemName ?? draft.item;
  if (!stockResult.deducted) {
    const available = stockResult.available ?? 0;
    await sendWhatsAppMessage(phone, stockLimitMessage(matchedItem, draft.quantity, available));
    console.log(`[whatsapp-webhook] Stock rejected item=${matchedItem} requested=${draft.quantity} available=${available}`);
    return { canConfirm: false, itemName: matchedItem };
  }

  console.log(`[whatsapp-webhook] Stock deducted item=${matchedItem} quantity=${draft.quantity}`);
  return { canConfirm: true, itemName: matchedItem };
}

async function processResolvedOrder(phone: string, draft: ResolvedOrderDraft, rawMessage: string) {
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
    (order: any) => order.status !== "flagged" && !String(order.status ?? "").startsWith("rejected") && order.flagged !== true
  );
  const average =
    baselineOrders.length > 0
      ? baselineOrders.reduce((sum: number, order: any) => sum + Number(order.quantity), 0) / baselineOrders.length
      : null;
  const isFlagged = average !== null && baselineOrders.length >= 1 && (draft.quantity > average * 2 || draft.quantity < average * 0.5);
  const flagReason = isFlagged
    ? `Unusual quantity for ${draft.item}: ${draft.quantity} vs average ${average!.toFixed(1)}`
    : null;

  if (!isFlagged) {
    const stockDecision = await checkStockAndDeductForConfirmation(phone, draft);
    if (!stockDecision.canConfirm) {
      return;
    }
    draft.item = stockDecision.itemName;
  }

  const inventoryItem = await previewInventoryMatch(draft.item);
  const estimatedDeliveryDate = estimateDeliveryDateForCategory(inventoryItem?.category);
  const pricePerUnit =
    inventoryItem?.price_per_unit === null || inventoryItem?.price_per_unit === undefined
      ? null
      : Number(inventoryItem.price_per_unit);
  const status = isFlagged ? "flagged" : "confirmed";
  const { data: order, error: orderErr } = await supabaseAdmin
    .from("orders")
    .insert({
      customer_id: customer.id,
      raw_message: rawMessage,
      item: draft.item,
      quantity: draft.quantity,
      flagged: isFlagged,
      flag_reason: flagReason,
      status,
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
      orderConfirmationMessage(draft.quantity, draft.item, pricePerUnit, estimatedDeliveryDate)
    );
  }

  console.log(`[whatsapp-webhook] Processed orderId=${order.id} flagged=${isFlagged}`);
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

  if (command === "APPROVE") {
    const stockResult = await checkAndDeductStock(String(order.item), Number(order.quantity));
    const matchedItem = stockResult.itemName ?? String(order.item);
    let approvedConfirmationMessage = `Order confirmed: ${order.quantity} ${matchedItem}.`;

    if (!stockResult.found) {
      return stockNotFoundMessage(String(order.item));
    }

    if (!stockResult.deducted) {
      const { error: updateErr } = await supabaseAdmin
        .from("orders")
        .update({ status: "rejected_out_of_stock" })
        .eq("id", order.id);
      if (updateErr) throw updateErr;
      return stockLimitMessage(matchedItem, Number(order.quantity), stockResult.available ?? 0);
    }

    const inventoryItem = await previewInventoryMatch(matchedItem);
    const estimatedDeliveryDate = estimateDeliveryDateForCategory(inventoryItem?.category);
    const pricePerUnit =
      inventoryItem?.price_per_unit === null || inventoryItem?.price_per_unit === undefined
        ? null
        : Number(inventoryItem.price_per_unit);
    approvedConfirmationMessage = orderConfirmationMessage(
      Number(order.quantity),
      matchedItem,
      pricePerUnit,
      estimatedDeliveryDate
    );
    console.log(`[whatsapp-webhook] Stock deducted item=${matchedItem} quantity=${Number(order.quantity)} for approved orderId=${order.id}`);

    const { error: approvedUpdateErr } = await supabaseAdmin
      .from("orders")
      .update({
        item: matchedItem,
        estimated_delivery_date: estimatedDeliveryDate,
      })
      .eq("id", order.id);
    if (approvedUpdateErr) throw approvedUpdateErr;

    const nextStatus = "approved";
    const { error: updateErr } = await supabaseAdmin.from("orders").update({ status: nextStatus }).eq("id", order.id);
    if (updateErr) throw updateErr;
    return approvedConfirmationMessage;
  }

  const nextStatus = "rejected";
  const { error: updateErr } = await supabaseAdmin.from("orders").update({ status: nextStatus }).eq("id", order.id);
  if (updateErr) throw updateErr;

  return `Order rejected: ${order.quantity} ${order.item}.`;
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
    if (existingState?.step === "updating_address") {
      if (!looksLikeAddress(message)) {
        await saveConversation(phone, "updating_address", draft);
        return twiml("Please send your full new address, including enough detail for delivery.");
      }

      const addressCustomer = customer ?? (await getOrCreateCustomer(phone, draft.customerName ?? "Customer"));
      await setCustomerAddress(addressCustomer.id, message);
      await clearConversation(phone);
      return twiml(`Thanks, your address has been updated to: ${message}`);
    }

    if (isAddressLookupIntent(message)) {
      return twiml(addressOnFileMessage(customer));
    }

    if (isNameLookupIntent(message)) {
      return twiml(nameOnFileMessage(customer));
    }

    if (isAddressUpdateIntent(message)) {
      await saveConversation(phone, "updating_address", { customerName: customer?.name });
      return twiml("Sure, please send your new full delivery address.");
    }

    if (existingState?.step === "ask_name") {
      draft.customerName = cleanName(message);
    } else if (existingState?.step === "ask_address") {
      if (!looksLikeAddress(message)) {
        await saveConversation(phone, "ask_address", draft);
        return twiml("Please share your full delivery address so we can complete the order.");
      }
      draft.address = message;
    } else {
      if (looksLikeMultiItemOrder(message)) {
        return twiml(multiItemOrderMessage());
      }

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
      if (existingState?.step === "ask_order" && looksLikeMultiItemOrder(message)) {
        return twiml(multiItemOrderMessage());
      }

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
