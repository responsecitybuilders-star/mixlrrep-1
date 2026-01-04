const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const compression = require('compression'); 
const rateLimit = require('express-rate-limit'); 
const cors = require('cors'); 

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" }, 
    pingTimeout: 60000 
});
const db = new sqlite3.Database('./platform.db');

// --- MIDDLEWARE ---
app.use(compression()); 
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' })); 
app.use(cookieParser());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// --- DATABASE INIT ---
db.serialize(() => {
    db.run("PRAGMA journal_mode = WAL;"); 
    
    // Users
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, 
        username TEXT UNIQUE, 
        password TEXT, 
        role TEXT, 
        wallet_balance INTEGER DEFAULT 0,
        coins INTEGER DEFAULT 100,
        plan TEXT DEFAULT 'free',
        bio TEXT,
        display_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Transactions & Events
    db.run(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT, amount INTEGER, status TEXT, description TEXT, date DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, host_name TEXT, title TEXT, is_live BOOLEAN DEFAULT 0)`);
});

// --- API ROUTES ---

// 1. AUTH
app.post('/api/register', (req, res) => {
    const { username, password, role } = req.body;
    const hash = bcrypt.hashSync(password, 10);
    db.run(`INSERT INTO users (username, password, role) VALUES (?,?,?)`, [username, hash, role], (err) => {
        if(err) return res.status(400).json({error: "Username taken"});
        res.json({success: true});
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({error: "Invalid credentials"});
        res.json({success: true, user: {id: user.id, username: user.username, role: user.role, plan: user.plan}});
    });
});

// 2. USER DATA
app.get('/api/user/me', (req, res) => {
    const userId = 1; // Mock ID for demo (Replace with session logic in prod)
    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
        if(!user) {
            db.run(`INSERT OR IGNORE INTO users (id, username, role, wallet_balance, coins, display_name, plan) VALUES (1, 'TomiwaHost', 'host', 45000, 500, 'Tomiwa Vibes', 'free')`);
            return res.json({success: true, user: {username: 'TomiwaHost', role: 'host', plan: 'free', wallet_balance: 45000, coins: 500, display_name: 'Tomiwa Vibes', total_earned: 0}});
        }
        res.json({ success: true, user });
    });
});

// 3. WALLET
app.post('/api/wallet/buy-coins', (req, res) => {
    const { amount } = req.body;
    const userId = 1;
    db.run(`UPDATE users SET coins = coins + ? WHERE id = ?`, [amount, userId], (err) => {
        if(err) return res.status(500).json({error: "DB Error"});
        res.json({success: true});
    });
});

// 4. PAGE ROUTES (Updated for Auth.html)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/studio', (req, res) => res.sendFile(path.join(__dirname, 'public', 'broadcast.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));

// --- 4. REAL-TIME ENGINE ---
let activeStreams = {};
let streamHeaders = {}; // NEW: Store header chunks

io.on('connection', (socket) => {
    console.log(`🔌 Connected: ${socket.id}`);

    // --- 1. DATA REQUEST ---
    socket.on('requestData', () => {
        socket.emit('streamList', activeStreams);
    });

    // --- HOST LOGIC ---
    socket.on('broadcaster', (data) => {
        activeStreams[socket.id] = { id: socket.id, ...data, listeners: 0 };
        streamHeaders[socket.id] = null; // Reset header on new stream
        socket.join(socket.id);
        io.emit('streamList', activeStreams);
        console.log(`🎙️ LIVE: ${data.title}`);
    });

    socket.on('stopBroadcast', () => {
        if(activeStreams[socket.id]) {
            delete activeStreams[socket.id];
            delete streamHeaders[socket.id]; // Clean up header
            io.emit('streamList', activeStreams);
        }
    });

    // --- AUDIO RELAY (FIXED FOR LATE JOINERS) ---
    socket.on('audioStream', (data) => {
        // 1. If this is the FIRST chunk, save it as the header
        if (!streamHeaders[data.room]) {
            streamHeaders[data.room] = data.chunk;
            console.log(`🧠 Captured Header for Room ${data.room}`);
        }

        // 2. Broadcast to everyone in the room
        socket.to(data.room).emit('audioBuffer', data.chunk);
    });

    // --- LISTENER LOGIC (FIXED) ---
    socket.on('joinEvent', (data) => {
        const roomId = (typeof data === 'object') ? data.targetId : data;
        const user = (typeof data === 'object' && data.user) ? data.user.username : 'Guest';

        if (roomId && activeStreams[roomId]) {
            socket.join(roomId);
            console.log(`🎧 ${user} joined ${roomId}`);
            activeStreams[roomId].listeners++;
            
            // Notify room
            io.to(roomId).emit('roomLog', { type: 'join', count: activeStreams[roomId].listeners });
            io.emit('streamList', activeStreams);

            // 🔥 CRITICAL FIX: Send Header to new listener
            if (streamHeaders[roomId]) {
                socket.emit('audioBuffer', streamHeaders[roomId]);
                console.log(`📨 Sent Header to ${user} (Late Joiner Fix)`);
            }
        }
    });

    // --- CHAT ---
    socket.on('chatMessage', (data) => {
        console.log(`💬 ${data.user}: ${data.msg}`);
        socket.to(data.room).emit('chatMessage', data);
    });

    // --- GIFTING ---
    socket.on('sendGift', (data) => {
        console.log(`🎁 ${data.gift} from ${data.user}`);
        socket.to(data.room).emit('giftReceived', data);
        
        // Deduct coins (Mock ID 1)
        const costMap = { '❤️': 10, '🚀': 5000, '🕊️': 500 }; 
        const cost = costMap[data.gift] || 10; 
        db.run(`UPDATE users SET coins = coins - ? WHERE id = 1`, [cost]);
    });

    socket.on('disconnect', () => {
        if(activeStreams[socket.id]) {
            delete activeStreams[socket.id];
            delete streamHeaders[socket.id];
            io.emit('streamList', activeStreams);
        }
    });
});

server.listen(PORT, () => console.log(`🚀 AIRVIBE SERVER ONLINE: ${PORT}`));