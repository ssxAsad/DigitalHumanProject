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
    let mixer = null;
    const clock = new THREE.Clock();
    let idleAction = null;
    let idle1Action = null;
    let talkingAction = null;
    let textingIntroAction = null;
    let thinkingIntroAction = null;
    let thinkingLoopAction = null;
    let textingLoopAction = null;
    let wavingAction = null;
    let lastPlayedAction = null;
    let idle1Duration = 0;
    let wavingDuration = 0;
    const VISEME_MAPPING = { 'a': 'aa', 'e': 'ee', 'i': 'ih', 'o': 'oh', 'u': 'ou' };

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    function safeRemoveVrmFromScene(vrm) {
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
    }

    function setupSideGlances(vrm) {
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
    }

    function scheduleIdle1() {
        const nextTime = Math.floor(Math.random() * 5000) + 10000;
        setTimeout(() => {
            const canSwitch = lastPlayedAction === idleAction && !isTalking && !isTextOutputOn;
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
        const fadeDuration = 0.35; 

        if (actionToFadeOut) {
            actionToPlay.reset().play();
            actionToFadeOut.crossFadeTo(actionToPlay, fadeDuration, true);
        } else {
            actionToPlay.reset().fadeIn(fadeDuration).play();
        }
        
        if (actionToPlay === idleAction) idleAction.setEffectiveTimeScale(0.8);
        else if (actionToPlay === textingIntroAction) textingIntroAction.setEffectiveTimeScale(0.8);
        else if (actionToPlay === textingLoopAction) textingLoopAction.setEffectiveTimeScale(0.8);
        else { 
            actionToPlay.setEffectiveTimeScale(1.0);
        }
        
        lastPlayedAction = actionToPlay;
    }

    function isGreetingPrompt(userText) {
        const greetingRegex = /\b(hi|hello|hey|greetings|yo)\b/i;
        return greetingRegex.test(userText);
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
   10. RENDER / UPDATE LOOP (drives visemes + animations)
   ========================================================= */
    function updateVisemesSafe() {
        if (!currentVrm || !currentVrm.expressionManager) return;

        if (!isTalking) {
            if (lastAppliedViseme.shape !== 'sil') {
                const lastMappedShape = VISEME_MAPPING[lastAppliedViseme.shape] || lastAppliedViseme.shape;
                currentVrm.expressionManager.setValue(lastMappedShape, 0);
                lastAppliedViseme = { shape: 'sil', time: 0 };
            }
            return;
        }

        if (!audioContext || audioPlaybackStartTime === 0) return;
        const elapsedTime = audioContext.currentTime - audioPlaybackStartTime;
        let newViseme = lastAppliedViseme;
        while (visemeQueue.length > 0 && elapsedTime >= visemeQueue[0].time) {
            newViseme = visemeQueue.shift();
        }

        if (newViseme.shape === lastAppliedViseme.shape) return;

        const oldMappedShape = VISEME_MAPPING[lastAppliedViseme.shape] || lastAppliedViseme.shape;
        if (oldMappedShape !== 'sil') {
            currentVrm.expressionManager.setValue(oldMappedShape, 0);
        }
        const newMappedShape = VISEME_MAPPING[newViseme.shape] || newViseme.shape;
        if (newMappedShape !== 'sil') {
            currentVrm.expressionManager.setValue(newMappedShape, 1.0);
        }
        lastAppliedViseme = newViseme;
    }

    function animate() {
        requestAnimationFrame(animate);
        const delta = clock.getDelta();
        
        if (mixer) mixer.update(delta);

        if (currentVrm && currentVrm.expressionManager) {
            ALLOWED_EXPRESSIONS_FOR_AI.forEach(name => {
                if (name !== activeEmotionName) {
                    currentVrm.expressionManager.setValue(name, 0);
                }
            });

            if (isTalking) {
                applyEmotionNonMouth(currentVrm, activeEmotionName, activeEmotionWeight);
                updateVisemesSafe();
            } else {
                updateVisemesSafe(); 
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
   12. PLAY RESPONSE & EXPRESSIONS (chunked TTS playback)
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
                if(lastPlayedAction === talkingAction) {
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

                    for (const chunkText of chunks) {
                        const ttsResponse = await fetch("/.netlify/functions/elevenlabs", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                voiceId,
                                payload: { text: chunkText }
                            })
                        });

                        if (!ttsResponse.ok) throw new Error(await ttsResponse.text().catch(()=>'TTS Error'));
                        
                        const audioData = await ttsResponse.arrayBuffer();
                        const decodedBuffer = await audioContext.decodeAudioData(audioData);
                        audioBuffers.push(decodedBuffer);
                    }

                    if (audioBuffers.length === 0) {
                        endPlayback();
                        return;
                    }

                    if (isGreeting && wavingAction) {
                        setAnimation(wavingAction);
                    } else {
                        setAnimation(talkingAction);
                    }

                    let currentBufferIndex = 0;
                    function playNextBuffer() {
                        if (currentBufferIndex >= audioBuffers.length) {
                            endPlayback();
                            return;
                        }
                        const buffer = audioBuffers[currentBufferIndex];
                        const source = audioContext.createBufferSource();
                        source.buffer = buffer;
                        source.connect(audioContext.destination);
                        source.onended = playNextBuffer;
                        source.start();
                        currentBufferIndex++;
                    }
                    playNextBuffer();

                } catch (err) {
                    console.error("Error playing response:", err);
                    endPlayback();
                }
            })();
        });
    }

