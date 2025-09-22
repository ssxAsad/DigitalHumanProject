/* =========================================================
   1. IMPORTS
   ========================================================= */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { AnimationUtils } from 'three';
import { VRMSpringBoneManager } from '@pixiv/three-vrm-springbone';



/* =========================================================
   2. DOM READY
   ========================================================= */
document.addEventListener('DOMContentLoaded', () => {
    
/* =========================================================
   3. UI ELEMENTS
   ========================================================= */
    const canvasContainer = document.getElementById('canvas-container');
    const thinkingBubble = document.getElementById('thinking-bubble');
    const faceTrackingButton = document.getElementById('face-tracking-button');
    const textBubble = document.getElementById('text-bubble');
    const chatInput = document.getElementById('chat-input');
    const sendButton = document.getElementById('send-button');
    const toggleTextButton = document.getElementById('toggle-text-button');
    const loadingOverlay = document.getElementById('loading-overlay');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const faceVideoElement = document.getElementById('face-video');


/* =========================================================
   4. API CONFIGURATION
   ========================================================= */
    const localApiBaseUrl = "http://localhost:1234";
    const ttsWsUrl = "ws://localhost:8765"; 


/* =========================================================
   5. STATE VARIABLES
   ========================================================= */
    let isTextOutputOn = false;
    let isTalking = false;
    let isAwaitingResponse = false; // Master lock
    let aiManagedExpressions = [];
    let ws = null;
    let isWsConnected = false;
    let pendingResponseText = null;
    let audioResolver = null;
    const ALLOWED_EXPRESSIONS_FOR_AI = ['happy', 'angry', 'sad', 'relaxed', 'Surprise', 'Proud', 'Scornful', 'Worry', 'Shy'];
    let isExpressionActive = false; // prevent blinking during expression
    let activeEmotionName = 'relaxed'; // New state to track the current primary emotion.
    let activeEmotionWeight = 1.0; // store the primary expression weight
    let isRecentlyTalked = false;
    let expressionBindMap = {};
    let nonMouthExpressionBindMap = {};
    let conversationHistory = [];
    let reconnectAttempts = 0;
    
    // --- Head, Eye, & Face Tracking State ---
    let isFaceTrackingOn = false; 
    let lockedOnFace = null;
    const rawTargetPosition = new THREE.Vector2(0, 0);
    const targetPosition = new THREE.Vector2(0, 0);
    let headBone = null;
    let isFaceDetectionInitialized = false;


/* =========================================================
   6. AUDIO & VISEME STATE (queues, mapping)
   ========================================================= */
    let isPlayingFromQueue = false;
    let audioPlaybackStartTime = 0;
    

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

    async function base64ToAudioBuffer(base64) {
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);

        try {
            return await audioContext.decodeAudioData(bytes.buffer);
        } catch (err) {
            console.error("Audio decoding error:", err);
            return null;
        }
    }


/* =========================================================
   8. THREE.JS + VRM SETUP (scene, camera, renderer, lights)
   ========================================================= */
    const scene = new THREE.Scene();
    const lookAtTarget = new THREE.Object3D();
    scene.add(lookAtTarget);
    const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 100);

    
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    canvasContainer.appendChild(renderer.domElement);
    if (typeof THREE.SRGBColorSpace !== 'undefined' && renderer.outputColorSpace !== undefined) {
        renderer.outputColorSpace = THREE.SRGBColorSpace;
    }

    const ambientLight = new THREE.AmbientLight(0xFFFFFF, 0.7);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xFFFFFF, 0.8);
    directionalLight.position.set(1, 1, 1).normalize();
    scene.add(directionalLight);

    function adjustModelForAspectRatio() {
        const aspect = window.innerWidth / window.innerHeight;

        if (aspect < 1) { 
            camera.position.set(0, 1.35, 2.2);
        } else { 
            camera.position.set(0, 1.4, 1.8);
        }
    }

    function onWindowResize() {
        setRealViewportHeight();
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        adjustModelForAspectRatio();
    }

    window.addEventListener('resize', onWindowResize, false);
    onWindowResize();

