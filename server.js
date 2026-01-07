const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { ExpressPeerServer } = require("peer");
const { v4: uuidv4 } = require("uuid");

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

// ========== STREAMING SYSTEM ==========
const streams = new Map(); // Store all active streams
const users = new Map(); // Store all connected users

io.on("connection", (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);
  
  // Initialize user data
  users.set(socket.id, {
    id: socket.id,
    name: `Guest${Math.floor(Math.random() * 10000)}`,
    type: 'listener',
    joinedAt: Date.now(),
    currentRoom: null
  });

  // Send initial stream list
  sendStreamList(socket);

  // ========== STREAM CREATION (HOST) ==========
  socket.on("create-stream", (data) => {
    const streamId = uuidv4();
    const hostInfo = users.get(socket.id);
    
    const streamData = {
      id: streamId,
      title: data.title || "Untitled Stream",
      description: data.description || "",
      host: {
        id: socket.id,
        name: data.hostName || hostInfo.name,
        peerId: data.peerId
      },
      category: data.category || "general",
      thumbnail: data.thumbnail || `https://api.dicebear.com/7.x/shapes/svg?seed=${streamId}`,
      listeners: 0,
      maxListeners: data.maxListeners || 1000,
      isLive: true,
      isPrivate: data.isPrivate || false,
      password: data.password || null,
      tags: data.tags || [],
      createdAt: Date.now(),
      startedAt: Date.now(),
      listenersList: []
    };

    streams.set(streamId, streamData);
    socket.join(streamId);
    hostInfo.currentRoom = streamId;
    hostInfo.type = 'host';
    hostInfo.streamId = streamId;

    console.log(`🎙️ New stream created: ${streamId} by ${hostInfo.name}`);

    // Notify everyone about new stream
    io.emit("stream-created", streamData);
    io.emit("stream-list", Array.from(streams.values()));
    
    socket.emit("stream-created-success", streamData);
  });

  // ========== STREAM JOINING (LISTENER) ==========
  socket.on("join-stream", (data) => {
    const { streamId, peerId, userData } = data;
    const stream = streams.get(streamId);
    
    if (!stream) {
      socket.emit("stream-error", { message: "Stream not found" });
      return;
    }

    if (stream.isPrivate && data.password !== stream.password) {
      socket.emit("stream-error", { message: "Incorrect password" });
      return;
    }

    // Check if stream is full
    if (stream.listeners >= stream.maxListeners) {
      socket.emit("stream-error", { message: "Stream is full" });
      return;
    }

    // Join the stream room
    socket.join(streamId);
    
    // Update user info
    const userInfo = users.get(socket.id);
    userInfo.currentRoom = streamId;
    userInfo.name = userData?.name || userInfo.name;
    userInfo.peerId = peerId;
    
    // Add to listeners list
    stream.listeners++;
    stream.listenersList.push({
      id: socket.id,
      name: userInfo.name,
      peerId: peerId,
      joinedAt: Date.now()
    });

    // Send stream info to the new listener
    socket.emit("stream-joined", {
      ...stream,
      hostPeerId: stream.host.peerId
    });

    // Notify host about new listener
    socket.to(stream.host.id).emit("new-listener", {
      listenerId: socket.id,
      peerId: peerId,
      name: userInfo.name
    });

    // Notify everyone in the stream about new listener
    io.to(streamId).emit("listener-joined", {
      streamId: streamId,
      listener: userInfo.name,
      totalListeners: stream.listeners
    });

    // Update stream list for everyone
    io.emit("stream-list", Array.from(streams.values()));
    
    console.log(`👂 ${userInfo.name} joined stream: ${streamId}`);
  });

  // ========== STREAM LEAVING ==========
  socket.on("leave-stream", (data) => {
    const { streamId } = data;
    const stream = streams.get(streamId);
    const userInfo = users.get(socket.id);
    
    if (!stream) return;
    
    socket.leave(streamId);
    
    // Update listeners count
    stream.listeners = Math.max(0, stream.listeners - 1);
    stream.listenersList = stream.listenersList.filter(listener => listener.id !== socket.id);
    
    // Notify everyone in the stream
    io.to(streamId).emit("listener-left", {
      streamId: streamId,
      listener: userInfo.name,
      totalListeners: stream.listeners
    });

    // Notify host
    socket.to(stream.host.id).emit("listener-left", {
      listenerId: socket.id
    });

    // Update stream list
    io.emit("stream-list", Array.from(streams.values()));
    
    userInfo.currentRoom = null;
    
    console.log(`👋 ${userInfo.name} left stream: ${streamId}`);
  });

  // ========== STREAM ENDING (HOST) ==========
  socket.on("end-stream", (data) => {
    const { streamId } = data;
    const stream = streams.get(streamId);
    
    if (!stream) return;
    
    // Notify all listeners
    io.to(streamId).emit("stream-ended", {
      streamId: streamId,
      reason: data.reason || "Host ended the stream"
    });

    // Remove stream from active streams
    streams.delete(streamId);
    
    // Update host info
    const hostInfo = users.get(socket.id);
    hostInfo.currentRoom = null;
    hostInfo.type = 'listener';
    delete hostInfo.streamId;
    
    // Update stream list for everyone
    io.emit("stream-list", Array.from(streams.values()));
    
    console.log(`🛑 Stream ended: ${streamId}`);
  });

  // ========== CHAT MESSAGES ==========
  socket.on("chat-message", (data) => {
    const { streamId, message, user } = data;
    const stream = streams.get(streamId);
    
    if (!stream) return;
    
    const messageData = {
      id: uuidv4(),
      streamId: streamId,
      user: user || users.get(socket.id)?.name,
      message: message,
      timestamp: Date.now(),
      type: 'user'
    };

    // Send to everyone in the stream room
    io.to(streamId).emit("chat-message", messageData);
    
    // Log the message
    console.log(`💬 [${streamId}] ${messageData.user}: ${message}`);
  });

  // ========== GIFT SENDING ==========
  socket.on("send-gift", (data) => {
    const { streamId, gift, user } = data;
    const stream = streams.get(streamId);
    
    if (!stream) return;
    
    const giftData = {
      id: uuidv4(),
      streamId: streamId,
      user: user || users.get(socket.id)?.name,
      gift: gift,
      timestamp: Date.now()
    };

    // Notify everyone in the stream
    io.to(streamId).emit("gift-received", giftData);
    
    // Also send as system message in chat
    const systemMessage = {
      id: uuidv4(),
      streamId: streamId,
      user: 'SYSTEM',
      message: `${giftData.user} sent a ${gift} gift! 🎁`,
      timestamp: Date.now(),
      type: 'system'
    };
    
    io.to(streamId).emit("chat-message", systemMessage);
    
    console.log(`🎁 [${streamId}] ${giftData.user} sent ${gift}`);
  });

  // ========== REACTIONS ==========
  socket.on("send-reaction", (data) => {
    const { streamId, reaction, user } = data;
    const stream = streams.get(streamId);
    
    if (!stream) return;
    
    const reactionData = {
      id: uuidv4(),
      streamId: streamId,
      user: user || users.get(socket.id)?.name,
      reaction: reaction,
      timestamp: Date.now()
    };

    io.to(streamId).emit("reaction-received", reactionData);
  });

  // ========== STREAM UPDATES ==========
  socket.on("update-stream", (data) => {
    const { streamId, updates } = data;
    const stream = streams.get(streamId);
    
    if (!stream) return;
    
    // Only host can update stream
    if (stream.host.id !== socket.id) return;
    
    Object.assign(stream, updates);
    
    // Notify all listeners about stream update
    io.to(streamId).emit("stream-updated", {
      streamId: streamId,
      updates: updates
    });
    
    // Update stream list for everyone
    io.emit("stream-list", Array.from(streams.values()));
  });

  // ========== PEER SIGNALING ==========
  socket.on("signal", (data) => {
    const { to, signal } = data;
    socket.to(to).emit("signal", {
      from: socket.id,
      signal: signal
    });
  });

  socket.on("request-stream-list", () => {
    sendStreamList(socket);
  });

  // ========== DISCONNECTION ==========
  socket.on("disconnect", () => {
    const userInfo = users.get(socket.id);
    
    if (!userInfo) return;
    
    // If user was hosting a stream, end it
    if (userInfo.type === 'host' && userInfo.streamId) {
      const stream = streams.get(userInfo.streamId);
      if (stream) {
        // Notify all listeners
        io.to(userInfo.streamId).emit("stream-ended", {
          streamId: userInfo.streamId,
          reason: "Host disconnected"
        });
        
        // Remove stream
        streams.delete(userInfo.streamId);
        io.emit("stream-list", Array.from(streams.values()));
      }
    }
    
    // If user was in a stream as listener, remove them
    if (userInfo.currentRoom) {
      const stream = streams.get(userInfo.currentRoom);
      if (stream) {
        stream.listeners = Math.max(0, stream.listeners - 1);
        stream.listenersList = stream.listenersList.filter(listener => listener.id !== socket.id);
        
        io.to(userInfo.currentRoom).emit("listener-left", {
          streamId: userInfo.currentRoom,
          listener: userInfo.name,
          totalListeners: stream.listeners
        });
        
        io.emit("stream-list", Array.from(streams.values()));
      }
    }
    
    // Remove user
    users.delete(socket.id);
    
    console.log(`❌ Disconnected: ${socket.id} (${userInfo.name})`);
  });

  // Helper function to send stream list
  function sendStreamList(socket) {
    const activeStreams = Array.from(streams.values())
      .filter(stream => stream.isLive)
      .map(stream => ({
        id: stream.id,
        title: stream.title,
        description: stream.description,
        host: stream.host,
        category: stream.category,
        thumbnail: stream.thumbnail,
        listeners: stream.listeners,
        maxListeners: stream.maxListeners,
        isLive: stream.isLive,
        isPrivate: stream.isPrivate,
        tags: stream.tags,
        createdAt: stream.createdAt,
        startedAt: stream.startedAt
      }));
    
    socket.emit("stream-list", activeStreams);
  }

  // Periodic cleanup of empty streams
  setInterval(() => {
    for (const [streamId, stream] of streams.entries()) {
      if (stream.listeners === 0 && Date.now() - stream.startedAt > 300000) { // 5 minutes
        streams.delete(streamId);
        io.emit("stream-list", Array.from(streams.values()));
        console.log(`🧹 Cleaned up empty stream: ${streamId}`);
      }
    }
  }, 60000); // Every minute
});

server.listen(PORT, () => {
  console.log(`🚀 Airvibe Server Running on Port ${PORT}`);
  console.log(`➡️ Studio: http://localhost:${PORT}/studio`);
  console.log(`➡️ Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`🎧 WebRTC Peer Server: /peerjs`);
  console.log(`📡 Socket.io: /socket.io`);
  console.log(`💬 Active Streams: 0`);
});