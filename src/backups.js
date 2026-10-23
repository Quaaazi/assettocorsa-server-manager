// Резервные копии настроек: cfg/, profiles/ и списки доступа (admins/whitelist/blacklist).
// Снимок — обычная папка в server_instance/backups, чтобы откат был простым копированием.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_AUTO_SNAPSHOTS = 10;
const ROOT_FILES = ['admins.txt', 'whitelist.txt', 'blacklist.txt', 'player_history.json'];
const FOLDERS = ['cfg', 'profiles'];

function backupsDir(serverDir) {
    return path.join(serverDir, 'backups');
}

function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function listFilesRecursive(dir, base = dir, acc = []) {
    if (!fs.existsSync(dir)) return acc;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) listFilesRecursive(full, base, acc);
        else acc.push(path.relative(base, full));
    }
    return acc;
}

// Хэш содержимого настроек — чтобы не плодить одинаковые автоснимки при каждом сохранении
function contentHash(serverDir) {
    const hash = crypto.createHash('sha1');
    for (const folder of FOLDERS) {
        for (const rel of listFilesRecursive(path.join(serverDir, folder)).sort()) {
            hash.update(rel);
            hash.update(fs.readFileSync(path.join(serverDir, folder, rel)));
        }
    }
    for (const f of ROOT_FILES) {
        const p = path.join(serverDir, f);
        if (fs.existsSync(p)) { hash.update(f); hash.update(fs.readFileSync(p)); }
    }
    return hash.digest('hex');
}

function list(serverDir) {
    const dir = backupsDir(serverDir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => {
            let meta = {};
            try { meta = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'backup.json'), 'utf-8')); } catch (err) {}
            return { id: e.name, kind: meta.kind || 'manual', reason: meta.reason || '', createdAt: meta.createdAt || 0, hash: meta.hash || '' };
        })
        .sort((a, b) => b.createdAt - a.createdAt);
}

// kind: 'auto' (перед сохранением/откатом) или 'manual' (кнопка)
function createSnapshot(serverDir, { kind = 'manual', reason = '' } = {}) {
    const hash = contentHash(serverDir);
    if (kind === 'auto') {
        const lastAuto = list(serverDir).find(b => b.kind === 'auto');
        if (lastAuto && lastAuto.hash === hash) return { skipped: true, id: lastAuto.id };
    }

    const id = `${stamp()}_${kind}`;
    const target = path.join(backupsDir(serverDir), id);
    fs.mkdirSync(target, { recursive: true });

    for (const folder of FOLDERS) {
        const src = path.join(serverDir, folder);
        if (fs.existsSync(src)) fs.cpSync(src, path.join(target, folder), { recursive: true });
    }
    for (const f of ROOT_FILES) {
        const src = path.join(serverDir, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target, f));
    }
    fs.writeFileSync(path.join(target, 'backup.json'), JSON.stringify({ kind, reason, createdAt: Date.now(), hash }, null, 2), 'utf-8');

    pruneAuto(serverDir);
    return { skipped: false, id };
}

function pruneAuto(serverDir) {
    const autos = list(serverDir).filter(b => b.kind === 'auto');
    for (const old of autos.slice(MAX_AUTO_SNAPSHOTS)) {
        fs.rmSync(path.join(backupsDir(serverDir), old.id), { recursive: true, force: true });
    }
}

function resolveBackup(serverDir, id) {
    // id приходит из интерфейса — не даём выйти за пределы папки backups
    const dir = path.resolve(backupsDir(serverDir), String(id));
    if (path.dirname(dir) !== path.resolve(backupsDir(serverDir)) || !fs.existsSync(dir)) throw new Error('Backup not found');
    return dir;
}

function restore(serverDir, id) {
    const source = resolveBackup(serverDir, id);
    createSnapshot(serverDir, { kind: 'auto', reason: 'before_restore' });

    for (const folder of FOLDERS) {
        const src = path.join(source, folder);
        if (!fs.existsSync(src)) continue;
        fs.rmSync(path.join(serverDir, folder), { recursive: true, force: true });
        fs.cpSync(src, path.join(serverDir, folder), { recursive: true });
    }
    for (const f of ROOT_FILES) {
        const src = path.join(source, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(serverDir, f));
    }
}

function remove(serverDir, id) {
    fs.rmSync(resolveBackup(serverDir, id), { recursive: true, force: true });
}

// Архив .zip одной кнопкой (PowerShell Compress-Archive, пути передаются через переменные окружения — без кавычек в команде)
function exportZip(serverDir, id, destZip) {
    const source = resolveBackup(serverDir, id);
    return new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -Path (Join-Path $env:ASM_SRC "*") -DestinationPath $env:ASM_DST -Force'],
            { env: { ...process.env, ASM_SRC: source, ASM_DST: destZip }, windowsHide: true },
            err => (err ? reject(new Error('Compress-Archive failed')) : resolve(destZip)));
    });
}

module.exports = { list, createSnapshot, restore, remove, exportZip, backupsDir };
