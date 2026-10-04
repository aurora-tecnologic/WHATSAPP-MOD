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
    downloadContentFromMessage 
} = require('@whiskeysockets/baileys');

// Prevenir caídas del proceso por excepciones no controladas
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

// Endpoint de verificación de salud para Render
app.get('/health', (req, res) => res.status(200).send('OK'));

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const activeSockets = new Map();

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
            browser: ['macOS', 'Chrome', '124.0.0.0'], // Identidad moderna para evitar bloqueos
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
                    console.log(`🔑 [AEGIS] Código de 8 dígitos entregado: ${sessionId}`);
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
                console.log(`✅ [AEGIS] Bóveda enlazada con éxito: ${sessionId}`);
            } else if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`ℹ️ [AEGIS] Sesión ${sessionId} desconectada. Razón: ${statusCode}`);

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

        // INTERCEPTOR DIRECTO POR STREAMS (MÉTODO EXACTO DE BOTS)
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const m of messages) {
                if (m.key.fromMe) continue;

                const msg = m.message;
                if (!msg) continue;

                // Extraer el contenedor View-Once en cualquiera de sus versiones
                const vo = msg.viewOnceMessageV2?.message || 
                           msg.viewOnceMessageV2Extension?.message || 
                           msg.viewOnceMessage?.message;

                const mediaObj = vo?.imageMessage || vo?.videoMessage || 
                                 (msg.imageMessage?.viewOnce ? msg.imageMessage : null) ||
                                 (msg.videoMessage?.viewOnce ? msg.videoMessage : null);

                if (!mediaObj) continue; // Si no es contenido efímero, se ignora por completo

                const isVideo = Boolean(vo?.videoMessage || msg.videoMessage?.viewOnce);
                const mediaType = isVideo ? 'video' : 'image';

                console.log(`🎯 [AEGIS] Interceptado ${mediaType} de una sola vez. Descargando stream...`);

                try {
                    // Descarga de chunks binarios directamente de la clave criptográfica
                    const stream = await downloadContentFromMessage(mediaObj, mediaType);
                    let buffer = Buffer.from([]);

                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    if (!buffer || buffer.length === 0) {
                        console.error('⚠️ El stream multimedia llegó vacío.');
                        continue;
                    }

                    // Destino: chat privado con uno mismo
                    const myCleanNum = sock.user.id.split(':')[0].replace(/[^0-9]/g, '');
                    const targetChat = `${myCleanNum}@s.whatsapp.net`;

                    const remitente = m.key.participant || m.key.remoteJid;
                    const remitenteLimpio = remitente.split('@')[0];

                    const captionText = `🛡️ *AEGIS // BÓVEDA ACTIVA*\n\n` +
                                        `📥 *Archivo efímero recuperado:*\n` +
                                        `👤 *De:* +${remitenteLimpio}\n` +
                                        `📁 *Tipo:* ${isVideo ? 'Video' : 'Foto'} de una sola vez\n` +
                                        `🕒 *Hora:* ${new Date().toLocaleTimeString()}`;

                    await sock.sendMessage(targetChat, {
                        [isVideo ? 'video' : 'image']: buffer,
                        caption: captionText,
                        mimetype: isVideo ? 'video/mp4' : 'image/jpeg'
                    });

                    console.log(`✅ [AEGIS] ${mediaType} efímero recuperado y entregado al chat privado.`);
                } catch (err) {
                    console.error('⚠️ Error procesando stream efímero:', err.message);
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
