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

// Captura de errores globales para evitar que el proceso muera inesperadamente
process.on('uncaughtException', (err) => console.error('⚠️ [EXCEPCIÓN NO CONTROLADA]:', err.message));
process.on('unhandledRejection', (reason) => console.error('⚠️ [RECHAZO NO CONTROLADO]:', reason));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

// Endpoint para mantener vivo el servicio en Render con cron-job / uptimerobot
app.get('/health', (req, res) => res.status(200).send('OK'));
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Carpetas para persistir datos y sesiones
const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const CONFIG_FILE = path.join(DATA_DIR, 'configs.json');

function leerConfig() {
    try {
        return fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) : {};
    } catch (_) { return {}; }
}

function guardarConfig(data) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Error guardando configuración:', err.message);
    }
}

let configuraciones = leerConfig();

// Variables de estado en memoria
const activeSockets = new Map();
const reconnectTimers = new Map();
const sessionStartTimes = new Map();
const messageStore = new Map();
const msgRetryCounterMap = new Map();

// Helper para extraer contenido de View-Once
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

// Descarga el archivo de medios y lo redirige al número receptor externo
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

    if (!buffer || buffer.length === 0) throw new Error('El archivo descargado está vacío.');

    const caption = 
`🛡️ *AEGIS // BÓVEDA ACTIVA*
${captionExtra}
👤 *De:* +${senderNum}
📁 *Tipo:* ${isVideo ? 'Video' : 'Foto'} de una sola vez
🕒 *Hora:* ${new Date().toLocaleTimeString()}`;

    const sent = await sock.sendMessage(targetChat, {
        [isVideo ? 'video' : 'image']: buffer,
        caption: caption,
        mimetype: isVideo ? 'video/mp4' : 'image/jpeg'
    });

    if (sent?.key?.id) {
        messageStore.set(sent.key.id, sent.message);
        setTimeout(() => messageStore.delete(sent.key.id), 10 * 60 * 1000);
    }
}