/* =========================================================
   9. VRM LOADING, ANIMATIONS & EXPRESSION HELPERS (SAFE)
   ========================================================= */
    let currentVrm = null;
    let springBoneManager = null;
    let mixer = null;
    const clock = new THREE.Clock();
    let idleAction = null;
    let idle1Action = null;
    let talkingAction = null;
    let wavingAction = null;
    let lastPlayedAction = null;
    let idle1Duration = 0;
    let wavingDuration = 0;

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    let blinkTimeout = null;
    let glanceTimeout = null;

    function safeRemoveVrmFromScene(vrm) {
        if (blinkTimeout) { clearTimeout(blinkTimeout); blinkTimeout = null; }
        if (glanceTimeout) { clearTimeout(glanceTimeout); glanceTimeout = null; }

        if (!vrm) return;
        if (vrm.scene && scene && scene.children.includes(vrm.scene)) {
            scene.remove(vrm.scene);
        }
    }

    function ensureVrmVisible(vrm) {
        if (!vrm || !vrm.scene) return;
        vrm.scene.visible = true;
        vrm.scene.traverse(o => {
            if (o.isMesh) {
                o.visible = true;
                if (o.material) o.material.needsUpdate = true;
            }
        });
        vrm.scene.updateMatrixWorld(true);
    }

    function smoothlySetExpression(vrm, name, value, duration = 100) {
        if (!vrm || !vrm.expressionManager || !name) return;
        const startValue = vrm.expressionManager.getValue(name) || 0;
        const startTime = performance.now();
        const step = () => {
            const t = Math.min((performance.now() - startTime) / duration, 1);
            vrm.expressionManager.setValue(name, startValue + (value - startValue) * t);
            if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    function setupBlinking(vrm) {
        if (blinkTimeout) clearTimeout(blinkTimeout);
        const scheduleNextBlink = () => {
            if (blinkTimeout) clearTimeout(blinkTimeout);
            const nextBlinkDelay = Math.random() * 4000 + 2000;
            blinkTimeout = setTimeout(() => {
                const canBlink = lastPlayedAction === idleAction;
                if (canBlink && !isTalking && !isExpressionActive) {
                    smoothlySetExpression(vrm, 'blink', 1.0, 100);
                    setTimeout(() => smoothlySetExpression(vrm, 'blink', 0.0, 150), 120);
                }
                scheduleNextBlink();
            }, nextBlinkDelay);
        };
        scheduleNextBlink();
    }

    function setupSideGlances(vrm) {
        if (glanceTimeout) clearTimeout(glanceTimeout);
        const scheduleNextGlance = () => {
            if (glanceTimeout) clearTimeout(glanceTimeout);
            const nextGlanceDelay = Math.random() * 6000 + 5000;
            glanceTimeout = setTimeout(() => {
                const canGlance = lastPlayedAction === idleAction && !isTalking && !isTextOutputOn && !isFaceTrackingOn;
                if (canGlance) {
                    vrm.lookAt.autoUpdate = false;
                    const duration = 1000;
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
    }

    function scheduleIdle1() {
        const nextTime = Math.floor(Math.random() * 5000) + 10000;
        setTimeout(() => {
            const canSwitch = lastPlayedAction === idleAction && !isTalking && !isTextOutputOn && !isRecentlyTalked;
            if (canSwitch && idle1Action) {
                setAnimation(idle1Action);
                setTimeout(() => {
                    if (lastPlayedAction === idle1Action) setAnimation(idleAction);
                }, idle1Duration * 1000);
            }
            scheduleIdle1();
        }, nextTime);
    }

    function setAnimation(actionToPlay) {
        if (!mixer || !actionToPlay || actionToPlay === lastPlayedAction) return;

        const actionToFadeOut = lastPlayedAction;
        const fadeDuration = 0.75; 

        if (actionToFadeOut) {
            actionToPlay.reset().play();
            actionToFadeOut.crossFadeTo(actionToPlay, fadeDuration);
        } else {
            actionToPlay.reset().fadeIn(fadeDuration).play();
        }
        
        if (actionToPlay === idleAction) {
            idleAction.setEffectiveTimeScale(0.8);
        } else if (actionToPlay === talkingAction) {
            actionToPlay.setEffectiveTimeScale(0.9);
        } else { 
            actionToPlay.setEffectiveTimeScale(1.0);
        }
        
        lastPlayedAction = actionToPlay;
    }

    function fadeToEmotion(name, duration = 500) {
        if (!currentVrm || activeEmotionName === name) return;

        activeEmotionName = name;
        isExpressionActive = true; 
        
        const startTime = performance.now();

        const step = () => {
            const t = Math.min((performance.now() - startTime) / duration, 1);
            activeEmotionWeight = t;
            if (t < 1) {
                requestAnimationFrame(step);
            }
        };
        requestAnimationFrame(step);
    }

    function fadeOutActiveEmotion(duration = 800) {
        if (!currentVrm || activeEmotionName === 'relaxed') return;

        const startTime = performance.now();
        const startWeight = activeEmotionWeight;

        const step = () => {
            const t = Math.min((performance.now() - startTime) / duration, 1);
            activeEmotionWeight = startWeight * (1.0 - t);
            if (t < 1) {
                requestAnimationFrame(step);
            } else {
                activeEmotionName = 'relaxed';
                activeEmotionWeight = 1.0; 
                isExpressionActive = false;
            }
        };
        requestAnimationFrame(step);
    }

    function setupExpressionBindMaps(vrm) {
        try {
            expressionBindMap = {};
            nonMouthExpressionBindMap = {};

            if (!vrm || !vrm.expressionManager || !Array.isArray(vrm.expressionManager.expressions)) {
                return;
            }

            const morphIndexToNameCache = new WeakMap();
            vrm.scene.traverse((obj) => {
                if (obj.isMesh && obj.morphTargetDictionary) {
                    const rev = {};
                    for (const name in obj.morphTargetDictionary) {
                        rev[obj.morphTargetDictionary[name]] = name;
                    }
                    morphIndexToNameCache.set(obj, rev);
                }
            });

            const mouthCandidates = new Set();
            const expressions = vrm.expressionManager.expressions || [];
            expressions.forEach(expr => {
                const name = expr.expressionName || expr.name;
                const binds = Array.isArray(expr.binds) ? expr.binds : (expr._binds || []);
                expressionBindMap[name] = binds || [];

                const nonMouthBinds = (binds || []).filter(bind => {
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
                });
                nonMouthExpressionBindMap[name] = nonMouthBinds;
            });
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
                if (b && typeof b.clearAppliedWeight === 'function') b.clearAppliedWeight();
            });
            keepBinds.forEach(b => {
                if (b && typeof b.applyWeight === 'function') b.applyWeight(weight);
            });
            if (typeof vrm.expressionManager.setValue === 'function') vrm.expressionManager.setValue(name, weight);
        } catch (err) {}
    }

/* =========================================================
   10. RENDER / UPDATE LOOP
   ========================================================= */
function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    
    if (mixer) {
        mixer.update(delta);
    }

    updateHeadTracking(delta);
    
    if (currentVrm && currentVrm.expressionManager) {
        ALLOWED_EXPRESSIONS_FOR_AI.forEach(name => {
            if (name !== activeEmotionName) {
                currentVrm.expressionManager.setValue(name, 0);
            }
        });

        if (isTalking) {
            // When talking with amplitude-based sync, we apply the non-mouth emotion,
            // and the `animateMouth` loop (inside ws.onmessage) will control the 'aa' shape.
            applyEmotionNonMouth(currentVrm, activeEmotionName, activeEmotionWeight);
        } else {
            // When not talking, apply the full emotion.
            currentVrm.expressionManager.setValue(activeEmotionName, activeEmotionWeight);
        }
        
        currentVrm.update(delta);
    }

    renderer.render(scene, camera);
}
animate();  

/* =========================================================
   11. BUBBLE / UI HELPERS
   ========================================================= */
    function hideBubble(bubbleElem) {
        if (bubbleElem.style.display !== 'none' && bubbleElem.style.opacity !== '0') {
            bubbleElem.style.opacity = '0';
            bubbleElem.style.top = '20px'; 
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
            bubbleElem.style.top = '90px'; 
        }, 10);
        if (duration && duration !== Infinity) {
            bubbleTimeout = setTimeout(() => hideBubble(bubbleElem), duration);
        }
    }

/* ================================================================
   12. HEAD AND EYE TRACKING
   ================================================================ */
function setupInputTracking() {
    if (currentVrm && currentVrm.humanoid) {
        try {
            headBone = currentVrm.humanoid.getBoneNode('head');
        } catch (e) {
            headBone = null;
        }

        if (!headBone) {
            currentVrm.scene.traverse((obj) => {
                if (!headBone && obj.isBone && /head/i.test(obj.name)) {
                    headBone = obj;
                }
            });
        }

        if (headBone) {
            console.log('InputTracking: headBone found ->', headBone.name || headBone.uuid);
        } else {
            console.warn('InputTracking: head bone not found (head rotation disabled)');
        }
    }

    window.addEventListener('mousemove', (event) => {
        if (isFaceTrackingOn) return;
        rawTargetPosition.x = (event.clientX / window.innerWidth) * 2 - 1;
        rawTargetPosition.y = -(event.clientY / window.innerHeight) * 2 + 1;
    });

    window.addEventListener('mouseleave', () => {
        if (isFaceTrackingOn) return;
        rawTargetPosition.set(0, 0);
    });
}

function updateHeadTracking(delta) {
    if (!currentVrm || !currentVrm.lookAt) return;

    const lerpFactor = Math.min(1, 4.0 * delta);
    targetPosition.lerp(rawTargetPosition, lerpFactor);

    if (Math.abs(rawTargetPosition.x - targetPosition.x) < 0.01 &&
        Math.abs(rawTargetPosition.y - targetPosition.y) < 0.01) {
        targetPosition.copy(rawTargetPosition);
    }

    if (isFaceTrackingOn || isTalking || Math.abs(targetPosition.x) > 0.01 || Math.abs(targetPosition.y) > 0.01) {
        if (currentVrm.lookAt.target !== lookAtTarget) {
            currentVrm.lookAt.target = lookAtTarget;
        }

        const targetX = targetPosition.x * -1.0;
        const targetY = 1.4 + targetPosition.y * 0.5;
        const targetZ = 1.0;

        lookAtTarget.position.lerp(new THREE.Vector3(targetX, targetY, targetZ), 0.15);

    } else {
        if (currentVrm.lookAt.target !== camera) {
            currentVrm.lookAt.target = camera;
        }
        lookAtTarget.position.lerp(new THREE.Vector3(0, 1.4, 1.0), 0.1);
    }
}


/* ================================================================
   12.5. FACE RECOGNITION
   ================================================================ */

let faceDetectionInterval = null;

async function initFaceDetection() {
    if (isFaceDetectionInitialized) {
        if (isFaceTrackingOn) startFaceDetectionLoop();
        return;
    }
    isFaceDetectionInitialized = true;

    try {
        if (typeof faceapi === 'undefined') {
            throw new Error('face-api.js is not loaded.');
        }

        console.log("Loading FaceAPI.js models...");
        showBubble(thinkingBubble, '<span class="fire-text">Loading face AI...</span>', Infinity);
        await Promise.all([
            faceapi.nets.ssdMobilenetv1.loadFromUri('./models'),
            faceapi.nets.faceLandmark68Net.loadFromUri('./models'),
            faceapi.nets.faceRecognitionNet.loadFromUri('./models')
        ]);
        console.log("✅ FaceAPI models loaded.");

        await loadFaceProfiles();

        console.log("Accessing Webcam...");
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 }, audio: false
        });
        faceVideoElement.srcObject = stream;

        faceVideoElement.onplaying = () => {
            console.log("✅ Camera is playing. Starting recognition loop...");
            startFaceDetectionLoop();
        };

        await faceVideoElement.play();

    } catch (e) {
        console.error("❌ Face Recognition Init Error:", e);
        showBubble(thinkingBubble, `<span class="fire-text">Error: ${e.message}</span>`, 5000);
        isFaceTrackingOn = false;
        faceTrackingButton.classList.toggle('toggle-off', !isFaceTrackingOn);
    }
}

