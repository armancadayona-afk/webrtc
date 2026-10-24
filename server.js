const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8080;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map(); // clientId -> { frame: null, command: null, lastSeen: Date.now() }

function getOrCreateSession(clientId) {
    if (!clients.has(clientId)) {
        clients.set(clientId, {
            clientId,
            frame: null,
            command: null,
            lastSeen: Date.now()
        });
    }
    return clients.get(clientId);
}

// Server Health
app.get('/api/status', (req, res) => {
    res.json({
        server: 'Screen Monitor Fast Server',
        status: 'ONLINE',
        activeClients: clients.size,
        uptime: process.uptime()
    });
});

// Client Uploads Fast Resolution Live Frame
app.post('/api/feed', (req, res) => {
    const { clientId = 'default-camera', image } = req.body;
    if (!image) return res.status(400).json({ error: 'image required' });

    const session = getOrCreateSession(clientId);
    session.frame = image;
    session.lastSeen = Date.now();

    res.json({ success: true, pendingCommand: session.command });
});

// Admin Fetches Fast Resolution Live Frame
app.get('/api/feed/:clientId', (req, res) => {
    const { clientId } = req.params;
    const session = clients.get(clientId);
    if (!session || !session.frame) {
        return res.status(404).json({ error: 'No live frame' });
    }
    res.json({ success: true, image: session.frame, timestamp: session.lastSeen });
});

// Admin Sends Remote Camera Command (e.g. switch-lens, mute, stop)
app.post('/api/control', (req, res) => {
    const { clientId = 'default-camera', command } = req.body;
    if (!command) return res.status(400).json({ error: 'command required' });

    const session = getOrCreateSession(clientId);
    session.command = command;
    console.log(`[CONTROL] Remote command sent to ${clientId}: ${command}`);
    res.json({ success: true, command });
});

// Client Polls Remote Command
app.get('/api/control/:clientId', (req, res) => {
    const { clientId } = req.params;
    const session = clients.get(clientId);
    if (!session || !session.command) {
        return res.json({ command: null });
    }
    const cmd = session.command;
    session.command = null; // Clear consumed command
    res.json({ command: cmd });
});

// Web UI Dashboard
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Screen Monitor Fast Online Server</title>
    <style>
        body { background-color: #0b0f19; color: #f0f4f8; font-family: -apple-system, sans-serif; margin: 0; padding: 24px; }
        .card { background-color: #131a27; border: 1px solid #232f45; border-radius: 12px; padding: 20px; max-width: 800px; margin: 0 auto; }
        h1 { font-size: 20px; color: #00e5ff; margin-top: 0; }
        .badge { background: #00c853; color: #000; font-weight: bold; padding: 4px 10px; border-radius: 12px; font-size: 12px; }
        img { width: 100%; max-width: 480px; border-radius: 8px; border: 1px solid #232f45; margin-top: 12px; display: block; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Screen Monitor Fast Server</h1>
        <p><span class="badge">ONLINE</span> Smooth Low-Latency Feed Protocol Active</p>
        <h3>Live Feed Preview (Fast 320x240 Stream)</h3>
        <img id="livePreview" src="" alt="Awaiting smooth camera stream..." />
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
        }, 150); // 6-7 FPS browser preview
    </script>
</body>
</html>
    `);
});

server.listen(PORT, () => {
    console.log(`Fast Server started on port ${PORT}`);
});
