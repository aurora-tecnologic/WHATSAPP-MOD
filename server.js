const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadMediaMessage 
} = require('@whiskeysockets/baileys');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const activeSockets = new Map();

function extraerContenidoVO(msg) {
    if (!msg) return null;
    let m = msg;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;

    if (m.imageMessage?.viewOnce || m.imageMessage) return { type: 'image', media: m.imageMessage };
    if (m.videoMessage?.viewOnce || m.videoMessage) return { type: 'video', media: m.videoMessage };
    return null;
}

async function iniciarSesion(sessionId, phoneNumber = null, clientSocket) {
    const sessionDir = path.join(__dirname, 'sessions', sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    activeSockets.set(sessionId, sock);
    sock.ev.on('creds.update', saveCreds);

    if (phoneNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                clientSocket.emit('pairing_code', { code });
            } catch (err) {
                clientSocket.emit('error_msg', { message: 'Error solicitando código de emparejamiento' });
            }
        }, 2000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !phoneNumber) {
            clientSocket.emit('qr_code', { qr });
        }

        if (connection === 'open') {
            clientSocket.emit('status', { status: 'connected' });
            console.log(`✅ [AEGIS] Sesión ${sessionId} vinculada y activa.`);
        } else if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            clientSocket.emit('status', { status: 'disconnected' });
            if (!shouldReconnect) {
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
                activeSockets.delete(sessionId);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const m of messages) {
            const vo = extraerContenidoVO(m.message);
            if (!vo || !vo.media) continue;

            try {
                const isVideo = vo.type === 'video';
                const mediaKey = isVideo ? 'videoMessage' : 'imageMessage';

                const fakeMsg = {
                    key: m.key,
                    message: { [mediaKey]: vo.media }
                };

                const buffer = await downloadMediaMessage(
                    fakeMsg,
                    'buffer',
                    {},
                    { reuploadRequest: sock.updateMediaMessage }
                );

                const myNum = sock.user.id.split(':')[0].replace(/[^0-9]/g, '');
                const targetChat = `${myNum}@s.whatsapp.net`;

                await sock.sendMessage(targetChat, {
                    [isVideo ? 'video' : 'image']: buffer,
                    caption: '🛡️ *AEGIS // BÓVEDA ACTIVA*\nFoto de una sola vez recuperada con éxito.',
                    mimetype: isVideo ? 'video/mp4' : 'image/jpeg'
                });
                console.log(`📸 [AEGIS] Contenido efímero recuperado para ${sessionId}`);
            } catch (e) {
                console.error(`⚠️ Error al descifrar archivo:`, e.message);
            }
        }
    });
}

io.on('connection', (clientSocket) => {
    clientSocket.on('iniciar_con_codigo', ({ phoneNumber }) => {
        const sessionId = `user_${phoneNumber.replace(/[^0-9]/g, '')}`;
        iniciarSesion(sessionId, phoneNumber, clientSocket);
    });

    clientSocket.on('iniciar_con_qr', () => {
        const sessionId = `guest_${Date.now()}`;
        iniciarSesion(sessionId, null, clientSocket);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SERVIDOR AEGIS CORRIENDO EN EL PUERTO ${PORT}`);
});
