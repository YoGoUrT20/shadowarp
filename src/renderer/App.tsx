import React, { useState, useEffect, useRef } from 'react';
import { Settings, Video, FolderOpen, HardDrive, Monitor, Save, Minus, Square, X, Mic } from 'lucide-react';

interface Config {
    fps: string;
    codec: string;
    bitrate: string;
    bufferTime: string;
    outputFolder: string;
    shortcut: string;
    autoStart: boolean;
    audioDevice: string;
    systemAudioDevice: string;
}

declare global {
    interface Window {
        api: any;
    }
}

export default function App() {
    const [activeTab, setActiveTab] = useState('record');
    const [isRecording, setIsRecording] = useState(false);
    const [isRecordingHotkey, setIsRecordingHotkey] = useState(false);
    const [config, setConfig] = useState<Config>({
        fps: '60',
        codec: 'h264_nvenc',
        bitrate: '15',
        bufferTime: '300',
        outputFolder: '',
        shortcut: 'Alt+F10',
        autoStart: false,
        audioDevice: 'Default',
        systemAudioDevice: 'Default'
    });
    const [audioDevices, setAudioDevices] = useState<string[]>(['None']);

    const bufferOptions = [
        { label: '5 seconds', value: 5 },
        { label: '15 seconds', value: 15 },
        { label: '30 seconds', value: 30 },
        { label: '1 minute', value: 60 },
        { label: '2 minutes', value: 120 },
        { label: '3 minutes', value: 180 },
        { label: '5 minutes', value: 300 },
        { label: '10 minutes', value: 600 },
        { label: '15 minutes', value: 900 }
    ];

    const currentBufferOption = bufferOptions.find(o => o.value.toString() === config.bufferTime) || bufferOptions[6];
    const sliderIndex = bufferOptions.indexOf(currentBufferOption);

    useEffect(() => {
        if (window.api) {
            window.api.getConfig().then(setConfig);
            window.api.onRecordingStateChange((state: boolean) => setIsRecording(state));
            window.api.getAudioDevices().then(setAudioDevices);
        } else {
            console.warn("API not found. Running in browser?");
        }
    }, []);

    // System audio capture state
    const sysAudioCtxRef = useRef<AudioContext | null>(null);
    const sysAudioStreamRef = useRef<MediaStream | null>(null);
    const sysAudioProcessorRef = useRef<ScriptProcessorNode | null>(null);

    const stopSystemAudioCapture = () => {
        if (sysAudioProcessorRef.current) {
            sysAudioProcessorRef.current.disconnect();
            sysAudioProcessorRef.current = null;
        }
        if (sysAudioCtxRef.current) {
            sysAudioCtxRef.current.close().catch(() => { });
            sysAudioCtxRef.current = null;
        }
        if (sysAudioStreamRef.current) {
            sysAudioStreamRef.current.getTracks().forEach(t => t.stop());
            sysAudioStreamRef.current = null;
        }
        console.log('[SysAudio] Capture stopped');
    };

    const startSystemAudioCapture = async () => {
        stopSystemAudioCapture(); // clean up any existing
        try {
            // Use getDisplayMedia with audio: true to capture system audio.
            // On Windows/Chromium, if systemAudio is set, it captures desktop audio via loopback.
            const stream = await (navigator.mediaDevices as any).getDisplayMedia({
                video: { width: 1, height: 1, frameRate: 1 }, // minimal video, required for the prompt
                audio: true,
                systemAudio: 'include' // Chromium-specific: capture system audio
            } as any);

            // Stop the video track immediately — we only need audio
            stream.getVideoTracks().forEach((t: MediaStreamTrack) => t.stop());

            const audioTracks = stream.getAudioTracks();
            if (audioTracks.length === 0) {
                console.warn('[SysAudio] No audio tracks from getDisplayMedia');
                return;
            }

            sysAudioStreamRef.current = stream;

            // Create AudioContext at 48kHz to match FFmpeg's expected input
            const audioCtx = new AudioContext({ sampleRate: 48000 });
            sysAudioCtxRef.current = audioCtx;

            const source = audioCtx.createMediaStreamSource(new MediaStream(audioTracks));

            // ScriptProcessorNode to get raw PCM samples
            // Buffer size 4096 is a good balance between latency and performance
            const processor = audioCtx.createScriptProcessor(4096, 2, 2);
            sysAudioProcessorRef.current = processor;

            processor.onaudioprocess = (e) => {
                if (!window.api) return;
                const left = e.inputBuffer.getChannelData(0);
                const right = e.inputBuffer.getChannelData(1);

                // Convert Float32 stereo to interleaved Int16 PCM
                const pcm = new Int16Array(left.length * 2);
                for (let i = 0; i < left.length; i++) {
                    pcm[i * 2] = Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767)));
                    pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767)));
                }

                window.api.sendSystemAudioData(pcm.buffer);
            };

            // Route: source -> processor -> gainNode(muted) -> destination
            // The processor must be connected to a destination to process audio,
            // but we use a zero-gain node so the user doesn't hear echo
            const gainNode = audioCtx.createGain();
            gainNode.gain.value = 0;
            source.connect(processor);
            processor.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            console.log('[SysAudio] Capture started successfully');
        } catch (err) {
            console.error('[SysAudio] Failed to start capture:', err);
        }
    };

    // Listen for main process signals to start/stop system audio
    useEffect(() => {
        if (!window.api) return;

        window.api.onStartSystemAudio(() => {
            console.log('[SysAudio] Received start signal from main');
            startSystemAudioCapture();
        });
        window.api.onStopSystemAudio(() => {
            console.log('[SysAudio] Received stop signal from main');
            stopSystemAudioCapture();
        });

        return () => {
            stopSystemAudioCapture();
        };
    }, []);

    const handleConfigChange = (key: keyof Config, value: any) => {
        const newConfig = { ...config, [key]: value };
        setConfig(newConfig);
        if (window.api) window.api.saveConfig(newConfig);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!isRecordingHotkey) return;
        e.preventDefault();

        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

        let keys = [];
        if (e.ctrlKey || e.metaKey) keys.push('CommandOrControl');
        if (e.altKey) keys.push('Alt');
        if (e.shiftKey) keys.push('Shift');

        let mainKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;
        if (mainKey === ' ') mainKey = 'Space';

        keys.push(mainKey);
        handleConfigChange('shortcut', keys.join('+'));
        setIsRecordingHotkey(false);
    };

    const toggleRecording = () => {
        const newState = !isRecording;
        if (window.api) {
            if (newState) window.api.startRecording();
            else window.api.stopRecording();
        }
        setIsRecording(newState);
    };

    const saveReplay = () => {
        if (window.api) window.api.saveReplay();
        else alert('Replay saved! (simulation)');
    };

    const selectFolder = async () => {
        if (window.api) {
            const folder = await window.api.selectFolder();
            if (folder) handleConfigChange('outputFolder', folder);
        }
    };

    return (
        <div className="app-container">
            <div className="window-drag">
                <span className="window-drag-title">SHADOWWARP</span>
                <div className="window-controls">
                    <button className="window-control-btn minimize" onClick={() => window.api?.windowControl('minimize')}>
                        <Minus size={14} />
                    </button>
                    <button className="window-control-btn maximize" onClick={() => window.api?.windowControl('maximize')}>
                        <Square size={12} />
                    </button>
                    <button className="window-control-btn close" onClick={() => window.api?.windowControl('close')}>
                        <X size={14} />
                    </button>
                </div>
            </div>

            <div className="sidebar">
                <div
                    className={`nav-item ${activeTab === 'record' ? 'active' : ''}`}
                    onClick={() => setActiveTab('record')}
                >
                    <Video /> Record
                </div>
                <div
                    className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
                    onClick={() => setActiveTab('settings')}
                >
                    <Settings /> Settings
                </div>
            </div>

            <div className="main-content">
                {activeTab === 'record' && (
                    <div className="animate-in glass-card">
                        <h2 className="card-title delay-1 animate-in"><Monitor /> Dashboard</h2>

                        <div className={`switch-container delay-2 animate-in ${isRecording ? 'active' : ''}`} onClick={toggleRecording}>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: '18px', color: isRecording ? 'var(--accent-primary)' : 'var(--text-primary)' }}>
                                    {isRecording ? 'Background Recording Active' : 'Background Recording Paused'}
                                </div>
                                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                                    Continuously buffers the last {currentBufferOption.label} of gameplay.
                                </div>
                            </div>
                            <div className="switch"><div className="switch-thumb"></div></div>
                        </div>

                        <div className="control-group delay-3 animate-in" style={{ marginTop: '32px' }}>
                            <button className="btn-primary" onClick={saveReplay} disabled={!isRecording} style={{ opacity: isRecording ? 1 : 0.5 }}>
                                <Save /> Save Instant Replay ({config.shortcut})
                            </button>
                        </div>
                    </div>
                )}

                {activeTab === 'settings' && (
                    <div className="animate-in glass-card">
                        <h2 className="card-title delay-1 animate-in" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span><Settings /> Configuration</span>
                            {isRecording && (
                                <span style={{ fontSize: '12px', background: 'rgba(255, 170, 0, 0.2)', color: '#ffaa00', padding: '4px 10px', borderRadius: '12px', border: '1px solid rgba(255, 170, 0, 0.4)', fontWeight: 'normal' }}>
                                    Settings Disabled (Recording Active)
                                </span>
                            )}
                        </h2>

                        {isRecording && (
                            <div className="delay-1 animate-in" style={{ background: 'rgba(255, 170, 0, 0.1)', color: '#ffaa00', padding: '12px', borderRadius: '8px', marginBottom: '20px', fontSize: '13px', border: '1px solid rgba(255, 170, 0, 0.3)' }}>
                                Background recording is currently running. You must pause recording from the Dashboard before adjusting settings.
                            </div>
                        )}

                        <div className="flex-row delay-2 animate-in" style={{ gap: '16px' }}>
                            <div className="control-group flex-1">
                                <label className="control-label"><HardDrive size={14} style={{ display: 'inline', marginBottom: '-2px' }} /> Video Codec</label>
                                <select disabled={isRecording} value={config.codec} onChange={(e) => handleConfigChange('codec', e.target.value)}>
                                    <option value="h264_nvenc">NVIDIA NVENC (H.264)</option>
                                    <option value="hevc_nvenc">NVIDIA NVENC (HEVC)</option>
                                    <option value="libx264">Software CPU (x264 fallback)</option>
                                </select>
                            </div>

                            <div className="control-group flex-1">
                                <label className="control-label"><Mic size={14} style={{ display: 'inline', marginBottom: '-2px' }} /> Microphone</label>
                                <select disabled={isRecording} value={config.audioDevice || 'Default'} onChange={(e) => handleConfigChange('audioDevice', e.target.value)}>
                                    <option value="Default">Default</option>
                                    {audioDevices.filter(d => d !== 'None').map((dev, idx) => (
                                        <option key={idx} value={dev}>{dev}</option>
                                    ))}
                                    <option value="None">None</option>
                                </select>
                            </div>

                            <div className="control-group flex-1">
                                <label className="control-label"><Mic size={14} style={{ display: 'inline', marginBottom: '-2px' }} /> System Audio</label>
                                <select disabled={isRecording} value={config.systemAudioDevice === 'None' ? 'None' : 'Default'} onChange={(e) => handleConfigChange('systemAudioDevice', e.target.value)}>
                                    <option value="Default">Enabled (Desktop Loopback)</option>
                                    <option value="None">None</option>
                                </select>
                            </div>
                        </div>

                        <div className="flex-row delay-2 animate-in" style={{ marginTop: '16px' }}>
                            <div className="control-group flex-1">
                                <label className="control-label">Framerate (FPS)</label>
                                <select disabled={isRecording} value={config.fps} onChange={(e) => handleConfigChange('fps', e.target.value)}>
                                    <option value="30">30 FPS</option>
                                    <option value="60">60 FPS</option>
                                    <option value="120">120 FPS</option>
                                </select>
                            </div>

                            <div className="control-group flex-1">
                                <label className="control-label">Bitrate (Mbps)</label>
                                <input
                                    type="number"
                                    value={config.bitrate}
                                    onChange={(e) => handleConfigChange('bitrate', e.target.value)}
                                    min="5" max="100"
                                />
                            </div>
                        </div>

                        <div className="flex-row delay-3 animate-in">
                            <div className="control-group flex-1">
                                <label className="control-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span>Replay Buffer Length</span>
                                    <span style={{ color: 'var(--accent-primary)' }}>{currentBufferOption.label}</span>
                                </label>
                                <input
                                    disabled={isRecording}
                                    type="range"
                                    min="0"
                                    max={bufferOptions.length - 1}
                                    step="1"
                                    value={sliderIndex}
                                    onChange={(e) => handleConfigChange('bufferTime', bufferOptions[e.target.value as any].value.toString())}
                                    style={{ width: '100%', accentColor: 'var(--accent-primary)', marginTop: '8px' }}
                                />
                                <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
                                    Estimated disk usage: ~{(() => {
                                        const bps = parseInt(config.bitrate) || 15;
                                        const secs = parseInt(config.bufferTime) || 300;
                                        const totalMb = (bps / 8) * secs;
                                        return totalMb >= 1024 ? (totalMb / 1024).toFixed(2) + ' GB' : Math.round(totalMb) + ' MB';
                                    })()}
                                </div>
                            </div>

                            <div className="control-group flex-1">
                                <label className="control-label">Capture Hotkey</label>
                                <button
                                    disabled={isRecording}
                                    onClick={() => setIsRecordingHotkey(true)}
                                    onKeyDown={handleKeyDown}
                                    onBlur={() => setIsRecordingHotkey(false)}
                                    style={{
                                        width: '100%',
                                        padding: '12px 16px',
                                        borderRadius: '12px',
                                        background: isRecordingHotkey ? 'var(--accent-glow)' : 'rgba(0, 0, 0, 0.3)',
                                        border: `1px solid ${isRecordingHotkey ? 'var(--accent-primary)' : 'var(--border-glass)'}`,
                                        color: isRecordingHotkey ? 'var(--accent-primary)' : 'var(--text-primary)',
                                        cursor: isRecording ? 'not-allowed' : 'pointer',
                                        opacity: isRecording ? 0.5 : 1,
                                        textAlign: 'left',
                                        outline: 'none',
                                        fontFamily: 'Inter, sans-serif',
                                        fontSize: '14px',
                                        transition: 'var(--transition-fast)'
                                    }}
                                >
                                    {isRecordingHotkey ? 'Press any key combination...' : config.shortcut}
                                </button>
                            </div>
                        </div>

                        <div className="control-group delay-3 animate-in">
                            <label className="control-label"><FolderOpen size={14} style={{ display: 'inline', marginBottom: '-2px' }} /> Output Folder</label>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                <input type="text" readOnly value={config.outputFolder || 'Default Videos Folder'} />
                                <button
                                    disabled={isRecording}
                                    onClick={selectFolder}
                                    style={{
                                        padding: '0 16px',
                                        borderRadius: '12px',
                                        background: 'var(--bg-secondary)',
                                        border: '1px solid var(--border-glass)',
                                        color: 'var(--text-primary)',
                                        cursor: isRecording ? 'not-allowed' : 'pointer',
                                        opacity: isRecording ? 0.5 : 1
                                    }}
                                >
                                    Browse
                                </button>
                            </div>
                        </div>

                        <div className={`switch-container delay-3 animate-in ${config.autoStart ? 'active' : ''}`} onClick={() => !isRecording && handleConfigChange('autoStart', !config.autoStart)} style={{ marginTop: '24px', opacity: isRecording ? 0.5 : 1, pointerEvents: isRecording ? 'none' : 'auto' }}>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: '15px', color: config.autoStart ? 'var(--accent-primary)' : 'var(--text-primary)' }}>
                                    Launch on Startup
                                </div>
                                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                                    Automatically start ShadowWarp quietly in the background when your PC boots.
                                </div>
                            </div>
                            <div className="switch"><div className="switch-thumb"></div></div>
                        </div>

                    </div>
                )}
            </div>
        </div>
    );
}
