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

process.on('uncaughtException', (err) => {
    console.error('⚠️ [UNCAUGHT EXCEPTION]:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️️ [UNHANDLED REJECTION]:', reason);
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

app.get('/health', (req, res) => res.status(200).send('OK'));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const activeSockets = new Map();

// Función extractora que busca en mensajes normales o citados
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

// Descarga y reenvío genérico
async function descargarYEnviar(sock, mediaObj, isVideo, senderNum, targetChat, captionExtra = '') {
    const mediaKey = isVideo ? 'videoMessage' : 'imageMessage';
    const fakeMsg = {
        key: { remoteJid: targetChat },
        message: { [mediaKey]: mediaObj }
    };

    const buffer = await downloadMediaMessage(
        fakeMsg,
        'buffer',
        {},
        { reuploadRequest: sock.updateMediaMessage }
    );

    if (!buffer || buffer.length === 0) throw new Error('El buffer descargado vino vacío.');

    const caption = 
`🛡️ *AEGIS // BÓVEDA ACTIVA*
${captionExtra}
👤 *De:* +${senderNum}
📁 *Tipo:* ${isVideo ? 'Video' : 'Foto'} de una sola vez
🕒 *Hora:* ${new Date().toLocaleTimeString()}`;

    await sock.sendMessage(targetChat, {
        [isVideo ? 'video' : 'image']: buffer,
        caption: caption,
        mimetype: isVideo ? 'video/mp4' : 'image/jpeg'
    });
}

async function iniciarSesion(sessionId, phoneNumber = null, clientSocket) {
    try {
        if (activeSockets.has(sessionId)) {
            console.log(`🧹 Cerrando instancia anterior para ${sessionId}...`);
            try {
                const oldSock = activeSockets.get(sessionId);
                oldSock.ev.removeAllListeners();
                oldSock.end();
            } catch (_) {}
            activeSockets.delete(sessionId);
        }

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
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && 
                                        statusCode !== 440 && 
                                        statusCode !== 401;

                console.log(`ℹ️ [AEGIS] Sesión cerrada (${sessionId}). Código: ${statusCode}`);

                if (shouldReconnect) {
                    console.log(`🔄 [AEGIS] Reconectando sesión ${sessionId}...`);
                    setTimeout(() => iniciarSesion(sessionId, phoneNumber, clientSocket), 5000);
                } else {
                    console.log(`🛑 [AEGIS] Deteniendo reconexión para ${sessionId}.`);
                    try {
                        sock.ev.removeAllListeners();
                        sock.end();
                    } catch (_) {}
                    activeSockets.delete(sessionId);
                    clientSocket.emit('status', { status: 'disconnected' });
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const m of messages) {
                if (!m.message) continue;

                const myJidRaw = sock.user?.id || '';
                const myCleanNum = myJidRaw.split(':')[0].replace(/[^0-9]/g, '');
                if (!myCleanNum) continue;
                const miChatPersonal = `${myCleanNum}@s.whatsapp.net`;

                // ==========================================
                // MÉTODO 1: COMANDO MANUAL RESPONDIENDO CON "."
                // ==========================================
                const textoMensaje = m.message.conversation || 
                                     m.message.extendedTextMessage?.text || '';

                // Si respondes con un punto (.) o (.r)
                if (textoMensaje.trim() === '.' || textoMensaje.trim().toLowerCase() === '.r') {
                    const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (quoted) {
                        const voCitado = extraerContenidoVO(quoted);
                        if (voCitado && voCitado.media) {
                            console.log(`🎯 [COMANDO . DETECTADO] Desbloqueando mensaje efímero citado...`);
                            try {
                                const senderParticipant = m.message.extendedTextMessage.contextInfo.participant || m.key.remoteJid;
                                const senderNum = senderParticipant.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                                
                                await descargarYEnviar(
                                    sock, 
                                    voCitado.media, 
                                    voCitado.type === 'video', 
                                    senderNum, 
                                    miChatPersonal, 
                                    '🔓 *DESBLOQUEO MANUAL VÍA COMANDO ( . )*'
                                );

                                console.log(`✅ [COMANDO . COMPLETADO] Enviado a tu chat personal.`);
                            } catch (err) {
                                console.error('⚠️ Error al desbloquear por comando:', err.message);
                            }
                            continue;
                        }
                    }
                }

                // ==========================================
                // MÉTODO 2: INTERCEPCIÓN AUTOMÁTICA EN SEGUNDO PLANO
                // ==========================================
                if (m.key.fromMe) continue;

                const isVO = m.message.viewOnceMessage || 
                             m.message.viewOnceMessageV2 || 
                             m.message.viewOnceMessageV2Extension || 
                             m.message.ephemeralMessage?.message?.viewOnceMessage || 
                             m.message.ephemeralMessage?.message?.viewOnceMessageV2;

                if (!isVO) continue;

                const voData = extraerContenidoVO(m.message);
                if (!voData || !voData.media) continue;

                console.log(`📸 [AUTO-VIEWONCE] Interceptado ${voData.type}. Procesando...`);
                try {
                    const senderRaw = m.key.participant || m.key.remoteJid || '';
                    const senderNum = senderRaw.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

                    await descargarYEnviar(
                        sock, 
                        voData.media, 
                        voData.type === 'video', 
                        senderNum, 
                        miChatPersonal, 
                        '📥 *INTERCEPCIÓN AUTOMÁTICA*'
                    );

                    console.log(`✅ [AUTO-VIEWONCE] Enviado a tu chat personal.`);
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
});
