const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
let peerConnection, audioCtx;

window.joinStream = function(broadcasterId) {
    if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if(audioCtx.state === 'suspended') audioCtx.resume();
    if(peerConnection) peerConnection.close();
    socket.emit('watcher', broadcasterId);
};

socket.on('offer', (id, description) => {
    peerConnection = new RTCPeerConnection(rtcConfig);
    peerConnection.ontrack = event => {
        const el = document.getElementById('remoteAudio');
        if(el) el.srcObject = event.streams[0];
    };
    peerConnection.onicecandidate = event => { if (event.candidate) socket.emit('candidate', id, event.candidate); };
    peerConnection.setRemoteDescription(description).then(() => peerConnection.createAnswer()).then(sdp => peerConnection.setLocalDescription(sdp)).then(() => socket.emit('answer', id, peerConnection.localDescription));
});

socket.on('candidate', (id, candidate) => peerConnections.addIceCandidate(new RTCPeerConnection(candidate)));
socket.on('streamEnded', () => { alert("Broadcast ended."); window.location.reload(); });