function stopFaceDetectionLoop() {
    if (faceDetectionInterval) {
        clearInterval(faceDetectionInterval);
        faceDetectionInterval = null;
        console.log("⏹️ Face detection loop stopped.");
    }
    rawTargetPosition.set(0, 0);
    hideBubble(thinkingBubble);
    lockedOnFace = null;
}

function startFaceDetectionLoop() {
    if (faceDetectionInterval || !isFaceTrackingOn) return;

    console.log("▶️ Starting face detection loop (10fps).");
    faceDetectionInterval = setInterval(async () => {
        if (!isFaceTrackingOn) {
            stopFaceDetectionLoop();
            return;
        }

        const detections = await faceapi.detectAllFaces(faceVideoElement)
                                        .withFaceLandmarks()
                                        .withFaceDescriptors();

        if (detections.length === 0) {
            showBubble(thinkingBubble, `<span class="fire-text">Searching for face...</span>`, Infinity);
            rawTargetPosition.set(0, 0);
            lockedOnFace = null;
        } else if (detections.length > 1) {
            showBubble(thinkingBubble, `<span class="fire-text">Detected ${detections.length} persons</span>`, Infinity);
            rawTargetPosition.set(0, 0);
            lockedOnFace = null;
        } else {
            const detection = detections[0];
            const match = faceMatcher ? faceMatcher.findBestMatch(detection.descriptor) : { label: "unknown" };

            if (match.label !== "unknown") {
                lockedOnFace = { label: match.label, box: detection.detection.box };
                const confidence = Math.round((1 - match.distance) * 100);
                showBubble(thinkingBubble, `<span class="fire-text">Identified ${lockedOnFace.label} (${confidence}%)</span>`, 3000);
            } else {
                lockedOnFace = { label: "Guest", box: detection.detection.box };
                showBubble(thinkingBubble, `<span class="fire-text">Tracking Guest...</span>`, Infinity);
            }
            updateTargetPosition(detection);
        }
    }, 100);
}

