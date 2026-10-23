const https = require('https');

class DiscordWebhook {
    constructor() {
        this.webhookUrl = '';
        this.enabled = false;
        this.serverName = 'Assetto Corsa Server';
        this.trackName = '';
    }

    configure({ url, enabled, serverName, trackName }) {
        if (url !== undefined) this.webhookUrl = String(url).trim();
        if (enabled !== undefined) this.enabled = Boolean(enabled);
        if (serverName) this.serverName = serverName;
        if (trackName) this.trackName = trackName;
    }

    sendEmbed({ title, description, color = 0x3b82f6, fields = [] }) {
        if (!this.enabled || !this.webhookUrl || !this.webhookUrl.startsWith('https://discord.com/api/webhooks/') && !this.webhookUrl.startsWith('https://discordapp.com/api/webhooks/')) {
            return Promise.resolve(false);
        }

        const payload = JSON.stringify({
            username: 'Assetto Corsa Server Manager',
            embeds: [{
                title,
                description,
                color,
                fields,
                footer: { text: `${this.serverName} • BY QUAAAZI` },
                timestamp: new Date().toISOString()
            }]
        });

        return new Promise((resolve) => {
            try {
                const urlObj = new URL(this.webhookUrl);
                const req = https.request({
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload)
                    }
                }, (res) => {
                    resolve(res.statusCode >= 200 && res.statusCode < 300);
                });

                req.on('error', () => resolve(false));
                req.write(payload);
                req.end();
            } catch (e) {
                resolve(false);
            }
        });
    }

    notifyServerStart(track, maxClients, aiEnabled) {
        return this.sendEmbed({
            title: '🟢 Сервер запущен и готов к игре!',
            description: `Сервер **${this.serverName}** успешно запущен.`,
            color: 0x10b981,
            fields: [
                { name: '🗺️ Карта', value: `\`${track || 'Не указана'}\``, inline: true },
                { name: '🏎️ Слоты', value: `\`${maxClients}\``, inline: true },
                { name: '🚦 ИИ-Трафик', value: aiEnabled ? '`Включен`' : '`Выключен`', inline: true }
            ]
        });
    }

    notifyServerStop(isCrash = false, exitCode = 0) {
        if (isCrash) {
            return this.sendEmbed({
                title: '🔴 Внимание: Сервер аварийно остановился!',
                description: `Процесс **AssettoServer.exe** завершился с ошибкой (Код: \`${exitCode}\`). Проверьте консоль лаунчера.`,
                color: 0xef4444
            });
        }
        return this.sendEmbed({
            title: '⚪ Сервер остановлен',
            description: `Сервер **${this.serverName}** был остановлен администратором.`,
            color: 0x64748b
        });
    }

    notifyPlayerConnect(player, onlineCount) {
        return this.sendEmbed({
            title: '📥 Игрок подключился',
            description: `**${player.name}** зашел на сервер!`,
            color: 0x3b82f6,
            fields: [
                { name: '🚗 Машина', value: `\`${player.car}\``, inline: true },
                { name: '👥 Онлайн', value: `\`${onlineCount}\` игр.`, inline: true }
            ]
        });
    }

    notifyPlayerDisconnect(playerName, onlineCount) {
        return this.sendEmbed({
            title: '📤 Игрок вышел',
            description: `**${playerName}** покинул сервер. Онлайн: \`${onlineCount}\``,
            color: 0xf59e0b
        });
    }
}

module.exports = new DiscordWebhook();