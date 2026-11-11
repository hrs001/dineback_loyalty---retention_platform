"use client";

import { useCallback, useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const STOREFRONT_KEY = "dev-storefront-key";
const ADMIN_KEY = "dev-admin-key";

interface OrderThread {
  order: {
    _id: string;
    tenantId: string;
    customerId: string;
    channel: string;
    items: { name: string; price: number; qty: number }[];
    amount: number;
    status: "received" | "routed";
    createdAt: string;
  };
  ledger: { type: string; points: number; createdAt: string }[];
  decision: {
    agentType: string;
    payload: { action: string; tone: string; offerType: string; requiresApproval: boolean };
    reasoning: string;
    status: string;
  } | null;
  balance: number;
}

const WS_URL = API_URL.replace(/^http/, "ws");
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000]; // 1s/2s/4s, capped at 8s

interface EvalSummary {
  ranAt: string | null;
  total?: number;
  passed?: number;
  passRate?: number;
}

interface PendingDecision {
  _id: string;
  payload: {
    customerId: string;
    action: string;
    tone: string;
    offerType: string;
    offerValue: number;
  };
  reasoning: string;
  timestamp: string;
}

interface Metrics {
  webhook: { total: number; succeeded: number; successRate: number | null };
  eventLag: { sampleSize: number; avgLagMs: number | null };
}

interface OrderSummary {
  _id: string;
  customerId: string;
  channel: string;
  amount: number;
  status: "received" | "routed";
}

const ORDERS_PAGE_SIZE = 12;

interface AuditDecision {
  status: "completed" | "failed";
  payload: {
    pageSpeedScore: number;
    mobileUsabilityScore: number;
    structuredDataScore: number;
    menuCompletenessScore: number;
    fixes: string[];
    artifactRef?: string;
  };
  reasoning: string;
}

