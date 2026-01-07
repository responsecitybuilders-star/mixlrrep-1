const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { ExpressPeerServer } = require("peer");

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

// Serve Public Files
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// --- 🚏 ROUTES (THE MAP) ---
function sendIfExists(res, fileName) {
  const filePath = path.join(PUBLIC_DIR, fileName);
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).send(`Missing file: ${fileName}`);
  });
}

// 1. Landing Page
app.get("/", (req, res) => sendIfExists(res, "index.html"));

// 2. Apps
app.get("/studio", (req, res) => sendIfExists(res, "studio.html"));
app.get("/listen", (req, res) => sendIfExists(res, "dashboard.html"));
app.get("/dashboard", (req, res) => sendIfExists(res, "dashboard.html"));

// 3. Auth Pages (NEW LINKS)
app.get("/login", (req, res) => sendIfExists(res, "login.html"));
app.get("/register", (req, res) => sendIfExists(res, "register.html"));

// PeerJS Server
const peerServer = ExpressPeerServer(server, { path: "/peerjs", debug: true });
app.use("/peerjs", peerServer);

// --- 📡 SOCKET LOGIC (EXISTING) ---
let activeStreams = new Map(); // Store active streams

io.on("connection", (socket) => {
  console.log("🔌 Connected:", socket.id);
  
  // Send list to new user
  socket.emit("stream-list", Array.from(activeStreams.values()));

  // HOST: Go Live
  socket.on("host-ready", (data) => {
    activeStreams.set(socket.id, {
      peerId: data.peerId,
      title: data.title || "Unknown Frequency",
      hostName: data.hostName || "Anonymous",
      listeners: 0
    });
    socket.join(data.peerId); // Join own room
    io.emit("stream-list", Array.from(activeStreams.values()));
  });

  // LISTENER: Join Stream
  socket.on("join-stream", (roomPeerId) => {
    socket.join(roomPeerId);
    // Find host socket to notify
    for (let [id, stream] of activeStreams) {
      if (stream.peerId === roomPeerId) {
        io.to(id).emit("new-listener", socket.id);
        break;
      }
    }
  });

  // CHAT & GIFTS
  socket.on('chatMessage', (data) => {
    if (data.room) socket.to(data.room).emit('chatMessage', data);
  });
  
  socket.on('sendGift', (data) => {
    if (data.room) io.to(data.room).emit('giftReceived', data);
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    if (activeStreams.has(socket.id)) {
      activeStreams.delete(socket.id);
      io.emit("stream-list", Array.from(activeStreams.values()));
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Airvibe running on port ${PORT}`);
});