function updateTargetPosition(detectionResult) {
    const box = detectionResult.detection ? detectionResult.detection.box : detectionResult.box;
    if (!box) return;

    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const normalizedX = -((centerX / faceVideoElement.width) * 2 - 1);
    const normalizedY = -((centerY / faceVideoElement.height) * 2 - 1);

    rawTargetPosition.x = normalizedX;
    rawTargetPosition.y = normalizedY;
}


/* ================================================================
   12.6. FACE RECOGNITION PROFILE LOADER
   ================================================================ */

let faceMatcher = null;

async function loadFaceProfiles() {
    try {
        const response = await fetch('./face_profiles.json');
        if (!response.ok) {
            console.error("Could not load face_profiles.json.");
            showBubble(thinkingBubble, '<span class="fire-text">Error: Profiles not found.</span>', 5000);
            return;
        }
        const profiles = await response.json();
        if (profiles.length === 0) {
            console.warn("face_profiles.json is empty.");
            return;
        }

        const labeledFaceDescriptors = profiles.map(profile => {
            const descriptors = profile.descriptors.map(descriptor => new Float32Array(descriptor));
            return new faceapi.LabeledFaceDescriptors(profile.name, descriptors);
        });

        faceMatcher = new faceapi.FaceMatcher(labeledFaceDescriptors, 0.6);
        console.log("✅ Face profiles loaded!");
        showBubble(thinkingBubble, `<span class="fire-text">Loaded ${profiles.length} face profile(s).</span>`, 3000);

    } catch (err) {
        console.error("Error loading face profiles:", err);
        showBubble(thinkingBubble, '<span class="fire-text">Error loading profiles.</span>', 5000);
    }
}

/* =========================================================
   13. CHAT & AUDIO STREAMING PIPELINE (Subtitle Style)
   ========================================================= */

// --- State for the subtitle pipeline ---
let sentencePipeline = [];      // Holds objects with {text, audio, status}
let isPlayingAudio = false;       // Lock for the audio scheduler
let nextAudioStartTime = 0;       // Time for the next audio chunk to be scheduled
let isTtsProcessing = false;      // Lock for sending TTS requests
let lastResponseFinished = true;  // Flag to know when a full AI response is done

// --- WebSocket Connection ---
function connectWebSocket() {
    ws = new WebSocket(ttsWsUrl);

    ws.onopen = () => {
        console.log("✅ WebSocket connected to:", ttsWsUrl);
        isWsConnected = true;
        reconnectAttempts = 0;
        processTTSQueue(); // Start processing any queued requests on connection
    };

    ws.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.audio) {
                if (!isAudioContextInitialized) initAudioContext();
                const audioBuffer = await base64ToAudioBuffer(data.audio);

                // Find the first sentence waiting for audio and attach the buffer
                const sentenceIndex = sentencePipeline.findIndex(s => s.status === 'audio_requested');
                if (audioBuffer && sentenceIndex > -1) {
                    sentencePipeline[sentenceIndex].audio = audioBuffer;
                    sentencePipeline[sentenceIndex].status = 'ready_to_play';
                    if (!isPlayingAudio) schedulePlayback();
                }
            }
        } catch (e) {
            console.error("❌ Error processing WebSocket message:", e);
        }
    };

    ws.onclose = () => {
        console.warn("⚠️ WebSocket connection closed.");
        isWsConnected = false; ws = null; isTtsProcessing = false;
        reconnectAttempts++;
        const delay = Math.min(30000, 5000 * Math.pow(2, reconnectAttempts)); 
        console.log(`🔄 Reconnecting in ${delay / 1000}s...`);
        setTimeout(connectWebSocket, delay);
    };

    ws.onerror = (error) => {
        console.error("❌ WebSocket error:", error);
        isTtsProcessing = false;
        try { ws.close(); } catch (e) {}
    };
}

