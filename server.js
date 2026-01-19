/**
 * OCPP 1.6J Central System (WS) + Internal REST API (HTTP)
 * - WebSocket endpoint:  /ocpp/:chargePointId
 * - Health:              GET  /health
 * - Internal API:
 *    GET  /api/connections
 *    POST /api/remote-start
 *    POST /api/remote-stop
 *
 * Security:
 * - All /api/* routes require header: x-internal-key: <INTERNAL_API_KEY>
 *
 * Railway:
 * - Set env INTERNAL_API_KEY in Railway Variables (recommended)
 * - Railway provides PORT automatically
 */

const http = require("http");
const WebSocket = require("ws");

/**
 * ==============================
 * CONFIG
 * ==============================
 */
const PORT = Number(process.env.PORT || 3000);

// Railway ENV overrides this. Keep a fallback for local dev ONLY.
const INTERNAL_API_KEY =
  process.env.INTERNAL_API_KEY || "ocpp_internal_7f3c9a2b4d8e6a91";

// Optional: allow only a specific WS subprotocol. Many chargers use "ocpp1.6".
// If your charger fails to connect, set WS_PROTOCOL to "" (empty) or remove check.
const WS_PROTOCOL = process.env.WS_PROTOCOL || "ocpp1.6";

// How long to wait for an OCPP CallResult after sending a command
const OCPP_TIMEOUT_MS = Number(process.env.OCPP_TIMEOUT_MS || 10000);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,x-internal-key",
};

/**
 * ==============================
 * STATE
 * ==============================
 */
const activeConnections = new Map(); // chargePointId -> ws
const pending = new Map(); // messageId -> { resolve, reject, timer }

/**
 * ==============================
 * HELPERS
 * ==============================
 */
function json(res, status, payload) {
  res.writeHead(status, { ...corsHeaders, "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function requireInternalKey(req, res) {
  const key = req.headers["x-internal-key"];
  if (!key || key !== INTERNAL_API_KEY) {
    json(res, 401, { success: false, message: "Unauthorized" });
    return false;
  }
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function waitForResult(messageId, timeoutMs = OCPP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(messageId);
      reject(new Error("Timeout waiting OCPP response"));
    }, timeoutMs);

    pending.set(messageId, { resolve, reject, timer });
  });
}

function genMessageId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * ==============================
 * HTTP SERVER
 * ==============================
 */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // Health
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return json(res, 200, {
      status: "online",
      service: "OCPP 1.6J Central System",
      uptime: process.uptime(),
      activeConnections: activeConnections.size,
      timestamp: new Date().toISOString(),
    });
  }

  // Protect internal API
  if (url.pathname.startsWith("/api/")) {
    if (!requireInternalKey(req, res)) return;
  }

  // List active connections
  if (req.method === "GET" && url.pathname === "/api/connections") {
    return json(res, 200, {
      connections: Array.from(activeConnections.keys()),
      count: activeConnections.size,
    });
  }

  // Remote Start Transaction
  if (req.method === "POST" && url.pathname === "/api/remote-start") {
    try {
      const { chargePointId, idTag = "REMOTE", connectorId = 1 } = await readJsonBody(req);

      if (!chargePointId) {
        return json(res, 400, { success: false, message: "chargePointId required" });
      }

      const ws = activeConnections.get(chargePointId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return json(res, 404, { success: false, message: "Charger not connected" });
      }

      const messageId = genMessageId("rs");
      const payload = { connectorId, idTag };
      const msg = [2, messageId, "RemoteStartTransaction", payload];

      ws.send(JSON.stringify(msg));

      const result = await waitForResult(messageId);
      const status = result?.status || "Unknown";

      return json(res, 200, {
        success: status === "Accepted",
        ocppStatus: status,
        result,
      });
    } catch (err) {
      return json(res, 500, { success: false, message: err.message });
    }
  }

  // Remote Stop Transaction
  if (req.method === "POST" && url.pathname === "/api/remote-stop") {
    try {
      const { chargePointId, transactionId } = await readJsonBody(req);

      if (!chargePointId || typeof transactionId !== "number") {
        return json(res, 400, { success: false, message: "chargePointId and numeric transactionId required" });
      }

      const ws = activeConnections.get(chargePointId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return json(res, 404, { success: false, message: "Charger not connected" });
      }

      const messageId = genMessageId("rst");
      const payload = { transactionId };
      const msg = [2, messageId, "RemoteStopTransaction", payload];

      ws.send(JSON.stringify(msg));

      const result = await waitForResult(messageId);
      const status = result?.status || "Unknown";

      return json(res, 200, {
        success: status === "Accepted",
        ocppStatus: status,
        result,
      });
    } catch (err) {
      return json(res, 500, { success: false, message: err.message });
    }
  }

  // 404
  return json(res, 404, { error: "Not Found" });
});

