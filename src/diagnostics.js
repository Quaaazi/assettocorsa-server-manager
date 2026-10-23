// Диагностика перед запуском: порты, файлы сервера, трасса и машины, безопасность настроек.
const fs = require('fs');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const os = require('os');

function checkTcpPort(port) {
    return new Promise(resolve => {
        const srv = net.createServer();
        srv.once('error', err => resolve(err.code !== 'EADDRINUSE' && err.code !== 'EACCES'));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, '0.0.0.0');
    });
}

function checkUdpPort(port) {
    return new Promise(resolve => {
        const sock = dgram.createSocket('udp4');
        sock.once('error', () => { try { sock.close(); } catch (e) {} resolve(false); });
        sock.bind(port, '0.0.0.0', () => sock.close(() => resolve(true)));
    });
}

// Адреса этого ПК в локальной сети — их видят друзья в LAN/Radmin/Hamachi
function localAddresses() {
    return Object.values(os.networkInterfaces()).flat()
        .filter(i => i && i.family === 'IPv4' && !i.internal)
        .map(i => i.address);
}

// Только порты: быстрая проверка при старте лаунчера
async function checkPorts({ udpPort, tcpPort, httpPort, rconPort }) {
    const checks = [
        { key: 'udp', proto: 'UDP', port: udpPort, free: await checkUdpPort(udpPort) },
        { key: 'tcp', proto: 'TCP', port: tcpPort, free: await checkTcpPort(tcpPort) },
        { key: 'http', proto: 'HTTP/TCP', port: httpPort, free: httpPort === tcpPort ? true : await checkTcpPort(httpPort) }
    ];
    if (rconPort) checks.push({ key: 'rcon', proto: 'RCON/TCP', port: rconPort, free: await checkTcpPort(rconPort) });
    return checks;
}

// items: { level: 'ok' | 'warn' | 'error', code, params } — тексты собирает интерфейс (нужен перевод)
async function preflight({ serverDir, serverCfg, extraCfg, serverRunning }) {
    const items = [];
    const s = serverCfg.SERVER || {};
    const add = (level, code, params = {}) => items.push({ level, code, params });

    if (!fs.existsSync(path.join(serverDir, 'AssettoServer.exe'))) add('error', 'exe_missing');
    else add('ok', 'exe_ok');

    if (String(s.ADMIN_PASSWORD || '').length < 8) add('error', 'password_short');

    if (!serverRunning) {
        const ports = await checkPorts({
            udpPort: parseInt(s.UDP_PORT) || 9600,
            tcpPort: parseInt(s.TCP_PORT) || 9600,
            httpPort: parseInt(s.HTTP_PORT) || 8081,
            rconPort: parseInt(extraCfg.RconPort) || 0
        });
        for (const p of ports) add(p.free ? 'ok' : 'error', p.free ? 'port_free' : 'port_busy', { proto: p.proto, port: p.port });
    }

    const trackDir = path.join(serverDir, 'content', 'tracks', String(s.TRACK || ''));
    if (!s.TRACK || !fs.existsSync(trackDir)) add('error', 'track_missing', { track: s.TRACK || '—' });
    else add('ok', 'track_ok', { track: s.TRACK });

    const cars = String(s.CARS || '').split(';').filter(Boolean);
    const missingCars = cars.filter(c => {
        const dir = path.join(serverDir, 'content', 'cars', c);
        return !fs.existsSync(path.join(dir, 'data.acd')) && !fs.existsSync(path.join(dir, 'data'));
    });
    if (cars.length === 0) add('error', 'no_cars');
    else if (missingCars.length) add('warn', 'cars_missing_data', { cars: missingCars.slice(0, 5).join(', '), count: missingCars.length });
    else add('ok', 'cars_ok', { count: cars.length });

    const admins = fs.existsSync(path.join(serverDir, 'admins.txt'))
        ? fs.readFileSync(path.join(serverDir, 'admins.txt'), 'utf-8').split(/\r?\n/).filter(l => l.trim()).length : 0;
    if (admins > 0 && !extraCfg.UseSteamAuth) add('warn', 'admins_without_steam_auth', { count: admins });

    if (extraCfg.IgnoreConfigurationErrors && Object.values(extraCfg.IgnoreConfigurationErrors).some(Boolean)) add('warn', 'ignoring_config_errors');

    add('info', 'local_addresses', { list: localAddresses().join(', ') || '—', udp: s.UDP_PORT, tcp: s.TCP_PORT, http: s.HTTP_PORT });
    return items;
}

module.exports = { checkPorts, preflight, localAddresses };
