import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { supabase } from "../supabaseClient";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import PatternStrip from "./PatternStrip";

interface Customer {
  name: string;
  address: string | null;
}

interface Order {
  id: number;
  customer_id: number;
  raw_message: string;
  item: string;
  quantity: number;
  flagged: boolean;
  flag_reason: string;
  status: string;
  created_at: string;
  estimated_delivery_date: string | null;
  customers: Customer | null;
}

interface InventoryItem {
  item_name: string;
  category: string | null;
  current_stock: number;
  price_per_unit: number | null;
}

type DashboardView = "feed" | "insights" | "tracking" | "inventory";

const dashboardViews: DashboardView[] = ["feed", "insights", "tracking", "inventory"];
const lowStockThreshold = 10;
const customerStatusMeta = {
  reviewHistory: {
    label: "Review history",
    color: "var(--rust)",
  },
  clear: {
    label: "Clear",
    color: "var(--ledger-teal)",
  },
} as const;

const isConfirmedOrApprovedStatus = (status: string | null | undefined) =>
  Boolean(status?.startsWith("confirmed") || status === "approved");

const getDashboardViewLabel = (view: DashboardView) => {
  if (view === "feed") return "LIVE FEED";
  if (view === "insights") return "INSIGHTS";
  if (view === "tracking") return "TRACKING";
  return "INVENTORY";
};

const isMeaningfulReason = (reason: string) => {
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return true;

  const words = normalized.match(/[a-z]{3,}/g) ?? [];
  const uniqueWords = new Set(words);
  const hasReasonCue =
    /\b(customer|client|requested|asked|stock|inventory|available|availability|shortage|supply|warehouse|delivery|duplicate|mistake|error|typo|correction|changed|adjusted|limit|space|damaged|expired|packed|dispatch|vendor|supplier)\b/.test(
      normalized
    );
  const repeatedChunk = /^([a-z]{2,6})\1{2,}$/.test(normalized.replace(/[^a-z]/g, ""));

  return (
    normalized.length >= 12 &&
    words.length >= 3 &&
    uniqueWords.size >= 2 &&
    hasReasonCue &&
    !repeatedChunk
  );
};

const areOrdersEqual = (current: Order[], next: Order[]) => {
  if (current.length !== next.length) return false;

  return current.every((order, index) => {
    const nextOrder = next[index];

    return (
      order.id === nextOrder.id &&
      order.customer_id === nextOrder.customer_id &&
      order.raw_message === nextOrder.raw_message &&
      order.item === nextOrder.item &&
      order.quantity === nextOrder.quantity &&
      order.flagged === nextOrder.flagged &&
      order.flag_reason === nextOrder.flag_reason &&
      order.status === nextOrder.status &&
      order.created_at === nextOrder.created_at &&
      order.estimated_delivery_date === nextOrder.estimated_delivery_date &&
      (order.customers?.name || "") === (nextOrder.customers?.name || "") &&
      (order.customers?.address || "") === (nextOrder.customers?.address || "")
    );
  });
};

const areInventoryItemsEqual = (current: InventoryItem[], next: InventoryItem[]) => {
  if (current.length !== next.length) return false;

  return current.every((item, index) => {
    const nextItem = next[index];
    return (
      item.item_name === nextItem.item_name &&
      item.category === nextItem.category &&
      Number(item.current_stock) === Number(nextItem.current_stock) &&
      Number(item.price_per_unit ?? 0) === Number(nextItem.price_per_unit ?? 0)
    );
  });
};

interface CustomerSummary {
  id: number;
  name: string;
  address: string | null;
  count: number;
  hasFlagged: boolean;
  latestOrderAt: string;
  latestFlaggedAt: string | null;
}

interface CustomerDistributionDatum {
  id: number;
  name: string;
  count: number;
  percentage: number;
  fill: string;
}

/* ── Recharts custom tooltip ── */
const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    const isFlagged = data.status === "flagged" || data.status === "rejected";
    return (
      <div
        style={{
          background: "var(--ledger-panel)",
          border: "1px solid var(--rule)",
          borderRadius: 4,
          padding: "8px 12px",
          fontSize: 12,
          color: "var(--parchment)",
        }}
      >
        <p style={{ color: "var(--muted)", margin: 0 }} className="font-mono-num">
          Order #{data.sequence}
        </p>
        <p style={{ margin: "4px 0 0", fontWeight: 600 }}>
          Qty: <span className="font-mono-num" style={{ color: "var(--brass)" }}>{data.quantity}</span>
        </p>
        <p className="font-mono-num" style={{ color: "var(--muted)", margin: "4px 0 0", fontSize: 10 }}>
          {data.date}
        </p>
        <p style={{ margin: "6px 0 0" }}>
          <span
            className="font-mono-num"
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: isFlagged ? "var(--rust)" : "var(--ledger-teal)",
            }}
          >
            {data.status === "flagged"
              ? "FLAGGED"
              : data.status === "approved"
              ? "APPROVED"
              : data.status === "rejected"
              ? "REJECTED"
              : "CONFIRMED"}
          </span>
        </p>
        {data.status === "flagged" && data.flag_reason && (
          <p style={{ color: "var(--rust)", fontSize: 10, fontStyle: "italic", margin: "6px 0 0", maxWidth: 180 }}>
            {data.flag_reason}
          </p>
        )}
      </div>
    );
  }
  return null;
};

