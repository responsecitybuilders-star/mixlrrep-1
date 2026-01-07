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

// ✅ GLOBAL CHAT SYSTEM
const GLOBAL_CHAT_ROOM = "airvibe-global-chat";
let chatHistory = []; // Store last 100 messages
let onlineUsers = new Map(); // Store socket.id -> user info

let hostPeerId = null;
let hostSocketId = null;
let currentStream = null;

function broadcastStatus() {
  io.emit("host-status", {
    live: !!hostPeerId,
    stream: currentStream,
    hostPeerId: hostPeerId || null,
    onlineCount: onlineUsers.size
  });
}

function broadcastOnlineUsers() {
  const users = Array.from(onlineUsers.values()).map(user => ({
    name: user.name,
    isHost: user.isHost,
    role: user.role
  }));
  io.to(GLOBAL_CHAT_ROOM).emit("online-users", users);
}

io.on("connection", (socket) => {
  console.log("🔌 New Connection:", socket.id);

  // ✅ Auto-join global chat
  socket.join(GLOBAL_CHAT_ROOM);

  // Send current status and chat history to new user
  socket.emit("host-status", {
    live: !!hostPeerId,
    stream: currentStream,
    hostPeerId: hostPeerId || null,
    onlineCount: onlineUsers.size
  });

  // Send chat history
  socket.emit("chat-history", chatHistory.slice(-50));

  // ✅ USER JOIN EVENT
  socket.on("user-join", (userData) => {
    onlineUsers.set(socket.id, {
      name: userData.name || "Anonymous",
      isHost: userData.isHost || false,
      role: userData.role || "listener",
      socketId: socket.id
    });

    // Notify everyone about new user
    const joinMsg = {
      user: "SYSTEM",
      msg: `${userData.name || "Anonymous"} joined the chat`,
      type: "system",
      ts: Date.now()
    };
    
    chatHistory.push(joinMsg);
    if (chatHistory.length > 100) chatHistory.shift();
    
    io.to(GLOBAL_CHAT_ROOM).emit("chatMessage", joinMsg);
    broadcastOnlineUsers();
    
    console.log(`👤 ${userData.name || "Anonymous"} joined (${onlineUsers.size} online)`);
  });

  // ✅ GLOBAL CHAT MESSAGES
  socket.on("chatMessage", (data) => {
    const userInfo = onlineUsers.get(socket.id);
    const userName = userInfo?.name || data?.user || "Guest";
    const isHost = userInfo?.isHost || false;
    
    const message = {
      user: userName,
      msg: data?.msg || "",
      type: isHost ? "host" : "user",
      isHost: isHost,
      color: data?.color || (isHost ? "#ef4444" : "#3b82f6"),
      ts: Date.now(),
      socketId: socket.id
    };

    if (!message.msg.trim()) return;

    // Add to chat history
    chatHistory.push(message);
    if (chatHistory.length > 100) chatHistory.shift();

    // Broadcast to everyone in global chat
    io.to(GLOBAL_CHAT_ROOM).emit("chatMessage", message);
    console.log(`💬 ${userName}: ${message.msg}`);
  });

  // ✅ GIFTS (Global)
  socket.on("sendGift", (data) => {
    const userInfo = onlineUsers.get(socket.id);
    const userName = userInfo?.name || data?.user || "Guest";
    
    const giftMsg = {
      user: userName,
      gift: data?.gift || "❤️",
      type: "gift",
      isHost: userInfo?.isHost || false,
      ts: Date.now()
    };

    // Broadcast gift to everyone
    io.to(GLOBAL_CHAT_ROOM).emit("giftReceived", giftMsg);
    
    // Also send as system message in chat
    const chatGiftMsg = {
      user: "SYSTEM",
      msg: `${userName} sent a ${giftMsg.gift} gift!`,
      type: "gift-announce",
      ts: Date.now()
    };
    
    chatHistory.push(chatGiftMsg);
    if (chatHistory.length > 100) chatHistory.shift();
    io.to(GLOBAL_CHAT_ROOM).emit("chatMessage", chatGiftMsg);
  });

  // ✅ TYPING INDICATOR
  socket.on("typing", (isTyping) => {
    const userInfo = onlineUsers.get(socket.id);
    if (userInfo) {
      socket.to(GLOBAL_CHAT_ROOM).emit("user-typing", {
        user: userInfo.name,
        isTyping: isTyping
      });
    }
  });

  // ✅ HOST SPECIFIC EVENTS
  socket.on("host-ready", (peerId) => {
    hostPeerId = peerId;
    hostSocketId = socket.id;

    currentStream = {
      title: "Live Radio",
      host: "Host",
      startedAt: Date.now(),
    };

    // Update user info to host
    onlineUsers.set(socket.id, {
      name: "HOST",
      isHost: true,
      role: "host",
      socketId: socket.id
    });

    console.log("🎙️ Host Live. PeerId:", peerId);
    
    // Announce host is live
    const liveMsg = {
      user: "SYSTEM",
      msg: "🎤 Host is now LIVE!",
      type: "system",
      ts: Date.now()
    };
    
    chatHistory.push(liveMsg);
    io.to(GLOBAL_CHAT_ROOM).emit("chatMessage", liveMsg);
    
    broadcastStatus();
    broadcastOnlineUsers();
  });

  socket.on("listener-ready", (listenerPeerId) => {
    if (hostPeerId && hostSocketId) {
      io.to(hostSocketId).emit("new-listener", listenerPeerId);
    }
  });

  socket.on("request-online-users", () => {
    const users = Array.from(onlineUsers.values()).map(user => ({
      name: user.name,
      isHost: user.isHost,
      role: user.role
    }));
    socket.emit("online-users", users);
  });

  socket.on("disconnect", () => {
    const userInfo = onlineUsers.get(socket.id);
    
    if (userInfo) {
      // Notify chat about user leaving
      const leaveMsg = {
        user: "SYSTEM",
        msg: `${userInfo.name} left the chat`,
        type: "system",
        ts: Date.now()
      };
      
      chatHistory.push(leaveMsg);
      io.to(GLOBAL_CHAT_ROOM).emit("chatMessage", leaveMsg);
      
      onlineUsers.delete(socket.id);
      
      // If host disconnects
      if (socket.id === hostSocketId) {
        console.log("🛑 Host Offline");
        hostPeerId = null;
        hostSocketId = null;
        currentStream = null;
        
        const offlineMsg = {
          user: "SYSTEM",
          msg: "🎤 Host went offline",
          type: "system",
          ts: Date.now()
        };
        
        chatHistory.push(offlineMsg);
        io.to(GLOBAL_CHAT_ROOM).emit("chatMessage", offlineMsg);
      }
    }
    
    broadcastStatus();
    broadcastOnlineUsers();
    console.log(`❌ User disconnected (${onlineUsers.size} online)`);
  });

  // Ping for latency
  socket.on("ping", () => {
    socket.emit("pong");
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Airvibe Server Running on Port ${PORT}`);
  console.log(`➡️ Studio: /studio`);
  console.log(`➡️ Listen: /listen`);
  console.log(`💬 Global Chat: Enabled`);
});