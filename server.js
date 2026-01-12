const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { ExpressPeerServer } = require("peer");
const helmet = require('helmet');
const morgan = require('morgan');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || '*';
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

function sendIfExists(res, fileName) {
  const filePath = path.join(PUBLIC_DIR, fileName);
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).send(`Missing file: ${fileName}`);
  });
}

app.get("/", (req, res) => sendIfExists(res, "index.html"));
app.get("/studio", (req, res) => sendIfExists(res, "studio.html"));
app.get("/listen", (req, res) => sendIfExists(res, "dashboard.html"));
app.get("/dashboard", (req, res) => sendIfExists(res, "dashboard.html"));

const peerServer = ExpressPeerServer(server, { path: "/peerjs", debug: true });
app.use("/peerjs", peerServer);

// ========== REAL-TIME STREAMING ENGINE ==========
const activeStreams = new Map(); // Only stores REAL streams

io.on("connection", (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);

  // Send current list immediately to new user
  socket.emit("stream-list", Array.from(activeStreams.values()));

  // allow explicit refresh from clients
  socket.on('request-stream-list', () => socket.emit('stream-list', Array.from(activeStreams.values())));

  // 1. HOST STARTS STREAM
  socket.on("host-ready", (data) => {
    console.log(`🎙️ New Host Live: ${data.title}`);
    
    const stream = {
      id: socket.id,
      peerId: data.peerId,
      title: data.title || "Untitled Stream",
      hostName: data.hostName || "Anonymous",
      listeners: 0,
      startedAt: Date.now(),
      thumbnail: `https://api.dicebear.com/7.x/shapes/svg?seed=${data.title}` // Auto-generated art
    };

    activeStreams.set(socket.id, stream);
    socket.join(data.peerId); // Create a room for this stream

    // Broadcast update to ALL dashboards
    io.emit("stream-list", Array.from(activeStreams.values()));
  });

  // 2. LISTENER JOINS
  socket.on("join-stream", (peerId) => {
    socket.join(peerId); // Join the chat room
    socket.joinedStream = peerId; // store the host peerId this socket joined

    // Optimistically increment listener count
    for (let [id, stream] of activeStreams) {
      if (stream.peerId === peerId) {
        stream.listeners = (stream.listeners || 0) + 1;
        break;
      }
    }

    // Broadcast updated listener count to everyone
    io.emit("stream-list", Array.from(activeStreams.values()));
  });

  // When the listener has initialized PeerJS, they should send their peer id
  socket.on('listener-ready', (listenerPeerId) => {
    const hostPeerId = socket.joinedStream;
    if (!hostPeerId) return;
    for (let [hostSocketId, stream] of activeStreams) {
      if (stream.peerId === hostPeerId) {
        // notify host with the listener's PeerJS id so host can call them
        io.to(hostSocketId).emit('new-listener', listenerPeerId);
        break;
      }
    }
  });

  // 3. CHAT & GIFTS
  socket.on('chatMessage', (data) => {
    if (data.room) socket.to(data.room).emit('chatMessage', data);
  });
  
  socket.on('sendGift', (data) => {
    if (data.room) io.to(data.room).emit('giftReceived', data);
  });

  // 4. DISCONNECT
  socket.on("disconnect", () => {
    // Check if a HOST disconnected
    if (activeStreams.has(socket.id)) {
      console.log(`🛑 Stream Ended: ${activeStreams.get(socket.id).title}`);
      activeStreams.delete(socket.id);
      io.emit("stream-list", Array.from(activeStreams.values())); // Remove from dashboard
    }
    // Note: If a listener disconnects, we ideally decrement count, but for simplicity we rely on refresh for now
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Airvibe Real-Time Server running on port ${PORT}`);
});