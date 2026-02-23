import { app, BrowserWindow, ipcMain, dialog, Notification, Tray, Menu, nativeImage, shell, session, desktopCapturer } from 'electron';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import * as path from 'path';
import * as fs from 'fs';

import { spawn, ChildProcess } from 'child_process';
import _ffmpeg from 'ffmpeg-static';

const ffmpeg = (_ffmpeg as string).replace('app.asar', 'app.asar.unpacked');

app.setAppUserModelId("ShadowWarp");
app.name = "ShadowWarp";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuiting = false;
let isRecording = false;
let recordProcess: ChildProcess | null = null;
let cleanupInterval: NodeJS.Timeout | null = null;
let useSystemAudio = false;

let config = {
    fps: '60',
    codec: 'h264_nvenc',
    bitrate: '15',
    bufferTime: '300',
    outputFolder: '',
    shortcut: 'Alt+F10',
    autoStart: false,
    autoRecord: true,
    audioDevice: 'Default',
    systemAudioDevice: 'Default'
};

const configPath = path.join(app.getPath('userData'), 'config.json');
try {
    if (fs.existsSync(configPath)) {
        Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf8')));
    }
} catch (e) {
    console.error("Failed to load config:", e);
}

function saveConfigToDisk() {
    try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { console.error("Failed to save config:", e); }
}

const tempDir = path.join(app.getPath('userData'), 'shadowarp_buffers');
const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

function ensureDir(dir: string) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanOldSegments() {
    const files = fs.readdirSync(tempDir).filter(f => f.endsWith('.ts'));
    const now = Date.now();
    const maxAgeMs = parseInt(config.bufferTime) * 1000 + 30000;

    files.forEach(file => {
        const filePath = path.join(tempDir, file);
        try {
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > maxAgeMs) {
                fs.unlinkSync(filePath);
            }
        } catch (e) {
            console.error(e);
        }
    });
}

function startRecording() {
    if (isRecording) return;
    ensureDir(tempDir);

    const existingFiles = fs.readdirSync(tempDir);
    existingFiles.forEach(f => {
        try { fs.unlinkSync(path.join(tempDir, f)) } catch (ignored) { }
    });

    const timeFormat = "%Y%m%d%H%M%S";

    const fetchDevices = () => new Promise<string[]>((resolve) => {
        const proc = spawn(ffmpeg, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
        let output = '';
        proc.stderr.on('data', d => output += d.toString());
        proc.on('close', () => {
            const matches = [...output.matchAll(/\]\s+"([^"]+)"\s+\(audio\)/g)];
            resolve(matches.map(m => m[1]));
        });
    });

    fetchDevices().then((currentDevices) => {
        useSystemAudio = config.systemAudioDevice !== 'None';

        const args = [
            '-y',
        ];

        // System audio via stdin (pipe:0) — raw PCM from Electron renderer
        if (useSystemAudio) {
            args.push(
                '-thread_queue_size', '4096',
                '-f', 's16le',
                '-ar', '48000',
                '-ac', '2',
                '-i', 'pipe:0'
            );
        }

        // Screen capture via gdigrab
        args.push(
            '-thread_queue_size', '1024',
            '-f', 'gdigrab',
            '-framerate', config.fps,
            '-draw_mouse', '1',
            '-i', 'desktop'
        );

        let audioInputs = 0;
        const videoInputIndex = useSystemAudio ? 1 : 0;
        const sysAudioInputIndex = useSystemAudio ? 0 : -1;

        if (useSystemAudio) {
            audioInputs++;
        }

        // Microphone via dshow
        let mappedMic = config.audioDevice;
        if (mappedMic === 'Default') {
            mappedMic = currentDevices[0] || 'None';
        }

        const micInputIndex = useSystemAudio ? 2 : 1;

        if (mappedMic && mappedMic !== 'None' && currentDevices.includes(mappedMic)) {
            args.push('-thread_queue_size', '1024', '-f', 'dshow', '-i', `audio=${mappedMic}`);
            audioInputs++;
        }

        // Map video
        args.push('-map', `${videoInputIndex}:v`);

        if (audioInputs === 1 && useSystemAudio) {
            // Only system audio
            args.push('-map', `${sysAudioInputIndex}:a`, '-c:a', 'aac', '-b:a', '192k', '-af', 'aresample=async=1');
        } else if (audioInputs === 1 && !useSystemAudio) {
            // Only mic
            args.push('-map', `${micInputIndex}:a`, '-c:a', 'aac', '-b:a', '192k', '-af', 'aresample=async=1');
        } else if (audioInputs === 2) {
            // Both system audio and mic — mix them
            args.push(
                '-filter_complex', `[${sysAudioInputIndex}:a][${micInputIndex}:a]amix=inputs=2:duration=longest,aresample=async=1[aout]`,
                '-map', '[aout]',
                '-c:a', 'aac', '-b:a', '192k'
            );
        }
        // audioInputs === 0: no audio mapping needed

        args.push(
            '-vf', `fps=${config.fps}`,
            '-c:v', config.codec,
            ...(config.codec.includes('nvenc') ? ['-preset', 'p5'] : ['-preset', 'ultrafast']),
            '-b:v', `${config.bitrate}M`,
            '-f', 'segment',
            '-segment_time', '30',
            '-strftime', '1',
            path.join(tempDir, `buffer_${timeFormat}.ts`)
        );

        console.log(`Spawning ffmpeg with: `, args.join(' '));
        recordProcess = spawn(ffmpeg, args, {
            stdio: useSystemAudio ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
        });

        recordProcess.stderr?.on('data', (data) => console.log('FFMPEG:', data.toString()));
        recordProcess.stdout?.on('data', () => { }); // drain stdout

        // Write initial silence to stdin so FFmpeg doesn't block waiting for data
        // 48000 samples/sec * 2 channels * 2 bytes (s16le) = 192000 bytes per second
        if (useSystemAudio && recordProcess.stdin) {
            const silenceBuffer = Buffer.alloc(192000, 0); // 1 second of silence
            recordProcess.stdin.write(silenceBuffer);
        }

        recordProcess.on('exit', (code) => {
            console.log('FFmpeg exited with code:', code);
            isRecording = false;
            useSystemAudio = false;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('recording-state', false);
                mainWindow.webContents.send('stop-system-audio');
            }
        });

        isRecording = true;
        config.autoRecord = true;
        saveConfigToDisk();

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('recording-state', true);
            // Tell renderer to start capturing system audio and pipe PCM to us
            if (useSystemAudio) {
                mainWindow.webContents.send('start-system-audio');
            }
        }

        cleanupInterval = setInterval(cleanOldSegments, 60000);
    });
}

