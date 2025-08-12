/* =========================================================
   1. IMPORTS
   ========================================================= */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { AnimationUtils } from 'three';

/* =========================================================
   2. DOM READY
   ========================================================= */
document.addEventListener('DOMContentLoaded', () => {

/* =========================================================
   3. UI ELEMENTS
   ========================================================= */
    const canvasContainer = document.getElementById('canvas-container');
    const thinkingBubble = document.getElementById('thinking-bubble');
    const textBubble = document.getElementById('text-bubble');
    const chatInput = document.getElementById('chat-input');
    const sendButton = document.getElementById('send-button');
    const toggleTextButton = document.getElementById('toggle-text-button');
    const modeToggleButton = document.getElementById('mode-toggle-button');
    const loadingOverlay = document.getElementById('loading-overlay');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');

/* =========================================================
   4. API CONFIGURATION
   ========================================================= */
    const elevenLabsApiKey = ""; 
    const voiceId = "BpjGufoPiobT79j2vtj4";
    const geminiApiKey = ""; 

/* =========================================================
   5. STATE VARIABLES
   ========================================================= */
    let conversationHistory = [];
    const MAX_CONVERSATION_TURNS = 10;
    let isTextOutputOn = false;
    let isTalking = false;
    let isAwaitingResponse = false; // Master lock
    let aiManagedExpressions = [];
    let activeTweens = {};
    const ALLOWED_EXPRESSIONS_FOR_AI = ['happy', 'angry', 'sad', 'relaxed', 'Surprise', 'Proud', 'Scornful', 'Worry', 'Shy'];
    let apiMode = 'online'; // 'online' or 'local'
    let isExpressionActive = false; // prevent blinking during expression
    let activeEmotionName = 'relaxed'; // New state to track the current primary emotion.
    let activeEmotionWeight = 1.0; // store the primary expression weight
    // Expression bind maps (populated later by setupExpressionBindMaps)
    let expressionBindMap = {};      // expressionName -> array of bind objects (VRMExpressionBind)
    let nonMouthExpressionBindMap = {}; // same but filtered to exclude mouth-related binds

    
/* =========================================================
   6. AUDIO & VISEME STATE (queues, mapping)
   ========================================================= */
    let audioQueue = [];   // stores Float32Array chunks
    let visemeQueue = [];  // stores {shape, time}
    let currentViseme = { shape: 'sil', time: 0 };
    let lastAppliedViseme = { shape: 'sil', time: 0 }; 
    let isPlayingFromQueue = false;
    let audioPlaybackStartTime = 0;
    // VISEME_MAPPING has been moved to Section 9 to be used by the expression masker.

/* =========================================================
   7. WEB AUDIO / DECODING
   ========================================================= */
    let audioContext;
    let isAudioContextInitialized = false;

    function initAudioContext() {
        if (isAudioContextInitialized) return;
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(err => console.warn('AudioContext resume failed:', err));
        }
        isAudioContextInitialized = true;
        console.log("AudioContext Initialized.");
    }

    // Decode Base64-encoded PCM (commonly 16-bit LE) -> Float32Array [-1..1]
    function base64ToFloat32Array(base64) {
        // decode base64 to binary string
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);

        // If even number of bytes, treat as 16-bit PCM LE
        if (bytes.length % 2 === 0) {
            const samples = new Float32Array(bytes.length / 2);
            for (let i = 0, s = 0; i < bytes.length; i += 2, s++) {
                const lo = bytes[i];
                const hi = bytes[i + 1];
                let int16 = (hi << 8) | lo;
                if (int16 >= 0x8000) int16 = int16 - 0x10000;
                samples[s] = Math.max(-1, int16 / 32768);
            }
            return samples;
        } else {
            // fallback: 8-bit PCM centered at 128
            const samples = new Float32Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) samples[i] = (bytes[i] - 128) / 128;
            return samples;
        }
    }

    function processAudioQueue() {
        if (!isAudioContextInitialized) initAudioContext();
        if (isPlayingFromQueue || audioQueue.length === 0) return;

        isPlayingFromQueue = true;
        const float32Chunk = audioQueue.shift(); // Float32Array

        try {
            const sampleRate = 16000; // we request 16k from ElevenLabs
            const buffer = audioContext.createBuffer(1, float32Chunk.length, sampleRate);
            buffer.copyToChannel(float32Chunk, 0, 0);

            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContext.destination);

            if (audioPlaybackStartTime === 0) {
                audioPlaybackStartTime = audioContext.currentTime;
            }

            source.start();

            source.onended = () => {
                isPlayingFromQueue = false;
                processAudioQueue();
            };
        } catch (err) {
            console.error('Playback error:', err);
            isPlayingFromQueue = false;
        }
    }

/* =========================================================
   8. THREE.JS + VRM SETUP (scene, camera, renderer, lights)
   ========================================================= */
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 100);
    // Initial position is now set by the aspect ratio function
    
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    canvasContainer.appendChild(renderer.domElement);
    if (typeof THREE.SRGBColorSpace !== 'undefined' && renderer.outputColorSpace !== undefined) {
        renderer.outputColorSpace = THREE.SRGBColorSpace;
    }

    const ambientLight = new THREE.AmbientLight(0xFFFFFF, 1.0);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xFFFFFF, 1.2);
    directionalLight.position.set(1, 1, 1).normalize();
    scene.add(directionalLight);

    /**
     * Adjusts the camera and model position based on the screen's aspect ratio.
     * This ensures the model is framed correctly on all devices.
     */
    function adjustModelForAspectRatio() {
        const aspect = window.innerWidth / window.innerHeight;

        if (aspect < 1) { // Portrait mode (e.g., phones)
            // Lower the model and pull the camera back for better framing
            camera.position.set(0, 1.35, 2.2);
        } else { // Landscape mode (e.g., desktops, tablets)
            // Use the standard, closer position
            camera.position.set(0, 1.4, 1.8);
        }
    }

    /**
     * Handles all updates needed when the window is resized.
     */
    function onWindowResize() {
        // Fix for mobile keyboard UI break
        setRealViewportHeight();

        // Update camera aspect ratio
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();

        // Update renderer size
        renderer.setSize(window.innerWidth, window.innerHeight);

        // Adjust model framing for the new aspect ratio
        adjustModelForAspectRatio();
    }

    // --- Initial Setup Calls ---
    window.addEventListener('resize', onWindowResize, false);
    // Call it once on load to set the initial state correctly
    onWindowResize();

