const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Allow image frame payloads

const PORT = process.env.PORT || 8080;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store sessions and latest camera live frames
const clients = new Map(); // clientId -> { offers: [], answers: [], candidates: [], frame: null, lastSeen: Date.now() }
const admins = new Map();

function getOrCreateSession(clientId) {
    if (!clients.has(clientId)) {
        clients.set(clientId, {
            clientId,
            offers: [],
            answers: [],
            candidates: [],
            frame: null,
            lastSeen: Date.now()
        });
    }
    return clients.get(clientId);
}

// Server Health & Status
app.get('/api/status', (req, res) => {
    res.json({
        server: 'Screen Monitor Online Server',
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
        hasFrame: !!c.frame,
        hasOffer: c.offers.length > 0,
        hasAnswer: c.answers.length > 0,
        lastSeen: c.lastSeen
    }));
    res.json(list);
});

// Client Uploads Live Camera Frame (JPEG Base64)
app.post('/api/feed', (req, res) => {
    const { clientId = 'default-camera', image } = req.body;
    if (!image) return res.status(400).json({ error: 'image data is required' });

    const session = getOrCreateSession(clientId);
    session.frame = image;
    session.lastSeen = Date.now();

    res.json({ success: true, clientId });
});

// Admin Fetches Latest Live Camera Frame
app.get('/api/feed/:clientId', (req, res) => {
    const { clientId } = req.params;
    const session = clients.get(clientId);
    if (!session || !session.frame) {
        return res.status(404).json({ error: 'No live frame available' });
    }
    res.json({ success: true, clientId, image: session.frame, timestamp: session.lastSeen });
});

// Client Posts SDP Offer
app.post('/api/offer', (req, res) => {
    const { clientId = 'default-camera', sdp } = req.body;
    if (!sdp) return res.status(400).json({ error: 'sdp is required' });

    const session = getOrCreateSession(clientId);
    session.offers.push(sdp);
    session.lastSeen = Date.now();

    console.log(`[REST] Offer received for client: ${clientId}`);
    res.json({ success: true, clientId });
});

// Admin Gets SDP Offer
app.get('/api/offer/:clientId', (req, res) => {
    const { clientId } = req.params;
    const session = clients.get(clientId);
    if (!session || session.offers.length === 0) {
        return res.status(404).json({ error: 'No offer available' });
    }
    const sdp = session.offers.shift();
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
    res.json({ success: true, clientId });
});

// Client Gets SDP Answer
app.get('/api/answer/:clientId', (req, res) => {
    const { clientId } = req.params;
    const session = clients.get(clientId);
    if (!session || session.answers.length === 0) {
        return res.status(404).json({ error: 'No answer available' });
    }
    const sdp = session.answers.shift();
    res.json({ success: true, clientId, sdp });
});

// WebSocket real-time relay
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const { type, clientId = 'default-camera', sdp, candidate, image } = data;

            if (type === 'frame') {
                const session = getOrCreateSession(clientId);
                session.frame = image;
                session.lastSeen = Date.now();
            }
        } catch (e) {}
    });
});

// Web UI Dashboard
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Screen Monitor Online Server</title>
    <style>
        body { background-color: #0b0f19; color: #f0f4f8; font-family: -apple-system, sans-serif; margin: 0; padding: 24px; }
        .card { background-color: #131a27; border: 1px solid #232f45; border-radius: 12px; padding: 20px; max-width: 800px; margin: 0 auto 16px; }
        h1 { font-size: 20px; color: #00e5ff; margin-top: 0; }
        .badge { background: #00c853; color: #000; font-weight: bold; padding: 4px 10px; border-radius: 12px; font-size: 12px; }
        img { width: 100%; max-width: 640px; border-radius: 8px; border: 1px solid #232f45; margin-top: 12px; display: block; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Screen Monitor Online Server</h1>
        <p><span class="badge">ONLINE</span> Server URL: https://webrtc-1zgo.onrender.com</p>
        <p>Active Camera Clients: ${clients.size}</p>
        <h3>Live Monitor Preview</h3>
        <img id="livePreview" src="" alt="Awaiting camera client stream..." />
    </div>

    <script>
        setInterval(async () => {
            try {
                const res = await fetch('/api/feed/default-camera');
                if (res.ok) {
                    const data = await res.json();
                    if (data.image) {
                        document.getElementById('livePreview').src = 'data:image/jpeg;base64,' + data.image;
                    }
                }
            } catch (e) {}
        }, 800);
    </script>
</body>
</html>
    `);
});

server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
