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
    downloadMediaMessage,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');

process.on('uncaughtException', (err) => {
    console.error('⚠️ [UNCAUGHT EXCEPTION]:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [UNHANDLED REJECTION]:', reason);
});

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const activeSockets = new Map();
const reconnectTimers = new Map();

// Almacén en memoria de mensajes enviados para resolver sincronizaciones pendientes
const messageStore = new Map();
const msgRetryCounterMap = new Map();

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

    if (!buffer || buffer.length === 0) throw new Error('El buffer descargado está vacío.');

    const caption = 
`🛡️ *AEGIS // BÓVEDA ACTIVA*
${captionExtra}
👤 *De:* +${senderNum}
📁 *Tipo:* ${isVideo ? 'Video' : 'Foto'} de una sola vez
🕒 *Hora:* ${new Date().toLocaleTimeString()}`;

    // Envío con registro en almacén para permitir descifrado si el teléfono lo solicita
    const sent = await sock.sendMessage(targetChat, {
        [isVideo ? 'video' : 'image']: buffer,
        caption: caption,
        mimetype: isVideo ? 'video/mp4' : 'image/jpeg'
    });

    if (sent?.key?.id) {
        messageStore.set(sent.key.id, sent.message);
        // Limpiar mensaje del almacén después de 10 minutos para ahorrar memoria
        setTimeout(() => messageStore.delete(sent.key.id), 10 * 60 * 1000);
    }
}

async function iniciarSesion(sessionId, phoneNumber = null, clientSocket = null) {
    try {
        if (reconnectTimers.has(sessionId)) {
            clearTimeout(reconnectTimers.get(sessionId));
            reconnectTimers.delete(sessionId);
        }

        if (activeSockets.has(sessionId)) {
            try {
                const old = activeSockets.get(sessionId);
                old.ev.removeAllListeners();
                old.end();
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
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 20000,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            msgRetryCounterMap,
            // Resuelve la petición de clave del teléfono móvil para evitar "Esperando mensaje"
            getMessage: async (key) => {
                if (messageStore.has(key.id)) {
                    return messageStore.get(key.id);
                }
                return {
                    conversation: 'Sync'
                };
            }
        });

        activeSockets.set(sessionId, sock);
        sock.ev.on('creds.update', saveCreds);

        if (phoneNumber && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                    if (clientSocket) clientSocket.emit('pairing_code', { code });
                    console.log(`🔑 [AEGIS] Código entregado: ${code} (${sessionId})`);
                } catch (err) {
                    console.error('⚠️ Error generando pairing code:', err.message);
                    if (clientSocket) clientSocket.emit('error_msg', { message: 'Error al solicitar código' });
                }
            }, 3000);
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !phoneNumber && clientSocket) {
                clientSocket.emit('qr_code', { qr });
            }

            if (connection === 'open') {
                if (clientSocket) clientSocket.emit('status', { status: 'connected' });
                console.log(`✅ [AEGIS] Sesión activa: ${sessionId}`);
            } else if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
                const isConflict = statusCode === 440;

                console.log(`ℹ️ [AEGIS] Desconexión (${sessionId}). Código: ${statusCode}`);

                if (!isLoggedOut && !isConflict) {
                    console.log(`🔄 [AEGIS] Reconectando sesión ${sessionId}...`);
                    const timer = setTimeout(() => {
                        iniciarSesion(sessionId, phoneNumber, clientSocket);
                    }, 5000);
                    reconnectTimers.set(sessionId, timer);
                } else {
                    console.log(`🛑 [AEGIS] Sesión cerrada definitivamente: ${sessionId}.`);
                    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
                    activeSockets.delete(sessionId);
                    if (clientSocket) clientSocket.emit('status', { status: 'disconnected' });
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const m of messages) {
                if (!m.message) continue;

                // Obtener el JID propio normalizado sin identificadores de instancia (:1, :2, etc.)
                const myNormalizedJid = jidNormalizedUser(sock.user?.id || '');
                if (!myNormalizedJid) continue;

                // 1. Comando manual mediante respuesta con "."
                const textoMensaje = m.message.conversation || m.message.extendedTextMessage?.text || '';
                if (textoMensaje.trim() === '.' || textoMensaje.trim().toLowerCase() === '.r') {
                    const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (quoted) {
                        const voCitado = extraerContenidoVO(quoted);
                        if (voCitado && voCitado.media) {
                            try {
                                const senderParticipant = m.message.extendedTextMessage.contextInfo.participant || m.key.remoteJid;
                                const senderNum = senderParticipant.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

                                await descargarYEnviar(
                                    sock, 
                                    voCitado.media, 
                                    voCitado.type === 'video', 
                                    senderNum, 
                                    myNormalizedJid, 
                                    '🔓 *DESBLOQUEO MANUAL ( . )*'
                                );
                                console.log(`✅ [COMANDO .] Mensaje sincronizado a la bóveda personal.`);
                            } catch (err) {
                                console.error('⚠️ Error al desbloquear por comando:', err.message);
                            }
                            continue;
                        }
                    }
                }

                // 2. Intercepción automática
                if (m.key.fromMe) continue;

                const isVO = m.message.viewOnceMessage || 
                             m.message.viewOnceMessageV2 || 
                             m.message.viewOnceMessageV2Extension || 
                             m.message.ephemeralMessage?.message?.viewOnceMessage || 
                             m.message.ephemeralMessage?.message?.viewOnceMessageV2;

                if (!isVO) continue;

                const voData = extraerContenidoVO(m.message);
                if (!voData || !voData.media) continue;

                try {
                    const senderRaw = m.key.participant || m.key.remoteJid || '';
                    const senderNum = senderRaw.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

                    await descargarYEnviar(
                        sock, 
                        voData.media, 
                        voData.type === 'video', 
                        senderNum, 
                        myNormalizedJid, 
                        '📥 *INTERCEPCIÓN AUTOMÁTICA*'
                    );
                    console.log(`✅ [AUTO-VIEWONCE] Mensaje sincronizado a la bóveda personal.`);
                } catch (err) {
                    console.error("❌ Error en auto-viewonce:", err.message);
                }
            }
        });

    } catch (globalErr) {
        console.error('Error crítico al inicializar sesión:', globalErr.message);
    }
}

function restaurarSesionesGuardadas() {
    const baseDir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(baseDir)) return;

    const carpetas = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    for (const id of carpetas) {
        if (id.startsWith('user_')) {
            const num = id.replace('user_', '');
            console.log(`📦 [AEGIS] Restaurando sesión en segundo plano: ${id}`);
            iniciarSesion(id, num, null);
        }
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

    clientSocket.on('verificar_estado', ({ phoneNumber }) => {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const sessionId = `user_${cleanNumber}`;
        if (activeSockets.has(sessionId)) {
            const sock = activeSockets.get(sessionId);
            if (sock.user) {
                clientSocket.emit('status', { status: 'connected' });
                return;
            }
        }
        clientSocket.emit('status', { status: 'disconnected' });
    });

    clientSocket.on('cerrar_sesion_usuario', ({ phoneNumber }) => {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const sessionId = `user_${cleanNumber}`;
        if (activeSockets.has(sessionId)) {
            try {
                const s = activeSockets.get(sessionId);
                s.logout();
                s.end();
            } catch (_) {}
            activeSockets.delete(sessionId);
            console.log(`🛑 [AEGIS] Sesión cerrada desde panel: ${sessionId}`);
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SERVIDOR AEGIS CORRIENDO EN EL PUERTO ${PORT}`);
    restaurarSesionesGuardadas();
});
