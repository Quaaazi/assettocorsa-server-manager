const fs = require('fs');
const path = require('path');

class LiveMonitor {
    constructor() {
        this.players = new Map();
        this.mainWindow = null;
        this.serverDir = '';
        this.onPlayerConnect = null;
        this.onPlayerDisconnect = null;
    }

    init(mainWindow, serverDir, callbacks = {}) {
        this.mainWindow = mainWindow;
        this.serverDir = serverDir;
        if (callbacks.onConnect) this.onPlayerConnect = callbacks.onConnect;
        if (callbacks.onDisconnect) this.onPlayerDisconnect = callbacks.onDisconnect;
    }

    reset() {
        this.players.clear();
        this.broadcastUpdate();
    }

    parseLogChunk(text) {
        const lines = text.split(/\r?\n/);
        let changed = false;

        for (const line of lines) {
            // "INF]" подходит и под формат файла "[INF] ...", и под консольный "[12:41:41 INF] ..."
            const attemptMatch = line.match(/\bINF\]\s+(.+?)\s+\((\d{17})\s+-\s+([^)]+)\)\s+is attempting to connect/);
            if (attemptMatch) {
                this.lastAttemptIp = { steamId: attemptMatch[2], ip: attemptMatch[3].split(':')[0] };
            }

            const connMatch = line.match(/\bINF\]\s+(.+?)\s+\((\d{17}),\s*(\d+)\s*\(([^)]+)\)\)\s+has connected/);
            if (connMatch) {
                const name = connMatch[1].trim();
                const steamId = connMatch[2];
                const sessionId = connMatch[3];
                const carRaw = connMatch[4];
                const ip = (this.lastAttemptIp && this.lastAttemptIp.steamId === steamId) ? this.lastAttemptIp.ip : 'Local';

                const playerObj = {
                    sessionId,
                    name,
                    steamId,
                    car: carRaw,
                    ip,
                    connectedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                };

                this.players.set(sessionId, playerObj);
                changed = true;
                if (this.onPlayerConnect) this.onPlayerConnect(playerObj, this.players.size);
            }

            const exitMatch = line.match(/Received clean exit from\s+(.+?)\s+\((\d+)\)/);
            if (exitMatch && this.players.has(exitMatch[2])) {
                const player = this.players.get(exitMatch[2]);
                this.players.delete(exitMatch[2]);
                changed = true;
                if (this.onPlayerDisconnect) this.onPlayerDisconnect(player.name, this.players.size, player);
            }

            const discMatch = line.match(/\bINF\]\s+(.+?)\s+has disconnected/);
            if (discMatch) {
                const discName = discMatch[1].trim();
                for (const [sId, p] of this.players.entries()) {
                    if (p.name === discName) {
                        this.players.delete(sId);
                        changed = true;
                        if (this.onPlayerDisconnect) this.onPlayerDisconnect(discName, this.players.size, p);
                    }
                }
            }
        }

        if (changed) this.broadcastUpdate();
    }

    broadcastUpdate() {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('live:playersUpdate', Array.from(this.players.values()));
        }
    }

    // Запасной канал, если RCON недоступен: команда в консоль процесса сервера
    sendServerCommand(serverProcess, cmd) {
        if (serverProcess && serverProcess.stdin && !serverProcess.killed) {
            serverProcess.stdin.write(cmd + '\n');
            return true;
        }
        return false;
    }

    // send(cmd) -> Promise<boolean>: RCON или stdin, решает main.js
    async kickPlayer(send, sessionId) {
        if (!this.players.has(String(sessionId))) return false;
        const ok = await send(`/kick_id ${sessionId}`);
        if (ok) {
            this.players.delete(String(sessionId));
            this.broadcastUpdate();
        }
        return ok;
    }

    async banPlayer(send, sessionId) {
        const player = this.players.get(String(sessionId));
        if (!player) return false;

        // AssettoServer сам записывает бан, но дублируем SteamID в blacklist.txt на случай отказа команды.
        // В строке только SteamID — так файл гарантированно читается сервером.
        if (this.serverDir && player.steamId) {
            const blacklistPath = path.join(this.serverDir, 'blacklist.txt');
            const content = fs.existsSync(blacklistPath) ? fs.readFileSync(blacklistPath, 'utf-8') : '';
            if (!content.split(/\r?\n/).some(l => l.trim() === player.steamId)) {
                const prefix = content && !content.endsWith('\n') ? '\r\n' : '';
                fs.appendFileSync(blacklistPath, `${prefix}${player.steamId}\r\n`, 'utf-8');
            }
        }

        const ok = await send(`/ban_id ${sessionId}`);
        this.players.delete(String(sessionId));
        this.broadcastUpdate();
        return ok;
    }

    async sendBroadcastChat(send, message) {
        if (!message || !message.trim()) return false;
        return send(`/say ${message.trim()}`);
    }
}

module.exports = new LiveMonitor();