/**
 * ==============================
 * WEBSOCKET (OCPP)
 * ==============================
 */
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  // Expected: /ocpp/:chargePointId
  if (parts[0] !== "ocpp" || !parts[1]) {
    socket.destroy();
    return;
  }

  // Optional subprotocol check (can break some chargers if they use another token)
  if (WS_PROTOCOL) {
    const proto = req.headers["sec-websocket-protocol"];
    // header can contain multiple protocols separated by commas
    const protocols = proto ? proto.split(",").map((p) => p.trim()) : [];
    if (protocols.length && !protocols.includes(WS_PROTOCOL)) {
      // If charger did not request WS_PROTOCOL, reject upgrade
      socket.destroy();
      return;
    }
  }

  const chargePointId = parts[1];

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.chargePointId = chargePointId;
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const id = ws.chargePointId;

  // If a charger reconnects, replace old socket
  const existing = activeConnections.get(id);
  if (existing && existing.readyState === WebSocket.OPEN) {
    try {
      existing.close(1000, "Replaced by new connection");
    } catch {}
  }

  activeConnections.set(id, ws);
  console.log("CONNECTED:", id);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const [typeId, messageId] = msg;

    // CallResult: [3, messageId, payload]
    if (typeId === 3) {
      const entry = pending.get(messageId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(messageId);
        entry.resolve(msg[2]);
      }
      return;
    }

    // CallError: [4, messageId, errorCode, errorDescription, errorDetails]
    if (typeId === 4) {
      const entry = pending.get(messageId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(messageId);
        entry.reject(new Error(msg[2] || "OCPP Error"));
      }
      return;
    }

    // Calls from charger: [2, messageId, action, payload]
    if (typeId === 2) {
      const action = msg[2];
      const payload = msg[3] || {};

      // Minimal handlers to keep charger online
      if (action === "BootNotification") {
        // You can log vendor/model here:
        // payload.chargePointVendor, payload.chargePointModel
        ws.send(
          JSON.stringify([
            3,
            messageId,
            {
              status: "Accepted",
              currentTime: new Date().toISOString(),
              interval: 60,
            },
          ])
        );
        return;
      }

      if (action === "Heartbeat") {
        ws.send(
          JSON.stringify([
            3,
            messageId,
            {
              currentTime: new Date().toISOString(),
            },
          ])
        );
        return;
      }

      // For everything else, ACK with empty object to avoid breaking basic flows
      // (You can expand later: Authorize, StartTransaction, StopTransaction, MeterValues, StatusNotification...)
      ws.send(JSON.stringify([3, messageId, {}]));
      return;
    }
  });

  ws.on("close", () => {
    const current = activeConnections.get(id);
    if (current === ws) activeConnections.delete(id);
    console.log("DISCONNECTED:", id);
  });

  ws.on("error", (e) => {
    console.log("WS_ERROR:", id, e?.message || e);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OCPP Central running on port ${PORT}`);
  console.log(`WS endpoint: /ocpp/:chargePointId`);
});
