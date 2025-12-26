const socket = io();
const peerConnections = {};
const config = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

let audioCtx, masterDest, micSource, micGain, bgmSource, bgmGain, bgmElement;
let isLive = false, isRecording = false, mediaRecorder, visualizerRunning = false;

async function startBroadcast() {
    if (isLive) return stopBroadcast();
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!audioCtx) audioCtx = new AudioContext();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        
        masterDest = audioCtx.createMediaStreamDestination();
        micGain = audioCtx.createGain(); 
        bgmGain = audioCtx.createGain();
        micGain.connect(masterDest); bgmGain.connect(masterDest);

        await setupMicrophone('default');
        setupVisualizer();

        const title = document.getElementById('showTitle').value || "Live Stream";
        const host = document.getElementById('hostName').value || "Host";
        socket.emit('broadcaster', { title, host });

        isLive = true;
        if(window.updateUIState) window.updateUIState(true);
    } catch (e) { alert("Error: " + e.message); stopBroadcast(); }
}

async function stopBroadcast() {
    isLive = false; visualizerRunning = false;
    if(isRecording) toggleRecording();
    socket.emit('stopBroadcast');
    if(window.updateUIState) window.updateUIState(false);
}

async function setupMicrophone(deviceId) {
    if(!audioCtx) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micSource = audioCtx.createMediaStreamSource(stream);
    micSource.connect(micGain);
}

function setupVisualizer() {
    const canvas = document.getElementById('visualizer');
    if(!canvas) return;
    canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight;
    const ctx = canvas.getContext('2d');
    const analyser = audioCtx.createAnalyser();
    const source = audioCtx.createMediaStreamSource(masterDest.stream);
    source.connect(analyser);
    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount, dataArray = new Uint8Array(bufferLength);
    visualizerRunning = true;

    function draw() {
        if(!visualizerRunning) return;
        requestAnimationFrame(draw);
        analyser.getByteFrequencyData(dataArray);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const barWidth = (canvas.width / bufferLength) * 2.5;
        let x = 0;
        for(let i = 0; i < bufferLength; i++) {
            const h = (dataArray[i] / 255) * canvas.height;
            ctx.fillStyle = `rgb(${h+50},50,255)`;
            ctx.fillRect(x, canvas.height - h, barWidth, h);
            x += barWidth + 1;
        }
    }
    draw();
}

socket.on('watcher', id => {
    const pc = new RTCPeerConnection(config);
    peerConnections[id] = pc;
    masterDest.stream.getTracks().forEach(t => pc.addTrack(t, masterDest.stream));
    pc.onicecandidate = e => { if (e.candidate) socket.emit('candidate', id, e.candidate); };
    pc.createOffer().then(d => pc.setLocalDescription(d)).then(() => socket.emit('offer', id, pc.localDescription));
});
socket.on('answer', (id, d) => peerConnections[id].setRemoteDescription(d));
socket.on('candidate', (id, c) => peerConnections[id].addIceCandidate(new RTCPeerConnection(c)));
socket.on('disconnectPeer', id => { if(peerConnections[id]) peerConnections[id].close(); });

// Social Listeners
socket.on('chatMessage', data => { if (window.incomingChat) window.incomingChat(data.user||"L", data.msg); });
socket.on('giftReceived', data => { if (window.incomingGift) window.incomingGift(data.user||"F", data.gift); });
socket.on('roomLog', data => { if(window.updateListenerCount && data.type==='join') window.updateListenerCount(data.count); });

window.socket = socket;