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

// Prevenir que el servidor se caiga por errores inesperados
process.on('uncaughtException', (err) => {
    console.error('⚠️ [UNCAUGHT EXCEPTION]:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [UNHANDLED REJECTION]:', reason);
});

const app = express();
const server = http.createServer(app);

// Configuración de WebSockets con CORS para permitir conexiones externas (Netlify/Navegador)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

// Endpoint de verificación de salud para Render
app.get('/health', (req, res) => res.status(200).send('OK'));

// Servir archivos estáticos del directorio actual
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const activeSockets = new Map();

// FILTRO ESTRICTO: Solo extrae si el mensaje es "Ver una sola vez" REAL
function extraerContenidoVO(msg) {
    if (!msg) return null;

    let target = msg;

    // Desempaquetar capas habituales de WhatsApp
    if (target.ephemeralMessage?.message) target = target.ephemeralMessage.message;
    if (target.deviceSentMessage?.message) target = target.deviceSentMessage.message;

    // Formato estándar moderno (viewOnceMessageV2)
    if (target.viewOnceMessageV2?.message) {
        const inner = target.viewOnceMessageV2.message;
        if (inner.imageMessage) return { type: 'image', media: inner.imageMessage };
        if (inner.videoMessage) return { type: 'video', media: inner.videoMessage };
    }

    // Extensiones V2
    if (target.viewOnceMessageV2Extension?.message) {
        const inner = target.viewOnceMessageV2Extension.message;
        if (inner.imageMessage) return { type: 'image', media: inner.imageMessage };
        if (inner.videoMessage) return { type: 'video', media: inner.videoMessage };
    }

    // Formato V1 clásico
    if (target.viewOnceMessage?.message) {
        const inner = target.viewOnceMessage.message;
        if (inner.imageMessage) return { type: 'image', media: inner.imageMessage };
        if (inner.videoMessage) return { type: 'video', media: inner.videoMessage };
    }

    // Mensaje directo con bandera viewOnce activa
    if (target.imageMessage?.viewOnce === true) {
        return { type: 'image', media: target.imageMessage };
    }
    if (target.videoMessage?.viewOnce === true) {
        return { type: 'video', media: target.videoMessage };
    }

    // Si es una foto o video normal, se ignora por completo
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
            syncFullHistory: false, // Evita saturar la memoria RAM en Render
            markOnlineOnConnect: false
        });

        activeSockets.set(sessionId, sock);
        sock.ev.on('creds.update', saveCreds);

        // Generar código de 8 dígitos si se pidió por número telefónico
        if (phoneNumber && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                    clientSocket.emit('pairing_code', { code });
                    console.log(`🔑 [AEGIS] Código de emparejamiento generado para: ${sessionId}`);
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
                console.log(`✅ [AEGIS] Sesión vinculada y activa: ${sessionId}`);
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

        // INTERCEPTOR EXCLUSIVO DE CONTENIDO EFÍMERO
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const m of messages) {
                // No interceptar mensajes enviados por uno mismo
                if (m.key.fromMe) continue;

                const vo = extraerContenidoVO(m.message);
                if (!vo || !vo.media) continue; // Si es una foto/video normal, lo ignora de inmediato

                try {
                    console.log(`🎯 [AEGIS] Interceptado archivo efímero (${vo.type}). Procediendo a descargar...`);

                    const isVideo = vo.type === 'video';
                    const mediaKey = isVideo ? 'videoMessage' : 'imageMessage';

                    // Clonar objeto y desactivar bandera viewOnce para permitir descarga limpia
                    const mediaPayload = { ...vo.media, viewOnce: false };

                    const fakeMsg = {
                        key: m.key,
                        message: {
                            [mediaKey]: mediaPayload
                        }
                    };

                    const buffer = await downloadMediaMessage(
                        fakeMsg,
                        'buffer',
                        {},
                        { 
                            reuploadRequest: sock.updateMediaMessage,
                            logger: pino({ level: 'silent' })
                        }
                    );

                    if (!buffer || buffer.length === 0) {
                        console.error('⚠️ Archivo descargado vacío.');
                        continue;
                    }

                    // Identificar remitente y destino (chat personal)
                    const remitente = m.key.participant || m.key.remoteJid;
                    const remitenteLimpio = remitente.split('@')[0];
                    const myCleanNum = sock.user.id.split(':')[0].replace(/[^0-9]/g, '');
                    const targetChat = `${myCleanNum}@s.whatsapp.net`;

                    const captionText = `🛡️ *AEGIS // BÓVEDA ACTIVA*\n\n` +
                                        `📥 *Archivo efímero rescatado:*\n` +
                                        `👤 *De:* +${remitenteLimpio}\n` +
                                        `📁 *Tipo:* ${isVideo ? 'Video' : 'Foto'} de una sola vez\n` +
                                        `🕒 *Hora:* ${new Date().toLocaleTimeString()}`;

                    await sock.sendMessage(targetChat, {
                        [isVideo ? 'video' : 'image']: buffer,
                        caption: captionText,
                        mimetype: isVideo ? 'video/mp4' : 'image/jpeg'
                    });

                    console.log(`📸 [AEGIS] ${vo.type} efímero entregado exitosamente al chat personal.`);
                } catch (e) {
                    console.error(`⚠️ Error al descifrar archivo efímero:`, e.message);
                }
            }
        });

    } catch (globalErr) {
        console.error('Error crítico inicializando sesión:', globalErr.message);
    }
}

// Escuchar solicitudes desde la página web
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
