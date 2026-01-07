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

// ========== STREAMING SYSTEM ==========
const streams = new Map(); // Store all active streams
const users = new Map(); // Store all connected users

// Generate unique IDs
function generateStreamId() {
  return 'stream_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function generateMessageId() {
  return 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Function to send stream list to all or specific client
function broadcastStreamList() {
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
      startedAt: stream.startedAt,
      uptime: Math.floor((Date.now() - stream.startedAt) / 1000)
    }));
  
  console.log(`📡 Broadcasting ${activeStreams.length} streams to all clients`);
  io.emit("stream-list", activeStreams);
}

io.on("connection", (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);
  
  // Initialize user data
  users.set(socket.id, {
    id: socket.id,
    name: `Guest${Math.floor(Math.random() * 10000)}`,
    type: 'listener',
    joinedAt: Date.now(),
    currentRoom: null,
    peerId: null
  });

  // Send initial stream list IMMEDIATELY
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
      startedAt: stream.startedAt,
      uptime: Math.floor((Date.now() - stream.startedAt) / 1000)
    }));
  
  socket.emit("stream-list", activeStreams);
  console.log(`📡 Sent ${activeStreams.length} streams to ${socket.id}`);

  // ========== STREAM CREATION (HOST) ==========
  socket.on("create-stream", (data) => {
    console.log("📡 Create stream request received:", data);
    
    const streamId = generateStreamId();
    const hostInfo = users.get(socket.id);
    
    const streamData = {
      id: streamId,
      title: data.title || "Untitled Stream",
      description: data.description || "Join my live broadcast!",
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
      isPrivate: false,
      password: null,
      tags: [data.category || "general"],
      createdAt: Date.now(),
      startedAt: Date.now(),
      listenersList: []
    };

    streams.set(streamId, streamData);
    socket.join(streamId);
    
    // Update host info
    hostInfo.currentRoom = streamId;
    hostInfo.type = 'host';
    hostInfo.streamId = streamId;
    hostInfo.name = data.hostName || hostInfo.name;

    console.log(`🎙️ New stream created: ${streamId} by ${hostInfo.name}`);
    console.log(`📡 Total active streams: ${streams.size}`);

    // Notify everyone about new stream
    broadcastStreamList();
    
    socket.emit("stream-created-success", streamData);
  });

  // ========== STREAM JOINING (LISTENER) ==========
  socket.on("join-stream", (data) => {
    console.log("📡 Join stream request:", data);
    
    const { streamId, peerId, userData } = data;
    const stream = streams.get(streamId);
    
    if (!stream) {
      socket.emit("stream-error", { message: "Stream not found" });
      console.log(`❌ Stream not found: ${streamId}`);
      return;
    }

    // Join the stream room
    socket.join(streamId);
    
    // Update user info
    const userInfo = users.get(socket.id);
    userInfo.currentRoom = streamId;
    userInfo.name = userData?.name || userInfo.name;
    userInfo.peerId = peerId;
    
    // Update listener count
    stream.listeners++;
    stream.listenersList.push({
      id: socket.id,
      name: userInfo.name,
      peerId: peerId,
      joinedAt: Date.now()
    });

    console.log(`👂 ${userInfo.name} joined stream: ${stream.title} (${stream.listeners} listeners)`);

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
    broadcastStreamList();
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
    
    console.log(`👋 ${userInfo.name} left stream: ${stream.title} (${stream.listeners} listeners)`);

    // Notify everyone in the stream
    io.to(streamId).emit("listener-left", {
      streamId: streamId,
      listener: userInfo.name,
      totalListeners: stream.listeners
    });

    // Update stream list
    broadcastStreamList();
    
    userInfo.currentRoom = null;
  });

  // ========== STREAM ENDING (HOST) ==========
  socket.on("end-stream", (data) => {
    const { streamId } = data;
    const stream = streams.get(streamId);
    
    if (!stream) return;
    
    console.log(`🛑 Stream ending: ${stream.title}`);
    
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
    broadcastStreamList();
  });

  // ========== CHAT MESSAGES ==========
  socket.on("chat-message", (data) => {
    const { streamId, message, user } = data;
    const stream = streams.get(streamId);
    
    if (!stream) return;
    
    const messageData = {
      id: generateMessageId(),
      streamId: streamId,
      user: user || users.get(socket.id)?.name,
      message: message,
      timestamp: Date.now(),
      type: 'user'
    };

    // Send to everyone in the stream room
    io.to(streamId).emit("chat-message", messageData);
    
    console.log(`💬 [${stream.title}] ${messageData.user}: ${message}`);
  });

  // ========== GIFT SENDING ==========
  socket.on("send-gift", (data) => {
    const { streamId, gift, user } = data;
    const stream = streams.get(streamId);
    
    if (!stream) return;
    
    const giftData = {
      id: generateMessageId(),
      streamId: streamId,
      user: user || users.get(socket.id)?.name,
      gift: gift,
      timestamp: Date.now()
    };

    // Notify everyone in the stream
    io.to(streamId).emit("gift-received", giftData);
    
    // Also send as system message in chat
    const systemMessage = {
      id: generateMessageId(),
      streamId: streamId,
      user: 'SYSTEM',
      message: `${giftData.user} sent a ${gift} gift! 🎁`,
      timestamp: Date.now(),
      type: 'system'
    };
    
    io.to(streamId).emit("chat-message", systemMessage);
    
    console.log(`🎁 [${stream.title}] ${giftData.user} sent ${gift}`);
  });

  // ========== REACTIONS ==========
  socket.on("send-reaction", (data) => {
    const { streamId, reaction, user } = data;
    const stream = streams.get(streamId);
    
    if (!stream) return;
    
    const reactionData = {
      id: generateMessageId(),
      streamId: streamId,
      user: user || users.get(socket.id)?.name,
      reaction: reaction,
      timestamp: Date.now()
    };

    io.to(streamId).emit("reaction-received", reactionData);
  });

  // ========== PEER SIGNALING ==========
  socket.on("signal", (data) => {
    const { to, signal } = data;
    socket.to(to).emit("signal", {
      from: socket.id,
      signal: signal
    });
  });

  // Request stream list
  socket.on("request-stream-list", () => {
    console.log(`📡 Stream list requested by ${socket.id}`);
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
        startedAt: stream.startedAt,
        uptime: Math.floor((Date.now() - stream.startedAt) / 1000)
      }));
    
    socket.emit("stream-list", activeStreams);
  });

  // ========== DISCONNECTION ==========
  socket.on("disconnect", () => {
    const userInfo = users.get(socket.id);
    
    if (!userInfo) return;
    
    console.log(`❌ Disconnected: ${socket.id} (${userInfo.name})`);
    
    // If user was hosting a stream, end it
    if (userInfo.type === 'host' && userInfo.streamId) {
      const stream = streams.get(userInfo.streamId);
      if (stream) {
        console.log(`🛑 Host disconnected, ending stream: ${stream.title}`);
        
        // Notify all listeners
        io.to(userInfo.streamId).emit("stream-ended", {
          streamId: userInfo.streamId,
          reason: "Host disconnected"
        });
        
        // Remove stream
        streams.delete(userInfo.streamId);
        broadcastStreamList();
      }
    }
    
    // If user was in a stream as listener, remove them
    if (userInfo.currentRoom) {
      const stream = streams.get(userInfo.currentRoom);
      if (stream) {
        stream.listeners = Math.max(0, stream.listeners - 1);
        stream.listenersList = stream.listenersList.filter(listener => listener.id !== socket.id);
        
        console.log(`👋 ${userInfo.name} auto-left stream: ${stream.title} (${stream.listeners} listeners)`);
        
        io.to(userInfo.currentRoom).emit("listener-left", {
          streamId: userInfo.currentRoom,
          listener: userInfo.name,
          totalListeners: stream.listeners
        });
        
        broadcastStreamList();
      }
    }
    
    // Remove user
    users.delete(socket.id);
  });

  // Periodic stream updates
  setInterval(() => {
    broadcastStreamList();
  }, 5000); // Update every 5 seconds

  // Cleanup empty streams
  setInterval(() => {
    let cleaned = 0;
    for (const [streamId, stream] of streams.entries()) {
      if (stream.listeners === 0 && Date.now() - stream.startedAt > 300000) { // 5 minutes
        streams.delete(streamId);
        cleaned++;
        console.log(`🧹 Cleaned up empty stream: ${stream.title}`);
      }
    }
    if (cleaned > 0) {
      broadcastStreamList();
    }
  }, 60000); // Every minute
});

