import { app, BrowserWindow, ipcMain, dialog, Notification, Tray, Menu, nativeImage, shell, session, desktopCapturer } from 'electron';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import * as path from 'path';
import * as fs from 'fs';

import { spawn, ChildProcess } from 'child_process';
import _ffmpeg from 'ffmpeg-static';

const ffmpeg = (_ffmpeg as string).replace('app.asar', 'app.asar.unpacked');

app.setAppUserModelId("ShadowWarp");
app.name = "ShadowWarp";

// Global safety net: catch EPIPE and other stream errors that would crash the app
process.on('uncaughtException', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    const msg = err.message || '';
    // Suppress all pipe/stream errors — they're expected when FFmpeg exits
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END'
        || code === 'ECONNRESET' || msg.includes('EPIPE') || msg.includes('stream')) {
        console.warn('Suppressed stream error:', code, msg);
        return;
    }
    // Log but don't re-throw — crashing the app is worse than swallowing an error
    console.error('Uncaught exception:', err);
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuiting = false;
let isRecording = false;
let recordProcess: ChildProcess | null = null;
let recordingStartTime = 0;
let useSystemAudio = false;

// New Memory Architecture for Replay Buffer
let videoBuffer: { time: number, chunk: Buffer }[] = [];
let totalBytes = 0;

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
const iconPath = isDev
    ? path.join(__dirname, '..', '..', 'public', 'icon.png')
    : path.join(__dirname, '..', '..', 'dist', 'icon.png');
const BUFFER_FILE = path.join(tempDir, 'buffer.m3u8');