function stopRecording() {
    if (!isRecording) return;

    // Tell renderer to stop capturing system audio
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stop-system-audio');
    }

    if (recordProcess) {
        // Close stdin to signal EOF to FFmpeg's pipe:0 input
        try { recordProcess.stdin?.end(); } catch (e) { /* ignore */ }
        // Send SIGINT for graceful shutdown (equivalent to pressing 'q')
        try { recordProcess.kill('SIGINT'); } catch (e) { /* ignore */ }
        if (cleanupInterval) clearInterval(cleanupInterval);
        setTimeout(() => {
            if (recordProcess) {
                try { recordProcess.kill('SIGKILL'); } catch (e) { /* ignore */ }
            }
            recordProcess = null;
        }, 3000);
    }
    isRecording = false;
    useSystemAudio = false;
    config.autoRecord = false;
    saveConfigToDisk();

    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('recording-state', false);
}

function saveReplay() {
    if (!isRecording) return;

    const files = fs.readdirSync(tempDir)
        .filter(f => f.endsWith('.ts'))
        .sort()
        .map(f => path.join(tempDir, f));

    if (files.length === 0) {
        new Notification({ title: 'ShadowWarp', body: 'No video buffered yet.' }).show();
        return;
    }

    const concatListPath = path.join(tempDir, 'concat.txt');
    let lines = files.map(f => `file '${f.replace(/\\/g, '/')}'`);
    fs.writeFileSync(concatListPath, lines.join('\n'));

    const outputFolder = config.outputFolder || app.getPath('videos');
    ensureDir(outputFolder);
    const now = new Date();
    const formatTime = now.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
    const outputFile = path.join(outputFolder, `ShadowWarp_Replay_${formatTime}.mp4`);

    const concatProcess = spawn(ffmpeg, [
        '-y',
        '-fflags', '+genpts+igndts',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        '-c', 'copy',
        outputFile
    ]);

    concatProcess.on('exit', (code) => {
        if (code === 0) {
            const notif = new Notification({ title: 'ShadowWarp', body: `Replay saved!\nClick to view in folder.` });
            notif.on('click', () => {
                shell.showItemInFolder(outputFile);
            });
            notif.show();
        } else {
            new Notification({ title: 'ShadowWarp', body: `Failed to save replay. Code: ${code}` }).show();
        }
    });
    concatProcess.stderr?.on('data', d => console.log('CONCAT ERR:', d.toString()));
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'index.js'),
            contextIsolation: true
        },
        show: !process.argv.includes('--hidden'),
        frame: false,
        transparent: true,
        backgroundColor: '#00000000'
    });

    const url = isDev
        ? "http://localhost:3000"
        : `file://${path.join(__dirname, '..', '..', 'dist', 'index.html')}`;

    mainWindow.loadURL(url);

    // Auto-approve getDisplayMedia requests for system audio capture
    // This bypasses the screen share picker dialog
    mainWindow.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
            // Grant access to the first screen source with audio
            callback({ video: sources[0], audio: 'loopback' });
        });
    });

    mainWindow.on('close', (event) => {
        if (!isQuiting) {
            event.preventDefault();
            mainWindow?.hide();
            new Notification({ title: 'ShadowWarp', body: 'Running in background. Check System Tray' }).show();
        }
    });
}

