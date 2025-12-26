const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const compression = require('compression'); 
const rateLimit = require('express-rate-limit'); 

// --- CONFIGURATION ---
const MAX_LISTENERS = 50; 
const RATE_LIMIT_MSG = "Too many requests, please try again later.";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    pingTimeout: 60000, 
    pingInterval: 25000
});
const db = new sqlite3.Database('./platform.db');

// --- 1. MIDDLEWARE ---
app.use(compression()); 
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10kb' })); 
app.use(cookieParser());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: { error: RATE_LIMIT_MSG }
});
app.use('/api/', limiter);

// --- 2. DB INIT ---
db.serialize(() => {
    db.run("PRAGMA journal_mode = WAL;"); 
    // Users
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT)`);
    // Profiles
    db.run(`CREATE TABLE IF NOT EXISTS profiles (user_id INTEGER PRIMARY KEY, bio TEXT, avatar TEXT, banner TEXT, followers INTEGER DEFAULT 0)`);
    // Events
    db.run(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, host_id INTEGER, host_name TEXT, title TEXT, category TEXT, start_time DATETIME, is_live BOOLEAN DEFAULT 0)`);
    // Chat
    db.run(`CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY, event_title TEXT, username TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

// --- 3. ROUTES ---

// Auth
app.post('/api/register', (req, res) => {
    const { username, password, role } = req.body;
    if(!username || !password) return res.status(400).json({error: "Missing fields"});
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
        res.json({success: true, user: {id: user.id, username: user.username, role: user.role}});
    });
});

// Profile API
app.get('/api/profile/:username', (req, res) => {
    const sql = `SELECT u.username, u.role, p.bio, p.avatar, p.banner, p.followers 
                 FROM users u LEFT JOIN profiles p ON u.id = p.user_id 
                 WHERE u.username = ?`;
    db.get(sql, [req.params.username], (err, row) => {
        if(row) res.json({success: true, profile: row});
        else res.json({success: false});
    });
});

app.post('/api/profile/update', (req, res) => {
    const { username, bio, avatar, banner } = req.body;
    db.get(`SELECT id FROM users WHERE username = ?`, [username], (err, user) => {
        if(!user) return res.json({success: false});
        
        const sql = `INSERT INTO profiles (user_id, bio, avatar, banner) VALUES (?, ?, ?, ?)
                     ON CONFLICT(user_id) DO UPDATE SET bio=excluded.bio, avatar=excluded.avatar, banner=excluded.banner`;
        db.run(sql, [user.id, bio, avatar, banner], (err) => {
            res.json({success: true});
        });
    });
});

app.get('/api/feed', (req, res) => {
    db.all(`SELECT * FROM events WHERE is_live = 1`, [], (err, live) => {
        db.all(`SELECT * FROM events WHERE is_live = 0 ORDER BY start_time ASC LIMIT 10`, [], (err, upcoming) => {
            res.json({live, upcoming});
        });
    });
});

// PAGE ROUTES
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/studio', (req, res) => res.sendFile(path.join(__dirname, 'public', 'broadcast.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));

// --- 4. REAL-TIME ENGINE ---
let activeStreams = {};
let roomParticipants = {}; 

io.on('connection', (socket) => {
    socket.emit('streamList', activeStreams);

    // Host Goes Live
    socket.on('broadcaster', (data) => {
        activeStreams[socket.id] = { id: socket.id, ...data, listeners: 0 };
        roomParticipants[socket.id] = []; 
        socket.join(socket.id);
        
        addToRoom(socket.id, { socketId: socket.id, username: data.host, role: 'host' });

        db.run(`UPDATE events SET is_live = 1 WHERE title = ?`, [data.title], function(err) {
            if(this.changes === 0) db.run(`INSERT INTO events (host_name, title, category, start_time, is_live) VALUES (?, ?, 'Live', CURRENT_TIMESTAMP, 1)`, [data.host, data.title]);
        });

        io.emit('streamList', activeStreams);
    });

    // Listener Joins
    socket.on('joinEvent', (data) => {
        let roomId, userObj;
        if (typeof data === 'string') {
            roomId = data; userObj = { username: 'Guest' };
        } else {
            roomId = data.targetId; userObj = data.user || { username: 'Guest' };
        }

        // Safety
        const room = io.sockets.adapter.rooms.get(roomId);
        if ((room ? room.size : 0) >= MAX_LISTENERS) {
            socket.emit('notification', '⚠️ Room Full');
            return;
        }

        if(activeStreams[roomId]) {
            socket.join(roomId);
            addToRoom(roomId, { socketId: socket.id, username: userObj.username, role: 'listener' });
            
            // Stats
            const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
            activeStreams[roomId].listeners = Math.max(0, roomSize - 1); 

            // Notify Host
            io.to(roomId).emit('roomLog', { 
                type: 'join', 
                user: userObj.username, 
                count: activeStreams[roomId].listeners 
            });

            // WebRTC
            socket.to(roomId).emit('watcher', socket.id);
            
            // Global Update
            io.emit('streamList', activeStreams);
        }
    });

    // Interaction
    socket.on('chatMessage', (data) => io.to(data.room).emit('chatMessage', data));
    socket.on('sendGift', (data) => io.to(data.room).emit('giftReceived', data));
    
    // WebRTC
    socket.on('offer', (id, m) => socket.to(id).emit('offer', socket.id, m));
    socket.on('answer', (id, m) => socket.to(id).emit('answer', socket.id, m));
    socket.on('candidate', (id, m) => socket.to(id).emit('candidate', socket.id, m));

    // Disconnects
    socket.on('disconnecting', () => {
        for (const room of socket.rooms) {
            if (activeStreams[room]) {
                const count = (io.sockets.adapter.rooms.get(room)?.size || 1) - 1;
                activeStreams[room].listeners = Math.max(0, count - 1);
                
                io.to(room).emit('roomLog', { type: 'leave', user: 'Listener', count: activeStreams[room].listeners });
                io.emit('streamList', activeStreams);
            }
        }
    });

    socket.on('disconnect', () => {
        if(activeStreams[socket.id]) {
            const title = activeStreams[socket.id].title;
            db.run(`UPDATE events SET is_live = 0 WHERE title = ?`, [title]);
            delete activeStreams[socket.id];
            delete roomParticipants[socket.id];
            io.emit('streamList', activeStreams);
        } else {
            removeFromRooms(socket.id);
        }
    });
});

function addToRoom(roomId, user) {
    if(!roomParticipants[roomId]) roomParticipants[roomId] = [];
    roomParticipants[roomId] = roomParticipants[roomId].filter(u => u.socketId !== user.socketId);
    roomParticipants[roomId].push(user);
}

function removeFromRooms(socketId) {
    for (let r in roomParticipants) {
        roomParticipants[r] = roomParticipants[r].filter(u => u.socketId !== socketId);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 AIRVIBE SERVER ONLINE: ${PORT}`));