// Inicialización de la sesión Baileys
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

        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        if (clientSocket) {
            clientSocket.emit('sync_progress', { percent: 25, statusText: 'Iniciando llaves criptográficas...' });
        }

        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ['macOS', 'Chrome', '124.0.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 20000,
            msgRetryCounterMap,
            getMessage: async (key) => messageStore.get(key.id) || { conversation: 'Sync' }
        });

        activeSockets.set(sessionId, sock);
        sock.ev.on('creds.update', saveCreds);

        // Generar código de emparejamiento (Pairing Code) si es sesión nueva por teléfono
        if (phoneNumber && !sock.authState.creds.registered) {
            if (clientSocket) {
                clientSocket.emit('sync_progress', { percent: 50, statusText: 'Solicitando código de WhatsApp...' });
            }
            setTimeout(async () => {
                try {
                    const clean = phoneNumber.replace(/[^0-9]/g, '');
                    const code = await sock.requestPairingCode(clean);
                    if (clientSocket) {
                        clientSocket.emit('pairing_code', { code });
                        clientSocket.emit('sync_progress', { percent: 75, statusText: 'Código recibido. Ingrésalo en WhatsApp.' });
                    }
                    console.log(`🔑 [AEGIS] Código entregado: ${code} (${sessionId})`);
                } catch (err) {
                    console.error('Error generando pairing code:', err.message);
                    if (clientSocket) clientSocket.emit('error_msg', { message: 'Error solicitando código: ' + err.message });
                }
            }, 3000);
        }

        // Eventos de estado de conexión
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !phoneNumber && clientSocket) {
                clientSocket.emit('qr_code', { qr });
            }

            if (connection === 'open') {
                sessionStartTimes.set(sessionId, Date.now());
                if (clientSocket) {
                    clientSocket.emit('sync_progress', { percent: 100, statusText: 'Enlace completado. Bóveda activa.' });
                    clientSocket.emit('status', { status: 'connected', startTime: sessionStartTimes.get(sessionId) });
                    clientSocket.emit('toast_msg', { message: 'WhatsApp vinculado exitosamente', type: 'success' });
                }
                console.log(`✅ [AEGIS] Sesión en línea y permanente: ${sessionId}`);
            } else if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
                const isConflict = statusCode === 440;

                sessionStartTimes.delete(sessionId);
                console.log(`ℹ️ [AEGIS] Conexión cerrada en ${sessionId}. Código HTTP: ${statusCode}`);

                if (!isLoggedOut && !isConflict) {
                    if (clientSocket) {
                        clientSocket.emit('sync_progress', { percent: 40, statusText: 'Reconectando con WhatsApp...' });
                        clientSocket.emit('status', { status: 'connecting', message: 'Reconexión automática en proceso...' });
                    }
                    const timer = setTimeout(() => iniciarSesion(sessionId, phoneNumber, clientSocket), 5000);
                    reconnectTimers.set(sessionId, timer);
                } else {
                    try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (_) {}
                    activeSockets.delete(sessionId);
                    delete configuraciones[sessionId];
                    guardarConfig(configuraciones);
                    if (clientSocket) {
                        clientSocket.emit('status', { status: 'disconnected', message: 'Sesión desvinculada o cerrada.' });
                        clientSocket.emit('toast_msg', { message: 'Sesión finalizada', type: 'error' });
                    }
                }
            }
        });

        // Intercepción de mensajes
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const m of messages) {
                if (!m.message) continue;

                // Destino: si hay número receptor configurado va a ese chat, de lo contrario al chat actual
                const userConf = configuraciones[sessionId] || {};
                const receptorFinal = userConf.targetNumber 
                    ? `${userConf.targetNumber}@s.whatsapp.net` 
                    : m.key.remoteJid;

                // 1. Comando manual de respuesta con "." o ".r"
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
                                    receptorFinal, 
                                    '🔓 *DESBLOQUEO MANUAL ( . )*'
                                );
                                if (clientSocket) {
                                    clientSocket.emit('toast_msg', { message: `Archivo reenviado a +${receptorFinal.split('@')[0]}`, type: 'success' });
                                }
                                console.log(`✅ [AEGIS] Desbloqueo manual enviado a: ${receptorFinal}`);
                            } catch (err) {
                                console.error('Error al desbloquear por comando:', err.message);
                                if (clientSocket) clientSocket.emit('toast_msg', { message: 'Error procesando comando: ' + err.message, type: 'error' });
                            }
                            continue;
                        }
                    }
                }

                // 2. Intercepción automática de fotos o videos efímeros
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
                        receptorFinal, 
                        '📥 *INTERCEPCIÓN AUTOMÁTICA*'
                    );
                    if (clientSocket) {
                        clientSocket.emit('toast_msg', { message: `Foto efímera interceptada y enviada a +${receptorFinal.split('@')[0]}`, type: 'success' });
                    }
                    console.log(`✅ [AEGIS] Auto-captura enviada a: ${receptorFinal}`);
                } catch (err) {
                    console.error('Error en captura automática:', err.message);
                    if (clientSocket) clientSocket.emit('toast_msg', { message: 'Fallo al interceptar: ' + err.message, type: 'error' });
                }
            }
        });

    } catch (globalErr) {
        console.error('Error crítico al inicializar sesión:', globalErr.message);
        if (clientSocket) clientSocket.emit('error_msg', { message: 'Fallo interno: ' + globalErr.message });
    }
}