/* =========================================================
   9. VRM LOADING, ANIMATIONS & EXPRESSION HELPERS (SAFE)
   ========================================================= */
let currentVrm = null;
let mixer = null;
const clock = new THREE.Clock();
let idleAction = null;
let idle1Action = null;
let talkingAction = null;
let textingIntroAction = null;
let textingLoopAction = null;
let wavingAction = null;
let lastPlayedAction = null;
let idle1Duration = 0;
let wavingDuration = 0;
const VISEME_MAPPING = { 'a': 'aa', 'e': 'ee', 'i': 'ih', 'o': 'oh', 'u': 'ou' };

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

// ---- Safe removal helper (does NOT call dispose by default) ----
function safeRemoveVrmFromScene(vrm) {
    try {
        if (!vrm) return;
        if (vrm.scene && scene && scene.children.includes(vrm.scene)) {
            scene.remove(vrm.scene);
            console.log('Removed previous VRM scene from scene graph.');
        } else {
            // Not present in scene — nothing to remove
            console.log('Previous VRM not present in scene (no removal necessary).');
        }
    } catch (e) {
        console.warn('safeRemoveVrmFromScene error:', e);
    }
}

// ---- Ensure a scene is visible and updated ----
function ensureVrmVisible(vrm) {
    try {
        if (!vrm || !vrm.scene) return;
        vrm.scene.visible = true;
        vrm.scene.traverse(o => {
            if (o.isMesh) {
                try { o.visible = true; } catch(e){}
                try { if (o.material) o.material.needsUpdate = true; } catch(e){}
            }
        });
        vrm.scene.updateMatrixWorld(true);
        console.log('Ensured VRM scene visible and materials flagged for update.');
    } catch (e) {
        console.warn('ensureVrmVisible error:', e);
    }
}

function loadVRM(url) {
    loader.load(
        url,
        (gltf) => {
            try {
                const vrm = gltf.userData?.vrm || gltf.userData?.gltfVrm || null;
                if (!vrm) {
                    console.error('Loaded GLTF did not contain a VRM object in userData.');
                    return;
                }

                // Safely remove previous VRM from scene (do not dispose resources here)
                safeRemoveVrmFromScene(currentVrm);

                // Replace currentVrm with the newly loaded one
                currentVrm = vrm;

                // Add new VRM scene (ensure we don't accidentally add a duplicate)
                try {
                    if (!scene.children.includes(vrm.scene)) {
                        scene.add(vrm.scene);
                        console.log('Added new VRM.scene to scene.');
                    } else {
                        console.log('VRM.scene was already present in scene.');
                    }
                } catch (e) {
                    console.warn('Failed to add vrm.scene to scene:', e);
                }

                // Defensive visibility + orientation fixes
                try { vrm.scene.rotation.y = Math.PI; } catch(e){}
                try { vrm.scene.visible = true; } catch(e){}
                try { if (vrm.expressionManager) vrm.expressionManager.setValue('relaxed', 1); } catch(e){}
                try { vrm.lookAt.target = camera; } catch(e){}

                // Build list of AI-manageable expression names (filter known viseme/blink shapes)
                try {
                    aiManagedExpressions = Array.isArray(vrm.expressionManager?.expressions)
                        ? vrm.expressionManager.expressions.map(e => e.expressionName || e.name)
                            .filter(name => !['aa','ih','ou','ee','oh','blink','blinkLeft','blinkRight'].includes(name))
                        : [];
                } catch (e) {
                    aiManagedExpressions = [];
                }

                console.log("VRM Model loaded. AI can control:", aiManagedExpressions);

                // Setup expression bind maps gently — if it fails, we'll still proceed.
                try { setupExpressionBindMaps(vrm); } catch (e) { console.warn("setupExpressionBindMaps failed:", e); }

                // Load animations & setup helpers (these are async and have their own try/catch)
                loadAnimations();
                setupBlinking(vrm);
                setupSideGlances(vrm);

                // Ensure scene is visible a short time after load (fallback for odd timing issues)
                setTimeout(() => ensureVrmVisible(vrm), 200);

            } catch (err) {
                console.error('Error in loadVRM callback:', err);
            }
        },
        (progress) => {
            try {
                const pct = Math.round(100.0 * (progress.loaded / progress.total));
                console.log('Loading model.', pct, '%');
            } catch(e){}
        },
        (error) => {
            console.error('Error loading VRM:', error);
        }
    );
}