export default function Home() {
  const [orderId, setOrderId] = useState<string | null>(null);
  const [thread, setThread] = useState<OrderThread | null>(null);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const placeOrder = useCallback(async () => {
    setPlacing(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-storefront-key": STOREFRONT_KEY },
        body: JSON.stringify({
          customerId: `cust_${Math.random().toString(36).slice(2, 8)}`,
          items: [{ name: "Jollof Rice", price: 15, qty: 2 }],
        }),
      });
      if (!res.ok) throw new Error(`order failed: ${res.status}`);
      const data = await res.json();
      setOrderId(data.order._id);
      setThread(null);
      setShowActivity(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setPlacing(false);
    }
  }, []);

  const [seedingStale, setSeedingStale] = useState(false);
  const [seedingApproval, setSeedingApproval] = useState(false);
  const [seedMessage, setSeedMessage] = useState<string | null>(null);

  /**
   * Demo-only: seeds backdated order history and immediately triggers the
   * real batch sweep, instead of waiting on its 24h schedule — see
   * POST /admin/retention/seed-stale.
   */
  const seedStaleOrders = useCallback(async () => {
    setSeedingStale(true);
    setSeedMessage(null);
    try {
      const res = await fetch(`${API_URL}/admin/retention/seed-stale`, {
        method: "POST",
        headers: { "x-admin-key": ADMIN_KEY },
      });
      if (!res.ok) throw new Error(`seed failed: ${res.status}`);
      const data = await res.json();
      setSeedMessage(`Seeded ${data.seeded} stale orders. Retention sweep running, check back in a few seconds.`);
    } catch (e) {
      setSeedMessage(e instanceof Error ? e.message : "unknown error");
    } finally {
      setSeedingStale(false);
    }
  }, []);

  /**
   * Demo-only: seeds one customer biased toward tripping the approval
   * guardrail, for exercising the pending-approval card — not a guarantee,
   * the LLM still decides the offer itself. See POST /admin/retention/seed-approval.
   */
  const seedApprovalScenario = useCallback(async () => {
    setSeedingApproval(true);
    setSeedMessage(null);
    try {
      const res = await fetch(`${API_URL}/admin/retention/seed-approval`, {
        method: "POST",
        headers: { "x-admin-key": ADMIN_KEY },
      });
      if (!res.ok) throw new Error(`seed failed: ${res.status}`);
      setSeedMessage("Seeded a high-value lapsed customer. Check the Retention agent tile in a few seconds.");
    } catch (e) {
      setSeedMessage(e instanceof Error ? e.message : "unknown error");
    } finally {
      setSeedingApproval(false);
    }
  }, []);

  const [wsStatus, setWsStatus] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [evalSummary, setEvalSummary] = useState<EvalSummary | null>(null);
  const [pending, setPending] = useState<PendingDecision[]>([]);
  const [showActivity, setShowActivity] = useState(false);

  // Slice 3 eval scorecard (Selective Expansion 3, reuses this shell) —
  // "not run" is a real state, never a blank panel (Test Plan's empty-state case).
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/eval-results`);
        if (res.ok && !cancelled) setEvalSummary(await res.json());
      } catch {
        // transient — next poll retries
      }
    };
    poll();
    const interval = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Slice 5 observability — webhook success rate + event lag, the 2
  // metrics the design doc calls for. Real numbers (in-memory counters +
  // a Mongo aggregation on the API side), not a fabricated sparkline.
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/metrics`, { headers: { "x-admin-key": ADMIN_KEY } });
        if (res.ok && !cancelled) setMetrics(await res.json());
      } catch {
        // transient — next poll retries
      }
    };
    poll();
    const interval = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Slice 3 approval queue (Locked Contract #3) — decisions above the
  // guardrail threshold wait here until an admin approves or rejects them.
  const refreshPending = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/admin/retention/pending`, {
        headers: { "x-admin-key": ADMIN_KEY },
      });
      if (res.ok) setPending((await res.json()).pending);
    } catch {
      // transient — next poll retries
    }
  }, []);

  useEffect(() => {
    refreshPending();
    const interval = setInterval(refreshPending, 5_000);
    return () => clearInterval(interval);
  }, [refreshPending]);

  const actOnApproval = useCallback(
    async (id: string, action: "approve" | "reject") => {
      await fetch(`${API_URL}/admin/retention/${id}/${action}`, {
        method: "POST",
        headers: { "x-admin-key": ADMIN_KEY },
      });
      refreshPending();
    },
    [refreshPending]
  );

  // Slice 4 (subsystem D) — async crawl job + status endpoint, reusing C's
  // agent-decision-log/guardrailed-writeup plumbing (platform-coherence
  // framing, not its own bounded-autonomy story).
  const [auditUrl, setAuditUrl] = useState("https://example.com");
  const [auditRunning, setAuditRunning] = useState(false);
  const [auditResult, setAuditResult] = useState<AuditDecision | null>(null);

  const runAudit = useCallback(async () => {
    setAuditRunning(true);
    setAuditResult(null);
    try {
      const res = await fetch(`${API_URL}/admin/audit/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
        body: JSON.stringify({ url: auditUrl }),
      });
      if (!res.ok) throw new Error(`audit request failed: ${res.status}`);
      const { jobId } = await res.json();

      for (let i = 0; i < 100; i++) {
        const statusRes = await fetch(`${API_URL}/admin/audit/${jobId}/status`, {
          headers: { "x-admin-key": ADMIN_KEY },
        });
        const body = await statusRes.json();
        if (body.state === "completed" || body.state === "failed") {
          setAuditResult(body.decision ?? null);
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } finally {
      setAuditRunning(false);
    }
  }, [auditUrl]);

  // Slice 2: live push over WebSocket, replacing Slice 0's 1s poll. The
  // storefront key travels as a query param (browsers can't set custom
  // headers on the WS handshake) — see resolveTenantFromStorefrontKeyQuery.
  // Reconnects with 1s/2s/4s/cap-8s backoff if the connection drops mid-demo.
  useEffect(() => {
    if (!orderId) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (cancelled) return;
      setWsStatus(attempt === 0 ? "connecting" : "reconnecting");
      socket = new WebSocket(
        `${WS_URL}/orders/${orderId}/thread/ws?key=${STOREFRONT_KEY}`
      );

      socket.onopen = () => {
        attempt = 0;
        setWsStatus("live");
      };
      socket.onmessage = (event) => {
        if (!cancelled) setThread(JSON.parse(event.data));
      };
      socket.onclose = () => {
        if (cancelled) return;
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
        attempt += 1;
        setWsStatus("reconnecting");
        reconnectTimer = setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [orderId]);

  // Live all-orders feed, backing the full-width order thread table below.
  // Same reconnect-with-backoff shape as the single-order thread WS above.
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [ordersFeedStatus, setOrdersFeedStatus] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (cancelled) return;
      setOrdersFeedStatus(attempt === 0 ? "connecting" : "reconnecting");
      socket = new WebSocket(`${WS_URL}/orders/feed/ws?key=${STOREFRONT_KEY}`);
      socket.onopen = () => {
        attempt = 0;
        setOrdersFeedStatus("live");
      };
      socket.onmessage = (event) => {
        if (!cancelled) setOrders(JSON.parse(event.data).orders);
      };
      socket.onclose = () => {
        if (cancelled) return;
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
        attempt += 1;
        setOrdersFeedStatus("reconnecting");
        reconnectTimer = setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  const pageCount = Math.max(1, Math.ceil(orders.length / ORDERS_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageOrders = orders.slice(currentPage * ORDERS_PAGE_SIZE, currentPage * ORDERS_PAGE_SIZE + ORDERS_PAGE_SIZE);

  const activityCount = (thread?.decision ? 1 : 0) + pending.length;

  return (
    <>
      <header className="topbar">
        <div className="brand">loop</div>
        <div className="spacer"></div>
        <div className="env">
          <span className={`dot${wsStatus === "live" ? "" : " warn"}`}></span>
          rest_demo · {wsStatus === "live" ? "live" : wsStatus === "reconnecting" ? "reconnecting" : "connecting"}
        </div>
      </header>

      <main className="shell">
        <h2 className="section-title">System overview</h2>
        <div className="kpi-grid">
          <div className="kpi">
            <div className="top-row">
              <span className="label">Selected order</span>
              {thread && <span className="delta good">{thread.order.customerId}</span>}
            </div>
            <div className="val">
              {thread ? thread.balance : "—"}
              {thread && <small> pts</small>}
            </div>
            {thread ? (
              <div className="kpi-secondary">
                <span className={`badge badge-${thread.order.status}`}>{thread.order.status}</span>
                <span className="mono">{thread.order._id.slice(0, 8)}</span>
              </div>
            ) : (
              <div className="note">Place or select an order to see its balance + status.</div>
            )}
          </div>

          <div className="kpi">
            <div className="top-row">
              <span className="label">Retention agent</span>
              <span className={`delta ${pending.length > 0 ? "warn" : "good"}`}>
                {pending.length > 0 ? "needs review" : "clear"}
              </span>
            </div>
            <div className="val">{pending.length}</div>
            <div className="kpi-secondary">
              <span>eval:</span>
              {evalSummary?.ranAt ? (
                <span className="mono">
                  {evalSummary.passed}/{evalSummary.total} ({((evalSummary.passRate ?? 0) * 100).toFixed(0)}%)
                </span>
              ) : (
                <span>not run yet</span>
              )}
            </div>
          </div>

          <div className="kpi">
            <div className="top-row">
              <span className="label">Webhook success</span>
              {metrics && metrics.webhook.successRate !== null && (
                <span className={`delta ${metrics.webhook.successRate === 1 ? "good" : "warn"}`}>
                  {(metrics.webhook.successRate * 100).toFixed(0)}%
                </span>
              )}
            </div>
            <div className="val">
              {metrics && metrics.webhook.total > 0 ? (
                <>
                  {metrics.webhook.succeeded}
                  <small> / {metrics.webhook.total}</small>
                </>
              ) : (
                "—"
              )}
            </div>
            <div className="note">since this API process started</div>
          </div>

          <div className="kpi">
            <div className="top-row">
              <span className="label">Event lag</span>
            </div>
            <div className="val">
              {metrics?.eventLag.avgLagMs != null ? (
                <>
                  {metrics.eventLag.avgLagMs}
                  <small> ms</small>
                </>
              ) : (
                "—"
              )}
            </div>
            <div className="note">
              {metrics && metrics.eventLag.sampleSize > 0
                ? `avg over last ${metrics.eventLag.sampleSize} events`
                : "no events processed yet"}
            </div>
          </div>
        </div>

        <div className="panel" style={{ marginBottom: 20 }}>
          <div className="panel-head">
            <h3>Demo controls</h3>
            <span className="muted mono" style={{ fontSize: 11 }}>real orders · real Gemini calls</span>
          </div>
          <div className="panel-body">
            <div className="actions-row">
              <button onClick={placeOrder} disabled={placing}>
                {placing ? "Placing…" : "Place a demo order"}
              </button>
              <div className="actions-divider" />
              <button className="ghost" onClick={seedStaleOrders} disabled={seedingStale}>
                {seedingStale ? "Seeding…" : "Seed stale orders (win-back)"}
              </button>
              <button className="ghost" onClick={seedApprovalScenario} disabled={seedingApproval}>
                {seedingApproval ? "Seeding…" : "Seed high-value lapsed customer"}
              </button>
            </div>
            <div className="actions-hint">
              Seed buttons backdate order history and immediately trigger the retention batch sweep, which normally runs on a 24h schedule.
            </div>
            {error && <p className="error-text">{error}</p>}
            {seedMessage && <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>{seedMessage}</p>}
          </div>
        </div>

        <div className="panel" style={{ marginBottom: 20, position: "relative" }}>
          <div className="panel-head">
            <h3>Order thread</h3>
            <span className="muted mono" style={{ fontSize: 11 }}>
              {ordersFeedStatus === "live" ? "● live" : ordersFeedStatus === "reconnecting" ? "○ reconnecting…" : "○ connecting…"}{" "}
              · {orders.length} orders
            </span>
          </div>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Channel</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pageOrders.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted" style={{ textAlign: "center", padding: "28px 18px" }}>
                      No orders yet. Place a demo order to start.
                    </td>
                  </tr>
                )}
                {pageOrders.map((o) => (
                  <tr
                    key={o._id}
                    className={`clickable ${orderId === o._id ? "selected" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setOrderId(o._id);
                      setShowActivity(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        setOrderId(o._id);
                        setShowActivity(true);
                      }
                    }}
                  >
                    <td>{o._id.slice(0, 8)}</td>
                    <td>{o.customerId}</td>
                    <td>
                      <span className={`chan-pill ${o.channel}`}>{o.channel}</span>
                    </td>
                    <td>${o.amount}</td>
                    <td>
                      <span className={`badge badge-${o.status}`}>{o.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {orders.length > ORDERS_PAGE_SIZE && (
            <div className="pagination">
              <button className="secondary" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={currentPage === 0}>
                Prev
              </button>
              <span className="muted mono" style={{ fontSize: 11.5 }}>
                page {currentPage + 1} of {pageCount}
              </span>
              <button
                className="secondary"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={currentPage === pageCount - 1}
              >
                Next
              </button>
            </div>
          )}
          {thread && (
            <div className="panel-body" style={{ borderTop: "1px solid var(--border)" }}>
              <div className="order-row">
                <span className="mono">{thread.order._id}</span>
                <span className={`badge badge-${thread.order.status}`}>{thread.order.status}</span>
              </div>
              <div className="order-meta mono">
                {thread.order.customerId} · ${thread.order.amount} ·{" "}
                <span className={`chan-pill ${thread.order.channel}`}>{thread.order.channel}</span>
              </div>
              <div className="scroll-x" style={{ marginTop: 12 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Ledger entry</th>
                      <th>Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {thread.ledger.length === 0 && (
                      <tr>
                        <td colSpan={2} className="muted">
                          No entries yet.
                        </td>
                      </tr>
                    )}
                    {thread.ledger.map((entry, i) => (
                      <tr key={i}>
                        <td>{entry.type}</td>
                        <td>+{entry.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {showActivity && (
            <div className="agent-tooltip">
              <div className="panel-head">
                <h3>Agent activity</h3>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="muted mono" style={{ fontSize: 11 }}>{activityCount} entries</span>
                  <button className="tooltip-close" onClick={() => setShowActivity(false)} aria-label="Close">
                    ×
                  </button>
                </div>
              </div>
              <div className="agent-tooltip-body">
                {activityCount === 0 && <div className="empty-state">No agent decisions yet.</div>}

                {thread?.decision && (
                  <div className="feed-item">
                    <div className="who">
                      {thread.order.customerId}
                      <span className={`badge badge-${thread.decision.status}`}>{thread.decision.status}</span>
                    </div>
                    <div className="meta">
                      retention · {thread.decision.payload.action} · {thread.decision.payload.tone} ·{" "}
                      {thread.decision.payload.offerType}
                    </div>
                    <div className="reason">{thread.decision.reasoning}</div>
                  </div>
                )}

                {pending.map((d) => (
                  <div className="feed-item" key={d._id}>
                    <div className="who">
                      {d.payload.customerId}
                      <span className="badge badge-pending_approval">pending_approval</span>
                    </div>
                    <div className="meta">
                      retention · {d.payload.action} · {d.payload.tone} · {d.payload.offerType} {d.payload.offerValue}
                    </div>
                    <div className="reason">{d.reasoning}</div>
                    <div className="actions">
                      <button onClick={() => actOnApproval(d._id, "approve")}>Approve</button>
                      <button className="secondary" onClick={() => actOnApproval(d._id, "reject")}>
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3>Storefront audit: subsystem D</h3>
            <span className="muted mono" style={{ fontSize: 11 }}>PageSpeed Insights + heuristics</span>
          </div>
          <div className="panel-body">
            <div className="field-row" style={{ marginBottom: 14 }}>
              <input
                value={auditUrl}
                onChange={(e) => setAuditUrl(e.target.value)}
                placeholder="https://a-restaurant-site.com"
              />
              <button onClick={runAudit} disabled={auditRunning}>
                {auditRunning ? "Crawling…" : "Run audit"}
              </button>
            </div>

            {!auditResult && !auditRunning && <p className="muted">No audit run yet.</p>}

            {auditResult && (
              <>
                <div className="subscore-grid">
                  <div>
                    <div className="v">{auditResult.payload.pageSpeedScore}</div>
                    <div className="l">page speed</div>
                  </div>
                  <div>
                    <div className="v">{auditResult.payload.mobileUsabilityScore}</div>
                    <div className="l">mobile usability</div>
                  </div>
                  <div>
                    <div className="v">{auditResult.payload.structuredDataScore}</div>
                    <div className="l">structured data</div>
                  </div>
                  <div>
                    <div className="v">{auditResult.payload.menuCompletenessScore}</div>
                    <div className="l">menu complete</div>
                  </div>
                </div>
                {auditResult.payload.fixes.map((fix, i) => (
                  <p key={i} className="fix-item">
                    • {fix}
                  </p>
                ))}
                <p className="muted" style={{ fontSize: 13 }}>
                  {auditResult.reasoning}
                </p>
                {auditResult.payload.artifactRef && (
                  <p className="muted mono" style={{ fontSize: 12, marginTop: 10 }}>
                    artifact: {auditResult.payload.artifactRef}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
