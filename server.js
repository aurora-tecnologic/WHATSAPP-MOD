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

// Prevenir caídas del proceso por errores no capturados
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

// Endpoint de verificación para Render
app.get('/health', (req, res) => res.status(200).send('OK'));

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const activeSockets = new Map();

// Función idéntica a la del bot para extraer medios de View-Once
function extraerContenidoVO(msg) {
    if (!msg) return null;
    let m = msg;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;

    if (m.imageMessage) return { type: 'image', media: m.imageMessage };
    if (m.videoMessage) return { type: 'video', media: m.videoMessage };
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
            browser: ['macOS', 'Chrome', '124.0.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false
        });

        activeSockets.set(sessionId, sock);
        sock.ev.on('creds.update', saveCreds);

        if (phoneNumber && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                    clientSocket.emit('pairing_code', { code });
                    console.log(`🔑 [AEGIS] Código entregado: ${sessionId}`);
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
                console.log(`✅ [AEGIS] Bóveda conectada exitosamente: ${sessionId}`);
            } else if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`ℹ️ [AEGIS] Sesión cerrada (${sessionId}). Código: ${statusCode}`);

                if (shouldReconnect) {
                    console.log(`🔄 [AEGIS] Reconectando sesión ${sessionId}...`);
                    setTimeout(() => iniciarSesion(sessionId, phoneNumber, clientSocket), 4000);
                } else {
                    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
                    activeSockets.delete(sessionId);
                    clientSocket.emit('status', { status: 'disconnected' });
                }
            }
        });

        // INTERCEPTOR FIEL A LA LÓGICA DEL BOT
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const m of messages) {
                if (!m.message || m.key.fromMe) continue;

                // Validación estricta de contenedor efímero
                const isVO = m.message.viewOnceMessage || 
                             m.message.viewOnceMessageV2 || 
                             m.message.viewOnceMessageV2Extension || 
                             m.message.ephemeralMessage?.message?.viewOnceMessage || 
                             m.message.ephemeralMessage?.message?.viewOnceMessageV2;

                if (!isVO) continue;

                const voData = extraerContenidoVO(m.message);
                if (!voData || !voData.media) continue;

                console.log(`📸 [AUTO-VIEWONCE] Mensaje efímero (${voData.type}) detectado. Procesando...`);

                try {
                    const isVideo = voData.type === 'video';
                    const mediaKey = isVideo ? 'videoMessage' : 'imageMessage';

                    // Estructura sintética original sin modificar propiedades de voData.media
                    const fakeMsg = {
                        key: m.key,
                        message: { [mediaKey]: voData.media }
                    };

                    const buffer = await downloadMediaMessage(
                        fakeMsg,
                        'buffer',
                        {},
                        { reuploadRequest: sock.updateMediaMessage }
                    );

                    if (!buffer || buffer.length === 0) {
                        console.error('⚠️ El buffer descargado vino vacío.');
                        continue;
                    }

                    // Destino: chat personal (evitando @lid)
                    const myJidRaw = sock.user?.id || '';
                    const myCleanNum = myJidRaw.split(':')[0].replace(/[^0-9]/g, '');
                    if (!myCleanNum) continue;

                    const targetChat = `${myCleanNum}@s.whatsapp.net`;

                    // Remitente y origen
                    const senderRaw = m.key.participant || m.key.remoteJid || '';
                    const senderNum = senderRaw.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                    const esGrupo = m.key.remoteJid.endsWith('@g.us');
                    const origen = esGrupo ? `Grupo (${m.key.remoteJid})` : `Chat privado`;

                    const caption = 
`🛡️ *AUTO-VIEWONCE RECUPERADO*

👤 *De:* @${senderNum}
📍 *Origen:* ${origen}
${voData.media.caption ? `📝 *Texto:* ${voData.media.caption}` : ''}`;

                    if (isVideo) {
                        await sock.sendMessage(targetChat, {
                            video: buffer,
                            caption: caption,
                            mimetype: 'video/mp4',
                            mentions: [senderRaw]
                        });
                    } else {
                        await sock.sendMessage(targetChat, {
                            image: buffer,
                            caption: caption,
                            mimetype: 'image/jpeg',
                            mentions: [senderRaw]
                        });
                    }

                    console.log(`✅ [AUTO-VIEWONCE ENVIADO] Entregado con éxito a tu chat.`);
                } catch (err) {
                    console.error("❌ Error en auto-viewonce:", err.message);
                }
            }
        });

    } catch (globalErr) {
        console.error('Error crítico al inicializar sesión:', globalErr.message);
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
    console.log(`🚀 SERVIDOR AEGIS CORRIENDO EN EL PUERTO ${PORT}`);
    console.log(`🌐 Acceso público: https://whatsapp-mod-ffam.onrender.com`);
});
