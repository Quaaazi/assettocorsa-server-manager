// Клиент Source RCON для AssettoServer (порт RconPort в extra_cfg.yml, пароль — ADMIN_PASSWORD).
// Пакет: int32 size | int32 id | int32 type | body\0 | \0  (little-endian)
const net = require('net');

const SERVERDATA_AUTH = 3;
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_RESPONSE_VALUE = 0;

class RconClient {
    constructor() {
        this.socket = null;
        this.connected = false;
        this.nextId = 1;
        this.pending = new Map();
        this.buffer = Buffer.alloc(0);
        this.onStatus = null;
    }

    setStatus(connected) {
        this.connected = connected;
        if (this.onStatus) this.onStatus(connected);
    }

    connect({ host = '127.0.0.1', port, password, timeoutMs = 4000 }) {
        this.close();
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host, port });
            this.socket = socket;
            const timer = setTimeout(() => { socket.destroy(); reject(new Error('RCON: timeout')); }, timeoutMs);

            socket.on('data', chunk => this.handleData(chunk));
            socket.on('error', err => { clearTimeout(timer); this.failAll(err); reject(err); });
            socket.on('close', () => { this.failAll(new Error('RCON: connection closed')); this.setStatus(false); });

            socket.once('connect', () => {
                const authId = this.nextId++;
                this.pending.set(authId, {
                    auth: true,
                    resolve: () => { clearTimeout(timer); this.setStatus(true); resolve(); },
                    reject: err => { clearTimeout(timer); reject(err); }
                });
                socket.write(this.encode(authId, SERVERDATA_AUTH, password));
            });
        });
    }

    encode(id, type, body) {
        const payload = Buffer.from(String(body), 'utf8');
        const packet = Buffer.alloc(14 + payload.length);
        packet.writeInt32LE(10 + payload.length, 0);
        packet.writeInt32LE(id, 4);
        packet.writeInt32LE(type, 8);
        payload.copy(packet, 12);
        return packet; // два завершающих нуля уже есть после alloc
    }

    handleData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
            const size = this.buffer.readInt32LE(0);
            if (this.buffer.length < size + 4) return;
            const id = this.buffer.readInt32LE(4);
            const type = this.buffer.readInt32LE(8);
            const body = this.buffer.slice(12, 4 + size - 2).toString('utf8');
            this.buffer = this.buffer.slice(size + 4);

            if (type === SERVERDATA_AUTH_RESPONSE) {
                // id = -1 означает неверный пароль
                const entry = [...this.pending.entries()].find(([, p]) => p.auth);
                if (!entry) continue;
                this.pending.delete(entry[0]);
                if (id === -1) entry[1].reject(new Error('RCON: wrong password'));
                else entry[1].resolve();
            } else if (type === SERVERDATA_RESPONSE_VALUE && this.pending.has(id) && !this.pending.get(id).auth) {
                // Пустой RESPONSE_VALUE перед AUTH_RESPONSE (особенность Source RCON) пропускаем выше по условию
                const p = this.pending.get(id);
                this.pending.delete(id);
                p.resolve(body);
            }
        }
    }

    exec(command, timeoutMs = 5000) {
        if (!this.connected || !this.socket) return Promise.reject(new Error('RCON: not connected'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('RCON: no response')); }, timeoutMs);
            this.pending.set(id, {
                resolve: body => { clearTimeout(timer); resolve(body); },
                reject: err => { clearTimeout(timer); reject(err); }
            });
            this.socket.write(this.encode(id, SERVERDATA_EXECCOMMAND, command));
        });
    }

    failAll(err) {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
    }

    close() {
        if (this.socket) this.socket.destroy();
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        if (this.connected) this.setStatus(false);
    }
}

module.exports = new RconClient();