function createTray() {
    const iconPath = isDev
        ? path.join(__dirname, '..', '..', 'public', 'icon.png')
        : path.join(__dirname, '..', '..', 'dist', 'icon.png');

    let icon = nativeImage.createFromPath(iconPath);
    // As a fallback to prevent crash if nativeImage is empty on some systems, we pass the icon instance directly.
    tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show App', click: () => {
                mainWindow?.show();
                mainWindow?.focus();
            }
        },
        { label: 'Save Instant Replay', click: () => saveReplay() },
        { type: 'separator' },
        {
            label: 'Quit ShadowWarp', click: () => {
                isQuiting = true;
                app.quit();
            }
        }
    ]);
    tray.setToolTip('ShadowWarp Background Recorder');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
    });
}

app.whenReady().then(() => {
    createWindow();

    // We need an empty or dummy icon to avoid crashing if favicon not built yet. We fallback to NativeImage later if needed.
    try { createTray(); } catch (e) { console.error("Tray fail (likely missing icon):", e); }

    uIOhook.on('keydown', (e) => {
        if (!config.shortcut) return;

        const parts = config.shortcut.split('+');
        const mainKeyStr = parts[parts.length - 1];

        const needsCtrl = parts.includes('CommandOrControl') || parts.includes('Ctrl');
        const needsAlt = parts.includes('Alt');
        const needsShift = parts.includes('Shift');
        const needsMeta = parts.includes('Super') || parts.includes('Meta');

        if (e.ctrlKey !== needsCtrl) return;
        if (e.altKey !== needsAlt) return;
        if (e.shiftKey !== needsShift) return;
        if (e.metaKey !== needsMeta) return;

        const targetKeycode = UiohookKey[mainKeyStr as keyof typeof UiohookKey];
        if (targetKeycode !== undefined && e.keycode === targetKeycode) {
            saveReplay();
        }
    });
    uIOhook.start();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    app.setLoginItemSettings({
        openAtLogin: config.autoStart,
        path: app.getPath('exe'),
        args: ['--hidden']
    });

    if (config.autoRecord) {
        startRecording();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    uIOhook.stop();
    if (recordProcess) recordProcess.kill();
    if (tray) tray.destroy();
});

ipcMain.handle('get-config', () => config);
ipcMain.handle('save-config', (e, newConfig) => {
    const oldShortcut = config.shortcut;
    const oldAutoStart = config.autoStart;
    Object.assign(config, newConfig);

    if (config.autoStart !== oldAutoStart) {
        app.setLoginItemSettings({
            openAtLogin: config.autoStart,
            path: app.getPath('exe'),
            args: ['--hidden']
        });
    }

    // Restart background recording if audio setup changed.
    if ((config.audioDevice !== newConfig.audioDevice || config.systemAudioDevice !== newConfig.systemAudioDevice) && isRecording) {
        stopRecording();
        setTimeout(() => startRecording(), 3000);
    }

    saveConfigToDisk();
});

// Handle system audio PCM data from renderer — write directly to FFmpeg stdin
ipcMain.on('system-audio-data', (_e, buffer: Buffer) => {
    if (recordProcess && useSystemAudio && recordProcess.stdin && !recordProcess.stdin.destroyed) {
        try {
            recordProcess.stdin.write(buffer);
        } catch (e) {
            // Ignore write errors (e.g., if FFmpeg is shutting down)
        }
    }
});

ipcMain.handle('get-audio-devices', () => {
    return new Promise((resolve) => {
        const proc = spawn(ffmpeg, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
        let output = '';
        proc.stderr.on('data', d => output += d.toString());
        proc.on('close', () => {
            const matches = [...output.matchAll(/\]\s+"([^"]+)"\s+\(audio\)/g)];
            resolve(['None', ...matches.map(m => m[1])]);
        });
    });
});

ipcMain.handle('start-recording', startRecording);
ipcMain.handle('stop-recording', stopRecording);
ipcMain.handle('save-replay', saveReplay);
ipcMain.handle('select-folder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (!result.canceled) return result.filePaths[0];
    return null;
});

ipcMain.handle('window-control', (e, action) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;

    switch (action) {
        case 'minimize':
            win.minimize();
            break;
        case 'maximize':
            if (win.isMaximized()) win.unmaximize();
            else win.maximize();
            break;
        case 'close':
            win.close();
            // In our implementation this goes to hide() unless isQuiting is true
            break;
    }
});
