const socket = io();
const peerConnections = {};
const config = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// --- AUDIO GRAPH STATE ---
let audioCtx, masterDest, micSource, micGain, bgmSource, bgmGain, bgmElement;
let lowEQ, midEQ, highEQ; 
let fxInput, fxOutput, currentFXNode;
let isLive = false;
let isRecording = false;
let mediaRecorder, recordedChunks = [];
let visualizerRunning = false;

// --- 1. CORE BROADCAST LOGIC ---
async function startBroadcast() {
    if (isLive) return stopBroadcast();

    try {
        console.log("🚀 Initializing Audio Engine...");
        
        // A. Init Context (Handle Browser Autoplay Policy)
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!audioCtx) audioCtx = new AudioContext();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        
        // B. Master Output
        masterDest = audioCtx.createMediaStreamDestination();

        // C. Create Nodes
        micGain = audioCtx.createGain(); 
        bgmGain = audioCtx.createGain();
        fxInput = audioCtx.createGain(); 
        fxOutput = audioCtx.createGain();
        
        // Defaults
        micGain.gain.value = 1.0;
        bgmGain.gain.value = 0.5;

        // EQ Nodes (3-Band)
        lowEQ = audioCtx.createBiquadFilter(); lowEQ.type = "lowshelf"; lowEQ.frequency.value = 320;
        midEQ = audioCtx.createBiquadFilter(); midEQ.type = "peaking"; midEQ.frequency.value = 1000;
        highEQ = audioCtx.createBiquadFilter(); highEQ.type = "highshelf"; highEQ.frequency.value = 3200;

        // D. Connect Graph: Mic -> FX -> EQ -> Master
        // Mic Path
        micGain.connect(fxInput);
        fxInput.connect(fxOutput);
        fxOutput.connect(lowEQ);
        lowEQ.connect(midEQ);
        midEQ.connect(highEQ);
        highEQ.connect(masterDest);

        // Music Path (Bypasses Mic FX, goes straight to Master)
        bgmGain.connect(masterDest);

        // E. Get Microphone
        await setupMicrophone('default');
        
        // F. Start Visualizer (Now taps the Master Destination)
        setupVisualizer();

        // G. Signal Server
        const title = document.getElementById('showTitle').value || "Live Stream";
        const host = document.getElementById('hostName').value || "Host";
        const user = JSON.parse(localStorage.getItem('mixlr_user'));
        
        socket.emit('broadcaster', { title, host, host_id: user ? user.id : null });

        // H. UI State
        isLive = true;
        if(window.updateUIState) window.updateUIState(true);

        console.log("✅ SYSTEM ONLINE: Broadcasting");

    } catch (e) {
        console.error("Broadcast Error:", e);
        alert("Engine Error: " + e.message);
        stopBroadcast();
    }
}

async function stopBroadcast() {
    isLive = false;
    visualizerRunning = false; // Stop the draw loop
    if(isRecording) toggleRecording();
    
    // Close Connections
    if(audioCtx) {
        if(micSource) micSource.disconnect();
        await audioCtx.close();
        audioCtx = null;
    }
    
    socket.emit('stopBroadcast');
    if(window.updateUIState) window.updateUIState(false);
}

// --- 2. MICROPHONE SETUP ---
async function setupMicrophone(deviceId) {
    if(!audioCtx) return;
    if(micSource) micSource.disconnect();

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: { 
                deviceId: deviceId === 'default' ? undefined : { exact: deviceId },
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: false
            } 
        });
        
        micSource = audioCtx.createMediaStreamSource(stream);
        micSource.connect(micGain);
    } catch(err) {
        console.error("Mic Access Denied:", err);
        alert("Microphone access denied. Please allow permission.");
    }
}

// --- 3. FX CONTROL ---
window.setVoiceFX = function(type) {
    if(!audioCtx) return;
    fxInput.disconnect();
    if(currentFXNode) { currentFXNode.disconnect(); currentFXNode = null; }

    if(type === 'normal') {
        fxInput.connect(fxOutput);
    } else if (type === 'robot') {
        // Ring Modulator
        const osc = audioCtx.createOscillator();
        osc.frequency.value = 50;
        const gain = audioCtx.createGain();
        gain.gain.value = 1.0;
        
        osc.connect(gain.gain);
        fxInput.connect(gain);
        gain.connect(fxOutput);
        osc.start();
        currentFXNode = gain; // Store to disconnect later
        
    } else if (type === 'echo') {
        const delay = audioCtx.createDelay();
        delay.delayTime.value = 0.4;
        const feedback = audioCtx.createGain();
        feedback.gain.value = 0.4;
        
        delay.connect(feedback);
        feedback.connect(delay);
        
        fxInput.connect(delay);
        delay.connect(fxOutput);
        
        // Dry path (so you hear original + echo)
        const dry = audioCtx.createGain();
        fxInput.connect(dry);
        dry.connect(fxOutput);
        
        currentFXNode = delay;
    } else if (type === 'radio') {
        const filter = audioCtx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = 2000;
        filter.Q.value = 1.5;
        
        fxInput.connect(filter);
        filter.connect(fxOutput);
        currentFXNode = filter;
    }
};