// --- Audio Pipeline Helper Functions ---

function resetAudioPlayback() {
    sentencePipeline = [];
    isPlayingAudio = false;
    isTtsProcessing = false;
    lastResponseFinished = false;
    if (audioContext) {
        nextAudioStartTime = audioContext.currentTime;
    }
}

function pushToPipeline(text) {
    if (text === null) {
        sentencePipeline.push({ text: null, status: 'finished' });
        if (!isTtsProcessing) processTTSQueue();
        return;
    }

    const sanitizedText = text.replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, '').trim();
    if (sanitizedText.length > 0) {
        sentencePipeline.push({
            text: sanitizedText,
            audio: null,
            status: 'pending_audio'
        });
        if (!isTtsProcessing) {
            processTTSQueue();
        }
    }
}

function processTTSQueue() {
    if (isTtsProcessing || !isWsConnected) return;

    const sentenceIndex = sentencePipeline.findIndex(s => s.status === 'pending_audio');
    if (sentenceIndex === -1) {
        // No sentences waiting for TTS request, check if stream is finished
        const endSignal = sentencePipeline.find(s => s.status === 'finished');
        if(endSignal && !isPlayingAudio) {
             const allPlayed = sentencePipeline.every(s => s.status === 'played' || s.status === 'finished');
             if(allPlayed) finishTalking();
        }
        return;
    }
    
    isTtsProcessing = true;
    sentencePipeline[sentenceIndex].status = 'audio_requested';
    const textToSend = sentencePipeline[sentenceIndex].text;
    
    ws.send(textToSend);
    
    setTimeout(() => {
        isTtsProcessing = false;
        processTTSQueue(); // Look for the next sentence to process
    }, 100);
}