function ensureDir(dir: string) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function startRecording() {
    if (isRecording) return;
    ensureDir(tempDir);

    // Clean up old buffer files if they exist
    try {
        if (fs.existsSync(tempDir)) {
            const files = fs.readdirSync(tempDir);
            for (const file of files) {
                fs.unlinkSync(path.join(tempDir, file));
            }
        }
    } catch (e) { /* ignore */ }

    const fetchDevices = () => new Promise<string[]>((resolve) => {
        const proc = spawn(ffmpeg, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true });
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

        // System audio via stdin (pipe:0) — WebM Opus stream from Electron renderer
        if (useSystemAudio) {
            args.push(
                '-thread_queue_size', '4096',
                '-f', 'webm',
                '-i', 'pipe:0'
            );
        }

        const fpsNum = parseInt(config.fps) || 60;

        // Screen capture via ddagrab (Desktop Duplication API) - native DXGI
        // Solves the blinking cursor bug inherent to Windows GDI capture.
        args.push(
            '-init_hw_device', 'd3d11va=dx11',
            '-filter_hw_device', 'dx11',
            '-thread_queue_size', '4096',
            '-f', 'lavfi',
            '-i', `ddagrab=framerate=${fpsNum}:draw_mouse=1`
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
            args.push('-thread_queue_size', '4096', '-f', 'dshow', '-i', `audio=${mappedMic}`);
            audioInputs++;
        }

        // Map video
        args.push('-map', `${videoInputIndex}:v`);

        if (audioInputs === 1 && useSystemAudio) {
            // Only system audio
            args.push('-map', `${sysAudioInputIndex}:a`, '-c:a', 'aac', '-b:a', '256k');
        } else if (audioInputs === 1 && !useSystemAudio) {
            // Only mic
            args.push('-map', `${micInputIndex}:a`, '-c:a', 'aac', '-b:a', '256k');
        } else if (audioInputs === 2) {
            // Both system audio and mic — mix them
            args.push(
                '-filter_complex', `[${sysAudioInputIndex}:a][${micInputIndex}:a]amix=inputs=2:duration=longest[aout]`,
                '-map', '[aout]',
                '-c:a', 'aac', '-b:a', '256k'
            );
        }
        // audioInputs === 0: no audio mapping needed

        args.push(
            // Hardware translation of pure DXGI frames back to standard colorspace for universal encoder compat
            '-vf', 'hwdownload,format=bgra',
            // Video encoding
            '-c:v', config.codec,
            ...(config.codec.includes('nvenc') ? ['-preset', 'p5'] : ['-preset', 'ultrafast']),
            '-b:v', `${config.bitrate}M`,
            // Force constant framerate — prevents variable timing that causes stutters
            '-vsync', 'cfr',
            // GOP size: keyframe every 2 seconds
            '-g', String(fpsNum * 2),
            // Output to TS pipe for memory streaming
            '-f', 'mpegts',
            '-mpegts_flags', '+resend_headers',
            'pipe:1'
        );

        console.log(`Spawning ffmpeg with: `, args.join(' '));
        recordingStartTime = Date.now();
        recordProcess = spawn(ffmpeg, args, {
            stdio: useSystemAudio ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        videoBuffer = [];
        totalBytes = 0;

        recordProcess.stdout?.on('data', (chunk) => {
            videoBuffer.push({ time: Date.now(), chunk });
            totalBytes += chunk.length;

            const bufferSecs = parseInt(config.bufferTime) || 300;
            const cutoff = Date.now() - (bufferSecs + 15) * 1000;
            const hardLimit = 2.5 * 1024 * 1024 * 1024; // 2.5 GB Safety Limit

            while (videoBuffer.length > 2 && (videoBuffer[0].time < cutoff || totalBytes > hardLimit)) {
                const removed = videoBuffer.shift();
                if (removed) totalBytes -= removed.chunk.length;
            }
        });

        recordProcess.stderr?.on('data', (data) => console.log('FFMPEG:', data.toString()));

        // Attach error handler on stdin to prevent EPIPE from crashing the app
        // This MUST be set before any writes, otherwise an async write error is uncaught
        if (recordProcess.stdin) {
            recordProcess.stdin.on('error', (err) => {
                console.warn('FFmpeg stdin error (expected if FFmpeg exited):', err.message);
            });
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

let isSavingReplay = false;

function saveReplay() {
    if (!isRecording) return;
    if (isSavingReplay) {
        console.log('Save already in progress, ignoring duplicate request.');
        return;
    }

    // Check that the buffer array has some content
    if (videoBuffer.length === 0) {
        new Notification({ title: 'ShadowWarp', body: 'No video buffered yet.', icon: iconPath }).show();
        return;
    }
    if (totalBytes < 1024) {
        new Notification({ title: 'ShadowWarp', body: 'Not enough video buffered yet.', icon: iconPath }).show();
        return;
    }

    const bufferSecs = parseInt(config.bufferTime);
    isSavingReplay = true;

    const outputFolder = config.outputFolder || app.getPath('videos');
    ensureDir(outputFolder);
    const now = new Date();
    const formatTime = now.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
    const outputFile = path.join(outputFolder, `ShadowWarp_Replay_${formatTime}.mp4`);

    console.log(`Saving replay: extracting exact ${bufferSecs}s from memory buffer`);

    const tempDump = path.join(tempDir, `dump_${Date.now()}.ts`);
    const chunksCopy = videoBuffer.map(v => v.chunk);

    // Async piped write avoids electron freeze on large buffers
    const writeStream = fs.createWriteStream(tempDump);
    let i = 0;

    const writeNext = () => {
        let isFlushed = true;
        while (i < chunksCopy.length && isFlushed) {
            isFlushed = writeStream.write(chunksCopy[i++]);
        }
        if (i < chunksCopy.length) {
            writeStream.once('drain', writeNext);
        } else {
            writeStream.end();
        }
    };

    writeStream.on('finish', () => {
        let stderrOutput = '';
        const extractProcess = spawn(ffmpeg, [
            '-y',
            '-sseof', `-${bufferSecs}`,
            '-i', tempDump,
            '-c', 'copy',
            '-movflags', '+faststart',
            outputFile
        ], { windowsHide: true });

        extractProcess.stderr?.on('data', (d: Buffer) => {
            stderrOutput += d.toString();
        });

        extractProcess.on('error', (err) => {
            console.error('Extract process error:', err);
            isSavingReplay = false;
            try { if (fs.existsSync(tempDump)) fs.unlinkSync(tempDump); } catch (e) { }
            new Notification({ title: 'ShadowWarp', body: `Failed to save replay: ${err.message}`, icon: iconPath }).show();
        });

        extractProcess.on('exit', (code) => {
            isSavingReplay = false;
            try { if (fs.existsSync(tempDump)) fs.unlinkSync(tempDump); } catch (e) { }
            if (code === 0) {
                const notif = new Notification({ title: 'ShadowWarp', body: `Replay saved!\nClick to view in folder.`, icon: iconPath });
                notif.on('click', () => {
                    shell.showItemInFolder(outputFile);
                });
                notif.show();
            } else {
                console.error(`Extract failed with code ${code}. stderr: ${stderrOutput}`);
                new Notification({ title: 'ShadowWarp', body: `Failed to save replay. Code: ${code}`, icon: iconPath }).show();
            }
        });
    });

    writeNext();
}

function createWindow() {
    const isHidden = process.argv.includes('--hidden');

    mainWindow = new BrowserWindow({
        width: 900,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'index.js'),
            contextIsolation: true,
            backgroundThrottling: false
        },
        show: true, // MUST remain true to prevent Chromium MediaRecorder suspension
        opacity: isHidden ? 0 : 1,
        skipTaskbar: isHidden,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000'
    });

    if (isHidden) mainWindow.setIgnoreMouseEvents(true);

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
            // DO NOT USE .hide() as it suspends MediaRecorder on modern Chromium
            mainWindow?.setOpacity(0);
            mainWindow?.setSkipTaskbar(true);
            mainWindow?.setIgnoreMouseEvents(true);
            new Notification({ title: 'ShadowWarp', body: 'Running in background. Check System Tray', icon: iconPath }).show();
        }
    });
}

function createTray() {
    let icon = nativeImage.createFromPath(iconPath);
    // As a fallback to prevent crash if nativeImage is empty on some systems, we pass the icon instance directly.
    tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show App', click: () => {
                mainWindow?.setOpacity(1);
                mainWindow?.setSkipTaskbar(false);
                mainWindow?.setIgnoreMouseEvents(false);
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
        mainWindow?.setOpacity(1);
        mainWindow?.setSkipTaskbar(false);
        mainWindow?.setIgnoreMouseEvents(false);
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
    if (recordProcess && isRecording && useSystemAudio && recordProcess.stdin && !recordProcess.stdin.destroyed && recordProcess.stdin.writable) {
        try {
            recordProcess.stdin.write(buffer);
        } catch (e) {
            // Ignore write errors (e.g., if FFmpeg is shutting down)
            console.warn('Audio write error (FFmpeg may have exited):', (e as Error).message);
        }
    }
});

ipcMain.handle('get-audio-devices', () => {
    return new Promise((resolve) => {
        const proc = spawn(ffmpeg, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true });
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
            if (!isQuiting) {
                win.setOpacity(0);
                win.setSkipTaskbar(true);
                win.setIgnoreMouseEvents(true);
                new Notification({ title: 'ShadowWarp', body: 'Running in background. Check System Tray', icon: iconPath }).show();
            } else {
                win.close();
            }
            break;
    }
});