// --- 4. MUSIC DECK ---
window.loadBGM = function(file) {
    if(bgmElement) bgmElement.pause();
    bgmElement = new Audio(URL.createObjectURL(file));
    bgmElement.loop = true;
    
    // Auto-init context if user loads music before going live
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if(!audioCtx) audioCtx = new AudioContext();

    bgmElement.onplay = () => {
        if(!bgmSource) {
            bgmSource = audioCtx.createMediaElementSource(bgmElement);
            bgmSource.connect(bgmGain);
        }
    };
}

window.toggleBGMPlayJS = function() {
    if(!bgmElement) return alert("Load a track first!");
    if(bgmElement.paused) bgmElement.play(); else bgmElement.pause();
}

window.setMicVolume = function(val) { if(micGain) micGain.gain.value = val; }
window.setBGMVolume = function(val) { if(bgmGain) bgmGain.gain.value = val; }

// --- 5. RECORDING ---
window.toggleRecording = function() {
    if(isRecording) {
        mediaRecorder.stop();
        isRecording = false;
    } else {
        if(!isLive) return alert("Must be LIVE to record.");
        const chunks = [];
        mediaRecorder = new MediaRecorder(masterDest.stream);
        
        mediaRecorder.ondataavailable = e => chunks.push(e.data);
        mediaRecorder.onstop = () => {
            const blob = new Blob(chunks, {type:'audio/webm'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `airvibe_rec_${Date.now()}.webm`;
            a.click();
        };
        
        mediaRecorder.start();
        isRecording = true;
    }
}

// --- 6. VISUALIZER (FIXED) ---
function setupVisualizer() {
    const canvas = document.getElementById('visualizer');
    if(!canvas) return console.warn("No visualizer canvas found!");
    
    // Fix Resolution: Match internal pixels to display size
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    const ctx = canvas.getContext('2d');
    const analyser = audioCtx.createAnalyser();
    
    // Connect Analyzer to the final output (Master Destination)
    // We create a clone of the master stream to analyze
    const source = audioCtx.createMediaStreamSource(masterDest.stream);
    source.connect(analyser);
    
    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    visualizerRunning = true;

    function draw() {
        if(!visualizerRunning) return;
        requestAnimationFrame(draw);
        
        analyser.getByteFrequencyData(dataArray);
        
        // Clear screen
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Draw Bars
        const barWidth = (canvas.width / bufferLength) * 2.5;
        let x = 0;
        
        for(let i = 0; i < bufferLength; i++) {
            const barHeight = (dataArray[i] / 255) * canvas.height; // Scale to canvas height
            
            // Gradient Color
            const r = barHeight + (25 * (i/bufferLength));
            const g = 50;
            const b = 255;
            
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
            
            x += barWidth + 1;
        }
    }
    draw();
}

// --- 7. WEBRTC HANDLERS ---
socket.on('watcher', id => {
    const pc = new RTCPeerConnection(config);
    peerConnections[id] = pc;
    masterDest.stream.getTracks().forEach(t => pc.addTrack(t, masterDest.stream));
    
    pc.onicecandidate = e => { 
        if (e.candidate) socket.emit('candidate', id, e.candidate); 
    };
    
    pc.createOffer()
    .then(d => pc.setLocalDescription(d))
    .then(() => socket.emit('offer', id, pc.localDescription));
});

socket.on('answer', (id, d) => peerConnections[id].setRemoteDescription(d));
socket.on('candidate', (id, c) => peerConnections[id].addIceCandidate(new RTCPeerConnection(c)));
socket.on('disconnectPeer', id => { if(peerConnections[id]) peerConnections[id].close(); });

// Global Exposure
window.socket = socket;
window.startBroadcast = startBroadcast;
window.listAudioInputs = async function() {
    if(!navigator.mediaDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const sel = document.getElementById('audioSource');
    if(sel) {
        sel.innerHTML = '<option value="default">Default Mic</option>';
        devices.filter(d => d.kind === 'audioinput').forEach(d => {
            sel.innerHTML += `<option value="${d.deviceId}">${d.label || 'Mic ' + d.deviceId}</option>`;
        });
    }
};