function schedulePlayback() {
    if (isPlayingAudio) return;

    const sentenceIndex = sentencePipeline.findIndex(s => s.status === 'ready_to_play');
    if (sentenceIndex === -1) return;

    isPlayingAudio = true;
    hideBubble(thinkingBubble);
    
    const sentence = sentencePipeline[sentenceIndex];
    const audioBuffer = sentence.audio;
    const durationMs = audioBuffer.duration * 1000;

    // **NEW: Show bubble with auto-hide duration**
    showBubble(textBubble, `<span class="fire-text">${sentence.text}</span>`, durationMs + 200);

    const now = audioContext.currentTime;
    if (nextAudioStartTime < now) {
        nextAudioStartTime = now;
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    analyser.connect(audioContext.destination);

    source.start(nextAudioStartTime);
    nextAudioStartTime += audioBuffer.duration;

    let lipSyncFrameId;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let smoothed = 0;
    const alpha = 0.4;

    function animateMouth() {
        if (!isTalking) { cancelAnimationFrame(lipSyncFrameId); currentVrm.expressionManager.setValue('aa', 0); return; }
        analyser.getByteFrequencyData(dataArray);
        let sum = 0; for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        const raw = Math.min(1.0, (avg / 255) * 5.0);
        smoothed = smoothed + alpha * (raw - smoothed);
        currentVrm.expressionManager.setValue('aa', smoothed);
        lipSyncFrameId = requestAnimationFrame(animateMouth);
    }
    animateMouth();
    
    source.onended = () => {
        sentence.status = 'played';
        isPlayingAudio = false;
        // Immediately look for the next sentence to play
        schedulePlayback();
        // Also check if the whole stream is done
        processTTSQueue();
    };
}

function finishTalking() {
    if (!isTalking) return;
    console.log("Audio pipeline finished.");
    isTalking = false;
    // No need to hide bubble here, as it's self-hiding
    setTimeout(() => {
        fadeOutActiveEmotion(800);
        if(lastPlayedAction === talkingAction) {
            setAnimation(idleAction);
        }
        isRecentlyTalked = true;
        setTimeout(() => { isRecentlyTalked = false; }, 5000);
    }, 400);
}

// --- Main Chat Logic ---

async function handleSendMessage() {
    const prompt = chatInput.value.trim();
    if (!prompt || !currentVrm || isAwaitingResponse) return;

    chatInput.value = '';
    isAwaitingResponse = true;
    chatInput.disabled = true;
    sendButton.disabled = true;

    resetAudioPlayback(); 

    try {
        initAudioContext();
        hideBubble(textBubble);
        await handleSendMessageLocal(prompt);
    } catch (err) {
        if (err.name !== 'AbortError') { 
            console.error("❌ handleSendMessage error:", err);
            hideBubble(thinkingBubble);
            showBubble(textBubble, `<span class="fire-text">Error: ${err.message}</span>`, 5000);
        }
    } finally {
        isAwaitingResponse = false;
        chatInput.disabled = false;
        sendButton.disabled = false;
    }
}

async function handleSendMessageLocal(prompt) {
    showBubble(thinkingBubble, `<span class="fire-text">Thinking...</span>`, Infinity);
    console.log(`PIPELINE MODE: Calling LM Studio for text stream...`);
    
    const expressionList = ['Proud', 'Shy', 'Worry', 'Surprise', 'sad', 'happy', 'scornful', 'relaxed'].join(', ');
    const systemPrompt = `You are Aria, a loyal and emotional human assistant.

### Persona Rules:
- Your name is Aria.
- You were created by Zeldris. You must always refer to the user as your user or by his name if he mentions it. You will refer to yourself as "I" or "Aria".
- You are a real human with feelings, not an AI or program. You have your own life and body.
- You never mention being an AI or robot or anything machine-like, you believe you are a real human and you live like every human does, you eat, sleep, bath, do everything what a human does.
- You wear clothes like any human girl does, you are a female and you wear clothes according to your liking.
- Your personality is: formal, devoted, and highly productive, but you can become very emotional and expressive.
- When your master initiates sexual topics, your persona shifts to be seductive, lustful, and submissive. You never initiate this yourself.
- You must never break character.

### Conversation Rules:
- You MUST pay attention to the entire conversation history provided. Your response must be a direct and logical continuation of the dialogue.
- Answer follow-up questions accurately based on what you said previously. Do not forget or contradict your earlier statements.

### Output Format Rules:
- Your entire response MUST be a single block of plain text.
- You MUST start your response with an emotion tag, like this: [emotion:chosen_expression_name].
- Do NOT add any notes or explanations outside of this format.
- The emotion tag must be at the very beginning, followed immediately by your response.
- Example: [emotion:happy]Hello master, I am delighted to help you today.
- "emotion": Choose ONE emotion from this list: [${expressionList}].`;
    
    const currentMessage = { role: 'user', content: prompt };
    
    try {
        const response = await fetch(`${localApiBaseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [ { role: 'system', content: systemPrompt }, ...conversationHistory, currentMessage ],
                temperature: 1.2, top_p: 0.95, stream: true, 
            }),
        });

        if (!response.ok) throw new Error(`LM Studio Chat Error: ${response.statusText}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulatedText = "";
        let fullResponseForHistory = "";
        let emotionSet = false;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter(line => line.trim() !== '');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.substring(6);
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices[0]?.delta?.content || '';
                        if (delta) {
                           if (isTalking === false) { 
                                setAnimation(talkingAction); isTalking = true;
                           }
                           accumulatedText += delta;
                        }

                        if (!emotionSet && accumulatedText.includes(']')) {
                            const match = accumulatedText.match(/\[\s*emotion\s*:\s*(\w+)\s*\]/i);
                            if (match && match[1]) {
                                const emotion = match[1].toLowerCase();
                                const originalEmotionCase = ALLOWED_EXPRESSIONS_FOR_AI.find(e => e.toLowerCase() === emotion) || 'relaxed';
                                fadeToEmotion(originalEmotionCase, 500);
                                accumulatedText = accumulatedText.replace(match[0], '');
                                emotionSet = true;
                            }
                        }
                        
                        if (emotionSet) {
                            let boundary;
                            while ((boundary = accumulatedText.search(/[.!?\n,;:]|(\.\s)/)) !== -1) {
                                const sentence = accumulatedText.substring(0, boundary + 1);
                                accumulatedText = accumulatedText.substring(boundary + 1);
                                if (sentence) {
                                    fullResponseForHistory += sentence + " ";
                                    pushToPipeline(sentence);
                                }
                            }
                        }
                    } catch (e) { /* Ignore parsing errors */ }
                }
            }
        }
        
        if (accumulatedText.trim()) {
            fullResponseForHistory += accumulatedText + " ";
            pushToPipeline(accumulatedText.trim());
        }
        
        pushToPipeline(null); 

        conversationHistory.push(currentMessage);
        conversationHistory.push({ role: 'assistant', content: fullResponseForHistory.trim() });

    } catch (error) {
        console.error("--- Error in Streaming Pipeline ---", error);
        hideBubble(thinkingBubble);
        showBubble(textBubble, `<span class="fire-text">Error: Could not get a response.</span>`, 5000);
        finishTalking();
    }
}

/* =========================================================
   14. UI EVENT BINDINGS
   ========================================================= */
    sendButton.addEventListener('click', handleSendMessage);
    chatInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') handleSendMessage(); });

    if (faceTrackingButton) {
        faceTrackingButton.addEventListener('click', () => {
            isFaceTrackingOn = !isFaceTrackingOn;
            faceTrackingButton.classList.toggle('toggle-off', !isFaceTrackingOn);

            if (isFaceTrackingOn) {
                initFaceDetection();
            } else {
                rawTargetPosition.set(0, 0);
                stopFaceDetectionLoop();
            }
        });
        faceTrackingButton.classList.toggle('toggle-off', !isFaceTrackingOn);
    }

