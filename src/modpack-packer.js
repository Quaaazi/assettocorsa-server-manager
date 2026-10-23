const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

function createClientModpack({ acPath, serverDir, outputZipPath }) {
    return new Promise(async (resolve, reject) => {
        try {
            const presetPath = path.join(serverDir, 'cfg', 'manager_preset.json');
            const serverCfgPath = path.join(serverDir, 'cfg', 'server_cfg.ini');

            if (!fs.existsSync(presetPath)) {
                return reject(new Error('Прежде чем упаковывать мод-пак, сохраните или запустите хотя бы одну сборку.'));
            }

            const preset = JSON.parse(fs.readFileSync(presetPath, 'utf-8'));
            const stagingDir = path.join(serverDir, `modpack_staging_${Date.now()}`);
            const contentTracksDir = path.join(stagingDir, 'content', 'tracks');
            const contentCarsDir = path.join(stagingDir, 'content', 'cars');

            fs.mkdirSync(contentTracksDir, { recursive: true });
            fs.mkdirSync(contentCarsDir, { recursive: true });

            // 1. Узнаем какая карта выбрана в server_cfg.ini
            let trackId = '';
            if (fs.existsSync(serverCfgPath)) {
                const iniContent = fs.readFileSync(serverCfgPath, 'utf-8');
                const match = iniContent.match(/TRACK\s*=\s*(.+)/);
                if (match) trackId = match[1].trim();
            }

            // 2. Копируем карту из папки игры (вместе с трафиком и лейаутами)
            if (trackId && acPath) {
                const srcTrack = path.join(acPath, 'content', 'tracks', trackId);
                const destTrack = path.join(contentTracksDir, trackId);
                if (fs.existsSync(srcTrack)) {
                    copyFolderRecursive(srcTrack, destTrack);
                }
            }

            // 3. Копируем машины игроков и трафика из папки игры
            const allCarsToPack = [
                ...(preset.playerCars || []),
                ...(preset.trafficCars || [])
            ];

            const uniqueCarIds = [...new Set(allCarsToPack.map(c => c.id))];
            for (const carId of uniqueCarIds) {
                if (!acPath) break;
                const srcCar = path.join(acPath, 'content', 'cars', carId);
                const destCar = path.join(contentCarsDir, carId);
                if (fs.existsSync(srcCar)) {
                    copyFolderRecursive(srcCar, destCar);
                }
            }

            // 4. Сжимаем временную папку в ZIP через PowerShell
            if (fs.existsSync(outputZipPath)) fs.unlinkSync(outputZipPath);

            const psCommand = `Add-Type -A 'System.IO.Compression.FileSystem'; [IO.Compression.ZipFile]::CreateFromDirectory('${stagingDir}', '${outputZipPath}')`;
            exec(`powershell -NoProfile -Command "${psCommand}"`, (err) => {
                // Удаляем временную папку-сборщик
                if (fs.existsSync(stagingDir)) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                }

                if (err) return reject(new Error('Ошибка создания ZIP архива через PowerShell.'));
                resolve(outputZipPath);
            });

        } catch (err) {
            reject(err);
        }
    });
}

function copyFolderRecursive(source, target) {
    if (!fs.existsSync(source)) return;
    fs.mkdirSync(target, { recursive: true });
    for (const file of fs.readdirSync(source, { withFileTypes: true })) {
        const curSource = path.join(source, file.name);
        const curTarget = path.join(target, file.name);
        if (file.isDirectory()) {
            copyFolderRecursive(curSource, curTarget);
        } else {
            fs.copyFileSync(curSource, curTarget);
        }
    }
}

module.exports = { createClientModpack };