// Handlers de Socket.IO comunicados con index.html
io.on('connection', (clientSocket) => {

    // Comprobar estado de la sesión según el UID de Google
    clientSocket.on('check_user_session', ({ uid }) => {
        const sessionId = `uid_${uid || 'anon'}`;
        const conf = configuraciones[sessionId] || {};
        const isConnected = activeSockets.has(sessionId) && activeSockets.get(sessionId)?.user;

        clientSocket.emit('session_data', {
            linkedNumber: conf.linkedNumber || null,
            targetNumber: conf.targetNumber || null,
            status: isConnected ? 'connected' : 'disconnected',
            startTime: sessionStartTimes.get(sessionId) || null
        });
    });

    // Iniciar vinculación mediante número
    clientSocket.on('vincular_dispositivo', ({ uid, linkedNumber, targetNumber }) => {
        const cleanLinked = (linkedNumber || '').replace(/[^0-9]/g, '');
        const cleanTarget = (targetNumber || '').replace(/[^0-9]/g, '');
        const sessionId = `uid_${uid || 'anon'}`;

        configuraciones[sessionId] = {
            linkedNumber: cleanLinked,
            targetNumber: cleanTarget
        };
        guardarConfig(configuraciones);

        clientSocket.emit('sync_progress', { percent: 10, statusText: 'Conectando túnel WebSocket...' });
        iniciarSesion(sessionId, cleanLinked, clientSocket);
    });

    // Iniciar vinculación mediante código QR
    clientSocket.on('iniciar_con_qr', ({ uid }) => {
        const sessionId = `uid_${uid || 'anon'}`;
        iniciarSesion(sessionId, null, clientSocket);
    });

    // Diagnóstico en vivo: Envía un mensaje de prueba al receptor asignado
    clientSocket.on('probar_conexion', async ({ uid }) => {
        const startTime = Date.now();
        const sessionId = `uid_${uid || 'anon'}`;
        const conf = configuraciones[sessionId];

        if (!conf || !conf.targetNumber) {
            clientSocket.emit('ping_result', { ok: false });
            return clientSocket.emit('toast_msg', { message: 'No tienes configurado un número receptor.', type: 'warn' });
        }

        const sock = activeSockets.get(sessionId);
        if (!sock || !sock.user) {
            clientSocket.emit('ping_result', { ok: false });
            return clientSocket.emit('toast_msg', { message: 'El WhatsApp enlazado no está en línea.', type: 'error' });
        }

        try {
            const targetJid = `${conf.targetNumber}@s.whatsapp.net`;
            await sock.sendMessage(targetJid, {
                text: `⚡ *PING DIAGNÓSTICO // AEGIS PROTOCOL*\n\nConexión establecida correctamente entre el daemon y la bóveda receptora.\n🕒 *Hora:* ${new Date().toLocaleTimeString()}`
            });
            const latency = Date.now() - startTime;
            clientSocket.emit('ping_result', { ok: true, latency });
            clientSocket.emit('toast_msg', { message: `Ping enviado con éxito a +${conf.targetNumber}`, type: 'success' });
        } catch (err) {
            clientSocket.emit('ping_result', { ok: false });
            clientSocket.emit('toast_msg', { message: 'Error enviando ping: ' + err.message, type: 'error' });
        }
    });

    // Desvinculación manual desde la página web
    clientSocket.on('desvincular_dispositivo', ({ uid }) => {
        const sessionId = `uid_${uid || 'anon'}`;
        if (activeSockets.has(sessionId)) {
            try {
                const s = activeSockets.get(sessionId);
                s.logout();
                s.end();
            } catch (_) {}
            activeSockets.delete(sessionId);
        }
        sessionStartTimes.delete(sessionId);
        try { fs.rmSync(path.join(SESSIONS_DIR, sessionId), { recursive: true, force: true }); } catch (_) {}
        delete configuraciones[sessionId];
        guardarConfig(configuraciones);

        clientSocket.emit('status', { status: 'disconnected', message: 'Sesión desvinculada por el usuario.' });
        clientSocket.emit('toast_msg', { message: 'Dispositivo desvinculado por completo.', type: 'info' });
    });
});

// Restaurar sesiones existentes cuando Render se despierta o se reinicia el contenedor
function restaurarSesionesGuardadas() {
    const ids = Object.keys(configuraciones);
    if (ids.length === 0) return;

    for (const sessionId of ids) {
        const conf = configuraciones[sessionId];
        if (conf && conf.linkedNumber) {
            console.log(`📦 [AEGIS] Reanudando sesión persistente: ${sessionId} (+${conf.linkedNumber})`);
            iniciarSesion(sessionId, conf.linkedNumber, null);
        }
    }
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SERVIDOR AEGIS CORRIENDO EN EL PUERTO ${PORT}`);
    restaurarSesionesGuardadas();
});
