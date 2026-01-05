const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const compression = require('compression'); 
const cors = require('cors'); 

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);

// 🚀 LOGGING ENABLED SERVER
const io = new Server(server, { 
    cors: { origin: "*" }, 
    pingTimeout: 60000,
    maxHttpBufferSize: 1e8 
});

const db = new sqlite3.Database('./platform.db');

app.use(compression()); 
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' })); 
app.use(cookieParser());

// --- DATABASE INIT ---
db.serialize(() => {
    db.run("PRAGMA journal_mode = WAL;");
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT, wallet_balance INTEGER DEFAULT 0, coins INTEGER DEFAULT 100, plan TEXT DEFAULT 'free', bio TEXT, display_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

// --- API ROUTES ---
app.post('/api/register', (req, res) => {
    const { username, password, role } = req.body;
    const hash = bcrypt.hashSync(password, 10);
    db.run(`INSERT INTO users (username, password, role) VALUES (?,?,?)`, [username, hash, role], (err) => {
        if(err) return res.status(400).json({error: "Taken"});
        res.json({success: true});
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({error: "Invalid"});
        res.json({success: true, user: {id: user.id, username: user.username, role: user.role, plan: user.plan}});
    });
});

app.get('/api/user/me', (req, res) => {
    const userId = 1; 
    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
        if(!user) return res.json({success: true, user: {username: 'TomiwaHost', role: 'host', plan: 'free', wallet_balance: 45000, coins: 500}});
        res.json({ success: true, user });
    });
});

app.get('*', (req, res) => {
    const file = req.path === '/' ? 'index.html' : req.path.substring(1) + '.html';
    const filePath = path.join(__dirname, 'public', file);
    res.sendFile(filePath, (err) => {
        if (err) res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
});

// --- 🔬 DIAGNOSTIC AUDIO ENGINE ---
let activeStreams = {};
let streamHeaders = {}; 

io.on('connection', (socket) => {
    console.log(`[SERVER] New Connection: ${socket.id.substr(0, 4)}`);

    socket.on('requestData', () => socket.emit('streamList', activeStreams));

    // 1. BROADCASTER STARTS
    socket.on('broadcaster', (data) => {
        console.log(`[SERVER] 🎙️ HOST STARTED: ${data.title} (${socket.id})`);
        activeStreams[socket.id] = { id: socket.id, ...data, listeners: 0 };
        streamHeaders[socket.id] = null; // Reset header
        socket.join(socket.id);
        io.emit('streamList', activeStreams);
    });

    socket.on('stopBroadcast', () => {
        console.log(`[SERVER] 🛑 HOST STOPPED: ${socket.id}`);
        if(activeStreams[socket.id]) {
            delete activeStreams[socket.id];
            delete streamHeaders[socket.id];
            io.emit('streamList', activeStreams);
        }
    });

    // 2. AUDIO RELAY (WITH LOGS)
    socket.on('audioStream', (data) => {
        // Log every 50th chunk to keep console clean but alive
        if (Math.random() < 0.05) console.log(`[SERVER] ⚡ Relay Chunk: ${data.chunk.byteLength} bytes -> Room ${data.room.substr(0, 4)}`);

        // CAPTURE HEADER
        if (!streamHeaders[data.room]) {
            streamHeaders[data.room] = data.chunk;
            console.log(`[SERVER] 💾 HEADER SAVED for Room ${data.room} (${data.chunk.byteLength} bytes)`);
        }

        socket.to(data.room).emit('audioBuffer', data.chunk);
    });

    // 3. LISTENER JOINING
    socket.on('joinEvent', (data) => {
        const roomId = (typeof data === 'object') ? data.targetId : data;
        const user = (typeof data === 'object' && data.user) ? data.user.username : 'Guest';

        if (roomId && activeStreams[roomId]) {
            socket.join(roomId);
            activeStreams[roomId].listeners++;
            
            console.log(`[SERVER] 🎧 ${user} joined ${roomId}`);
            
            // 🔥 HEADER INJECTION LOG
            if (streamHeaders[roomId]) {
                socket.emit('audioBuffer', streamHeaders[roomId]);
                console.log(`[SERVER] 📨 Sent Header Cache to ${user}`);
            } else {
                console.log(`[SERVER] ⚠️ NO HEADER FOUND for ${roomId} (Stream might be starting or glitching)`);
            }

            io.to(roomId).emit('roomLog', { type: 'join', count: activeStreams[roomId].listeners });
        }
    });

    socket.on('disconnect', () => {
        if(activeStreams[socket.id]) {
            console.log(`[SERVER] Host Disconnected: ${socket.id}`);
            delete activeStreams[socket.id];
            delete streamHeaders[socket.id];
            io.emit('streamList', activeStreams);
        }
    });
});

server.listen(PORT, () => console.log(`[SERVER] 🟢 ONLINE PORT: ${PORT}`));