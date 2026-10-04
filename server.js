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

// Prevenir caídas súbitas del proceso
process.on('uncaughtException', (err) => {
    console.error('⚠️ [UNCAUGHT EXCEPTION]:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [UNHANDLED REJECTION]:', reason);
});

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

// Ruta de estado para que Render sepa que el servicio está vivo
app.get('/health', (req, res) => res.status(200).send('OK'));

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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
    try {
        const sessionDir = path.join(__dirname, 'sessions', sessionId);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            syncFullHistory: false, // Optimización crucial para el consumo de memoria en Render
            markOnlineOnConnect: false
        });

        activeSockets.set(sessionId, sock);
        sock.ev.on('creds.update', saveCreds);

        if (phoneNumber && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                    clientSocket.emit('pairing_code', { code });
                    console.log(`🔑 [AEGIS] Código entregado a la sesión: ${sessionId}`);
                } catch (err) {
                    console.error('Error generando pairing code:', err.message);
                    clientSocket.emit('error_msg', { message: 'Error solicitando código de emparejamiento' });
                }
            }, 3000);
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !phoneNumber) {
                clientSocket.emit('qr_code', { qr });
            }

            if (connection === 'open') {
                clientSocket.emit('status', { status: 'connected' });
                console.log(`✅ [AEGIS] Enlace consolidado para la sesión: ${sessionId}`);
            } else if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`ℹ️ [AEGIS] Sesión ${sessionId} cerrada. Razón de estado: ${statusCode}`);

                if (shouldReconnect) {
                    console.log(`🔄 [AEGIS] Reintentando conexión silenciosa para ${sessionId}...`);
                    setTimeout(() => iniciarSesion(sessionId, phoneNumber, clientSocket), 4000);
                } else {
                    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
                    activeSockets.delete(sessionId);
                    clientSocket.emit('status', { status: 'disconnected' });
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

                    const myCleanNum = sock.user.id.split(':')[0].replace(/[^0-9]/g, '');
                    const targetChat = `${myCleanNum}@s.whatsapp.net`;

                    await sock.sendMessage(targetChat, {
                        [isVideo ? 'video' : 'image']: buffer,
                        caption: '🛡️ *AEGIS // BÓVEDA ACTIVA*\nFoto efímera recuperada con éxito.',
                        mimetype: isVideo ? 'video/mp4' : 'image/jpeg'
                    });
                    console.log(`📸 [AEGIS] Contenido efímero guardado en chat privado para: ${sessionId}`);
                } catch (e) {
                    console.error(`⚠️️ Error al descifrar archivo:`, e.message);
                }
            }
        });

    } catch (globalErr) {
        console.error('Error crítico inicializando sesión:', globalErr.message);
    }
}

io.on('connection', (clientSocket) => {
    clientSocket.on('iniciar_con_codigo', ({ phoneNumber }) => {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const sessionId = `user_${cleanNumber}`;
        iniciarSesion(sessionId, cleanNumber, clientSocket);
    });

    clientSocket.on('iniciar_con_qr', () => {
        const sessionId = `guest_${Date.now()}`;
        iniciarSesion(sessionId, null, clientSocket);
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SERVIDOR AEGIS ESTABLE EN PUERTO ${PORT}`);
});