// ---- Expression / animation helpers (defensive, lightweight) ----
function smoothlySetExpression(vrm, name, value, duration = 100) {
    if (!vrm || !vrm.expressionManager || !name) return;
    const startValue = vrm.expressionManager.getValue(name) || 0;
    const startTime = performance.now();
    const step = () => {
        const t = Math.min((performance.now() - startTime) / duration, 1);
        try { vrm.expressionManager.setValue(name, startValue + (value - startValue) * t); } catch(e){}
        if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

function setupBlinking(vrm) {
    try {
        let blinkTimeout;
        const scheduleNextBlink = () => {
            if (blinkTimeout) clearTimeout(blinkTimeout);
            const nextBlinkDelay = Math.random() * 4000 + 2000;
            blinkTimeout = setTimeout(() => {
                const canBlink = lastPlayedAction === idleAction || lastPlayedAction === textingIntroAction || lastPlayedAction === textingLoopAction;
                if (canBlink && !isTalking && !isExpressionActive) {
                    smoothlySetExpression(vrm, 'blink', 1.0, 100);
                    setTimeout(() => smoothlySetExpression(vrm, 'blink', 0.0, 150), 120);
                }
                scheduleNextBlink();
            }, nextBlinkDelay);
        };
        scheduleNextBlink();
    } catch(e) { console.warn('setupBlinking error', e); }
}

function setupSideGlances(vrm) {
    try {
        let glanceTimeout;
        const scheduleNextGlance = () => {
            if (glanceTimeout) clearTimeout(glanceTimeout);
            const nextGlanceDelay = Math.random() * 6000 + 5000;
            glanceTimeout = setTimeout(() => {
                const canGlance = lastPlayedAction === idleAction && !isTalking && !isTextOutputOn;
                if (canGlance) {
                    vrm.lookAt.autoUpdate = false;
                    const duration = Math.random() * 1200 + 800;
                    const transitionTime = 500;
                    const weight = Math.random() * 0.5 + 0.5;
                    const glanceDirection = Math.random() < 0.5 ? 'lookLeft' : 'lookRight';
                    smoothlySetExpression(vrm, glanceDirection, weight, transitionTime);
                    setTimeout(() => {
                        smoothlySetExpression(vrm, glanceDirection, 0, transitionTime);
                        setTimeout(() => { vrm.lookAt.autoUpdate = true; }, transitionTime);
                    }, duration);
                }
                scheduleNextGlance();
            }, nextGlanceDelay);
        };
        scheduleNextGlance();
    } catch(e){ console.warn('setupSideGlances error', e); }
}

function scheduleIdle1() {
    const nextTime = Math.floor(Math.random() * 5000) + 10000;
    setTimeout(() => {
        try {
            // Check if we are in a state where playing a one-off idle animation is appropriate.
            const canSwitch = lastPlayedAction === idleAction && !isTalking && !isTextOutputOn;
            if (canSwitch && idle1Action) {
                // The 'finished' listener will now handle returning to the main idle animation.
                setAnimation(idle1Action);
            }
        } catch (e) {
             console.warn("Error in scheduleIdle1:", e);
        }
        // Always schedule the next check to keep the loop going.
        scheduleIdle1();
    }, nextTime);
}

async function loadAnimations() {
    if (!currentVrm) return;
    try {
        mixer = new THREE.AnimationMixer(currentVrm.scene);

        // This listener centralizes animation transitions to prevent T-posing and race conditions.
        mixer.addEventListener('finished', (event) => {
            const finishedAction = event.action;

            // When a non-looping animation finishes, decide what to do next.
            if (finishedAction === wavingAction) {
                // If talking, switch to talking animation; otherwise, go back to idle.
                setAnimation(isTalking ? talkingAction : idleAction);
            } else if (finishedAction === textingIntroAction) {
                // After the texting intro, always start the texting loop.
                setAnimation(textingLoopAction);
            } else if (finishedAction === idle1Action) {
                // After the idle variant finishes, always return to the main idle animation.
                setAnimation(idleAction);
            }
        });

        // Idle
        try {
            const idleAnimGltf = await loader.loadAsync('./animations/idle.vrma');
            const idleClip = createVRMAnimationClip(idleAnimGltf.userData.vrmAnimations[0], currentVrm);
            idleAction = mixer.clipAction(idleClip);
            idleAction.setLoop(THREE.LoopPingPong, Infinity);
            idleAction.setEffectiveTimeScale(0.8);
            idleAction.play();
            lastPlayedAction = idleAction;
        } catch(e){ console.warn('idle animation load failed', e); }

        // Idle1
        try {
            const idle1AnimGltf = await loader.loadAsync('./animations/idle1.vrma');
            const idle1Clip = createVRMAnimationClip(idle1AnimGltf.userData.vrmAnimations[0], currentVrm);
            idle1Action = mixer.clipAction(idle1Clip);
            idle1Action.setLoop(THREE.LoopOnce, 0);
            idle1Action.clampWhenFinished = true;
            idle1Duration = idle1Clip.duration || 0;
        } catch(e){ console.warn('idle1 load failed', e); }

        // Talking
        try {
            const talkingAnimGltf = await loader.loadAsync('./animations/talking.vrma');
            const talkingClip = createVRMAnimationClip(talkingAnimGltf.userData.vrmAnimations[0], currentVrm);
            talkingAction = mixer.clipAction(talkingClip);
            talkingAction.setLoop(THREE.LoopPingPong, Infinity);
        } catch(e){ console.warn('talking animation load failed', e); }

        // Waving (optional)
        try {
            const wavingAnimGltf = await loader.loadAsync('./animations/waving.vrma');
            const wavingClip = createVRMAnimationClip(wavingAnimGltf.userData.vrmAnimations[0], currentVrm);
            wavingAction = mixer.clipAction(wavingClip);
            wavingAction.setLoop(THREE.LoopOnce, 0);
            wavingAction.clampWhenFinished = true;
            wavingDuration = wavingClip.duration || 0;
        } catch(e){ wavingAction = null; wavingDuration = 0; }

        scheduleIdle1();

        // Texting (split intro/loop)
        try {
            const textingAnimGltf = await loader.loadAsync('./animations/texting.vrma');
            let originalClip = createVRMAnimationClip(textingAnimGltf.userData.vrmAnimations[0], currentVrm);
            originalClip.tracks = originalClip.tracks.filter(track => !track.name.includes('morphTargetInfluences'));
            const fps = 30;
            const introEndFrame = Math.floor(originalClip.duration * 0.25 * fps);
            const clipEndFrame = Math.floor(originalClip.duration * fps);
            const introClip = AnimationUtils.subclip(originalClip, 'textingIntro', 0, introEndFrame, fps);
            const loopClip = AnimationUtils.subclip(originalClip, 'textingLoop', introEndFrame, clipEndFrame, fps);
            textingIntroAction = mixer.clipAction(introClip);
            textingIntroAction.setLoop(THREE.LoopOnce);
            textingIntroAction.clampWhenFinished = true;
            textingIntroAction.setEffectiveTimeScale(0.8);
            textingLoopAction = mixer.clipAction(loopClip);
            textingLoopAction.setLoop(THREE.LoopPingPong);
            textingLoopAction.setEffectiveTimeScale(0.8);
        } catch(e){ console.warn('texting animation load failed', e); }

    } catch (err) {
        console.error('loadAnimations error:', err);
    }
}

function setAnimation(actionToPlay) {
    if (!mixer || !actionToPlay || actionToPlay === lastPlayedAction) return;

    const actionToFadeOut = lastPlayedAction;
    const fadeDuration = 0.5;

    // Update the state immediately to prevent race conditions
    lastPlayedAction = actionToPlay;

    try {
        // Fade out the previous action if it exists
        if (actionToFadeOut) {
            actionToFadeOut.fadeOut(fadeDuration);
        }

        // Prepare and fade in the new action
        actionToPlay.reset();
        actionToPlay.setEffectiveWeight(1); // Ensure full weight before fading in
        actionToPlay.fadeIn(fadeDuration);
        actionToPlay.play();

        // Apply specific time scales as defined in your original logic
        if (actionToPlay === idleAction) idleAction.setEffectiveTimeScale(0.8);
        if (actionToPlay === textingIntroAction) textingIntroAction.setEffectiveTimeScale(0.8);
        if (actionToPlay === textingLoopAction) textingLoopAction.setEffectiveTimeScale(0.8);

    } catch (e) {
        console.warn('setAnimation failed', e);
        // If an error occurs, revert the state to avoid getting stuck
        lastPlayedAction = actionToFadeOut;
    }
}

function isGreetingPrompt(userText) {
    try {
        const greetingRegex = /\b(hi|hello|hey|greetings|yo)\b/i;
        return greetingRegex.test(userText);
    } catch (e) { return false; }
}

// ---------- Expression bind helpers (defensive) ----------
function setupExpressionBindMaps(vrm) {
    try {
        expressionBindMap = {};
        nonMouthExpressionBindMap = {};

        if (!vrm || !vrm.expressionManager || !Array.isArray(vrm.expressionManager.expressions)) {
            console.warn('No expressionManager.expressions available to build bind maps.');
            return;
        }

        const morphIndexToNameCache = new WeakMap();
        vrm.scene.traverse((obj) => {
            try {
                if (obj.isMesh && obj.morphTargetDictionary) {
                    const rev = {};
                    for (const name in obj.morphTargetDictionary) {
                        rev[obj.morphTargetDictionary[name]] = name;
                    }
                    morphIndexToNameCache.set(obj, rev);
                }
            } catch (e) {}
        });

        const mouthCandidates = new Set();
        const expressions = vrm.expressionManager.expressions || [];
        expressions.forEach(expr => {
            const name = expr.expressionName || expr.name;
            const binds = Array.isArray(expr.binds) ? expr.binds : (expr._binds || []);
            expressionBindMap[name] = binds || [];

            const nonMouthBinds = (binds || []).filter(bind => {
                try {
                    if (!bind || !bind.primitives || bind.primitives.length === 0) return true;
                    const prim = bind.primitives[0];
                    const rev = morphIndexToNameCache.get(prim);
                    if (!rev) return true;
                    const idx = (typeof bind.index === 'number') ? bind.index : (bind.morphTargetIndex ?? bind.index ?? null);
                    if (idx === null) return true;
                    const morphName = (rev[idx] || '').toLowerCase();

                    const isMouth = morphName.includes('mouth') ||
                                    morphName.includes('lip') ||
                                    morphName.includes('jaw') ||
                                    morphName.includes('tong') ||
                                    /fcl_?mth/i.test(morphName) ||
                                    /_a$|_i$|_ou$|_aa$|_ee$|_ih$/i.test(morphName) ||
                                    ['a','i','o','e','u'].includes(morphName);

                    if (isMouth) mouthCandidates.add(morphName);
                    return !isMouth;
                } catch (e) {
                    return true;
                }
            });

            nonMouthExpressionBindMap[name] = nonMouthBinds;
        });

        console.log('Expression bind maps prepared:', Object.keys(expressionBindMap).length, 'expressions.');
        if (mouthCandidates.size > 0) {
            console.log('Detected mouth-like morph names (examples):', Array.from(mouthCandidates).slice(0, 15));
        } else {
            console.log('No obvious mouth-like morph names detected by heuristics — run dumpMorphsAndExpressions() for details.');
        }
    } catch (err) {
        console.warn('setupExpressionBindMaps errored:', err);
    }
}

function applyEmotionNonMouth(vrm, name, weight = 1.0) {
    try {
        if (!vrm || !vrm.expressionManager || !name) return;
        const allBinds = expressionBindMap[name] || [];
        const keepBinds = nonMouthExpressionBindMap[name] || allBinds;

        allBinds.forEach(b => {
            try { if (b && typeof b.clearAppliedWeight === 'function') b.clearAppliedWeight(); } catch(e){}
        });

        keepBinds.forEach(b => {
            try { if (b && typeof b.applyWeight === 'function') b.applyWeight(weight); } catch(e){}
        });

        // fallback: set expressionManager value (may include mouth — visemes override immediately)
        try { if (typeof vrm.expressionManager.setValue === 'function') vrm.expressionManager.setValue(name, weight); } catch(e){}
    } catch (err) {}
}

// Debug helper that prints mesh morphs & expressions
function dumpMorphsAndExpressions() {
    try {
        if (!currentVrm) { console.warn('No currentVrm'); return; }
        console.log('--- DUMP: Mesh morph targets ---');
        currentVrm.scene.traverse(o => {
            try {
                if (o.isMesh && o.morphTargetDictionary) {
                    console.log('mesh:', o.name || o.uuid, Object.keys(o.morphTargetDictionary));
                }
            } catch(e){}
        });
        console.log('--- DUMP: Expressions ---');
        try {
            const exprs = currentVrm.expressionManager?.expressions || [];
            exprs.forEach(ex => {
                console.log('expr:', ex.expressionName || ex.name, 'binds:', Array.isArray(ex.binds) ? ex.binds.length : (ex._binds ? ex._binds.length : 0));
            });
        } catch(e){}
    } catch(e){ console.warn('dumpMorphsAndExpressions error', e); }
}

// Finally, start loading the model (same path as before)
loadVRM('./models/model.vrm'); 


/* =========================================================
   10. RENDER / UPDATE LOOP (drives visemes + animations)
   ========================================================= */
function updateVisemesSafe() {
    if (!currentVrm || !currentVrm.expressionManager) return;

    // If we are not talking, ensure the mouth is closed and reset the state.
    if (!isTalking) {
        if (lastAppliedViseme.shape !== 'sil') {
            const lastMappedShape = VISEME_MAPPING[lastAppliedViseme.shape] || lastAppliedViseme.shape;
            try { currentVrm.expressionManager.setValue(lastMappedShape, 0); } catch(e){}
            lastAppliedViseme = { shape: 'sil', time: 0 };
        }
        return;
    }

    if (!audioContext || audioPlaybackStartTime === 0) return;

    const elapsedTime = audioContext.currentTime - audioPlaybackStartTime;

    // Find the most recent viseme that should be active based on elapsed audio time.
    let newViseme = lastAppliedViseme;
    while (visemeQueue.length > 0 && elapsedTime >= visemeQueue[0].time) {
        newViseme = visemeQueue.shift();
    }

    // If the active viseme hasn't changed since the last frame, do nothing.
    if (newViseme.shape === lastAppliedViseme.shape) return;

    // Turn off the old viseme shape.
    const oldMappedShape = VISEME_MAPPING[lastAppliedViseme.shape] || lastAppliedViseme.shape;
    if (oldMappedShape !== 'sil') {
        try { currentVrm.expressionManager.setValue(oldMappedShape, 0); } catch(e){}
    }

    // Turn on the new viseme shape.
    const newMappedShape = VISEME_MAPPING[newViseme.shape] || newViseme.shape;
    if (newMappedShape !== 'sil') {
        try { currentVrm.expressionManager.setValue(newMappedShape, 1.0); } catch(e){}
    }

    lastAppliedViseme = newViseme;
}

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    if (mixer) {
        try { mixer.update(delta); } catch(e) {}
    }

    if (currentVrm && currentVrm.expressionManager) {
        // The conflicting expression reset loop has been removed to prevent jitter.
        // The animation mixer and the emotion system can now operate without fighting each other.

        if (isTalking) {
            // When talking, prioritize lip-sync. We use 'relaxed' as a neutral
            // base and ensure other primary AI expressions are turned off.
            try {
                currentVrm.expressionManager.setValue('relaxed', 1.0);
                if(activeEmotionName !== 'relaxed') {
                   currentVrm.expressionManager.setValue(activeEmotionName, 0);
                }
            } catch(e) {}

        } else {
            // When not talking, apply the current AI-driven emotion as usual.
            try { currentVrm.expressionManager.setValue(activeEmotionName, activeEmotionWeight || 1.0); } catch(e) {}
        }

        // Apply visemes on top of the base expression. This will correctly override the mouth shape.
        try { updateVisemesSafe(); } catch (e) {}

        // Let the VRM component update its internal state (like LookAt).
        try { currentVrm.update(delta); } catch(e) {}
    }

    try { renderer.render(scene, camera); } catch(e) {}
}
animate();

/* =========================================================
   11. BUBBLE / UI HELPERS
   ========================================================= */
    function hideBubble(bubbleElem) {
        if (bubbleElem.style.display !== 'none' && bubbleElem.style.opacity !== '0') {
            bubbleElem.style.opacity = '0';
            bubbleElem.style.bottom = '100px';
            setTimeout(() => { bubbleElem.style.display = 'none'; }, 400);
        }
    }

    let bubbleTimeout;
    function showBubble(bubbleElem, text, duration = 4000) {
        clearTimeout(bubbleTimeout);
        bubbleElem.innerHTML = text;
        bubbleElem.style.display = 'block';
        setTimeout(() => {
            bubbleElem.style.opacity = '1';
            bubbleElem.style.bottom = '120px';
        }, 10);
        if (duration && duration !== Infinity) {
            bubbleTimeout = setTimeout(() => hideBubble(bubbleElem), duration);
        }
    }

/* =========================================================
   12. PLAY RESPONSE & EXPRESSIONS (chunked TTS playback, preserves viseme/emotion flow)
   ========================================================= */
function playResponseAndExpressions(responseText, expressions, isGreeting = false) {
    return new Promise((resolve) => {
        const primaryExpression = expressions?.[0] || { name: 'relaxed', weight: 1.0 };

        if (isTextOutputOn) {
            const textDuration = Math.max(4000, responseText.length * 80);
            showBubble(textBubble, `<span class="fire-text">${responseText}</span>`, textDuration);
            isExpressionActive = true;
            activeEmotionName = primaryExpression.name;
            activeEmotionWeight = primaryExpression.weight ?? 1.0;
            setTimeout(() => {
                activeEmotionName = 'relaxed';
                activeEmotionWeight = 1.0;
                isExpressionActive = false;
            }, textDuration - 500);
            resolve();
            return;
        }

        function splitIntoChunks(text) {
            const rough = text.match(/[^.!?]+[.!?]?/g) || [text];
            const out = [];
            rough.forEach(sentence => {
                const trimmed = sentence.trim();
                if (!trimmed) return;
                if (trimmed.length <= 140) {
                    out.push(trimmed);
                } else {
                    let s = trimmed;
                    while (s.length > 0) {
                        let piece = s.slice(0, 140);
                        const lastSpace = piece.lastIndexOf(' ');
                        if (lastSpace > 60) piece = piece.slice(0, lastSpace);
                        out.push(piece.trim());
                        s = s.slice(piece.length).trim();
                    }
                }
            });
            return out;
        }

        const endPlayback = () => {
            isTalking = false;
            activeEmotionName = 'relaxed';
            activeEmotionWeight = 1.0;

            // CRITICAL FIX: Only transition to idle if the character is currently in a
            // talking-related animation. This prevents overriding other states (like texting)
            // that might have been triggered by the user during playback.
            if (lastPlayedAction === talkingAction || lastPlayedAction === wavingAction) {
                setAnimation(idleAction);
            }
            resolve();
        };

        (async () => {
            try {
                isTalking = true;
                activeEmotionName = primaryExpression.name;
                activeEmotionWeight = primaryExpression.weight ?? 1.0;

                initAudioContext();
                const chunks = splitIntoChunks(responseText);
                const audioBuffers = [];
                let totalDuration = 0;

                // Step 1: Fetch and decode all audio chunks first.
                for (const chunkText of chunks) {
                    const ttsResponse = await fetch("/.netlify/functions/elevenlabs", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            voiceId,
                            payload: {
                                text: chunkText,
                                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
                            }
                        })
                    });

                    if (!ttsResponse.ok) {
                        const errText = await ttsResponse.text().catch(() => 'TTS request failed');
                        throw new Error(errText);
                    }

                    // FIX: Process the response as a raw audio file, not JSON.
                    const audioData = await ttsResponse.arrayBuffer();
                    const decodedBuffer = await audioContext.decodeAudioData(audioData);
                    audioBuffers.push(decodedBuffer);
                    totalDuration += decodedBuffer.duration;
                }

                if (audioBuffers.length === 0) {
                    endPlayback();
                    return;
                }

                // Step 2: Start the animation. The 'finished' listener will handle transitions.
                if (isGreeting && wavingAction) {
                    setAnimation(wavingAction);
                } else {
                    setAnimation(talkingAction);
                }

                // Step 3: Play all decoded audio buffers sequentially.
                let startTime = audioContext.currentTime;
                for (const buffer of audioBuffers) {
                    const source = audioContext.createBufferSource();
                    source.buffer = buffer;
                    source.connect(audioContext.destination);
                    source.start(startTime);
                    startTime += buffer.duration;
                }

                // Step 4: Wait for all audio to finish, then end the playback state.
                setTimeout(endPlayback, totalDuration * 1000);

            } catch (err) {
                console.error("Error playing response:", err);
                endPlayback();
            }
        })();
    });
}
/* =========================================================
   13. CHAT / API FLOW (Gemini online + local LM Studio)
   ========================================================= */
