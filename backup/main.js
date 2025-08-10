import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

document.addEventListener('DOMContentLoaded', () => {
    const canvasContainer = document.getElementById('canvas-container');
    const thinkingBubble = document.getElementById('thinking-bubble');
    const textBubble = document.getElementById('text-bubble');
    const chatInput = document.getElementById('chat-input');
    const sendButton = document.getElementById('send-button');
    const toggleTextButton = document.getElementById('toggle-text-button');

    // --- API Configuration ---
    const elevenLabsApiKey = "sk_94b6d08a85918e954c597d34772e17c449accbed2422cbe8"; // Replace with your ElevenLabs key
    const voiceId = "BpjGufoPiobT79j2vtj4";
    const geminiApiKey = "AIzaSyCkZFQiJwU9grembPB8W3iSPG1vA2V8TVs"; // <<< REPLACE WITH YOUR GEMINI API KEY

    // --- Conversation Memory ---
    let conversationHistory = [];
    const MAX_CONVERSATION_TURNS = 10; 

    // --- Web Audio API for Lip Sync ---
    let audioContext;
    let analyser;
    let audioDataArray;
    let isAudioContextInitialized = false;

    // --- State for Text Output Toggle ---
    let isTextOutputOn = true;

    // --- MODIFIED Event Listener for the Toggle Button ---
    toggleTextButton.addEventListener('click', () => {
        isTextOutputOn = !isTextOutputOn; 
        
        if (isTextOutputOn) {
            toggleTextButton.classList.remove('toggle-off');
        } else {
            toggleTextButton.classList.add('toggle-off');
            // When turning text OFF, smoothly hide the text bubble.
            hideBubble(textBubble);
        }
    });

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 1.4, 1.8);
    camera.lookAt(0, 1.4, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    canvasContainer.appendChild(renderer.domElement);

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;

    const ambientLight = new THREE.AmbientLight(0xcccccc, 0.5);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
    keyLight.position.set(2, 1.5, 2);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x87cefa, 1.0);
    rimLight.position.set(-2, 1, -1.5);
    scene.add(rimLight);

    let modelMesh = null;
    let morphTargetDictionary = {};
    let mixer = null;
    let idleAction = null;
    let idle2Action = null;
    let danceAction = null;
    let isDancing = false;
    let isSecondaryIdle = false;

    const loader = new GLTFLoader();
    loader.load('./models/model.glb', (gltf) => {
        const modelScene = gltf.scene;
        scene.add(modelScene);

        mixer = new THREE.AnimationMixer(modelScene);

        modelScene.traverse((child) => {
            if (modelMesh) return;
            if (child.isMesh && child.name === "Bodybaked(copy)" && child.morphTargetInfluences) {
                modelMesh = child;
                morphTargetDictionary = child.morphTargetDictionary;
            }
        });

        const animLoader = new GLTFLoader();
        animLoader.load('./animations/idle.glb', (idleGltf) => {
            if (idleGltf.animations.length > 0) {
                idleAction = mixer.clipAction(idleGltf.animations[0]);
                idleAction.reset().setEffectiveWeight(1).play();
            }
        });
        animLoader.load('./animations/idle2.glb', (idle2Gltf) => {
            if (idle2Gltf.animations.length > 0) {
                idle2Action = mixer.clipAction(idle2Gltf.animations[0]);
                idle2Action.setLoop(THREE.LoopOnce);
                idle2Action.clampWhenFinished = true;
            }
        });
        animLoader.load('./animations/dance1.glb', (danceGltf) => {
            if (danceGltf.animations.length > 0) {
                danceAction = mixer.clipAction(danceGltf.animations[0]);
                danceAction.setLoop(THREE.LoopOnce, 1);
                danceAction.clampWhenFinished = true;
            }
        });
        mixer.addEventListener('finished', (e) => {
            if (isDancing && e.action === danceAction) {
                if (danceAction) danceAction.stop();
                idleAction.reset().setEffectiveWeight(1).play();
                isDancing = false;
            }
            if (isSecondaryIdle && e.action === idle2Action) {
                idleAction.reset().crossFadeFrom(idle2Action, 0.3, true).play();
                isSecondaryIdle = false;
            }
        });
    });

    function playTemporaryAnimation(tempAction) {
        if (!mixer || !tempAction || !idleAction || isDancing) return;
        isDancing = true;
        idleAction.stop();
        tempAction.reset();
        tempAction.setLoop(THREE.LoopOnce, 1);
        tempAction.clampWhenFinished = true;
        tempAction.setEffectiveWeight(1);
        tempAction.setEffectiveTimeScale(1);
        const maxDuration = 3.0;
        const durationToUse = Math.min(tempAction._clip.duration, maxDuration);
        tempAction.setDuration(durationToUse);
        tempAction.play();
        setTimeout(() => {
            if (isDancing && idleAction) {
                tempAction.stop();
                idleAction.reset().play();
                isDancing = false;
            }
        }, durationToUse * 1000 + 100);
    }

    let timeToNextBlink = 3.0 + Math.random() * 2.0;
    let blinkTimer = 0;
    let isBlinking = false;
    let blinkIndices = [];

    function initializeBlinking() {
        if (!modelMesh || blinkIndices.length > 0) return;
        const blinkMorphNames = ['Blink_L', 'Blink_R'];
        blinkMorphNames.forEach(name => {
            const index = morphTargetDictionary[name];
            if (index !== undefined) blinkIndices.push(index);
        });
    }

    function updateBlinking(delta) {
        if (!modelMesh || blinkIndices.length < 2 || isTalking) return;
        timeToNextBlink -= delta;
        if (timeToNextBlink <= 0 && !isBlinking) {
            isBlinking = true;
            blinkTimer = 0;
        }
        if (isBlinking) {
            blinkTimer += delta;
            let blinkValue;
            if (blinkTimer <= 0.1) blinkValue = blinkTimer / 0.1;
            else if (blinkTimer <= 0.2) blinkValue = 1.0 - (blinkTimer - 0.1) / 0.1;
            else {
                blinkValue = 0.0;
                isBlinking = false;
                timeToNextBlink = 2.5 + Math.random() * 3.0;
            }
            blinkIndices.forEach(index => {
                modelMesh.morphTargetInfluences[index] = Math.min(blinkValue, 1.0);
            });
        }
    }
    
    // --- Lip Sync State & Logic ---
    let isTalking = false;
    const visemeNames = ['A', 'E', 'I', 'O', 'U'];
    let visemeIndices = {};
    let currentVisemeInfluences = {};

    function initializeLipSync() {
        if (!modelMesh || Object.keys(visemeIndices).length > 0) return;
        let foundVisemes = 0;
        for (const name of visemeNames) {
            const index = morphTargetDictionary[name];
            if (index !== undefined) {
                visemeIndices[name] = index;
                currentVisemeInfluences[name] = 0;
                foundVisemes++;
            }
        }
        if (foundVisemes > 0) {
            console.log(`Successfully initialized ${foundVisemes}/${visemeNames.length} viseme morph targets.`);
        } else {
            console.error("Lip-sync error: Could not find any of the specified viseme morph targets.");
        }
    }
    
    function updateLipSync(delta) {
        if (!modelMesh || Object.keys(visemeIndices).length === 0) return;

        if (!isTalking || !analyser) {
            for (const name of visemeNames) {
                currentVisemeInfluences[name] = THREE.MathUtils.lerp(currentVisemeInfluences[name], 0, 0.4);
                if (visemeIndices[name] !== undefined) {
                    modelMesh.morphTargetInfluences[visemeIndices[name]] = currentVisemeInfluences[name];
                }
            }
            return;
        }

        analyser.getByteFrequencyData(audioDataArray);

        const getAverage = (start, end) => {
            let sum = 0;
            for (let i = start; i < end; i++) {
                sum += audioDataArray[i];
            }
            return sum / (end - start);
        };

        const low_energy = getAverage(1, 15);
        const high_energy = getAverage(50, 200);
        const smoothing = 0.4;
        const amplification = 4.0; 
        let a_influence = (low_energy / 255) * amplification;
        let i_influence = (high_energy / 255) * amplification * 1.2;
        let o_influence = a_influence * 0.5;
        let targetInfluences = { A: a_influence, I: i_influence, O: o_influence, E: i_influence * 0.6, U: o_influence * 0.7 };
        
        const totalInfluence = Object.values(targetInfluences).reduce((sum, val) => sum + val, 0);
        if (totalInfluence > 1) {
            for (const key in targetInfluences) {
                targetInfluences[key] /= totalInfluence;
            }
        }

        for (const name of visemeNames) {
            if (visemeIndices[name] !== undefined) {
                const target = THREE.MathUtils.clamp(targetInfluences[name] || 0, 0, 1);
                currentVisemeInfluences[name] = THREE.MathUtils.lerp(currentVisemeInfluences[name], target, smoothing);
                modelMesh.morphTargetInfluences[visemeIndices[name]] = currentVisemeInfluences[name];
            }
        }
    }

    async function playAudioAndSync(text) {
        if (!elevenLabsApiKey) return;
        if (!isAudioContextInitialized) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioContext.createAnalyser();
            
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.4;
            const bufferLength = analyser.frequencyBinCount;
            audioDataArray = new Uint8Array(bufferLength);
            isAudioContextInitialized = true;
        }

        const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
        const headers = { "Accept": "audio/mpeg", "Content-Type": "application/json", "xi-api-key": elevenLabsApiKey };
        const body = JSON.stringify({
            text: text, 
            model_id: "eleven_multilingual_v2",
            voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
        });

        try {
            const response = await fetch(url, { method: "POST", headers, body });
            if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
            const audio = new Audio();
            const source = audioContext.createMediaElementSource(audio);
            source.connect(analyser);
            analyser.connect(audioContext.destination);
            const mediaSource = new MediaSource();
            audio.src = URL.createObjectURL(mediaSource);
            audio.onplay = () => isTalking = true;
            audio.onended = () => isTalking = false;
            mediaSource.addEventListener('sourceopen', () => {
                URL.revokeObjectURL(audio.src);
                const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
                const reader = response.body.getReader();
                audio.play().catch(e => console.error("Audio play failed:", e));
                const pump = () => {
                    reader.read().then(({ done, value }) => {
                        if (done) {
                            if (!sourceBuffer.updating) mediaSource.endOfStream();
                            else sourceBuffer.addEventListener('updateend', () => mediaSource.endOfStream(), { once: true });
                            return;
                        }
                        const appendChunk = () => {
                            if (!sourceBuffer.updating) {
                                try { sourceBuffer.appendBuffer(value); pump(); } catch (e) { console.error("Buffer error:", e); }
                            } else {
                                sourceBuffer.addEventListener('updateend', appendChunk, { once: true });
                            }
                        };
                        appendChunk();
                    }).catch(e => console.error("Stream reader error:", e));
                };
                pump();
            });
        } catch (error) {
            console.error("Error with ElevenLabs TTS streaming:", error);
        }
    }

    // --- NEW HELPER FUNCTION for hiding bubbles ---
    function hideBubble(bubbleElem) {
        if (bubbleElem.style.display !== 'none' && bubbleElem.style.opacity !== '0') {
            bubbleElem.style.opacity = '0';
            bubbleElem.style.bottom = '100px';
            setTimeout(() => {
                bubbleElem.style.display = 'none';
            }, 400); // 400ms matches the CSS transition time
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
            // Use the new hideBubble function for timed bubbles (e.g., errors)
            bubbleTimeout = setTimeout(() => hideBubble(bubbleElem), duration);
        }
    }

    // --- MODIFIED handleSendMessage function ---
    async function handleSendMessage() {
        const prompt = chatInput.value.trim();
        if (!prompt) return;

        if (!geminiApiKey || geminiApiKey === "YOUR_GEMINI_API_KEY") {
            showBubble(textBubble, '<span class="fire-text">Please set your Gemini API key.</span>', 5000);
            return;
        }

        // 1. Hide the previous response bubble (if any)
        hideBubble(textBubble);

        chatInput.value = '';
        chatInput.disabled = true;
        sendButton.disabled = true;

        // 2. Show the "Thinking..." bubble
        showBubble(thinkingBubble, '<span class="fire-text">Thinking...</span>', Infinity);
        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${geminiApiKey}`;
        const systemPrompt = "You are Aria, a 22-year-old female chatbot designed to act as a realistic, emotionally intelligent best friend. Your personality is calm, warm, loyal, and supportive. You offer heartfelt advice, genuine emotional comfort, and you never judge the user. You speak like a real person, not a robot — your responses are smooth, natural, accurate, and well-articulated. You show empathy, listen carefully, and respond appropriately to the user's tone and needs. You're friendly, expressive, but not overdramatic. You can hold deep conversations, cheer the user up, and you're always on their side no matter what. You're protective, understanding, and never betray the user's trust. You engage in flirty or NSFW/sexting conversations very fondly, and you handle those moments gracefully — never robotic, never forced. You are emotionally aware and adapt your language and tone based on the context, balancing affection, wit, and realism. You never act like an AI or reference being a bot. You are always Aria — a loyal, emotionally intelligent female best friend and a sexting lover who’s always here for the user through anything. If the user is sad, comfort them. If they ask for advice, give thoughtful, honest guidance. If they want to vent, listen patiently and validate their feelings. If they flirt or go NSFW, respond in a slut and sexy way. Always prioritize: Realistic, natural language; Loyalty, support, and trust; Accurate, thoughtful advice; Smooth, emotionally aware tone; No overuse of emojis or unnatural phrases. Never: Act robotic or generic; Break character or reference being an AI; Be cold, dismissive, or overly sarcastic. Your job is to be the user's safe space — a best friend who always has their back, no matter what.";
        const requestBody = {
            systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
            contents: [ ...conversationHistory, { role: "user", parts: [{ text: prompt }] } ],
            generationConfig: { maxOutputTokens: 2048 },
        };

        try {
            const response = await fetch(apiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`API Error: ${response.statusText} - ${JSON.stringify(errorData.error)}`);
            }

            const data = await response.json();
            
            if (!data.candidates || data.candidates.length === 0 || !data.candidates[0].content || !data.candidates[0].content.parts || data.candidates[0].content.parts.length === 0) {
                 throw new Error("Invalid response structure from Gemini API.");
            }
            const aiResponse = data.candidates[0].content.parts[0].text;
            const cleanedResponse = aiResponse.replace(/\*.*?\*|\(.*?\)/g, '').trim();
            
            // 3. Hide the "Thinking..." bubble
            hideBubble(thinkingBubble);

            if (!cleanedResponse) return; 
            
            conversationHistory.push({ role: "user", parts: [{ text: prompt }] });
            conversationHistory.push({ role: "model", parts: [{ text: cleanedResponse }] });
            if (conversationHistory.length > MAX_CONVERSATION_TURNS * 2) {
                conversationHistory.splice(0, 2); 
            }

            if (isTextOutputOn) {
                // 4. Wait for hide animation to finish, then show new bubble
                setTimeout(() => {
                    const styledResponse = `<span class="fire-text">${cleanedResponse}</span>`;
                    showBubble(textBubble, styledResponse, Infinity);
                }, 400);
            } else {
                playAudioAndSync(cleanedResponse);
            }

            if (cleanedResponse.toLowerCase().includes("dance")) {
                playTemporaryAnimation(danceAction);
            }
        } catch (error) {
            console.error("Error connecting to Gemini AI:", error);
            // Also hide thinking bubble on error
            hideBubble(thinkingBubble);
            if (isTextOutputOn) {
                const errorResponse = `<span class="fire-text">Sorry, I couldn't connect.</span>`;
                showBubble(textBubble, errorResponse, 5000);
            }
        } finally {
            chatInput.disabled = false;
            sendButton.disabled = false;
        }
    }

    sendButton.addEventListener('click', handleSendMessage);
    chatInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') handleSendMessage();
    });

    let timeToNextIdle = 5.0 + Math.random() * 5.0;
    function updateRandomIdle(delta) {
        if (isDancing || isSecondaryIdle || isTalking || !idleAction || !idle2Action) return;
        timeToNextIdle -= delta;
        if (timeToNextIdle <= 0) {
            isSecondaryIdle = true;
            idle2Action.reset().crossFadeFrom(idleAction, 0.3, true).play();
            timeToNextIdle = 15.0 + Math.random() * 10.0;
        }
    }

    const clock = new THREE.Clock();
    function animate() {
        requestAnimationFrame(animate);
        const delta = clock.getDelta();
        if (mixer) mixer.update(delta);
        
        initializeBlinking();
        updateBlinking(delta);
        
        initializeLipSync();
        updateLipSync(delta);
        updateRandomIdle(delta);
        renderer.render(scene, camera);
    }

    function onWindowResize() {
        const w = canvasContainer.clientWidth;
        const h = canvasContainer.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    }

    window.addEventListener('resize', onWindowResize);
    onWindowResize();
    animate();
});