/* =========================================================
   13. CHAT / API FLOW (Gemini Online Only)
   ========================================================= */
    async function handleSendMessage() {
        const prompt = chatInput.value.trim();
        if (!prompt || !currentVrm || isAwaitingResponse) return;

        chatInput.value = '';

        isAwaitingResponse = true;
        chatInput.disabled = true;
        sendButton.disabled = true;

        initAudioContext();

        hideBubble(textBubble);
        showBubble(thinkingBubble, `<span class="fire-text">Thinking...</span>`, Infinity);
        setAnimation(thinkingIntroAction);

        const isGreeting = isGreetingPrompt(prompt);

        try {
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

        } catch (error) {
            console.error("--- Error in Chat Flow ---", error);
            hideBubble(thinkingBubble);
            showBubble(textBubble, `<span class="fire-text">${error.message}</span>`, 6000);
        } finally {
            isAwaitingResponse = false;
            chatInput.disabled = false;
            sendButton.disabled = false;
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
                            reject(new Error('Loaded GLTF did not contain a VRM object in userData.')); return;
                        }
                        safeRemoveVrmFromScene(currentVrm);
                        currentVrm = vrm;
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
        
        mixer.addEventListener('finished', (event) => {
            const finishedAction = event.action;
            if (finishedAction === textingIntroAction) {
               thinkingLoopAction.reset().play();
               thinkingIntroAction.crossFadeTo(thinkingLoopAction, 0.35, true);
               lastPlayedAction = thinkingLoopAction; // Keep the state updated
            }
            else if (finishedAction === thinkingIntroAction) {
               setAnimation(thinkingLoopAction);
            }
            else if (finishedAction === wavingAction) {
                if (isTalking) {
                    setAnimation(talkingAction);
                } else {
                    setAnimation(idleAction);
                }
            }
        });

        const animationFiles = [
            './animations/idle.vrma', './animations/idle1.vrma', './animations/talking.vrma',
            './animations/waving.vrma', './animations/texting.vrma', './animations/thinking.vrma'
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

        const [
            idleAnimGltf, idle1AnimGltf, talkingAnimGltf, wavingAnimGltf, textingAnimGltf, thinkingAnimGltf
        ] = await Promise.all([
            loadFile(animationFiles[0], 'Idle', 0),
            loadFile(animationFiles[1], 'Idle Variant', 1),
            loadFile(animationFiles[2], 'Talking', 2),
            loadFile(animationFiles[3], 'Waving', 3),
            loadFile(animationFiles[4], 'Texting', 4),
            loadFile(animationFiles[5], 'Thinking', 5)
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
        if (thinkingAnimGltf) {
           let originalClip = createVRMAnimationClip(thinkingAnimGltf.userData.vrmAnimations[0], currentVrm);
           const fps = 60;
           // Split the clip: 0-25% for intro, 25-100% for loop
           const introEndFrame = Math.floor(originalClip.duration * 0.40 * fps);
           const clipEndFrame = Math.floor(originalClip.duration * fps);
           const introClip = AnimationUtils.subclip(originalClip, 'thinkingIntro', 0, introEndFrame, fps);
           const loopClip = AnimationUtils.subclip(originalClip, 'thinkingLoop', introEndFrame, clipEndFrame, fps);
           // Setup the intro action to play once
           thinkingIntroAction = mixer.clipAction(introClip);
           thinkingIntroAction.setLoop(THREE.LoopOnce).clampWhenFinished = true;
           // Setup the loop action to play in a ping-pong style
           thinkingLoopAction = mixer.clipAction(loopClip);
           thinkingLoopAction.setLoop(THREE.LoopPingPong);
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
        if (textingAnimGltf) {
            let originalClip = createVRMAnimationClip(textingAnimGltf.userData.vrmAnimations[0], currentVrm);
            originalClip.tracks = originalClip.tracks.filter(track => !track.name.includes('morphTargetInfluences'));
            const fps = 30;
            const introEndFrame = Math.floor(originalClip.duration * 0.25 * fps);
            const clipEndFrame = Math.floor(originalClip.duration * fps);
            const introClip = AnimationUtils.subclip(originalClip, 'textingIntro', 0, introEndFrame, fps);
            const loopClip = AnimationUtils.subclip(originalClip, 'textingLoop', introEndFrame, clipEndFrame, fps);
            textingIntroAction = mixer.clipAction(introClip);
            textingIntroAction.setLoop(THREE.LoopOnce).clampWhenFinished = true;
            textingLoopAction = mixer.clipAction(loopClip);
            textingLoopAction.setLoop(THREE.LoopPingPong).setEffectiveTimeScale(0.8);
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
                if (wavingAction) {
                    setAnimation(wavingAction);
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

/* =========================================================
   17. SCRIPT END
   ========================================================= */
}); // end DOMContentLoaded






