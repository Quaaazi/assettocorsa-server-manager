// Редактор admins.txt / whitelist.txt / blacklist.txt.
// В самих файлах — только SteamID по одному в строке (так их гарантированно читает AssettoServer),
// а подписи к ним менеджер хранит отдельно в cfg/access_names.json.
const fs = require('fs');
const path = require('path');

const LISTS = { admins: 'admins.txt', whitelist: 'whitelist.txt', blacklist: 'blacklist.txt' };
const STEAM_ID_RE = /^7656119\d{10}$/;

const namesPath = serverDir => path.join(serverDir, 'cfg', 'access_names.json');

function loadNames(serverDir) {
    try { return JSON.parse(fs.readFileSync(namesPath(serverDir), 'utf-8')); } catch (e) { return {}; }
}

function readIds(serverDir, list) {
    const file = path.join(serverDir, LISTS[list]);
    if (!fs.existsSync(file)) return [];
    // Совместимость со старыми записями менеджера вида "SteamID // ник"
    return fs.readFileSync(file, 'utf-8').split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && !l.startsWith(';'))
        .map(l => {
            const [id, ...comment] = l.split('//');
            return { steamId: id.trim(), legacyName: comment.join('//').trim() };
        });
}

function loadAll(serverDir) {
    const names = loadNames(serverDir);
    const result = {};
    for (const list of Object.keys(LISTS)) {
        result[list] = readIds(serverDir, list).map(e => ({ steamId: e.steamId, name: names[e.steamId] || e.legacyName || '' }));
    }
    return result;
}

function saveList(serverDir, list, entries) {
    if (!LISTS[list]) throw new Error('Unknown list');
    const clean = [];
    const seen = new Set();
    for (const e of entries || []) {
        const steamId = String(e.steamId || '').trim();
        if (!STEAM_ID_RE.test(steamId)) throw new Error(`invalid_steam_id:${steamId}`);
        if (seen.has(steamId)) continue;
        seen.add(steamId);
        clean.push({ steamId, name: String(e.name || '').trim().slice(0, 64) });
    }

    const body = clean.map(e => e.steamId).join('\r\n');
    fs.writeFileSync(path.join(serverDir, LISTS[list]), body ? body + '\r\n' : '', 'utf-8');

    const names = loadNames(serverDir);
    for (const e of clean) {
        if (e.name) names[e.steamId] = e.name;
        else delete names[e.steamId];
    }
    // Подписи тех, кого больше нет ни в одном списке, удаляем
    const stillListed = new Set(Object.keys(LISTS).flatMap(l => readIds(serverDir, l).map(e => e.steamId)));
    for (const id of Object.keys(names)) if (!stillListed.has(id)) delete names[id];
    fs.mkdirSync(path.dirname(namesPath(serverDir)), { recursive: true });
    fs.writeFileSync(namesPath(serverDir), JSON.stringify(names, null, 2), 'utf-8');
    return clean;
}

// Подпись игрока при бане из Live-панели
function rememberName(serverDir, steamId, name) {
    if (!STEAM_ID_RE.test(String(steamId)) || !name) return;
    const names = loadNames(serverDir);
    names[steamId] = String(name).slice(0, 64);
    fs.mkdirSync(path.dirname(namesPath(serverDir)), { recursive: true });
    fs.writeFileSync(namesPath(serverDir), JSON.stringify(names, null, 2), 'utf-8');
}

module.exports = { LISTS, STEAM_ID_RE, loadAll, saveList, rememberName };
