const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// In-memory state store for WebRTC sessions
const clients = new Map(); // clientId -> { ws, offers: [], answers: [], candidates: [], status: 'ONLINE' }
const admins = new Map();  // adminId  -> { ws }

// Utility to get or create client session
function getOrCreateSession(clientId) {
    if (!clients.has(clientId)) {
        clients.set(clientId, {
            clientId,
            offers: [],
            answers: [],
            candidates: [],
            status: 'ONLINE',
            lastSeen: Date.now()
        });
    }
    return clients.get(clientId);
}

// ==========================================
// REST API Signaling & Status Endpoints
// ==========================================

// Server Health & Status
app.get('/api/status', (req, res) => {
    res.json({
        server: 'Screen Monitor Online Signaling Server',
        status: 'ONLINE',
        connectedClients: clients.size,
        connectedAdmins: admins.size,
        uptime: process.uptime()
    });
});

// List Active Camera Clients
app.get('/api/clients', (req, res) => {
    const list = Array.from(clients.values()).map(c => ({
        clientId: c.clientId,
        status: c.status,
        hasOffer: c.offers.length > 0,
        hasAnswer: c.answers.length > 0,
        lastSeen: c.lastSeen
    }));
    res.json(list);
});

// Client Posts SDP Offer
app.post('/api/offer', (req, res) => {
    const { clientId = 'default-camera', sdp } = req.body;
    if (!sdp) return res.status(400).json({ error: 'sdp is required' });

    const session = getOrCreateSession(clientId);
    session.offers.push(sdp);
    session.lastSeen = Date.now();

    console.log(`[REST] Offer received for client: ${clientId}`);
    res.json({ success: true, clientId, message: 'Offer stored successfully' });
});

// Admin Gets SDP Offer
app.get('/api/offer/:clientId', (req, res) => {
    const { clientId } = req.params;
    const session = clients.get(clientId);
    if (!session || session.offers.length === 0) {
        return res.status(404).json({ error: 'No offer available for this client' });
    }
    const sdp = session.offers.shift(); // Consume offer
    res.json({ success: true, clientId, sdp });
});

// Admin Posts SDP Answer
app.post('/api/answer', (req, res) => {
    const { clientId = 'default-camera', sdp } = req.body;
    if (!sdp) return res.status(400).json({ error: 'sdp is required' });

    const session = getOrCreateSession(clientId);
    session.answers.push(sdp);
    session.lastSeen = Date.now();

    console.log(`[REST] Answer received for client: ${clientId}`);
    res.json({ success: true, clientId, message: 'Answer stored successfully' });
});

// Client Gets SDP Answer
app.get('/api/answer/:clientId', (req, res) => {
    const { clientId } = req.params;
    const session = clients.get(clientId);
    if (!session || session.answers.length === 0) {
        return res.status(404).json({ error: 'No answer available yet' });
    }
    const sdp = session.answers.shift(); // Consume answer
    res.json({ success: true, clientId, sdp });
});

// Post ICE Candidate
app.post('/api/candidate', (req, res) => {
    const { clientId = 'default-camera', candidate } = req.body;
    if (!candidate) return res.status(400).json({ error: 'candidate is required' });

    const session = getOrCreateSession(clientId);
    session.candidates.push(candidate);
    res.json({ success: true, clientId });
});

// Get ICE Candidates
app.get('/api/candidates/:clientId', (req, res) => {
    const { clientId } = req.params;
    const session = clients.get(clientId);
    if (!session) return res.json([]);
    const candidates = [...session.candidates];
    session.candidates = []; // Clear retrieved candidates
    res.json(candidates);
});


// ==========================================
// Real-time WebSocket Signaling
// ==========================================

