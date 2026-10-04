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

// Configuración de WebSockets con soporte CORS para tu URL de Render
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Servir archivos estáticos directamente desde el directorio actual (donde está index.html)
app.use(express.static(__dirname));

// Ruta principal para asegurar la carga de la interfaz
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Mapa en memoria para mantener sockets de Baileys activos
const activeSockets = new Map();

// Función auxiliar para extraer contenido efímero (view-once)
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

// Inicializar sesión por usuario
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

    // Si el usuario solicitó código de 8 dígitos y no está vinculado aún
    if (phoneNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                clientSocket.emit('pairing_code', { code });
            } catch (err) {
                clientSocket.emit('error_msg', { message: 'Error solicitando código de emparejamiento' });
            }
        }, 2500);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Emitir QR si no se pidió por número telefónico
        if (qr && !phoneNumber) {
            clientSocket.emit('qr_code', { qr });
        }

        if (connection === 'open') {
            clientSocket.emit('status', { status: 'connected' });
            console.log(`✅ [AEGIS] Sesión vinculada con éxito: ${sessionId}`);
        } else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            clientSocket.emit('status', { status: 'disconnected' });
            
            if (!shouldReconnect) {
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
                activeSockets.delete(sessionId);
            }
        }
    });

    // Interceptor automático de mensajes "Ver una sola vez"
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

                // Destino: número propio de la sesión (evitando formato @lid)
                const myCleanNum = sock.user.id.split(':')[0].replace(/[^0-9]/g, '');
                const targetChat = `${myCleanNum}@s.whatsapp.net`;

                await sock.sendMessage(targetChat, {
                    [isVideo ? 'video' : 'image']: buffer,
                    caption: '🛡️ *AEGIS // BÓVEDA ACTIVA*\nFoto de una sola vez rescatada con éxito.',
                    mimetype: isVideo ? 'video/mp4' : 'image/jpeg'
                });
                console.log(`📸 [AEGIS] Contenido efímero recuperado para la sesión: ${sessionId}`);
            } catch (e) {
                console.error(`⚠️ Error al descifrar archivo:`, e.message);
            }
        }
    });
}

// Conexiones WebSocket desde la página web
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

// Render asigna dinámicamente process.env.PORT (puerto 10000)
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SERVIDOR AEGIS CORRIENDO EN EL PUERTO ${PORT}`);
    console.log(`🌐 Acceso público: https://whatsapp-mod-ffam.onrender.com`);
});