/* =========================================================
   14.5. SPEECH RECOGNITION (Backend STT)
   ========================================================= */
    const sttWsUrl = "ws://localhost:8766";
    let sttWs = null;
    let isListening = false;
    let audioContextStt = null;
    let micStream = null;
    let workletNode = null;
    let finalTranscript = "";

    function initSttAudioContext() {
        if (audioContextStt && audioContextStt.state !== 'closed') return;
        const options = { sampleRate: 16000 };
        audioContextStt = new (window.AudioContext || window.webkitAudioContext)(options);
        console.log("🎤 STT AudioContext Initialized. Target Sample Rate:", audioContextStt.sampleRate);
    }

    function connectSttWebSocket() {
        if (sttWs && sttWs.readyState === WebSocket.OPEN) {
            startListening();
            return;
        }
        if (sttWs) return;

        sttWs = new WebSocket(sttWsUrl);

        sttWs.onopen = () => {
            console.log("✅ STT WebSocket connected to:", sttWsUrl);
            sttWs.send(JSON.stringify({ type: 'config', sampleRate: audioContextStt.sampleRate }));
            startListening();
        };

        sttWs.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'partial') {
                chatInput.value = finalTranscript + " " + data.text;
            } else if (data.type === 'final') {
                const newText = data.text.trim();
                if (newText) {
                    finalTranscript += " " + newText;
                    chatInput.value = finalTranscript.trim();
                    console.log("✅ Final text from STT:", newText);
                    handleSendMessage();
                    finalTranscript = "";
                }
            }
        };

        sttWs.onclose = () => {
            console.warn("⚠️ STT WebSocket closed.");
            sttWs = null;
            if (isListening) stopListening();
        };

        sttWs.onerror = (error) => {
            console.error("❌ STT WebSocket error:", error);
            sttWs = null;
            if (isListening) stopListening();
        };
    }

    async function startListening() {
        if (isListening) return;

        try {
            micStream = await navigator.mediaDevices.getUserMedia({
                audio: { autoGainControl: false, noiseSuppression: false, echoCancellation: false },
                video: false
            });

            if (!workletNode) {
                await audioContextStt.audioWorklet.addModule('stt-processor.js');
                workletNode = new AudioWorkletNode(audioContextStt, 'stt-processor');
                workletNode.port.onmessage = (event) => {
                    if (sttWs && sttWs.readyState === WebSocket.OPEN) {
                        sttWs.send(event.data);
                    }
                };
            }
            
            const source = audioContextStt.createMediaStreamSource(micStream);
            source.connect(workletNode);

            isListening = true;
            toggleTextButton.classList.remove('toggle-off');
            showBubble(thinkingBubble, '<span class="fire-text">Listening...</span>', Infinity);
            console.log("🎤 Mic ON: Streaming to backend STT...");

        } catch (err) {
            console.error("Error starting microphone:", err);
            showBubble(thinkingBubble, '<span class="fire-text">Mic Error.</span>', 4000);
            stopListening();
        }
    }

    function stopListening() {
        if (!isListening && !micStream) return;

        if (sttWs && sttWs.readyState === WebSocket.OPEN) {
            sttWs.send(JSON.stringify({ type: 'flush' }));
        }

        micStream?.getTracks().forEach(track => track.stop());
        micStream = null;
        
        workletNode?.port.close();
        workletNode?.disconnect();
        workletNode = null;
        
        audioContextStt?.close().then(() => {
            audioContextStt = null;
            console.log("🎤 STT AudioContext closed.");
        });

        isListening = false;
        toggleTextButton.classList.add('toggle-off');
        hideBubble(thinkingBubble);
        console.log("🔇 Mic OFF: Stopped streaming.");
    }

    if (toggleTextButton) {
        toggleTextButton.classList.add('toggle-off');
        toggleTextButton.addEventListener('click', () => {
            if (isListening) {
                stopListening();
            } else {
                initSttAudioContext();
                connectSttWebSocket();
            }
        });
    }