async function handleSendMessage() {
    const prompt = chatInput.value.trim();
    if (!prompt || !currentVrm || isAwaitingResponse) return;

    chatInput.value = '';

    isAwaitingResponse = true;
    chatInput.disabled = true;
    sendButton.disabled = true;
    modeToggleButton.disabled = true;

    initAudioContext();

    hideBubble(textBubble);
    showBubble(thinkingBubble, `<span class="fire-text">Thinking...</span>`, Infinity);

    const isGreeting = isGreetingPrompt(prompt);

    try {
        if (apiMode === 'online') {
            const expressionList = ALLOWED_EXPRESSIONS_FOR_AI.join(', ');
            const systemPrompt = `You are Aria, an emotionally intelligent virtual friend. Your personality is calm, warm, and supportive.
            Respond in a natural, human-like way. NEVER mention you are an AI.
            IMPORTANT: Your entire response MUST be a single, valid JSON object. Do not include any text before or after the JSON.
            The JSON object must have this exact structure:
            {
              "responseText": "The text you want to say out loud.",
              "expressions": [ { "name": "expression_name", "weight": 0.8 } ]
            }
            - "responseText": The clean, natural language response.
            - "expressions": An array of facial expressions. Only the FIRST expression will be used and it will last for the entire duration of the response.
              - "name": Choose the MOST appropriate emotion from this list: [${expressionList}].
              - "weight": How strong the expression is (from 0.1 to 1.0).`;

            const requestBody = {
                contents: [
                    { role: 'user', parts: [{ text: systemPrompt }] },
                    { role: 'model', parts: [{ text: "Understood." }] },
                    ...conversationHistory,
                    { role: "user", parts: [{ text: prompt }] }
                ],
                generationConfig: { maxOutputTokens: 2048, responseMimeType: "application/json" },
            };

            const response = await fetch("/.netlify/functions/gemini", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) { throw new Error(`Gemini API request failed with status ${response.status}`); }

            const data = await response.json();

            if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
                throw new Error("Invalid response structure from Gemini API.");
            }
            const { responseText, expressions } = JSON.parse(data.candidates[0].content.parts[0].text);

            hideBubble(thinkingBubble);
            if (!responseText) throw new Error("Empty response text from API.");

            conversationHistory.push(
                { role: "user", parts: [{ text: prompt }] },
                { role: "model", parts: [{ text: JSON.stringify({ responseText, expressions }) }] }
            );
            if (conversationHistory.length > MAX_CONVERSATION_TURNS * 2) {
                conversationHistory.splice(0, 2);
            }

            await playResponseAndExpressions(responseText, expressions || [], isGreeting);

        } else {
            // Local LM Studio
            const localApiUrl = 'http://localhost:1234/v1/chat/completions';
            const localSystemPrompt = `You are Aria, an emotionally intelligent virtual friend. Your personality is calm, warm, and supportive. Respond in a natural, human-like way. NEVER mention you are an AI.`;

            const messages = conversationHistory.map(turn => {
                const role = turn.role === 'model' ? 'assistant' : 'user';
                const content = (turn.role === 'user')
                    ? turn.parts[0].text
                    : JSON.parse(turn.parts[0].text).responseText;
                return { role, content };
            });

            const requestBody = {
                model: "local-model",
                messages: [
                    { role: "system", content: localSystemPrompt },
                    ...messages,
                    { role: "user", content: prompt }
                ],
                temperature: 0.7,
                stream: false
            };

            const response = await fetch(localApiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                throw new Error(`Local API error: ${response.status}. Make sure LM Studio is running and the server is on.`);
            }

            const data = await response.json();
            const responseText = data.choices[0].message.content;
            hideBubble(thinkingBubble);

            const cleanedText = responseText.replace(/(\*.*?\*|")/g, '').trim();
            if (!cleanedText) {
                throw new Error("Empty response from local API.");
            }

            const expressions = [{ name: 'happy', weight: 0.7 }];

            conversationHistory.push(
                { role: "user", parts: [{ text: prompt }] },
                { role: "model", parts: [{ text: JSON.stringify({ responseText: cleanedText, expressions }) }] }
            );
            if (conversationHistory.length > MAX_CONVERSATION_TURNS * 2) {
                conversationHistory.splice(0, 2);
            }

            await playResponseAndExpressions(cleanedText, expressions, isGreeting);
        }
    } catch (error) {
        console.error("--- Error in Chat Flow ---", error);
        hideBubble(thinkingBubble);
        showBubble(textBubble, `<span class="fire-text">${error.message}</span>`, 6000);
    } finally {
        isAwaitingResponse = false;
        chatInput.disabled = false;
        sendButton.disabled = false;
        modeToggleButton.disabled = false;
    }
}


/* =========================================================
   14. UI EVENT BINDINGS (buttons, toggles)
   ========================================================= */
    sendButton.addEventListener('click', handleSendMessage);
    chatInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') handleSendMessage(); });

    toggleTextButton.addEventListener('click', () => {
        isTextOutputOn = !isTextOutputOn;
        toggleTextButton.classList.toggle('toggle-off', !isTextOutputOn);
        if (isTextOutputOn) {
            if (textingIntroAction) setAnimation(textingIntroAction);
        } else {
            hideBubble(textBubble);
            if (idleAction) setAnimation(idleAction);
        }
    });
    toggleTextButton.classList.toggle('toggle-off', !isTextOutputOn);

    modeToggleButton.addEventListener('click', () => {
        apiMode = apiMode === 'online' ? 'local' : 'online';
        modeToggleButton.textContent = apiMode === 'online' ? 'Online' : 'Local';
        modeToggleButton.classList.toggle('toggle-off', apiMode === 'local');
        if (conversationHistory.length > 0) {
            conversationHistory = [];
            showBubble(textBubble, `<span class="fire-text">Switched to ${apiMode} mode. History cleared.</span>`, 3000);
        }
    });

/* =========================================================
   16. LOADING SCREEN ORCHESTRATOR
   ========================================================= */
const progressWeights = { model: 0.7, animations: 0.3 };
let targetProgress = 0;
let displayedProgress = 0;
let animationFrameId;

function updateProgress(newProgress, newText) {
    targetProgress = Math.min(1, Math.max(targetProgress, newProgress));
    progressText.textContent = newText;
}

function animateProgressBar() {
    const difference = targetProgress - displayedProgress;
    if (Math.abs(difference) > 0.001) {
        displayedProgress += difference * 0.2;
        progressBar.style.transform = `scaleX(${displayedProgress})`;
    } else if (targetProgress > displayedProgress) {
        displayedProgress = targetProgress;
        progressBar.style.transform = `scaleX(${displayedProgress})`;
    }
    if (targetProgress < 1 || displayedProgress < 1) {
        animationFrameId = requestAnimationFrame(animateProgressBar);
    }
}

function loadVRMWithProgress(url) {
    return new Promise((resolve, reject) => {
        loader.load(url, (gltf) => {
            try {
                const vrm = gltf.userData?.vrm || gltf.userData?.gltfVrm;
                if (!vrm) { reject(new Error('Loaded file is not a valid VRM.')); return; }
                safeRemoveVrmFromScene(currentVrm);
                currentVrm = vrm;
                scene.add(vrm.scene);
                vrm.scene.rotation.y = Math.PI;
                vrm.lookAt.target = camera;
                aiManagedExpressions = vrm.expressionManager?.expressions?.map(e => e.expressionName || e.name).filter(name => !['aa','ih','ou','ee','oh','blink'].includes(name)) || [];
                setupBlinking(vrm);
                setupSideGlances(vrm);
                setTimeout(() => ensureVrmVisible(vrm), 200);
                resolve(vrm);
            } catch (err) { reject(err); }
        }, (progress) => {
            if (progress.total > 0) {
                const modelPct = progress.loaded / progress.total;
                const displayPct = Math.round(Math.min(1, modelPct) * 100);
                updateProgress(modelPct * progressWeights.model, `Loading Model... ${displayPct}%`);
            }
        }, reject);
    });
}

async function loadAnimationsWithProgress() {
    if (!currentVrm) return;
    mixer = new THREE.AnimationMixer(currentVrm.scene);
    mixer.addEventListener('finished', (event) => {
        if (event.action === textingIntroAction && textingLoopAction) setAnimation(textingLoopAction);
        if (event.action === wavingAction && isTalking && talkingAction) setAnimation(talkingAction);
    });
    const animationFiles = [
        './animations/idle.vrma', './animations/idle1.vrma', './animations/talking.vrma',
        './animations/waving.vrma', './animations/texting.vrma'
    ];
    const progressPerAnimation = progressWeights.animations / animationFiles.length;
    const loadFile = async (url, name, index) => {
        try {
            const gltf = await loader.loadAsync(url);
            updateProgress(progressWeights.model + ((index + 1) * progressPerAnimation), `Loading: ${name}`);
            return gltf;
        } catch (e) {
            updateProgress(progressWeights.model + ((index + 1) * progressPerAnimation), `Skipping: ${name}`);
            return null;
        }
    };
    const [idleAn, idle1An, talkAn, waveAn, textAn] = await Promise.all([
        loadFile(animationFiles[0], 'Idle', 0), loadFile(animationFiles[1], 'Idle Variant', 1),
        loadFile(animationFiles[2], 'Talking', 2), loadFile(animationFiles[3], 'Waving', 3),
        loadFile(animationFiles[4], 'Texting', 4)
    ]);
    if (idleAn) {
        const clip = createVRMAnimationClip(idleAn.userData.vrmAnimations[0], currentVrm);
        idleAction = mixer.clipAction(clip);
        idleAction.setLoop(THREE.LoopPingPong, Infinity).setEffectiveTimeScale(0.8).play();
        lastPlayedAction = idleAction;
    }
    if (idle1An) {
        const clip = createVRMAnimationClip(idle1An.userData.vrmAnimations[0], currentVrm);
        idle1Action = mixer.clipAction(clip);
        idle1Action.setLoop(THREE.LoopOnce, 0); // FIX: Removed clampWhenFinished for smooth transition
        idle1Duration = clip.duration || 0;
    }
    if (talkAn) {
        const clip = createVRMAnimationClip(talkAn.userData.vrmAnimations[0], currentVrm);
        talkingAction = mixer.clipAction(clip);
        talkingAction.setLoop(THREE.LoopPingPong, Infinity);
    }
    if (waveAn) {
        const clip = createVRMAnimationClip(waveAn.userData.vrmAnimations[0], currentVrm);
        wavingAction = mixer.clipAction(clip);
        wavingAction.setLoop(THREE.LoopOnce, 0); // FIX: Removed clampWhenFinished for smooth transition
        wavingDuration = clip.duration || 0;
    }
    if (textAn) {
        let clip = createVRMAnimationClip(textAn.userData.vrmAnimations[0], currentVrm);
        clip.tracks = clip.tracks.filter(track => !track.name.includes('morphTargetInfluences'));
        const introClip = AnimationUtils.subclip(clip, 'textIntro', 0, 30, 30);
        const loopClip = AnimationUtils.subclip(clip, 'textLoop', 30, clip.duration * 30, 30);
        textingIntroAction = mixer.clipAction(introClip);
        textingIntroAction.setLoop(THREE.LoopOnce); // FIX: Removed clampWhenFinished for smooth transition
        textingLoopAction = mixer.clipAction(loopClip);
        textingLoopAction.setLoop(THREE.LoopPingPong).setEffectiveTimeScale(0.8);
    }
    scheduleIdle1();
}

async function initializeScene() {
    animateProgressBar();
    try {
        await loadVRMWithProgress('./models/model.vrm');
        await loadAnimationsWithProgress();
        updateProgress(1, 'Finished!');
        
        loadingOverlay.classList.add('hidden');

        // This timeout matches the CSS transition duration for the loading overlay.
        setTimeout(() => {
            // Final cleanup
            loadingOverlay.style.display = 'none';
            cancelAnimationFrame(animationFrameId);

            // Play the initial waving animation
            if (wavingAction) {
                setAnimation(wavingAction);
                // After the wave finishes, return to idle.
                setTimeout(() => {
                    // Only return to idle if another action hasn't interrupted the wave.
                    if (idleAction && lastPlayedAction === wavingAction) {
                        setAnimation(idleAction);
                    }
                }, wavingDuration * 1000); // wavingDuration is in seconds
            }

        }, 750); 
    } catch (error) {
        console.error("Initialization failed:", error);
        updateProgress(targetProgress, "Failed to initialize. Please refresh.");
        cancelAnimationFrame(animationFrameId);
    }
}

// Start the entire application.
initializeScene();

/* =========================================================
   17. MOBILE VIEWPORT HELPER
   ========================================================= */

/**
 * Calculates the actual viewport height minus the browser UI and keyboard,
 * and sets it as a CSS variable (`--vh`). This prevents the layout from
 * breaking when the mobile keyboard appears.
 */
function setRealViewportHeight() {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
}

/* =========================================================
   18. SCRIPT END
   ========================================================= */

}); // end DOMContentLoaded






















