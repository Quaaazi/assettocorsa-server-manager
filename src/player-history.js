// История игроков: кто заходил, когда, сколько времени провёл. Хранится в server_instance/player_history.json
const fs = require('fs');
const path = require('path');

const MAX_SESSIONS = 300;

class PlayerHistory {
    constructor() {
        this.file = '';
        this.data = { players: {}, sessions: [] };
        this.open = new Map(); // sessionId -> { steamId, start }
    }

    init(serverDir) {
        this.file = path.join(serverDir, 'player_history.json');
        try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf-8')); } catch (e) {}
        if (!this.data.players) this.data.players = {};
        if (!Array.isArray(this.data.sessions)) this.data.sessions = [];
    }

    save() {
        if (!this.file) return;
        try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8'); } catch (e) {}
    }

    onConnect(player) {
        if (!player.steamId) return;
        const now = Date.now();
        const rec = this.data.players[player.steamId] || { steamId: player.steamId, names: [], firstSeen: now, visits: 0, totalMinutes: 0 };
        rec.name = player.name;
        if (!rec.names.includes(player.name)) rec.names = [...rec.names, player.name].slice(-5);
        rec.lastSeen = now;
        rec.lastCar = String(player.car || '').split('-')[0];
        rec.visits += 1;
        this.data.players[player.steamId] = rec;
        this.open.set(String(player.sessionId), { steamId: player.steamId, name: player.name, car: rec.lastCar, start: now });
        this.save();
    }

    onDisconnect(player) {
        if (!player) return;
        this.closeSession(String(player.sessionId));
        this.save();
    }

    closeSession(sessionId) {
        const s = this.open.get(sessionId);
        if (!s) return;
        this.open.delete(sessionId);
        const end = Date.now();
        const minutes = Math.max(0, Math.round((end - s.start) / 60000));
        const rec = this.data.players[s.steamId];
        if (rec) { rec.totalMinutes += minutes; rec.lastSeen = end; }
        this.data.sessions.unshift({ steamId: s.steamId, name: s.name, car: s.car, start: s.start, end, minutes });
        this.data.sessions = this.data.sessions.slice(0, MAX_SESSIONS);
    }

    // Сервер остановлен — закрываем все незавершённые сессии
    closeAll() {
        for (const id of [...this.open.keys()]) this.closeSession(id);
        this.save();
    }

    snapshot() {
        const players = Object.values(this.data.players).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
        return { players, sessions: this.data.sessions.slice(0, 100) };
    }

    clear() {
        this.data = { players: {}, sessions: [] };
        this.open.clear();
        this.save();
    }
}

module.exports = new PlayerHistory();