wss.on('connection', (ws) => {
    let clientRole = null;
    let registeredId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const { type, clientId = 'default-camera', sdp, candidate } = data;

            switch (type) {
                case 'register-camera':
                    clientRole = 'camera';
                    registeredId = clientId;
                    getOrCreateSession(clientId).ws = ws;
                    console.log(`[WS] Camera client registered: ${clientId}`);
                    ws.send(JSON.stringify({ type: 'registered', role: 'camera', clientId }));
                    break;

                case 'register-admin':
                    clientRole = 'admin';
                    registeredId = clientId;
                    admins.set(ws, clientId);
                    console.log(`[WS] Admin client registered for target: ${clientId}`);
                    ws.send(JSON.stringify({ type: 'registered', role: 'admin', clientId }));
                    break;

                case 'offer':
                    console.log(`[WS] Relay Offer from Camera -> Admin (${clientId})`);
                    const cameraSession = getOrCreateSession(clientId);
                    cameraSession.offers.push(sdp);
                    // Broadcast to admins watching this clientId
                    broadcastToAdmins(clientId, { type: 'offer', clientId, sdp });
                    break;

                case 'answer':
                    console.log(`[WS] Relay Answer from Admin -> Camera (${clientId})`);
                    const session = getOrCreateSession(clientId);
                    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                        session.ws.send(JSON.stringify({ type: 'answer', clientId, sdp }));
                    }
                    break;

                case 'ice-candidate':
                    console.log(`[WS] Relay ICE Candidate for ${clientId}`);
                    if (clientRole === 'camera') {
                        broadcastToAdmins(clientId, { type: 'ice-candidate', clientId, candidate });
                    } else if (clientRole === 'admin') {
                        const targetSession = clients.get(clientId);
                        if (targetSession && targetSession.ws && targetSession.ws.readyState === WebSocket.OPEN) {
                            targetSession.ws.send(JSON.stringify({ type: 'ice-candidate', clientId, candidate }));
                        }
                    }
                    break;
            }
        } catch (err) {
            console.error('[WS] Message error:', err.message);
        }
    });

    ws.on('close', () => {
        if (clientRole === 'camera' && registeredId) {
            console.log(`[WS] Camera disconnected: ${registeredId}`);
            clients.delete(registeredId);
        } else if (clientRole === 'admin') {
            admins.delete(ws);
        }
    });
});

function broadcastToAdmins(targetClientId, payload) {
    const msg = JSON.stringify(payload);
    for (const [ws, targetId] of admins.entries()) {
        if (targetId === targetClientId && ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        }
    }
}

// ==========================================
// Web Dashboard UI
// ==========================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Screen Monitor Signaling Server</title>
    <style>
        body { background-color: #0b0f19; color: #f0f4f8; font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; }
        .card { background-color: #131a27; border: 1px solid #232f45; border-radius: 12px; padding: 20px; max-width: 800px; margin: 0 auto 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        h1 { font-size: 20px; color: #00e5ff; margin-top: 0; }
        .badge { display: inline-block; background: #00c853; color: #000; font-weight: bold; padding: 4px 10px; border-radius: 12px; font-size: 12px; }
        .endpoint { background: #090d15; padding: 10px; border-radius: 6px; font-family: monospace; font-size: 13px; color: #8d9bb0; margin: 6px 0; border: 1px solid #1e293b; }
        .method { color: #0084ff; font-weight: bold; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Screen Monitor Online Signaling Server</h1>
        <p><span class="badge">ONLINE</span> Server is running and ready for remote WebRTC connections.</p>
        <p><strong>Connected Camera Clients:</strong> <span id="clientCount">${clients.size}</span></p>
        <p><strong>Connected Admin Monitors:</strong> <span id="adminCount">${admins.size}</span></p>
    </div>

    <div class="card">
        <h2>WebRTC Signaling REST Endpoints</h2>
        <div class="endpoint"><span class="method">GET</span> /api/status - Check server health & active client counts</div>
        <div class="endpoint"><span class="method">GET</span> /api/clients - List online camera client IDs</div>
        <div class="endpoint"><span class="method">POST</span> /api/offer - Send WebRTC SDP Offer from Camera Client</div>
        <div class="endpoint"><span class="method">GET</span> /api/offer/:clientId - Fetch WebRTC SDP Offer for Admin</div>
        <div class="endpoint"><span class="method">POST</span> /api/answer - Send WebRTC SDP Answer from Admin</div>
        <div class="endpoint"><span class="method">GET</span> /api/answer/:clientId - Fetch WebRTC SDP Answer for Camera Client</div>
        <div class="endpoint"><span class="method">POST</span> /api/candidate - Relay WebRTC ICE Candidates</div>
    </div>
</body>
</html>
    `);
});

// Start listening
server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(` Screen Monitor WebRTC Signaling Server Started!`);
    console.log(` Server URL: http://localhost:${PORT}`);
    console.log(` WebSocket URL: ws://localhost:${PORT}`);
    console.log(`====================================================`);
});