export default function OrderFeed() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "confirmed" | "flagged">("all");
  const [dashboardView, setDashboardView] = useState<DashboardView>("feed");
  const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
  const [hasOpenedWhatsApp, setHasOpenedWhatsApp] = useState(
    () => localStorage.getItem("nudge-whatsapp-opened") === "true"
  );

  // Track newly added order IDs for sweep animation
  const [newOrderIds, setNewOrderIds] = useState<Set<number>>(new Set());

  // Customer selection & history states
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [customerHistory, setCustomerHistory] = useState<Order[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [trackingOrders, setTrackingOrders] = useState<Order[]>([]);
  const [loadingTrackingOrders, setLoadingTrackingOrders] = useState(false);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [loadingInventory, setLoadingInventory] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [globalStats, setGlobalStats] = useState({ totalProcessed: 0, totalFlagged: 0, uniqueCustomers: 0 });
  const [loadingGlobalStats, setLoadingGlobalStats] = useState(true);

  // Delete order state
  const [deleteTargetOrder, setDeleteTargetOrder] = useState<Order | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Modify Quantity state
  const [modifyTargetOrder, setModifyTargetOrder] = useState<Order | null>(null);
  const [modifyQty, setModifyQty] = useState("");
  const [modifyReason, setModifyReason] = useState("");
  const [modifyLoading, setModifyLoading] = useState(false);
  const [modifyError, setModifyError] = useState<string | null>(null);

  // All orders for PatternStrip lookups (keyed by customer_id)
  const [allOrdersByCustomer, setAllOrdersByCustomer] = useState<Map<number, Order[]>>(new Map());

  const selectedCustomerIdRef = useRef<number | null>(null);
  useEffect(() => {
    selectedCustomerIdRef.current = selectedCustomerId;
  }, [selectedCustomerId]);

  const whatsAppOrderUrl =
    "https://wa.me/+14155238886?text=Hi%2C%20I%20want%20to%20place%20an%20order";
  const whatsappJoinCode = "join middle-past";
  const placeOrderButtonRef = useRef<HTMLButtonElement | null>(null);
  const orderModalRef = useRef<HTMLDivElement | null>(null);

  const handleOpenWhatsApp = useCallback((rememberJoinClick = false) => {
    if (rememberJoinClick) {
      localStorage.setItem("nudge-whatsapp-opened", "true");
      setHasOpenedWhatsApp(true);
    }
    window.open(whatsAppOrderUrl, "_blank");
  }, []);

  const closeOrderModal = useCallback(() => {
    setIsOrderModalOpen(false);
    window.setTimeout(() => placeOrderButtonRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!isOrderModalOpen) return;

    const focusableSelector =
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const modal = orderModalRef.current;
    const focusable = Array.from(modal?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
    focusable[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeOrderModal();
        return;
      }

      if (event.key !== "Tab" || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeOrderModal, isOrderModalOpen]);

  // Clear new order IDs after animation completes
  useEffect(() => {
    if (newOrderIds.size > 0) {
      const timer = setTimeout(() => {
        setNewOrderIds(new Set());
      }, 1500); // Wait long enough for the sweep animation
      return () => clearTimeout(timer);
    }
  }, [newOrderIds]);

  // Fetch initial orders on mount
  useEffect(() => {
    let active = true;

    async function fetchOrders(showLoading = true) {
      try {
        if (showLoading) setLoading(true);
        const { data, error } = await supabase
          .from("orders")
          .select(`
            id,
            customer_id,
            raw_message,
            item,
            quantity,
            flagged,
            flag_reason,
            status,
            created_at,
            estimated_delivery_date,
            customers (
              name,
              address
            )
          `)
          .order("created_at", { ascending: false })
          .limit(50);

        if (error) throw error;
        if (active) {
          const nextOrders = (data as unknown as Order[]) || [];
          setOrders((currentOrders) =>
            areOrdersEqual(currentOrders, nextOrders) ? currentOrders : nextOrders
          );
        }
      } catch (err: any) {
        if (active) {
          setError(err.message || "Failed to fetch orders");
        }
      } finally {
        if (active) {
          if (showLoading) setLoading(false);
        }
      }
    }

    fetchOrders();
    const intervalId = window.setInterval(() => {
      fetchOrders(false);
    }, 3000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  // Fetch chronological history when a customer is selected
  useEffect(() => {
    if (selectedCustomerId === null) {
      setCustomerHistory([]);
      return;
    }

    let active = true;
    async function fetchHistory(showLoading = true) {
      try {
        if (showLoading) setLoadingHistory(true);
        const { data, error } = await supabase
          .from("orders")
          .select(`
            id,
            customer_id,
            raw_message,
            item,
            quantity,
            flagged,
            flag_reason,
            status,
            created_at,
            estimated_delivery_date
          `)
          .eq("customer_id", selectedCustomerId)
          .order("created_at", { ascending: true });

        if (error) throw error;
        if (active) {
          const nextHistory = (data as unknown as Order[]) || [];
          setCustomerHistory((currentHistory) =>
            areOrdersEqual(currentHistory, nextHistory) ? currentHistory : nextHistory
          );
        }
      } catch (err) {
        console.error("Error fetching customer history:", err);
      } finally {
        if (active) {
          if (showLoading) setLoadingHistory(false);
        }
      }
    }

    fetchHistory();
    const intervalId = window.setInterval(() => {
      fetchHistory(false);
    }, 3000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [selectedCustomerId]);

  useEffect(() => {
    if (dashboardView !== "tracking" || selectedCustomerId === null) {
      setTrackingOrders([]);
      return;
    }

    let active = true;
    async function fetchTrackingOrders(showLoading = true) {
      try {
        if (showLoading) setLoadingTrackingOrders(true);
        const { data, error } = await supabase
          .from("orders")
          .select(`
            id,
            customer_id,
            raw_message,
            item,
            quantity,
            flagged,
            flag_reason,
            status,
            created_at,
            estimated_delivery_date
          `)
          .eq("customer_id", selectedCustomerId)
          .or("status.like.confirmed%,status.eq.approved")
          .order("created_at", { ascending: false });

        if (error) throw error;
        if (active) {
          const nextTrackingOrders = (data as unknown as Order[]) || [];
          setTrackingOrders((currentTrackingOrders) =>
            areOrdersEqual(currentTrackingOrders, nextTrackingOrders)
              ? currentTrackingOrders
              : nextTrackingOrders
          );
        }
      } catch (err) {
        console.error("Error fetching tracking orders:", err);
      } finally {
        if (active) {
          if (showLoading) setLoadingTrackingOrders(false);
        }
      }
    }

    fetchTrackingOrders();
    const intervalId = window.setInterval(() => {
      fetchTrackingOrders(false);
    }, 3000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [dashboardView, selectedCustomerId]);

  useEffect(() => {
    if (dashboardView !== "inventory") return;

    let active = true;
    async function fetchInventory(showLoading = true) {
      try {
        if (showLoading) setLoadingInventory(true);
        setInventoryError(null);

        const { data, error } = await supabase
          .from("inventory")
          .select("item_name, category, current_stock, price_per_unit")
          .order("category", { ascending: true, nullsFirst: false })
          .order("current_stock", { ascending: true });

        if (error) throw error;
        if (active) {
          const nextInventory = (data as unknown as InventoryItem[]) || [];
          setInventoryItems((currentInventory) =>
            areInventoryItemsEqual(currentInventory, nextInventory) ? currentInventory : nextInventory
          );
        }
      } catch (err: any) {
        if (active) {
          setInventoryError(err.message || "Failed to fetch inventory");
        }
      } finally {
        if (active) {
          if (showLoading) setLoadingInventory(false);
        }
      }
    }

    fetchInventory();
    const intervalId = window.setInterval(() => {
      fetchInventory(false);
    }, 3000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [dashboardView]);

  // Compute distinct customers list and global order stats reactively
  useEffect(() => {
    async function fetchGlobalData() {
      try {
        setLoadingGlobalStats(true);
        const { data, error } = await supabase
          .from("orders")
          .select("id, customer_id, item, quantity, status, flag_reason, flagged, created_at, estimated_delivery_date, customers(name, address)");
        if (error) throw error;

        let totalProcessed = 0;
        let totalFlagged = 0;
        const customerMap = new Map<
          number,
          {
            name: string;
            address: string | null;
            count: number;
            hasFlagged: boolean;
            latestOrderAt: string;
            latestFlaggedAt: string | null;
          }
        >();
        const ordersByCustomer = new Map<number, Order[]>();

        data?.forEach((row: any) => {
          totalProcessed++;
          if (row.status === "flagged") totalFlagged++;

          if (row.customer_id) {
            const name = row.customers?.name || "Unknown Customer";
            const address = row.customers?.address || null;
            const isFlaggedOrder =
              row.flagged === true ||
              row.status === "flagged" ||
              row.status === "approved" ||
              row.status === "rejected";
            const current = customerMap.get(row.customer_id) || {
              name,
              address,
              count: 0,
              hasFlagged: false,
              latestOrderAt: row.created_at,
              latestFlaggedAt: null,
            };
            const rowTime = new Date(row.created_at).getTime();
            const currentLatestTime = new Date(current.latestOrderAt).getTime();
            const currentLatestFlaggedTime = current.latestFlaggedAt
              ? new Date(current.latestFlaggedAt).getTime()
              : 0;

            customerMap.set(row.customer_id, {
              name,
              address: current.address || address,
              count: current.count + 1,
              hasFlagged: current.hasFlagged || isFlaggedOrder,
              latestOrderAt: rowTime > currentLatestTime ? row.created_at : current.latestOrderAt,
              latestFlaggedAt:
                isFlaggedOrder && rowTime > currentLatestFlaggedTime
                  ? row.created_at
                  : current.latestFlaggedAt,
            });

            // Build per-customer order list for PatternStrip
            if (!ordersByCustomer.has(row.customer_id)) {
              ordersByCustomer.set(row.customer_id, []);
            }
            ordersByCustomer.get(row.customer_id)!.push(row as Order);
          }
        });

        const list = Array.from(customerMap.entries())
          .map(([id, val]) => ({
            id,
            name: val.name,
            address: val.address,
            count: val.count,
            hasFlagged: val.hasFlagged,
            latestOrderAt: val.latestOrderAt,
            latestFlaggedAt: val.latestFlaggedAt,
          }))
          .sort((a, b) => {
            if (a.hasFlagged !== b.hasFlagged) return a.hasFlagged ? -1 : 1;
            const aSortTime = new Date(a.hasFlagged ? a.latestFlaggedAt || a.latestOrderAt : a.latestOrderAt).getTime();
            const bSortTime = new Date(b.hasFlagged ? b.latestFlaggedAt || b.latestOrderAt : b.latestOrderAt).getTime();
            return bSortTime - aSortTime;
          });

        setCustomers(list);
        setAllOrdersByCustomer(ordersByCustomer);
        setGlobalStats({
          totalProcessed,
          totalFlagged,
          uniqueCustomers: list.length,
        });
      } catch (err) {
        console.error("Error building global data:", err);
      } finally {
        setLoadingGlobalStats(false);
      }
    }

    fetchGlobalData();
  }, [orders]);

  // ── Delete an order ────────────────────────────────────────────────────
  const handleDeleteOrder = useCallback(async (orderId: number) => {
    setDeleteLoading(true);
    const { error: deleteErr } = await supabase
      .from("orders")
      .delete()
      .eq("id", orderId);

    if (deleteErr) {
      console.error("[delete-order] Failed:", deleteErr);
      alert(`Failed to delete order: ${deleteErr.message}`);
      setDeleteLoading(false);
      return;
    }

    console.log(`[delete-order] Deleted orderId=${orderId}`);
    setOrders((prev) => prev.filter((o) => o.id !== orderId));
    setCustomerHistory((prev) => prev.filter((o) => o.id !== orderId));
    setDeleteTargetOrder(null);
    setDeleteLoading(false);
  }, []);

  // ── Open Modify modal ───────────────────────────────────────────────────
  const openModifyModal = useCallback((order: Order) => {
    setModifyTargetOrder(order);
    setModifyQty(String(order.quantity));
    setModifyReason("");
    setModifyError(null);
  }, []);

  // ── Save quantity change + trigger WhatsApp notification ────────────────
  const handleModifyQuantity = useCallback(async () => {
    if (!modifyTargetOrder) return;

    const newQty = parseInt(modifyQty, 10);
    if (!modifyQty || isNaN(newQty) || newQty < 1) {
      setModifyError("Please enter a valid quantity (minimum 1).");
      return;
    }

    const trimmedReason = modifyReason.trim();
    if (trimmedReason.length > 0 && !isMeaningfulReason(trimmedReason)) {
      setModifyError("Please enter a real reason, or leave it blank.");
      return;
    }

    setModifyLoading(true);
    setModifyError(null);

    const orderId = modifyTargetOrder.id;
    const prevQty = modifyTargetOrder.quantity;

    // Optimistic update
    const applyQtyUpdate = (prev: Order[]) =>
      prev.map((o) => (o.id === orderId ? { ...o, quantity: newQty } : o));
    setOrders(applyQtyUpdate);
    setCustomerHistory(applyQtyUpdate);

    // Persist to DB
    const { error: updateErr } = await supabase
      .from("orders")
      .update({ quantity: newQty })
      .eq("id", orderId);

    if (updateErr) {
      console.error("[modify-quantity] DB update failed:", updateErr);
      const revert = (prev: Order[]) =>
        prev.map((o) => (o.id === orderId ? { ...o, quantity: prevQty } : o));
      setOrders(revert);
      setCustomerHistory(revert);
      setModifyError(`Failed to save: ${updateErr.message}`);
      setModifyLoading(false);
      return;
    }

    console.log(`[modify-quantity] Updated orderId=${orderId} quantity=${prevQty}->${newQty}`);

    // Call edge function for AI rewrite + Twilio send
    const customerName =
      modifyTargetOrder.customers?.name ||
      customers.find((c) => c.id === modifyTargetOrder.customer_id)?.name ||
      "Customer";

    try {
      const { data: fnData, error: fnErr } = await supabase.functions.invoke(
        "notify-quantity-change",
        {
          body: {
            orderId,
            newQty,
            reason: trimmedReason,
            item: modifyTargetOrder.item,
            customerName,
          },
        }
      );
      if (fnErr) {
        console.error("[notify-quantity-change] Edge function error:", fnErr);
      } else {
        console.log("[notify-quantity-change] Result:", fnData);
      }
    } catch (invokeErr) {
      // Non-blocking: quantity already saved; just log
      console.error("[notify-quantity-change] Invoke threw:", invokeErr);
    }

    setModifyTargetOrder(null);
    setModifyLoading(false);
  }, [modifyTargetOrder, modifyQty, modifyReason, customers]);

  // Update order status with optimistic UI updates
  const handleUpdateStatus = useCallback(async (orderId: number, newStatus: "approved" | "rejected") => {
    let previousOrder: Order | undefined;

    setOrders((prev) => {
      const idx = prev.findIndex((o) => o.id === orderId);
      if (idx !== -1) {
        previousOrder = prev[idx];
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          status: newStatus,
        };
        return next;
      }
      return prev;
    });

    // Also optimistically update customer history if loaded
    setCustomerHistory((prev) => {
      const idx = prev.findIndex((o) => o.id === orderId);
      if (idx !== -1) {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          status: newStatus,
        };
        return next;
      }
      return prev;
    });

    const { error } = await supabase
      .from("orders")
      .update({ status: newStatus })
      .eq("id", orderId);

    if (error) {
      console.error("Failed to update status:", error);
      if (previousOrder) {
        setOrders((prev) => {
          const idx = prev.findIndex((o) => o.id === orderId);
          if (idx !== -1) {
            const next = [...prev];
            next[idx] = previousOrder!;
            return next;
          }
          return prev;
        });

        setCustomerHistory((prev) => {
          const idx = prev.findIndex((o) => o.id === orderId);
          if (idx !== -1) {
            const next = [...prev];
            next[idx] = previousOrder!;
            return next;
          }
          return prev;
        });
      }
      alert(`Failed to update status: ${error.message}`);
    }
  }, []);

  // Helper function to show compact date + exact time
  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const datePart = date
      .toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
      })
      .replace(",", "");
    const timePart = date.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return `${datePart} · ${timePart}`;
  };

  const formatDateShort = (dateString: string | null) => {
    if (!dateString) return "—";
    return new Date(dateString)
      .toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
      })
      .replace(",", "");
  };

  const formatDeliveryDisplay = (orderId: number, dateString: string | null) => {
    if (dateString) return formatDateShort(dateString);
    const fallbackDays = (orderId % 5) + 1;
    return `Estimated delivery: ${fallbackDays} day(s)`;
  };

  const formatPrice = (price: number | null) => {
    if (price === null || Number.isNaN(Number(price))) return "—";
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 2,
    }).format(Number(price));
  };

  const getTrackingStatus = (dateString: string | null) => {
    if (!dateString) return { label: "", color: "var(--muted-strong)" };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const deliveryDate = new Date(dateString);
    deliveryDate.setHours(0, 0, 0, 0);

    const dayDiff = Math.ceil((deliveryDate.getTime() - today.getTime()) / 86400000);
    if (dayDiff < 0) return { label: "DELIVERED", color: "var(--ledger-teal)" };
    if (dayDiff === 0) return { label: "ARRIVING TODAY", color: "var(--brass)" };
    return { label: `IN TRANSIT · ${dayDiff} DAYS LEFT`, color: "rgba(237, 230, 214, 0.7)" };
  };

  // Derived state: filtered orders
  const filteredOrders = useMemo(() => {
    return orders.filter((order) => {
      const customerName = order.customers?.name || "Unknown Customer";
      const matchesSearch =
        customerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        order.item.toLowerCase().includes(searchTerm.toLowerCase()) ||
        order.raw_message.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "confirmed" && isConfirmedOrApprovedStatus(order.status)) ||
        (statusFilter === "flagged" && order.status === "flagged");

      return matchesSearch && matchesStatus;
    });
  }, [orders, searchTerm, statusFilter]);

  // Group history by item
  const historyByItem = useMemo(() => {
    const groups: { [item: string]: any[] } = {};
    customerHistory.forEach((order) => {
      if (!groups[order.item]) {
        groups[order.item] = [];
      }
      groups[order.item].push({
        id: order.id,
        sequence: groups[order.item].length + 1,
        quantity: order.quantity,
        date: formatTime(order.created_at),
        flagged: order.flagged,
        status: order.status,
        flag_reason: order.flag_reason,
      });
    });
    return groups;
  }, [customerHistory]);

  // Compute reference averages for each item
  const referenceAverages = useMemo(() => {
    const avgs: { [item: string]: number } = {};
    Object.keys(historyByItem).forEach((item) => {
      const items = historyByItem[item];
      // Average of all non-flagged/non-rejected orders
      const normalItems = items.filter((o) => o.status !== "flagged" && o.status !== "rejected");
      if (normalItems.length > 0) {
        const sum = normalItems.reduce((acc, curr) => acc + curr.quantity, 0);
        avgs[item] = parseFloat((sum / normalItems.length).toFixed(1));
      } else {
        // Fallback
        const sum = items.reduce((acc, curr) => acc + curr.quantity, 0);
        avgs[item] = parseFloat((sum / items.length).toFixed(1));
      }
    });
    return avgs;
  }, [historyByItem]);

  // Build PatternStrip data for a given order (from allOrdersByCustomer)
  const getPatternHistory = useCallback(
    (customerId: number, item: string) => {
      const custOrders = allOrdersByCustomer.get(customerId) || [];
      return custOrders
        .filter((o) => o.item === item)
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .map((o) => ({ id: o.id, quantity: o.quantity, status: o.status }));
    },
    [allOrdersByCustomer]
  );

  const getPatternAvg = useCallback(
    (customerId: number, item: string) => {
      const custOrders = allOrdersByCustomer.get(customerId) || [];
      const itemOrders = custOrders.filter(
        (o) => o.item === item && o.status !== "flagged" && o.status !== "rejected"
      );
      if (itemOrders.length === 0) return undefined;
      const sum = itemOrders.reduce((acc, o) => acc + o.quantity, 0);
      return sum / itemOrders.length;
    },
    [allOrdersByCustomer]
  );

  const customerDistribution = useMemo<CustomerDistributionDatum[]>(() => {
    const fills = [
      "#4E8C7C",
      "#C1553B",
      "#B98B4E",
      "#6B8E9E",
      "#8E7CC3",
      "#C9A66B",
      "#7A9E7E",
      "#B56576",
      "#6E9B8F",
      "#A86D3D",
      "#5F7A9A",
      "#9B6B8E",
      "#8A8F5A",
      "#B1785A",
      "#5B8A78",
      "#A05F5F",
      "#7C719E",
      "#9A8A5C",
      "#668C9A",
    ];

    return [...customers]
      .sort((a, b) => b.count - a.count)
      .map((customer, index) => ({
        id: customer.id,
        name: customer.name,
        count: customer.count,
        percentage: globalStats.totalProcessed > 0 ? (customer.count / globalStats.totalProcessed) * 100 : 0,
        fill: fills[index] || `hsl(${(index * 137.508) % 360}, 38%, ${42 + (index % 3) * 8}%)`,
      }));
  }, [customers, globalStats.totalProcessed]);

  const mostActiveCustomer = customerDistribution[0];

  const ordersTodayCount = useMemo(() => {
    const today = new Date();
    return Array.from(allOrdersByCustomer.values())
      .flat()
      .filter((order) => {
        const orderDate = new Date(order.created_at);
        return (
          orderDate.getFullYear() === today.getFullYear() &&
          orderDate.getMonth() === today.getMonth() &&
          orderDate.getDate() === today.getDate()
        );
      }).length;
  }, [allOrdersByCustomer]);

  const highestDeviationThisWeek = useMemo<{ customerName: string; multiple: number } | null>(() => {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    weekStart.setHours(0, 0, 0, 0);

    let highest: { customerName: string; multiple: number } | null = null;

    allOrdersByCustomer.forEach((custOrders, customerId) => {
      const customerName = customers.find((customer) => customer.id === customerId)?.name || "Unknown Customer";

      custOrders.forEach((order) => {
        const orderTime = new Date(order.created_at).getTime();
        const isFlaggedOrder =
          order.flagged === true ||
          order.status === "flagged" ||
          order.status === "approved" ||
          order.status === "rejected";

        if (!isFlaggedOrder || orderTime < weekStart.getTime()) return;

        const baselineOrders = custOrders.filter(
          (candidate) =>
            candidate.item === order.item &&
            candidate.id !== order.id &&
            candidate.status !== "flagged" &&
            candidate.status !== "rejected" &&
            candidate.flagged !== true
        );

        if (baselineOrders.length === 0) return;

        const baseline =
          baselineOrders.reduce((sum, candidate) => sum + candidate.quantity, 0) / baselineOrders.length;
        if (baseline <= 0) return;

        const multiple = order.quantity / baseline;
        if (!highest || multiple > highest.multiple) {
          highest = { customerName, multiple };
        }
      });
    });

    return highest;
  }, [allOrdersByCustomer, customers]);

  /* ── HUD Readout renderer ── */
  const renderHudReadout = (order: Order, patternAvg?: number) => {
    let label = "CONFIRMED";
    let color = "var(--ledger-teal)";
    let deviationOpacity = 1;
    const isConfirmed = !order.status || isConfirmedOrApprovedStatus(order.status) || order.status === "normal";

    if (order.status === "flagged") {
      label = "FLAGGED";
      color = "var(--rust)";
    } else if (order.status === "approved") {
      label = "APPROVED";
      color = "var(--brass)";
      deviationOpacity = 0.6;
    } else if (order.status === "rejected") {
      label = "REJECTED";
      color = "var(--rust)";
    }

    let deviationContent = null;
    if (!isConfirmed && patternAvg && patternAvg > 0) {
      const multiple = (order.quantity / patternAvg).toFixed(1);
      deviationContent = (
        <span
          className="font-mono-num"
          style={{ fontSize: 28, lineHeight: 1, color: color, display: "block", marginTop: 4, opacity: deviationOpacity }}
        >
          {multiple}×
        </span>
      );
    }

    return (
      <div style={{ textAlign: "right", display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
        <span className="font-mono-num" style={{ fontSize: 14, fontWeight: 600, letterSpacing: "0.1em", color: color }}>
          {label}
        </span>
        {deviationContent}
      </div>
    );
  };

  /* ═══════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════ */

  if (error) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <div className="viewfinder-card" style={{ maxWidth: 420, textAlign: "center" }}>
          <h2 className="font-display" style={{ fontSize: 20, marginBottom: 8 }}>Connection Error</h2>
          <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 24 }}>{error}</p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 20px",
              background: "transparent",
              border: "1px solid var(--rust)",
              borderRadius: 4,
              color: "var(--rust)",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
              fontFamily: "Inter, sans-serif",
            }}
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ── Layout wrapper: sidebar + main ── */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* ── LEFT SIDEBAR ── */}
        <aside
          style={{
            width: 280,
            borderRight: "1px solid var(--rule)",
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
            overflow: "hidden",
            background: "var(--ink)", // ensures pattern is covered
          }}
          className="sidebar-aside"
        >
          {/* Sidebar header */}
          <div style={{ padding: "24px 20px 16px" }}>
            <h2 className="font-display" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
              MONITORING · {customers.length} CLIENTS
            </h2>
            <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
              Select to view order trends
            </p>
            <div className="sidebar-status-legend" aria-label="Client status legend">
              {Object.values(customerStatusMeta).map((status) => (
                <span key={status.label} className="sidebar-status-legend__item">
                  <span
                    className="sidebar-customer-status-dot"
                    style={{ background: status.color }}
                    aria-hidden="true"
                    title={status.label}
                  />
                  {status.label}
                </span>
              ))}
            </div>
          </div>

          {/* Customer list */}
          <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px" }}>
            {/* Live Feed button */}
            <button
              onClick={() => {
                setSelectedCustomerId(null);
                setDashboardView("feed");
              }}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "10px 12px",
                borderRadius: 4,
                border: selectedCustomerId === null ? "1px solid var(--brass)" : "1px solid transparent",
                background: selectedCustomerId === null ? "rgba(185, 139, 78, 0.08)" : "transparent",
                color: selectedCustomerId === null ? "var(--brass)" : "var(--parchment)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 13,
                fontWeight: selectedCustomerId === null ? 600 : 400,
                fontFamily: "Inter, sans-serif",
                marginBottom: 4,
                transition: "all 0.15s",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  className={selectedCustomerId === null ? "live-pulse" : ""}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: selectedCustomerId === null ? "var(--ledger-teal)" : "var(--rule)",
                  }}
                />
                Live Feed
              </span>
            </button>

            <div style={{ height: 1, background: "var(--rule)", margin: "8px 0" }} />

            {customers.length === 0 ? (
              <p style={{ color: "var(--muted)", fontSize: 11, textAlign: "center", padding: "20px 0" }}>
                No customers recorded
              </p>
            ) : (
              customers.map((cust) => {
                const isActive = selectedCustomerId === cust.id;
                const customerStatus = cust.hasFlagged ? customerStatusMeta.reviewHistory : customerStatusMeta.clear;

                return (
                  <button
                    key={cust.id}
                    onClick={() => {
                      setSelectedCustomerId(cust.id);
                      if (dashboardView === "inventory") setDashboardView("feed");
                    }}
                    className={`sidebar-customer-button ${isActive ? "sidebar-customer-button--active" : ""}`}
                  >
                    <span className="sidebar-customer-copy">
                      <span className="sidebar-customer-name-row">
                        <span
                          className="sidebar-customer-status-dot"
                          style={{ background: customerStatus.color }}
                          title={customerStatus.label}
                          aria-hidden="true"
                        />
                        {isActive && (
                          <span className="sidebar-customer-active-glyph">▸</span>
                        )}
                        <span className="sidebar-customer-name">{cust.name}</span>
                      </span>
                      <span className="sidebar-customer-time font-mono-num">
                        {formatTime(cust.latestOrderAt)}
                      </span>
                      <span className="sidebar-customer-address">
                        {cust.address || "Address not on file"}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* ── MAIN PANEL ── */}
        <main style={{ flex: 1, overflowY: "auto", padding: "0 32px 96px" }}>
          {/* ════════════════════════════════════════════
              CUSTOMER DETAIL VIEW
              ════════════════════════════════════════════ */}
          {dashboardView === "tracking" ? (
            <div>
              <header style={{ padding: "24px 0 20px", borderBottom: "1px solid var(--rule)", marginBottom: 28 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <h1
                    className="font-display"
                    style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}
                  >
                    Tracking
                  </h1>
                  <div className="dashboard-view-toggle" aria-label="Dashboard view">
                    {dashboardViews.map((view) => (
                      <button
                        key={view}
                        type="button"
                        className={`dashboard-view-toggle__button ${
                          dashboardView === view ? "dashboard-view-toggle__button--active" : ""
                        }`}
                        onClick={() => setDashboardView(view)}
                      >
                        {getDashboardViewLabel(view)}
                      </button>
                    ))}
                  </div>
                </div>
              </header>

              {selectedCustomerId === null ? (
                <div style={{ minHeight: 360, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>
                    Select a client from the sidebar to view their tracking.
                  </p>
                </div>
              ) : (
                <div className="viewfinder-card tracking-list">
                  <div style={{ marginBottom: 16 }}>
                    <h2 className="font-display" style={{ fontSize: 18, margin: 0 }}>
                      {customers.find((customer) => customer.id === selectedCustomerId)?.name || "Client Tracking"}
                    </h2>
                  </div>

                  {loadingTrackingOrders ? (
                    <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>Loading tracking…</p>
                  ) : trackingOrders.length === 0 ? (
                    <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>
                      No confirmed or approved orders to track.
                    </p>
                  ) : (
                    <div>
                      {trackingOrders.map((order) => {
                        const trackingStatus = getTrackingStatus(order.estimated_delivery_date);

                        return (
                          <div key={order.id} className="tracking-row">
                            <div>
                              <p style={{ margin: 0, fontSize: 13, fontWeight: 600, textTransform: "capitalize" }}>
                                {order.item}
                              </p>
                              <p className="font-mono-num tracking-row__meta">
                                ORDERED {formatTime(order.created_at)} · DELIVERY {formatDeliveryDisplay(order.id, order.estimated_delivery_date)}
                              </p>
                            </div>
                            <div style={{ textAlign: "right" }}>
                              <p className="font-mono-num" style={{ margin: 0, fontSize: 13, color: "var(--brass)", fontWeight: 600 }}>
                                QTY {order.quantity}
                              </p>
                              {trackingStatus.label && (
                                <p className="font-mono-num tracking-row__status" style={{ color: trackingStatus.color }}>
                                  {trackingStatus.label}
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : dashboardView === "inventory" ? (
            <div>
              <header style={{ padding: "24px 0 20px", borderBottom: "1px solid var(--rule)", marginBottom: 28 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                  <h1
                    className="font-display"
                    style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}
                  >
                    Inventory
                  </h1>
                  <div className="dashboard-view-toggle" aria-label="Dashboard view">
                    {dashboardViews.map((view) => (
                      <button
                        key={view}
                        type="button"
                        className={`dashboard-view-toggle__button ${
                          dashboardView === view ? "dashboard-view-toggle__button--active" : ""
                        }`}
                        onClick={() => setDashboardView(view)}
                      >
                        {getDashboardViewLabel(view)}
                      </button>
                    ))}
                  </div>
                </div>
                <p style={{ fontSize: 12, color: "var(--muted)", margin: "8px 0 0" }}>
                  Stock monitor sorted by category, then lowest available units.
                </p>
              </header>

              <div className="viewfinder-card inventory-console">
                <div className="inventory-console__head">
                  <div>
                    <span className="label-caps">Inventory Signal</span>
                    <p className="font-mono-num inventory-console__summary">
                      {loadingInventory ? "SCANNING" : `${inventoryItems.length} Stock Keeping Unit${inventoryItems.length === 1 ? "" : "s"}`}
                    </p>
                  </div>
                  <div className="inventory-console__legend">
                    <span className="inventory-stock-badge inventory-stock-badge--low">LOW &lt; {lowStockThreshold}</span>
                    <span className="inventory-stock-badge inventory-stock-badge--ok">STABLE</span>
                  </div>
                </div>

                {loadingInventory ? (
                  <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>Loading inventory…</p>
                ) : inventoryError ? (
                  <p style={{ color: "var(--rust)", fontSize: 13, margin: 0 }}>{inventoryError}</p>
                ) : inventoryItems.length === 0 ? (
                  <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>No inventory rows found.</p>
                ) : (
                  <div className="inventory-table-wrap">
                    <table className="inventory-table">
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th>Category</th>
                          <th>Current Stock</th>
                          <th>Price / Unit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inventoryItems.map((item) => {
                          const stock = Number(item.current_stock ?? 0);
                          const isLowStock = stock < lowStockThreshold;

                          return (
                            <tr
                              key={`${item.category || "uncategorized"}-${item.item_name}`}
                              className={isLowStock ? "inventory-table__row--low" : ""}
                            >
                              <td>
                                <span className="inventory-item-name">{item.item_name}</span>
                              </td>
                              <td>
                                <span className="inventory-category">{item.category || "Uncategorized"}</span>
                              </td>
                              <td>
                                <span className="font-mono-num inventory-stock-cell">
                                  {stock}
                                  {isLowStock && (
                                    <span className="inventory-stock-badge inventory-stock-badge--low">LOW</span>
                                  )}
                                </span>
                              </td>
                              <td className="font-mono-num">{formatPrice(item.price_per_unit)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          ) : selectedCustomerId !== null ? (
            <div>
              {/* Header */}
              <header style={{ padding: "24px 0 20px", borderBottom: "1px solid var(--rule)", marginBottom: 28 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <button
                    onClick={() => setSelectedCustomerId(null)}
                    style={{
                      padding: "6px 10px",
                      background: "var(--ledger-panel)",
                      border: "1px solid var(--rule)",
                      borderRadius: 4,
                      color: "var(--parchment)",
                      cursor: "pointer",
                      fontSize: 14,
                      fontFamily: "Inter, sans-serif",
                    }}
                  >
                    ← Back
                  </button>
                  <div>
                    <h1
                      className="font-display"
                      style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}
                    >
                      {customers.find((c) => c.id === selectedCustomerId)?.name || "Customer Detail"}
                    </h1>
                    <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                      Historical trends and order log
                    </p>
                    <p className="sidebar-customer-address" style={{ margin: "6px 0 0", maxWidth: 520 }}>
                      Address: {customers.find((c) => c.id === selectedCustomerId)?.address || "Not on file"}
                    </p>
                  </div>
                </div>
              </header>

              {loadingHistory ? (
                <div style={{ textAlign: "center", padding: "60px 0", color: "var(--muted)" }}>
                  <p style={{ fontSize: 13 }}>Loading history…</p>
                </div>
              ) : (
                <div>
                  {/* Charts section */}
                  <section style={{ marginBottom: 40 }}>
                    <h3
                      className="font-display"
                      style={{ fontSize: 14, fontWeight: 600, color: "var(--muted-strong)", marginBottom: 20, textTransform: "uppercase", letterSpacing: "0.06em" }}
                    >
                      Order Trends & Baseline Averages
                    </h3>

                    {Object.keys(historyByItem).length === 0 ? (
                      <div className="viewfinder-card" style={{ textAlign: "center", padding: 32 }}>
                        <p style={{ color: "var(--muted)", fontSize: 13 }}>No items found</p>
                      </div>
                    ) : (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))", gap: 20 }}>
                        {Object.keys(historyByItem).map((item) => {
                          const itemHistory = historyByItem[item];
                          const hasBaselineChart = itemHistory.length >= 3;

                          return (
                          <div key={item} className="viewfinder-card">
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                              <div>
                                <h4 style={{ fontWeight: 600, fontSize: 14, margin: 0, textTransform: "capitalize" }}>
                                  {item}
                                </h4>
                                <p style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
                                  {hasBaselineChart ? "Quantity over time" : "Baseline pending"}
                                </p>
                              </div>
                              <div style={{ textAlign: "right" }}>
                                <span className="label-caps" style={{ fontSize: 9 }}>Ref. Avg</span>
                                <span
                                  className="font-mono-num"
                                  style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--brass)", marginTop: 2 }}
                                >
                                  {referenceAverages[item]}
                                </span>
                              </div>
                            </div>

                            {!hasBaselineChart ? (
                              <div className="baseline-pending-callout">
                                <span className="label-caps" style={{ fontSize: 9 }}>
                                  Establishing baseline
                                </span>
                                <p className="font-mono-num baseline-pending-callout__count">
                                  {itemHistory.length} {itemHistory.length === 1 ? "order" : "orders"} recorded
                                </p>
                                <div className="baseline-pending-callout__quantities">
                                  {itemHistory.map((order) => (
                                    <span key={order.id} className="baseline-pending-callout__quantity">
                                      #{order.sequence}: {order.quantity}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ) : (
                            <div style={{ height: 200 }}>
                              <ResponsiveContainer width="100%" height="100%">
                                <LineChart
                                  data={itemHistory}
                                  margin={{ top: 14, right: 18, left: -14, bottom: 8 }}
                                >
                                  <CartesianGrid strokeDasharray="3 3" stroke="var(--rule)" vertical={false} />
                                  <XAxis
                                    dataKey="sequence"
                                    stroke="var(--muted)"
                                    fontSize={10}
                                    tickLine={false}
                                    fontFamily="IBM Plex Mono"
                                  />
                                  <YAxis stroke="var(--muted)" fontSize={10} tickLine={false} fontFamily="IBM Plex Mono" />
                                  <RechartsTooltip content={<CustomTooltip />} />
                                  <ReferenceLine
                                    y={referenceAverages[item]}
                                    stroke="var(--brass)"
                                    strokeDasharray="5 5"
                                    strokeWidth={1.2}
                                  />
                                  <Line
                                    type="monotone"
                                    dataKey="quantity"
                                    stroke="var(--ledger-teal)"
                                    strokeWidth={2}
                                    activeDot={{ r: 5 }}
                                    dot={(props: any) => {
                                      const { cx, cy, payload } = props;
                                      if (payload.status === "flagged") {
                                        return <circle cx={cx} cy={cy} r={4} fill="var(--rust)" stroke="var(--rust)" strokeWidth={1.5} />;
                                      }
                                      return <circle cx={cx} cy={cy} r={2.5} fill="var(--ledger-teal)" stroke="var(--ledger-teal)" strokeWidth={1} />;
                                    }}
                                  />
                                </LineChart>
                              </ResponsiveContainer>
                            </div>
                            )}
                          </div>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  {/* Customer order cards */}
                  <section>
                    <h3
                      className="font-display"
                      style={{ fontSize: 14, fontWeight: 600, color: "var(--muted-strong)", marginBottom: 20, textTransform: "uppercase", letterSpacing: "0.06em" }}
                    >
                      Order Log
                    </h3>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
                      {[...customerHistory].reverse().map((order) => {
                        const patternAvg = getPatternAvg(order.customer_id, order.item);
                        return (
                          <div
                            key={order.id}
                            className={`viewfinder-card ${newOrderIds.has(order.id) ? "animate-sweep" : ""}`}
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              justifyContent: "space-between",
                              opacity: order.status === "rejected" ? 0.7 : 1,
                              transition: "opacity 0.2s",
                            }}
                          >
                            {/* Top row: Customer + HUD Readout */}
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                              <div style={{ paddingRight: 16 }}>
                                <h4 style={{ fontWeight: 600, fontSize: 14, margin: 0 }}>
                                  {customers.find((c) => c.id === selectedCustomerId)?.name || "Customer"}
                                </h4>
                                <span
                                  className="font-mono-num"
                                  style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, display: "block" }}
                                >
                                  {formatTime(order.created_at)}
                                </span>
                              </div>
                              <div style={{ flexShrink: 0 }}>
                                {renderHudReadout(order, patternAvg)}
                              </div>
                            </div>

                            {/* Item + Quantity */}
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                background: "var(--ink)",
                                borderRadius: 4,
                                padding: "10px 14px",
                                marginBottom: 12,
                              }}
                            >
                              <div>
                                <span className="label-caps" style={{ fontSize: 9 }}>Item</span>
                                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, textTransform: "capitalize" }}>{order.item}</p>
                              </div>
                              <div style={{ textAlign: "right" }}>
                                <span className="label-caps" style={{ fontSize: 9 }}>Qty</span>
                                <p className="font-mono-num" style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--brass)" }}>
                                  {order.quantity}
                                </p>
                              </div>
                            </div>

                            {isConfirmedOrApprovedStatus(order.status) && (
                              <p className="font-mono-num" style={{ fontSize: 10, color: "var(--parchment)", opacity: 0.6, margin: "0 0 12px" }}>
                                DELIVERY · {formatDeliveryDisplay(order.id, order.estimated_delivery_date)}
                              </p>
                            )}

                            {/* Flag reason */}
                            {(order.status === "flagged" || order.status === "approved" || order.status === "rejected") && order.flag_reason && (
                              <p style={{ fontSize: 11, color: "var(--rust)", fontStyle: "italic", margin: "0 0 12px", opacity: order.status === "approved" ? 0.6 : 0.85 }}>
                                {order.flag_reason}
                              </p>
                            )}

                            {/* Approve/Reject */}
                            {order.status === "flagged" && (
                              <div style={{ display: "flex", gap: 10, marginBottom: 12, position: "relative", zIndex: 20 }}>
                                <button
                                  onClick={() => handleUpdateStatus(order.id, "approved")}
                                  style={{
                                    flex: 1,
                                    padding: "7px 0",
                                    background: "transparent",
                                    border: "1px solid var(--ledger-teal)",
                                    borderRadius: 4,
                                    color: "var(--ledger-teal)",
                                    fontWeight: 600,
                                    fontSize: 11,
                                    cursor: "pointer",
                                    fontFamily: "Inter, sans-serif",
                                    textTransform: "uppercase",
                                    letterSpacing: "0.06em",
                                  }}
                                >
                                  Approve
                                </button>
                                <button
                                  onClick={() => handleUpdateStatus(order.id, "rejected")}
                                  style={{
                                    flex: 1,
                                    padding: "7px 0",
                                    background: "transparent",
                                    border: "1px solid var(--rust)",
                                    borderRadius: 4,
                                    color: "var(--rust)",
                                    fontWeight: 600,
                                    fontSize: 11,
                                    cursor: "pointer",
                                    fontFamily: "Inter, sans-serif",
                                    textTransform: "uppercase",
                                    letterSpacing: "0.06em",
                                  }}
                                >
                                  Reject
                                </button>
                              </div>
                            )}

                            {/* Raw message */}
                            {order.raw_message && (
                              <div style={{ borderTop: "1px solid var(--rule)", paddingTop: 10, marginBottom: 10 }}>
                                <span className="label-caps" style={{ fontSize: 9, display: "block", marginBottom: 4 }}>
                                  Message
                                </span>
                                <p style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic", margin: 0, lineHeight: 1.5 }}>
                                  "{order.raw_message}"
                                </p>
                              </div>
                            )}

                            {/* Order actions: Modify Qty + Delete */}
                            <div className="order-action-row">
                              <button
                                id={`modify-qty-detail-${order.id}`}
                                className="order-action-btn order-action-btn--modify"
                                onClick={() => openModifyModal(order)}
                                title="Modify quantity"
                              >
                                ✎ Modify Qty
                              </button>
                              <button
                                id={`delete-order-detail-${order.id}`}
                                className="order-action-btn order-action-btn--delete"
                                onClick={() => setDeleteTargetOrder(order)}
                                title="Delete order"
                              >
                                × Delete
                              </button>
                            </div>
                          </div>

                        );
                      })}
                    </div>
                  </section>
                </div>
              )}
            </div>
          ) : (
            /* ════════════════════════════════════════════
               LIVE FEED VIEW
               ════════════════════════════════════════════ */
            <div>
              {/* ── Masthead ── */}
              <header style={{ padding: "24px 0 20px", borderBottom: "1px solid var(--rule)", marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <h1
                    className="font-display"
                    style={{
                      fontSize: "2rem",
                      fontWeight: 700,
                      margin: 0,
                      letterSpacing: "-0.03em",
                      color: "var(--parchment)",
                    }}
                  >
                    Nudge AI
                  </h1>

                  {/* Live status HUD */}
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "3px 10px",
                      border: "1px solid var(--ledger-teal)",
                      borderRadius: 2,
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.15em",
                      textTransform: "uppercase" as const,
                      color: "var(--ledger-teal)",
                      fontFamily: "Inter, sans-serif",
                      background: "var(--ink)",
                    }}
                  >
                    <span
                      className="live-pulse"
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background: "var(--ledger-teal)",
                      }}
                    />
                    LIVE
                  </span>

                  <div className="dashboard-view-toggle" aria-label="Dashboard view">
                    {dashboardViews.map((view) => (
                      <button
                        key={view}
                        type="button"
                        className={`dashboard-view-toggle__button ${
                          dashboardView === view ? "dashboard-view-toggle__button--active" : ""
                        }`}
                        onClick={() => setDashboardView(view)}
                      >
                        {getDashboardViewLabel(view)}
                      </button>
                    ))}
                  </div>
                </div>
                <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
                  AI that catches unusual orders before they become inventory mistakes
                </p>
              </header>

              {/* ── Stats strip ── */}
              <section
                style={{
                  display: dashboardView === "feed" ? "flex" : "none",
                  border: "1px solid var(--rule)",
                  borderRadius: 4,
                  marginBottom: 24,
                  overflow: "hidden",
                  background: "var(--ink)",
                }}
              >
                {/* Segment 1 */}
                <div style={{ flex: 1, padding: "14px 20px", borderRight: "1px solid var(--rule)" }}>
                  <span className="label-caps">Orders Processed</span>
                  <p className="font-mono-num" style={{ fontSize: 24, fontWeight: 600, margin: "4px 0 0" }}>
                    {loadingGlobalStats ? "—" : globalStats.totalProcessed}
                  </p>
                </div>
                {/* Segment 2 */}
                <div style={{ flex: 1, padding: "14px 20px", borderRight: "1px solid var(--rule)" }}>
                  <span className="label-caps">Flagged</span>
                  <p className="font-mono-num" style={{ fontSize: 24, fontWeight: 600, margin: "4px 0 0", color: "var(--rust)" }}>
                    {loadingGlobalStats ? "—" : globalStats.totalFlagged}
                  </p>
                </div>
                {/* Segment 3 */}
                <div style={{ flex: 1, padding: "14px 20px" }}>
                  <span className="label-caps">Unique Customers</span>
                  <p className="font-mono-num" style={{ fontSize: 24, fontWeight: 600, margin: "4px 0 0" }}>
                    {loadingGlobalStats ? "—" : globalStats.uniqueCustomers}
                  </p>
                </div>
              </section>

              {/* ── Search & Filters ── */}
              <section style={{ display: "none" }}>
                <div
                  className="viewfinder-card"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(240px, 320px) minmax(260px, 1fr)",
                    gap: 28,
                    alignItems: "center",
                    marginBottom: 12,
                  }}
                >
                  <div style={{ position: "relative", height: 240 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={customerDistribution}
                          dataKey="count"
                          nameKey="name"
                          innerRadius={72}
                          outerRadius={104}
                          paddingAngle={2}
                          stroke="var(--ink)"
                          strokeWidth={2}
                          isAnimationActive={false}
                        >
                          {customerDistribution.map((entry) => (
                            <Cell key={entry.id} fill={entry.fill} />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        pointerEvents: "none",
                      }}
                    >
                      <span className="font-mono-num" style={{ fontSize: 34, fontWeight: 600, lineHeight: 1 }}>
                        {loadingGlobalStats ? "—" : globalStats.totalProcessed}
                      </span>
                      <span className="label-caps" style={{ fontSize: 9, marginTop: 8 }}>
                        TOTAL ORDERS
                      </span>
                    </div>
                  </div>

                  <div>
                    <h3
                      className="font-display"
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "var(--muted-strong)",
                        margin: "0 0 14px",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                      }}
                    >
                      Order Distribution
                    </h3>
                    <div style={{ display: "grid", gap: 4 }}>
                      {customerDistribution.length === 0 ? (
                        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>No customer orders recorded</p>
                      ) : (
                        customerDistribution.map((customer, index) => (
                          <div key={customer.id} className="distribution-customer-row">
                            <span className="sidebar-customer-copy">
                              <span className="sidebar-customer-name-row">
                                <span
                                  className="distribution-rank-dot"
                                  style={{ background: customer.fill }}
                                  aria-hidden="true"
                                />
                                <span className="sidebar-customer-name">{customer.name}</span>
                              </span>
                              <span className="sidebar-customer-time font-mono-num">
                                #{index + 1} · {customer.percentage.toFixed(1)}%
                              </span>
                            </span>
                            <span
                              className="font-mono-num"
                              style={{ color: "var(--parchment)", fontSize: 12, fontWeight: 600 }}
                            >
                              {customer.count}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <section
                  style={{
                    display: "flex",
                    border: "1px solid var(--rule)",
                    borderRadius: 4,
                    overflow: "hidden",
                    background: "var(--ink)",
                  }}
                >
                  <div style={{ flex: 1, padding: "14px 20px", borderRight: "1px solid var(--rule)" }}>
                    <span className="label-caps">Most active customer</span>
                    <p className="font-mono-num" style={{ fontSize: 18, fontWeight: 600, margin: "4px 0 0" }}>
                      {mostActiveCustomer ? `${mostActiveCustomer.name} · ${mostActiveCustomer.count}` : "—"}
                    </p>
                  </div>
                  <div style={{ flex: 1, padding: "14px 20px", borderRight: "1px solid var(--rule)" }}>
                    <span className="label-caps">Highest deviation this week</span>
                    <p className="font-mono-num" style={{ fontSize: 18, fontWeight: 600, margin: "4px 0 0", color: "var(--rust)" }}>
                      {highestDeviationThisWeek
                        ? `${highestDeviationThisWeek.customerName} · ${highestDeviationThisWeek.multiple.toFixed(1)}x`
                        : "—"}
                    </p>
                  </div>
                  <div style={{ flex: 1, padding: "14px 20px" }}>
                    <span className="label-caps">Orders today</span>
                    <p className="font-mono-num" style={{ fontSize: 24, fontWeight: 600, margin: "4px 0 0" }}>
                      {loadingGlobalStats ? "—" : ordersTodayCount}
                    </p>
                  </div>
                </section>
              </section>

              <section
                style={{
                  display: dashboardView === "feed" ? "flex" : "none",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 24,
                }}
              >
                {/* Search */}
                <div style={{ position: "relative", flex: "1 1 260px", maxWidth: 360 }}>
                  <input
                    type="text"
                    placeholder="Search orders…"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 14px",
                      background: "var(--ledger-panel)",
                      border: "1px solid var(--rule)",
                      borderRadius: 4,
                      color: "var(--parchment)",
                      fontSize: 13,
                      fontFamily: "Inter, sans-serif",
                      outline: "none",
                      boxSizing: "border-box",
                    }}
                  />
                </div>

                {/* Filter buttons */}
                <div style={{ display: "flex", gap: 4 }}>
                  {(["all", "confirmed", "flagged"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setStatusFilter(f)}
                      style={{
                        padding: "7px 14px",
                        background: statusFilter === f ? "rgba(185, 139, 78, 0.1)" : "var(--ledger-panel)",
                        border: statusFilter === f ? "1px solid var(--brass)" : "1px solid var(--rule)",
                        borderRadius: 4,
                        color: statusFilter === f ? "var(--brass)" : "var(--muted)",
                        fontSize: 11,
                        fontWeight: statusFilter === f ? 600 : 400,
                        cursor: "pointer",
                        fontFamily: "Inter, sans-serif",
                        textTransform: "capitalize",
                        transition: "all 0.15s",
                      }}
                    >
                      {f === "all" ? "All Orders" : f === "confirmed" ? "Confirmed" : "Flagged"}
                    </button>
                  ))}
                </div>
              </section>

              {/* ── Order cards ── */}
              {dashboardView === "feed" && (
                loading ? (
                <div style={{ textAlign: "center", padding: "60px 0", color: "var(--muted)" }}>
                  <p style={{ fontSize: 13 }}>Loading feed…</p>
                </div>
              ) : filteredOrders.length === 0 ? (
                <div
                  className="viewfinder-card"
                  style={{
                    textAlign: "center",
                    padding: "48px 0",
                  }}
                >
                  <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>No Orders Found</h3>
                  <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>
                    No orders match the current search or filter.
                  </p>
                </div>
              ) : (
                <div className="order-feed-scroll">
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
                      gap: 16,
                    }}
                  >
                    {filteredOrders.map((order) => {
                    const patternHistory = getPatternHistory(order.customer_id, order.item);
                    const patternAvg = getPatternAvg(order.customer_id, order.item);

                    return (
                      <div
                        key={order.id}
                        className={`viewfinder-card ${newOrderIds.has(order.id) ? "animate-sweep" : ""}`}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "space-between",
                          opacity: order.status === "rejected" ? 0.7 : 1,
                          transition: "opacity 0.2s",
                        }}
                      >
                        <div>
                          {/* Top row: Customer + HUD Readout */}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                            <div style={{ paddingRight: 16 }}>
                              <h4 style={{ fontWeight: 600, fontSize: 14, margin: 0 }}>
                                {order.customers?.name || "Unknown Customer"}
                              </h4>
                              <span
                                className="font-mono-num"
                                style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, display: "block" }}
                              >
                                {formatTime(order.created_at)}
                              </span>
                            </div>
                            <div style={{ flexShrink: 0 }}>
                              {renderHudReadout(order, patternAvg)}
                            </div>
                          </div>

                          {/* Item + Quantity row */}
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              background: "var(--ink)",
                              borderRadius: 4,
                              padding: "10px 14px",
                              marginBottom: 12,
                            }}
                          >
                            <div>
                              <span className="label-caps" style={{ fontSize: 9 }}>Item</span>
                              <p style={{ margin: 0, fontSize: 13, fontWeight: 600, textTransform: "capitalize" }}>
                                {order.item}
                              </p>
                            </div>
                            <div style={{ textAlign: "right" }}>
                              <span className="label-caps" style={{ fontSize: 9 }}>Qty</span>
                              <p
                                className="font-mono-num"
                                style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--brass)" }}
                              >
                                {order.quantity}
                              </p>
                            </div>
                          </div>

                          {isConfirmedOrApprovedStatus(order.status) && (
                            <p className="font-mono-num" style={{ fontSize: 10, color: "var(--parchment)", opacity: 0.6, margin: "0 0 12px" }}>
                              DELIVERY · {formatDeliveryDisplay(order.id, order.estimated_delivery_date)}
                            </p>
                          )}

                          {/* PatternStrip sparkline */}
                          {patternHistory.length > 1 && (
                            <div style={{ marginBottom: 12 }}>
                              <span className="label-caps" style={{ fontSize: 9, display: "block", marginBottom: 4 }}>
                                Order Pattern
                              </span>
                              <PatternStrip
                                history={patternHistory}
                                currentOrderId={order.id}
                                referenceAvg={patternAvg}
                              />
                            </div>
                          )}

                          {/* Flag reason */}
                          {(order.status === "flagged" || order.status === "approved" || order.status === "rejected") && order.flag_reason && (
                            <p
                              style={{
                                fontSize: 11,
                                color: "var(--rust)",
                                fontStyle: "italic",
                                margin: "0 0 12px",
                                opacity: order.status === "approved" ? 0.6 : 0.85,
                                lineHeight: 1.5,
                              }}
                            >
                              {order.flag_reason}
                            </p>
                          )}
                        </div>

                        {/* Approve/Reject */}
                        {order.status === "flagged" && (
                          <div style={{ display: "flex", gap: 10, marginBottom: 12, position: "relative", zIndex: 20 }}>
                            <button
                              onClick={() => handleUpdateStatus(order.id, "approved")}
                              style={{
                                flex: 1,
                                padding: "7px 0",
                                background: "transparent",
                                border: "1px solid var(--ledger-teal)",
                                borderRadius: 4,
                                color: "var(--ledger-teal)",
                                fontWeight: 600,
                                fontSize: 11,
                                cursor: "pointer",
                                fontFamily: "Inter, sans-serif",
                                textTransform: "uppercase",
                                letterSpacing: "0.06em",
                              }}
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => handleUpdateStatus(order.id, "rejected")}
                              style={{
                                flex: 1,
                                padding: "7px 0",
                                background: "transparent",
                                border: "1px solid var(--rust)",
                                borderRadius: 4,
                                color: "var(--rust)",
                                fontWeight: 600,
                                fontSize: 11,
                                cursor: "pointer",
                                fontFamily: "Inter, sans-serif",
                                textTransform: "uppercase",
                                letterSpacing: "0.06em",
                              }}
                            >
                              Reject
                            </button>
                          </div>
                        )}

                        {/* Raw message */}
                        {order.raw_message && (
                          <div style={{ borderTop: "1px solid var(--rule)", paddingTop: 10 }}>
                            <span className="label-caps" style={{ fontSize: 9, display: "block", marginBottom: 4 }}>
                              Message
                            </span>
                            <p
                              style={{
                                fontSize: 11,
                                color: "var(--muted)",
                                fontStyle: "italic",
                                margin: 0,
                                lineHeight: 1.5,
                              }}
                            >
                              "{order.raw_message}"
                            </p>
                          </div>
                        )}

                        <div className="order-action-row">
                          <button
                            id={`modify-qty-feed-${order.id}`}
                            className="order-action-btn order-action-btn--modify"
                            onClick={() => openModifyModal(order)}
                            title="Modify quantity"
                          >
                            Modify Qty
                          </button>
                          <button
                            id={`delete-order-feed-${order.id}`}
                            className="order-action-btn order-action-btn--delete"
                            onClick={() => setDeleteTargetOrder(order)}
                            title="Delete order"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                    })}
                  </div>
                </div>
                )
              )}

              <section style={{ display: dashboardView === "insights" ? "block" : "none" }}>
                <div
                  className="viewfinder-card"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(240px, 320px) minmax(260px, 1fr)",
                    gap: 28,
                    alignItems: "center",
                    marginBottom: 12,
                  }}
                >
                  <div style={{ position: "relative", height: 240 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={customerDistribution}
                          dataKey="count"
                          nameKey="name"
                          innerRadius={72}
                          outerRadius={104}
                          paddingAngle={2}
                          stroke="var(--ink)"
                          strokeWidth={2}
                          isAnimationActive={false}
                        >
                          {customerDistribution.map((entry) => (
                            <Cell key={entry.id} fill={entry.fill} />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        pointerEvents: "none",
                      }}
                    >
                      <span className="font-mono-num" style={{ fontSize: 34, fontWeight: 600, lineHeight: 1 }}>
                        {loadingGlobalStats ? "—" : globalStats.totalProcessed}
                      </span>
                      <span className="label-caps" style={{ fontSize: 9, marginTop: 8 }}>
                        TOTAL ORDERS
                      </span>
                    </div>
                  </div>

                  <div>
                    <h3
                      className="font-display"
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "var(--muted-strong)",
                        margin: "0 0 14px",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                      }}
                    >
                      Order Distribution
                    </h3>
                    <div style={{ display: "grid", gap: 4 }}>
                      {customerDistribution.length === 0 ? (
                        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>No customer orders recorded</p>
                      ) : (
                        customerDistribution.map((customer, index) => (
                          <div key={customer.id} className="distribution-customer-row">
                            <span className="sidebar-customer-copy">
                              <span className="sidebar-customer-name-row">
                                <span
                                  className="distribution-rank-dot"
                                  style={{ background: customer.fill }}
                                  aria-hidden="true"
                                />
                                <span className="sidebar-customer-name">{customer.name}</span>
                              </span>
                              <span className="sidebar-customer-time font-mono-num">
                                #{index + 1} · {customer.percentage.toFixed(1)}%
                              </span>
                            </span>
                            <span
                              className="font-mono-num"
                              style={{ color: "var(--parchment)", fontSize: 12, fontWeight: 600 }}
                            >
                              {customer.count}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <section
                  style={{
                    display: "flex",
                    border: "1px solid var(--rule)",
                    borderRadius: 4,
                    overflow: "hidden",
                    background: "var(--ink)",
                  }}
                >
                  <div style={{ flex: 1, padding: "14px 20px", borderRight: "1px solid var(--rule)" }}>
                    <span className="label-caps">Most active customer</span>
                    <p className="font-mono-num" style={{ fontSize: 18, fontWeight: 600, margin: "4px 0 0" }}>
                      {mostActiveCustomer ? `${mostActiveCustomer.name} · ${mostActiveCustomer.count}` : "—"}
                    </p>
                  </div>
                  <div style={{ flex: 1, padding: "14px 20px", borderRight: "1px solid var(--rule)" }}>
                    <span className="label-caps">Highest deviation this week</span>
                    <p className="font-mono-num" style={{ fontSize: 18, fontWeight: 600, margin: "4px 0 0", color: "var(--rust)" }}>
                      {highestDeviationThisWeek
                        ? `${highestDeviationThisWeek.customerName} · ${highestDeviationThisWeek.multiple.toFixed(1)}x`
                        : "—"}
                    </p>
                  </div>
                  <div style={{ flex: 1, padding: "14px 20px" }}>
                    <span className="label-caps">Orders today</span>
                    <p className="font-mono-num" style={{ fontSize: 24, fontWeight: 600, margin: "4px 0 0" }}>
                      {loadingGlobalStats ? "—" : ordersTodayCount}
                    </p>
                  </div>
                </section>
              </section>
            </div>
          )}
        </main>
      </div>

      {/* ── Responsive sidebar overlay for mobile ── */}
      <button
        type="button"
        className="floating-place-order"
        ref={placeOrderButtonRef}
        onClick={() => setIsOrderModalOpen(true)}
      >
        <span className="floating-place-order__dot live-pulse" />
        <span>PLACE ORDER</span>
      </button>

      {isOrderModalOpen && (
        <div className="order-modal-overlay" onClick={closeOrderModal}>
          <div
            className="order-modal viewfinder-card"
            ref={orderModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="order-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="order-modal__close"
              onClick={closeOrderModal}
              aria-label="Close order modal"
            >
              ×
            </button>

            <h2 id="order-modal-title" className="font-display order-modal__title">Order on WhatsApp</h2>

            <p className="order-modal__copy">First time? Send this code to join:</p>
            <div className="order-modal__code font-mono-num">{whatsappJoinCode}</div>

            {!hasOpenedWhatsApp ? (
              <>
                <button type="button" className="order-modal__primary" onClick={() => handleOpenWhatsApp(true)}>
                  Open WhatsApp
                </button>
                <button type="button" className="order-modal__link" onClick={() => handleOpenWhatsApp(false)}>
                  Already joined? Place an order instead
                </button>
              </>
            ) : (
              <>
                <button type="button" className="order-modal__primary" onClick={() => handleOpenWhatsApp(false)}>
                  Place an order instead
                </button>
                <button type="button" className="order-modal__link" onClick={() => handleOpenWhatsApp(true)}>
                  Need to rejoin?
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {deleteTargetOrder && (
        <div className="action-modal-overlay" onClick={() => !deleteLoading && setDeleteTargetOrder(null)}>
          <div className="action-modal viewfinder-card" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="action-modal__close"
              onClick={() => setDeleteTargetOrder(null)}
              disabled={deleteLoading}
              aria-label="Close delete confirmation"
            >
              x
            </button>
            <h2 className="font-display action-modal__title">Delete Order</h2>
            <p className="action-modal__subtitle">
              Remove {deleteTargetOrder.quantity} {deleteTargetOrder.item} for{" "}
              {deleteTargetOrder.customers?.name || "this customer"} from the order log?
            </p>
            <div className="action-modal__btn-row">
              <button
                type="button"
                className="action-modal__btn action-modal__btn--cancel"
                onClick={() => setDeleteTargetOrder(null)}
                disabled={deleteLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                className="action-modal__btn action-modal__btn--primary-rust"
                onClick={() => handleDeleteOrder(deleteTargetOrder.id)}
                disabled={deleteLoading}
              >
                {deleteLoading ? (
                  <>
                    <span className="inline-spinner" />
                    Deleting
                  </>
                ) : (
                  "Delete"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {modifyTargetOrder && (
        <div className="action-modal-overlay" onClick={() => !modifyLoading && setModifyTargetOrder(null)}>
          <div className="action-modal viewfinder-card" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="action-modal__close"
              onClick={() => setModifyTargetOrder(null)}
              disabled={modifyLoading}
              aria-label="Close quantity editor"
            >
              x
            </button>
            <h2 className="font-display action-modal__title">Modify Quantity</h2>
            <p className="action-modal__subtitle">
              Update only the quantity for {modifyTargetOrder.item}. The customer will be notified on WhatsApp.
            </p>

            <div className="action-modal__field">
              <label className="action-modal__label" htmlFor="modify-order-quantity">
                Quantity
              </label>
              <input
                id="modify-order-quantity"
                className="action-modal__input font-mono-num"
                type="number"
                min="1"
                step="1"
                value={modifyQty}
                onChange={(event) => setModifyQty(event.target.value)}
                disabled={modifyLoading}
              />
            </div>

            <div className="action-modal__field">
              <label className="action-modal__label" htmlFor="modify-order-reason">
                Reason optional
              </label>
              <textarea
                id="modify-order-reason"
                className="action-modal__textarea"
                value={modifyReason}
                onChange={(event) => setModifyReason(event.target.value)}
                placeholder="Example: customer requested fewer units due to low stock space"
                disabled={modifyLoading}
              />
              <p className="action-modal__hint">
                Leave blank for a generic update. If filled, use a real reason the AI can summarize.
              </p>
            </div>

            {modifyError && <p className="action-modal__error">{modifyError}</p>}

            <p className="action-modal__ai-note">
              The AI will write a short customer-facing message, then the existing WhatsApp sender will notify the customer.
            </p>

            <div className="action-modal__btn-row">
              <button
                type="button"
                className="action-modal__btn action-modal__btn--cancel"
                onClick={() => setModifyTargetOrder(null)}
                disabled={modifyLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                className="action-modal__btn action-modal__btn--primary-teal"
                onClick={handleModifyQuantity}
                disabled={modifyLoading}
              >
                {modifyLoading ? (
                  <>
                    <span className="inline-spinner" />
                    Saving
                  </>
                ) : (
                  "Save"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 768px) {
          .sidebar-aside {
            width: 100% !important;
            border-right: none !important;
            border-bottom: 1px solid var(--rule);
            max-height: 240px;
          }
          main {
            padding: 0 16px 96px !important;
          }
        }
      `}</style>
    </div>
  );
}