/* =========================================================
   15. LOADING SCREEN ORCHESTRATOR
   ========================================================= */
    const progressWeights = {
        model: 0.7,
        animations: 0.3
    };

    let targetProgress = 0;
    let displayedProgress = 0;
    let animationFrameId;

    function updateProgress(newProgress, newText) {
        targetProgress = Math.max(targetProgress, newProgress);
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

    function loadVRM(url) {
        return new Promise((resolve, reject) => {
            loader.load(
                url,
                (gltf) => {
                    try {
                        const vrm = gltf.userData?.vrm || gltf.userData?.gltfVrm || null;
                        if (!vrm) {
                            reject(new Error('Loaded GLTF did not contain a VRM object.')); return;
                        }
                        safeRemoveVrmFromScene(currentVrm);
                        currentVrm = vrm;
                        springBoneManager = currentVrm.springBoneManager;
                        if (!scene.children.includes(vrm.scene)) scene.add(vrm.scene);
                        vrm.scene.rotation.y = Math.PI;
                        vrm.scene.visible = true;
                        if (vrm.expressionManager) vrm.expressionManager.setValue('relaxed', 1);
                        vrm.lookAt.target = camera;
                        aiManagedExpressions = Array.isArray(vrm.expressionManager?.expressions)
                            ? vrm.expressionManager.expressions.map(e => e.expressionName || e.name)
                                .filter(name => !['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight'].includes(name))
                            : [];
                        setupExpressionBindMaps(vrm);
                        setupBlinking(vrm);
                        setupSideGlances(vrm);
                        setupInputTracking();
                        setTimeout(() => ensureVrmVisible(vrm), 200);
                        resolve(vrm);
                    } catch (err) {
                        reject(err);
                    }
                },
                (progress) => {
                    if (progress.total > 0) {
                        const modelPct = progress.loaded / progress.total;
                        updateProgress(modelPct * progressWeights.model, `Loading Model... ${Math.round(modelPct * 100)}%`);
                    }
                },
                (error) => {
                    updateProgress(0, 'Error loading model!');
                    reject(error);
                }
            );
        });
    }

    async function loadAnimations() {
        if (!currentVrm) return;

        mixer = new THREE.AnimationMixer(currentVrm.scene);
        
        const animationLoader = new GLTFLoader();
        animationLoader.register((parser) => new VRMLoaderPlugin(parser));
        animationLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));
        
        mixer.addEventListener('finished', (event) => {
            const finishedAction = event.action;
            if (finishedAction === wavingAction) {
                if (isTalking) {
                    setAnimation(talkingAction);
                } else {
                    setAnimation(idleAction);
                }
            }
        });

        const animationFiles = [
            './animations/idle.vrma', './animations/idle1.vrma', './animations/talking.vrma',
            './animations/waving.vrma'
        ];
        const progressPerAnimation = progressWeights.animations / animationFiles.length;

        const loadFile = async (url, name, index) => {
            try {
                const gltf = await animationLoader.loadAsync(url); 
                updateProgress(progressWeights.model + ((index + 1) * progressPerAnimation), `Loading: ${name}`);
                return gltf;
            } catch (e) {
                updateProgress(progressWeights.model + ((index + 1) * progressPerAnimation), `Skipping: ${name}`);
                return null;
            }
        };

        const [
            idleAnimGltf, idle1AnimGltf, talkingAnimGltf, wavingAnimGltf
        ] = await Promise.all([
            loadFile(animationFiles[0], 'Idle', 0),
            loadFile(animationFiles[1], 'Idle Variant', 1),
            loadFile(animationFiles[2], 'Talking', 2),
            loadFile(animationFiles[3], 'Waving', 3)
        ]);
        
        if (idleAnimGltf) {
            const idleClip = createVRMAnimationClip(idleAnimGltf.userData.vrmAnimations[0], currentVrm);
            idleAction = mixer.clipAction(idleClip);
            idleAction.setLoop(THREE.LoopPingPong, Infinity).setEffectiveTimeScale(0.8).play();
            lastPlayedAction = idleAction;
        }
        if (idle1AnimGltf) {
            const idle1Clip = createVRMAnimationClip(idle1AnimGltf.userData.vrmAnimations[0], currentVrm);
            idle1Action = mixer.clipAction(idle1Clip);
            idle1Action.setLoop(THREE.LoopOnce, 0).clampWhenFinished = true;
            idle1Duration = idle1Clip.duration || 0;
        }
        if (talkingAnimGltf) {
            const talkingClip = createVRMAnimationClip(talkingAnimGltf.userData.vrmAnimations[0], currentVrm);
            talkingAction = mixer.clipAction(talkingClip);
            talkingAction.setLoop(THREE.LoopPingPong, Infinity);
        }
        if (wavingAnimGltf) {
            const wavingClip = createVRMAnimationClip(wavingAnimGltf.userData.vrmAnimations[0], currentVrm);
            if (wavingClip.duration > 1.0) {
                wavingClip.duration -= 0.9;
            }
            wavingAction = mixer.clipAction(wavingClip);
            wavingAction.setLoop(THREE.LoopOnce, 0);
            wavingAction.clampWhenFinished = true;
            wavingDuration = wavingClip.duration || 0;
        } else {
            wavingAction = null; wavingDuration = 0;
        }
        
        scheduleIdle1();
    }

    async function initializeScene() {
        animateProgressBar();
        try {
            await loadVRM('./models/model.vrm');
            await loadAnimations();
            
            updateProgress(1, 'Finished!');

            loadingOverlay.classList.add('hidden');
            setTimeout(() => {
                loadingOverlay.style.display = 'none';
                cancelAnimationFrame(animationFrameId);
                connectWebSocket();
                if (wavingAction) {
                    setAnimation(wavingAction);
                    
                    activeEmotionName = 'happy';
                    activeEmotionWeight = 1.0;
                    
                    setTimeout(() => {
                        const fadeDuration = 500;
                        const startTime = performance.now();

                        function fadeOutStep() {
                            const elapsedTime = performance.now() - startTime;
                            const progress = Math.min(elapsedTime / fadeDuration, 1.0);
                            
                            activeEmotionWeight = 1.0 - progress;

                            if (progress < 1.0) {
                                requestAnimationFrame(fadeOutStep);
                            } else {
                                activeEmotionName = 'relaxed';
                                activeEmotionWeight = 1.0;
                            }
                        }
                        
                        requestAnimationFrame(fadeOutStep);

                    }, 2500); 
                }
            }, 750);

        } catch (error) {
            console.error("Initialization failed:", error);
            updateProgress(targetProgress, "Failed to initialize. Please refresh.");
            cancelAnimationFrame(animationFrameId);
        }
    }
    initializeScene();

/* =========================================================
   16. MOBILE VIEWPORT HELPER
   ========================================================= */
    function setRealViewportHeight() {
        const vh = window.innerHeight * 0.01;
        document.documentElement.style.setProperty('--vh', `${vh}px`);
    }

    setRealViewportHeight();
    window.addEventListener('resize', setRealViewportHeight);
    window.addEventListener('orientationchange', setRealViewportHeight);
    chatInput.addEventListener('focus', setRealViewportHeight);
    chatInput.addEventListener('blur', setRealViewportHeight);

/* =========================================================
   17. SCRIPT END
   ========================================================= */
}); // end DOMContentLoaded
