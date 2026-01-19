const http = require('http');
const WebSocket = require('ws');

/**
 * ==============================
 * CONFIG
 * ==============================
 */
const PORT = Number(process.env.PORT || 3000);

// 🔐 API KEY
// Railway irá sobrescrever via ENV
const INTERNAL_API_KEY =
  process.env.INTERNAL_API_KEY || 'ocpp_internal_7f3c9a2b4d8e6a91';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,x-internal-key',
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
function requireInternalKey(req, res) {
  const key = req.headers['x-internal-key'];
  if (!key || key !== INTERNAL_API_KEY) {
    res.writeHead(401, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
    return false;
  }
  return true;
}

function waitForResult(messageId, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(messageId);
      reject(new Error('Timeout waiting OCPP response'));
    }, timeoutMs);

    pending.set(messageId, { resolve, reject, timer });
  });
}

function json(res, status, payload) {
  res.writeHead(status, { ...corsHeaders, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * ==============================
 * HTTP SERVER
 * ==============================
 */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // Health
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return json(res, 200, {
      status: 'online',
      service: 'OCPP 1.6J Central System',
      uptime: process.uptime(),
      activeConnections: activeConnections.size,
      timestamp: new Date().toISOString(),
    });
  }

  // Protect API
  if (url.pathname.startsWith('/api/')) {
    if (!requireInternalKey(req, res)) return;
  }

  // Read JSON body
  const readBody = () =>
    new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          reject(e);
        }
      });
    });

  // List connections
  if (req.method === 'GET' && url.pathname === '/api/connections') {
    return json(res, 200, {
      connections: Array.from(activeConnections.keys()),
      count: activeConnections.size,
    });
  }

  // Remote Start
  if (req.method === 'POST' && url.pathname === '/api/remote-start') {
    try {
      const { chargePointId, idTag = 'REMOTE', connectorId = 1 } = await readBody();
      if (!chargePointId) return json(res, 400, { success: false, message: 'chargePointId required' });

      const ws = activeConnections.get(chargePointId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return json(res, 404, { success: false, message: 'Charger not connected' });
      }

      const messageId = `rs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      ws.send(JSON.stringify([2, messageId, 'RemoteStartTransaction', { connectorId, idTag }]));

      const result = await waitForResult(messageId);
      const status = result?.status || 'Unknown';

      return json(res, 200, {
        success: status === 'Accepted',
        ocppStatus: status,
      });
    } catch (err) {
      return json(res, 500, { success: false, message: err.message });
    }
  }

  // Remote Stop
  if (req.method === 'POST' && url.pathname === '/api/remote-stop') {
    try {
      const { chargePointId, transactionId } = await readBody();
      if (!chargePointId || typeof transactionId !== 'number') {
        return json(res, 400, { success: false, message: 'Invalid payload' });
      }

      const ws = activeConnections.get(chargePointId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return json(res, 404, { success: false, message: 'Charger not connected' });
      }

      const messageId = `rst-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      ws.send(JSON.stringify([2, messageId, 'RemoteStopTransaction', { transactionId }]));

      const result = await waitForResult(messageId);
      const status = result?.status || 'Unknown';

      return json(res, 200, {
        success: status === 'Accepted',
        ocppStatus: status,
      });
    } catch (err) {
      return json(res, 500, { success: false, message: err.message });
    }
  }

  return json(res, 404, { error: 'Not Found' });
});

/**
 * ==============================
 * WEBSOCKET (OCPP)
 * ==============================
 */
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'ocpp' || !parts[1]) {
    socket.destroy();
    return;
  }

  const chargePointId = parts[1];

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.chargePointId = chargePointId;
    wss.emit('connection', ws);
  });
});

wss.on('connection', (ws) => {
  const id = ws.chargePointId;
  activeConnections.set(id, ws);
  console.log('CONNECTED:', id);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const [typeId, messageId] = msg;

    // CallResult
    if (typeId === 3) {
      const entry = pending.get(messageId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(messageId);
        entry.resolve(msg[2]);
      }
      return;
    }

    // CallError
    if (typeId === 4) {
      const entry = pending.get(messageId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(messageId);
        entry.reject(new Error(msg[2] || 'OCPP Error'));
      }
      return;
    }

    // Calls from charger
    if (typeId === 2) {
      const action = msg[2];

      if (action === 'BootNotification') {
        ws.send(JSON.stringify([3, messageId, {
          status: 'Accepted',
          currentTime: new Date().toISOString(),
          interval: 60,
        }]));
      } else if (action === 'Heartbeat') {
        ws.send(JSON.stringify([3, messageId, {
          currentTime: new Date().toISOString(),
        }]));
      } else {
        ws.send(JSON.stringify([3, messageId, {}]));
      }
    }
  });

  ws.on('close', () => {
    activeConnections.delete(id);
    console.log('DISCONNECTED:', id);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OCPP Central running on port ${PORT}`);
});