// Mock data for testing
const mockStreams = [
  {
    id: 'stream_1',
    title: 'Chill LoFi Beats',
    description: 'Relaxing music for studying and working',
    host: { id: 'host_1', name: 'DJ Chill', peerId: 'peer123' },
    category: 'music',
    thumbnail: 'https://api.dicebear.com/7.x/shapes/svg?seed=lofi',
    listeners: 42,
    maxListeners: 1000,
    isLive: true,
    isPrivate: false,
    tags: ['music', 'lofi', 'chill'],
    createdAt: Date.now() - 3600000,
    startedAt: Date.now() - 3600000,
    listenersList: []
  },
  {
    id: 'stream_2',
    title: 'Tech Talk Live',
    description: 'Discussing latest tech news and innovations',
    host: { id: 'host_2', name: 'Tech Guru', peerId: 'peer456' },
    category: 'tech',
    thumbnail: 'https://api.dicebear.com/7.x/shapes/svg?seed=tech',
    listeners: 28,
    maxListeners: 500,
    isLive: true,
    isPrivate: false,
    tags: ['tech', 'discussion', 'news'],
    createdAt: Date.now() - 1800000,
    startedAt: Date.now() - 1800000,
    listenersList: []
  },
  {
    id: 'stream_3',
    title: 'Morning Meditation',
    description: 'Start your day with peace and mindfulness',
    host: { id: 'host_3', name: 'Zen Master', peerId: 'peer789' },
    category: 'wellness',
    thumbnail: 'https://api.dicebear.com/7.x/shapes/svg?seed=meditation',
    listeners: 15,
    maxListeners: 200,
    isLive: true,
    isPrivate: false,
    tags: ['wellness', 'meditation', 'peace'],
    createdAt: Date.now() - 900000,
    startedAt: Date.now() - 900000,
    listenersList: []
  }
];

// Add mock streams for testing
mockStreams.forEach(stream => {
  streams.set(stream.id, stream);
});

console.log(`📡 Added ${mockStreams.length} mock streams for testing`);

server.listen(PORT, () => {
  console.log(`🚀 Airvibe Server Running on Port ${PORT}`);
  console.log(`➡️ Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`➡️ Studio: http://localhost:${PORT}/studio`);
  console.log(`🎧 WebRTC Peer Server: /peerjs`);
  console.log(`📡 Socket.io: /socket.io`);
  console.log(`💬 Active Streams: ${mockStreams.length}`);
  console.log(`👂 Total Listeners: ${mockStreams.reduce((sum, s) => sum + s.listeners, 0)}`);
});