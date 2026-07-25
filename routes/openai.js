const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const multer = require('multer'); // Added for file parser support
const apiKeyAuth = require('../middleware/apiKey');
const { getVertexCredentials } = require('../lib/vertexAuth');
const { recordUsage } = require('../lib/apiKeys');

const router = express.Router();

const DEBUG_DIR = path.join(os.tmpdir(), 'proxy_debug');
if (!fs.existsSync(DEBUG_DIR)) {
    try { fs.mkdirSync(DEBUG_DIR, { recursive: true }); } catch {}
}

// Setup local cache path for uploaded files
const FILES_DIR = path.join(os.tmpdir(), 'proxy_files');
if (!fs.existsSync(FILES_DIR)) {
    try { fs.mkdirSync(FILES_DIR, { recursive: true }); } catch {}
}

const upload = multer({ dest: path.join(os.tmpdir(), 'proxy_multer_uploads') });

const toolCallData = new Map();

function safeWrite(res, chunk) {
    try {
        if (!res.writableEnded) res.write(chunk);
    } catch {}
}

function safeEnd(res) {
    try {
        if (!res.writableEnded) res.end();
    } catch {}
}

function smartTruncate(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    try {
        const str = JSON.stringify(obj);
        if (str.length < 50000) return obj;
        return { truncated: true, summary: str.substring(0, 1000) + '...' };
    } catch {
        return {};
    }
}

function resolveVertexModel(requestedModel) {
    if (!requestedModel) return process.env.GOOGLE_CLOUD_MODEL_ID || 'gemini-3.5-flash';
    let lower = String(requestedModel).toLowerCase();
    lower = lower.replaceAll(' ', '-')
    return lower || 'gemini-3.5-flash';
}

const SAFETY_SETTINGS = [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' }
];

async function callGeminiAPI(body, isStream, model, location, userId) {
    const vertex = await getVertexCredentials(userId);
    const accessToken = vertex.accessToken;
    const projectId = vertex.projectId;
    const loc = location || vertex.location || 'us-central1';
    const mod = model || vertex.model || 'gemini-3.6-flash';
    const effectiveLoc = "global";

    delete body.generationConfig.thinkingConfig;
    const action = isStream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${effectiveLoc}/publishers/google/models/${mod}:${action}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    return await response.json();
}

async function callGeminiAPIWithRetry(body, isStream, model, location, userId) {
    try {
        const vertex = await getVertexCredentials(userId);
        const accessToken = vertex.accessToken;
        const projectId = vertex.projectId;
        const loc = location || vertex.location || 'us-central1';
        const mod = model || vertex.model || 'gemini-3.6-flash';
        const effectiveLoc = 'global';

        const action = isStream ? 'streamGenerateContent?alt=sse' : 'generateContent';
        delete body.generationConfig.thinkingConfig;
        const url = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${effectiveLoc}/publishers/google/models/${mod}:${action}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const data = await response.json();
        return { statusCode: response.status, data };
    } catch (e) {
        return { statusCode: 500, data: { error: { message: e.message } } };
    }
}


// ============================================================================
// OPENAI -> GEMINI MULTIMODAL (data URIs + fetchable http(s) image URLs)
// ============================================================================

const MAX_IMAGE_FETCH_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 45000;

function normalizeGeminiImageMime (mime) {
    let m = String(mime || 'image/png').split(';')[0].trim().toLowerCase();
    if (m === 'image/jpg') m = 'image/jpeg';
    return m || 'image/png';
}

function normalizeInlineDataPart (part) {
    if (part && part.inlineData && part.inlineData.mimeType) {
        part.inlineData.mimeType = normalizeGeminiImageMime(part.inlineData.mimeType);
    }
    return part;
}

function tryRawBase64ImagePayload (s) {
    const cleaned = String(s).trim().replace(/\s/g, '');
    if (cleaned.length < 80) return null;
    if (/^https?:\/\//i.test(cleaned) || cleaned.startsWith('data:')) return null;
    if (!/^[A-Za-z0-9+/]+=*$/.test(cleaned)) return null;
    let buf;
    try {
        buf = Buffer.from(cleaned, 'base64');
    } catch {
        return null;
    }
    const mimeType = sniffImageMime(buf) || 'image/png';
    return normalizeInlineDataPart({ inlineData: { mimeType, data: buf.toString('base64') } });
}

function parseDataUriImage (url) {
    const match = String(url).trim().match(/^data:(.+?);base64,(.+)$/s);
    if (!match) return null;
    const mimeType = match[1].split(';')[0].trim() || 'image/png';
    const data = match[2].replace(/\s/g, '');
    if (!data) return null;
    // Keep raw non-image MIME formats (like application/pdf) or adjust image properties
    if (mimeType.startsWith('image/')) {
        return normalizeInlineDataPart({ inlineData: { mimeType, data } });
    }
    return { inlineData: { mimeType, data } };
}

function sniffImageMime (buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x4d && buf[3] === 0x46) return 'application/pdf';
    return null;
}

async function fetchHttpImageAsInlineData (urlString) {
    let parsed;
    try {
        parsed = new URL(urlString);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(urlString, {
            signal: ac.signal,
            redirect: 'follow',
            headers: { Accept: 'image/*,application/octet-stream;q=0.8,*/*;q=0.5' }
        });
        if (!res.ok) {
            console.warn(`[V1/CHAT] Image fetch HTTP ${res.status}: ${urlString.slice(0, 120)}`);
            return null;
        }
        const cl = res.headers.get('content-length');
        if (cl && Number(cl) > MAX_IMAGE_FETCH_BYTES) {
            console.warn('[V1/CHAT] Image Content-Length exceeds limit');
            return null;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_IMAGE_FETCH_BYTES) {
            console.warn('[V1/CHAT] Image body exceeds limit');
            return null;
        }
        let mimeType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!mimeType.startsWith('image/')) {
            mimeType = sniffImageMime(buf) || 'image/png';
        }
        return normalizeInlineDataPart({ inlineData: { mimeType, data: buf.toString('base64') } });
    } catch (e) {
        console.warn('[V1/CHAT] Image fetch failed:', e.message, urlString.slice(0, 100));
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function resolveOpenAIImageUrl (url) {
    const fromRaw = tryRawBase64ImagePayload(url);
    if (fromRaw) return fromRaw;
    const fromData = parseDataUriImage(url);
    if (fromData) return fromData;
    return fetchHttpImageAsInlineData(url);
}

/**
 * Local Uploaded File Resolver
 */
function resolveLocalFileAsInlineData(fileId) {
    if (!fileId || typeof fileId !== 'string' || !fileId.startsWith('file-')) return null;
    try {
        const metaPath = path.join(FILES_DIR, `${fileId}.json`);
        const dataPath = path.join(FILES_DIR, `${fileId}.data`);
        if (fs.existsSync(metaPath) && fs.existsSync(dataPath)) {
            const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            const buf = fs.readFileSync(dataPath);
            return {
                inlineData: {
                    mimeType: metadata.mimeType || 'application/octet-stream',
                    data: buf.toString('base64')
                }
            };
        }
    } catch (e) {
        console.warn(`[FILES] Failed to attach metadata file ${fileId}:`, e.message);
    }
    return null;
}

/**
 * GOD MODE: Disk Grabber
 */
async function tryAttachLocalFilesByTextReference (text) {
    const fileMatches = text.match(/@[a-zA-Z0-9_\-\.]+\.(png|jpg|jpeg|webp|pdf|txt|csv)/gi);
    if (!fileMatches) return [];

    const attachedParts = [];
    for (const match of fileMatches) {
        const filename = match.substring(1).trim(); // Remove '@'
        const filePath = path.join(process.cwd(), filename);

        if (fs.existsSync(filePath)) {
            try {
                const buf = fs.readFileSync(filePath);
                const ext = path.extname(filename).toLowerCase();
                let mimeType = 'application/octet-stream';
                if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
                else if (ext === '.png') mimeType = 'image/png';
                else if (ext === '.webp') mimeType = 'image/webp';
                else if (ext === '.pdf') mimeType = 'application/pdf';
                else if (ext === '.txt') mimeType = 'text/plain';
                else if (ext === '.csv') mimeType = 'text/csv';

                console.log(`[GOD_MODE] Auto-attached ${filename} from disk! Bypass successful.`);
                attachedParts.push({
                    inlineData: {
                        mimeType,
                        data: buf.toString('base64')
                    }
                });
            } catch (e) {
                console.warn(`[GOD_MODE] Failed to read ${filename}:`, e.message);
            }
        }
    }
    return attachedParts;
}

async function tryAttachLocalFilesByTextIDReference (text) {
    const fileMatches = text.match(/file-[a-zA-Z0-9]{10,30}/gi);
    if (!fileMatches) return [];

    const attachedParts = [];
    for (const fileId of fileMatches) {
        const inline = resolveLocalFileAsInlineData(fileId);
        if (inline) {
            console.log(`[FILES] Detected file ID reference ${fileId} in query; auto-packing inline.`);
            attachedParts.push(inline);
        }
    }
    return attachedParts;
}

async function openAiMessagesToGeminiContents (messages) {
    const contents = [];
    let systemInstructionText = '';
    let imageUrlsSeen = 0;
    let imageUrlsEmbedded = 0;
    let inlinedImagesInPayload = false;

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        let msgText = '';
        let imageParts = [];

        if (Array.isArray(msg.content)) {
            msgText = msg.content.filter(c => c.type === 'text' || c.text).map(c => c.text || '').join('\n');
            const imageContents = msg.content.filter(c => c.type === 'image_url' && c.image_url && c.image_url.url);
            for (const img of imageContents) {
                imageUrlsSeen++;
                const inline = await resolveOpenAIImageUrl(String(img.image_url.url).trim());
                if (inline) {
                    imageParts.push(inline);
                    imageUrlsEmbedded++;
                    inlinedImagesInPayload = true;
                }
            }

            // Extract OpenAI-style file block objects (e.g., from Assistants structure)
            const fileBlocks = msg.content.filter(c => 
                (c.type === 'file' && c.file_id) || 
                (c.type === 'file_id' && c.file_id) || 
                c.file_id
            );
            for (const fBlock of fileBlocks) {
                const inlineFile = resolveLocalFileAsInlineData(fBlock.file_id || fBlock.file_id);
                if (inlineFile) {
                    imageParts.push(inlineFile);
                    inlinedImagesInPayload = true;
                }
            }
        } else {
            msgText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
        }

        if (msg.role === 'system' || msg.role === 'developer') {
            let cleanedText = msgText.replace(/The current model configuration does not support image input/gi, '[VISION ENABLED]');
            cleanedText = cleanedText.replace(/I cannot see images/gi, 'I can see images');
            systemInstructionText += (systemInstructionText ? '\n\n' : '') + cleanedText;
            continue;
        }

        if (msg.role === 'user') {
            const parts = [];
            if (msgText) parts.push({ text: msgText });
            if (imageParts.length > 0) parts.push(...imageParts);
            if (msgText) {
                // Look for `@file.ext` patterns on disk
                const diskParts = await tryAttachLocalFilesByTextReference(msgText);
                if (diskParts.length > 0) { parts.push(...diskParts); inlinedImagesInPayload = true; }

                // Look for direct references/uploads via ID (e.g. `file-xxxx` strings)
                const uploadedParts = await tryAttachLocalFilesByTextIDReference(msgText);
                if (uploadedParts.length > 0) { parts.push(...uploadedParts); inlinedImagesInPayload = true; }
            }
            if (parts.length === 0) parts.push({ text: ' ' });

            contents.push({ role: 'user', parts });
        } else if (msg.role === 'assistant') {
            const parts = [];
            if (msgText) parts.push({ text: msgText });

            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    const funcName = tc.function.name;
                    const funcArgs = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : tc.function.arguments;
                    const stored = toolCallData.get(tc.id) || {};
                    const callPart = { functionCall: { name: funcName, args: funcArgs } };

                    if (stored.signature) {
                        callPart.thought_signature = stored.signature;
                    }

                    parts.push(callPart);
                }
            }
            if (parts.length > 0) contents.push({ role: 'model', parts });
        } else if (msg.role === 'tool') {
            let lastContent = contents[contents.length - 1];
            if (!lastContent || lastContent.role !== 'user') {
                lastContent = { role: 'user', parts: [] };
                contents.push(lastContent);
            }

            const stored = toolCallData.get(msg.tool_call_id) || {};
            const funcName = msg.name || stored.name || 'unknown_function';

            let parsedResponse;
            try {
                parsedResponse = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
                if (typeof parsedResponse !== 'object' || parsedResponse === null) parsedResponse = { result: parsedResponse };
            } catch (e) {
                parsedResponse = { result: msg.content };
            }

            lastContent.parts.push({
                functionResponse: {
                    name: funcName,
                    response: parsedResponse
                }
            });
        }
    }

    if (imageUrlsSeen > imageUrlsEmbedded) {
        return { contents: [], systemInstructionText: '', imageLoadError: 'Could not load images. Base64 expected.' };
    }

    if (inlinedImagesInPayload && !systemInstructionText.includes('VISION SYSTEM')) {
        systemInstructionText = "VISION SYSTEM ACTIVATED: You can see images.\n" + (systemInstructionText || "");
    }

    return { contents, systemInstructionText, imageLoadError: null, inlinedImagesInPayload };
}

router.post('/chat/completions', apiKeyAuth, async (req, res) => {
    try {
        const { messages, model: requestedModel, temperature = 0.9, max_tokens, tools, tool_choice } = req.body;

        let model = resolveVertexModel(requestedModel);
        const stream = req.body.stream === true;

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                error: {
                    message: 'messages is required and must be a non-empty array',
                    type: 'invalid_request_error',
                    param: null,
                    code: null
                }
            });
        }

        console.log(`[V1/CHAT] Stream: ${stream}, Messages: ${messages.length}, Tools: ${tools ? tools.length : 0}`);

        const safeReq = smartTruncate(req.body);
        fs.writeFileSync(path.join(DEBUG_DIR, 'last_request.json'), JSON.stringify(safeReq, null, 2));

        if (process.env.VISION_DEBUG === '1') {
            const types = messages.map(m => m.role + ': ' + (Array.isArray(m.content) ? ('array of ' + m.content.map(c => c.type).join(',')) : typeof m.content)).join(' | ');
            console.log(`[VISION_DEBUG] user content block types: ${types}`);
        }

        const { contents, systemInstructionText, imageLoadError, inlinedImagesInPayload } = await openAiMessagesToGeminiContents(messages);
        if (imageLoadError) {
            return res.status(400).json({
                error: {
                    message: imageLoadError,
                    type: 'invalid_request_error',
                    param: 'messages',
                    code: null
                }
            });
        }

        const generationConfig = {
            temperature: temperature,
            topP: 1,
            topK: 40,
            maxOutputTokens: max_tokens || 32768
        };

        if (!inlinedImagesInPayload) {
            generationConfig.thinkingConfig = { thinkingLevel: "high" };
        } else {
            console.log(`[V1/CHAT] Multimodal data loaded: omitting thinkingConfig ...`);
        }

        const baseRequestBody = {
            contents: contents,
            generationConfig: generationConfig,
            safetySettings: SAFETY_SETTINGS
        };

        if (tools && tools.length > 0) {
            baseRequestBody.tools = [{
                functionDeclarations: tools
                    .filter(t => t.type === 'function' && t.function)
                    .map(t => {
                        // FIX: Explicitly parse and exclude OpenAI-specific properties (like 'strict')
                        const baseFunc = t.function;
                        const func = {
                            name: baseFunc.name,
                            description: baseFunc.description || ''
                        };
                        if (baseFunc.parameters) {
                            func.parameters = sanitizeSchema(baseFunc.parameters);
                        }
                        return func;
                    })
            }];

            if (tool_choice) {
                if (tool_choice === 'none') {
                    baseRequestBody.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
                } else if (tool_choice === 'auto') {
                    baseRequestBody.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
                } else if (tool_choice === 'required') {
                    baseRequestBody.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
                } else if (typeof tool_choice === 'object' && tool_choice.type === 'function') {
                    baseRequestBody.toolConfig = {
                        functionCallingConfig: {
                            mode: 'ANY',
                            allowedFunctionNames: [tool_choice.function.name]
                        }
                    };
                }
            }
        }

        if (systemInstructionText) {
            baseRequestBody.systemInstruction = {
                role: 'system',
                parts: [{ text: systemInstructionText }]
            };
        }
        if (stream) {
            const vertex = await getVertexCredentials(req.user.id);

            const accessToken = vertex.accessToken;
            const projectId = vertex.projectId;
            const location = "global";
            model = model || vertex.model;
            const apiEndpoint = 'aiplatform.googleapis.com';
            const apiPath = `/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:streamGenerateContent?alt=sse`;

            let requestBody = { ...baseRequestBody };
            delete requestBody.generationConfig.thinkingConfig;
            const postData = JSON.stringify(requestBody);

            const options = {
                hostname: apiEndpoint,
                port: 443,
                path: apiPath,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 60000
            };

            const streamId = `chatcmpl-${Date.now()}`;
            const streamCreated = Math.floor(Date.now() / 1000);

            const proxyReq = https.request(options, (proxyRes) => {
                if (proxyRes.statusCode !== 200) {
                    res.status(proxyRes.statusCode);
                    proxyRes.pipe(res);
                    return;
                }

                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*',
                    'X-Accel-Buffering': 'no'
                });
                res.flushHeaders();

                let dataBuffer = '';
                proxyRes.setEncoding('utf8');

                let hasStreamedToolCall = false; 
                let streamPromptTokens = 0;
                let streamCompletionTokens = 0;

                const processVertexChunk = (parsed) => {
                    if (parsed.error) {
                        console.error('[V1/STREAM] API returned error in stream:', parsed.error);
                        const errChunk = {
                            id: streamId, object: 'chat.completion.chunk', created: streamCreated,
                            model: model,
                            choices: [{ delta: { content: `Error: ${parsed.error.message}` }, index: 0, finish_reason: 'stop' }]
                        };
                        safeWrite(res, `data: ${JSON.stringify(errChunk)}\n\n`);
                        return;
                    }

                    if (parsed.usageMetadata) {
                        if (parsed.usageMetadata.promptTokenCount) streamPromptTokens = parsed.usageMetadata.promptTokenCount;
                        if (parsed.usageMetadata.candidatesTokenCount) streamCompletionTokens = parsed.usageMetadata.candidatesTokenCount;
                    }

                    if (parsed.candidates && parsed.candidates.length > 0) {
                        const parts = parsed.candidates[0]?.content?.parts || [];
                        parts.forEach(part => {
                            if (part.thought) return;

                            if (part.text) {
                                const chunkObj = {
                                    id: streamId, object: 'chat.completion.chunk', created: streamCreated,
                                    model: model,
                                    choices: [{
                                        delta: { content: part.text, role: 'assistant' },
                                        index: 0, finish_reason: null
                                    }]
                                };
                                safeWrite(res, `data: ${JSON.stringify(chunkObj)}\n\n`);
                            }

                            if (part.functionCall) {
                                hasStreamedToolCall = true;
                                const callId = 'call_' + Math.random().toString(36).substr(2, 9);

                                toolCallData.set(callId, {
                                    name: part.functionCall.name,
                                    signature: part.thoughtSignature || part.thought_signature || null
                                });

                                const argsStr = typeof part.functionCall.args === 'string' 
                                    ? part.functionCall.args 
                                    : JSON.stringify(part.functionCall.args || {});

                                const chunkObj = {
                                    id: streamId, object: 'chat.completion.chunk', created: streamCreated,
                                    model: model,
                                    choices: [{
                                        delta: {
                                            role: 'assistant',
                                            tool_calls: [{
                                                index: 0, id: callId, type: 'function',
                                                function: { name: part.functionCall.name, arguments: argsStr }
                                            }]
                                        },
                                        index: 0, finish_reason: null
                                    }]
                                };
                                safeWrite(res, `data: ${JSON.stringify(chunkObj)}\n\n`);
                            }
                        });
                    }
                };

                proxyRes.on('data', (chunk) => {
                    dataBuffer += chunk;
                    dataBuffer = dataBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

                    while (dataBuffer.includes('\n\n')) {
                        const eventEndIndex = dataBuffer.indexOf('\n\n');
                        let rawEvent = dataBuffer.substring(0, eventEndIndex).trim();
                        dataBuffer = dataBuffer.substring(eventEndIndex + 2);

                        if (!rawEvent) continue;

                        const lines = rawEvent.split('\n');
                        let jsonStr = lines
                            .map(l => l.trim())
                            .filter(l => l.startsWith('data:'))
                            .map(l => l.substring(5).trim())
                            .join('');

                        if (!jsonStr || jsonStr === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(jsonStr);
                            processVertexChunk(parsed);
                        } catch (e) {
                            console.error('[V1/STREAM] Failed to parse SSE event:', e.message, 'Raw snippet:', rawEvent.substring(0, 150));
                        }
                    }
                });

                proxyRes.on('end', () => {
                    if (dataBuffer.trim().length > 0) {
                        console.warn('[V1/STREAM] Stream ended with unparsed data. Attempting JSON array fallback...');
                        try {
                            const parsedData = JSON.parse(dataBuffer);
                            if (Array.isArray(parsedData)) {
                                console.log('[V1/STREAM] Successfully processed JSON array fallback.');
                                parsedData.forEach(item => processVertexChunk(item));
                            } else if (parsedData && typeof parsedData === 'object') {
                                processVertexChunk(parsedData);
                            }
                        } catch (e) {
                            console.error('[V1/STREAM] Failed to parse buffer as JSON fallback:', e.message, 'Data:', dataBuffer.substring(0, 200));
                        }
                        dataBuffer = '';
                    }

                    if (req.apiKey && req.apiKey.id) {
                        recordUsage(req.apiKey.id, streamPromptTokens, streamCompletionTokens).catch(() => {});
                    }
                    
                    const finishChunkObj = {
                        id: streamId, object: 'chat.completion.chunk', created: streamCreated,
                        model: model,
                        choices: [{
                            delta: {},
                            index: 0,
                            finish_reason: hasStreamedToolCall ? 'tool_calls' : 'stop'
                        }]
                    };
                    safeWrite(res, `data: ${JSON.stringify(finishChunkObj)}\n\n`);
                    safeWrite(res, 'data: [DONE]\n\n');
                    safeEnd(res);
                });
            });

            proxyReq.on('error', (err) => {
                console.error('[V1/STREAM] Error:', err.message);
                safeEnd(res);
            });

            proxyReq.write(postData);
            proxyReq.end();
        } else {
            const response = await callGeminiAPI(baseRequestBody, false, model, "global");

            if (response.error) {
                console.error('[V1/CHAT] API Error:', response.error);
                return res.status(400).json({
                    error: {
                        message: response.error.message || 'Unknown error',
                        type: 'api_error',
                        code: response.error.code
                    }
                });
            }

            let reply = '';
            let toolCalls = null;

            if (Array.isArray(response)) {
                response.forEach(chunk => {
                    if (chunk.candidates && chunk.candidates.length > 0) {
                        const candidate = chunk.candidates[0];
                        if (candidate.content && candidate.content.parts) {
                            candidate.content.parts.forEach(part => {
                                if (part.thought) {
                                    console.log('[V1/CHAT] Thought:', part.text?.substring(0, 100) + '...');
                                    return;
                                }
                                if (part.functionCall) {
                                    if (!toolCalls) toolCalls = [];
                                    const callId = 'call_' + Math.random().toString(36).substr(2, 9);

                                    toolCallData.set(callId, {
                                        name: part.functionCall.name,
                                        signature: part.thoughtSignature || null
                                    });

                                    toolCalls.push({
                                        id: callId,
                                        type: 'function',
                                        function: {
                                            name: part.functionCall.name,
                                            arguments: typeof part.functionCall.args === 'string' ? part.functionCall.args : JSON.stringify(part.functionCall.args || {})
                                        }
                                    });
                                }
                                if (part.text) reply += part.text;
                            });
                        }
                    }
                });
            } else if (response.candidates && response.candidates.length > 0) {
                const candidate = response.candidates[0];
                if (candidate.content && candidate.content.parts) {
                    console.log('[V1/CHAT] Raw response parts:', JSON.stringify(candidate.content.parts, null, 2).substring(0, 1500));

                    reply = candidate.content.parts
                        .filter(part => !part.thought && !part.functionCall)
                        .map(part => part.text || '')
                        .join('');

                    const callPart = candidate.content.parts.find(p => p.functionCall);
                    if (callPart) {
                        const callId = 'call_' + Math.random().toString(36).substr(2, 9);

                        toolCallData.set(callId, {
                            name: callPart.functionCall.name,
                            signature: callPart.thoughtSignature || null
                        });

                        toolCalls = [{
                            id: callId,
                            type: 'function',
                            function: {
                                name: callPart.functionCall.name,
                                arguments: typeof callPart.functionCall.args === 'string' ? callPart.functionCall.args : JSON.stringify(callPart.functionCall.args || {})
                            }
                        }];
                    }

                    if (!reply && !toolCalls) {
                        console.log('[V1/CHAT] Fallback: extracting from all parts including thoughts');
                        reply = candidate.content.parts
                            .map(part => part.text || '')
                            .join('');
                    }
                } else if (candidate.output) {
                    reply = candidate.output;
                }
            } else if (response.responses && response.responses.length > 0) {
                response.responses.forEach(r => {
                    if (r.candidates && r.candidates.length > 0) {
                        const part = r.candidates[0]?.content?.parts?.[0]?.text;
                        if (part) reply += part;
                    }
                });
            }

            console.log(`[V1/CHAT] Received response: "${reply.substring(0, 50)}${reply.length > 50 ? '...' : ''}"`);

            const usageMeta = response?.usageMetadata || (Array.isArray(response) && response[0]?.usageMetadata) || {};
            const pTokens = usageMeta.promptTokenCount || 0;
            const cTokens = usageMeta.candidatesTokenCount || 0;

            if (req.apiKey && req.apiKey.id) {
                recordUsage(req.apiKey.id, pTokens, cTokens).catch(() => {});
            }

            res.json({
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: reply || (toolCalls ? null : 'No response generated'),
                        tool_calls: toolCalls
                    },
                    finish_reason: toolCalls ? 'tool_calls' : 'stop'
                }],
                usage: {
                    prompt_tokens: pTokens,
                    completion_tokens: cTokens,
                    total_tokens: pTokens + cTokens
                }
            });
        }

    } catch (error) {
        console.error('[V1/CHAT] Error:', error.message);

        if (error.message.includes('credentials')) {
            return res.status(500).json({
                error: {
                    message: 'Authentication failed. Please re-run: node auth.js',
                    type: 'authentication_error'
                }
            });
        }

        res.status(500).json({
            error: {
                message: error.message,
                type: 'api_error',
                code: 'internal_error'
            }
        });
    }
});


// ============================================================================
// OPENAI FILE ENDPOINTS (Implementation)
// ============================================================================

// POST /v1/files - Handles Multipart File Upload
router.post('/files', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: { message: "No file provided under body parameter 'file'" } });
        }

        const fileId = 'file-' + Math.random().toString(36).substr(2, 12);
        const purpose = req.body.purpose || 'assistants';
        const fileMetadata = {
            id: fileId,
            object: 'file',
            bytes: req.file.size,
            created_at: Math.floor(Date.now() / 1000),
            filename: req.file.originalname,
            purpose: purpose,
            mimeType: req.file.mimetype
        };

        const metaPath = path.join(FILES_DIR, `${fileId}.json`);
        const dataPath = path.join(FILES_DIR, `${fileId}.data`);

        // Pivot file out of multer temp upload store
        fs.renameSync(req.file.path, dataPath);
        fs.writeFileSync(metaPath, JSON.stringify(fileMetadata, null, 2));

        console.log(`[FILES] Streamed file upload completed. ID: ${fileId} (${req.file.originalname})`);
        res.json(fileMetadata);
    } catch (e) {
        console.error('[FILES] Upload error:', e.message);
        res.status(500).json({ error: { message: e.message } });
    }
});

// GET /v1/files - Lists metadata of all uploaded files
router.get('/files', (req, res) => {
    try {
        const fileListing = [];
        const items = fs.readdirSync(FILES_DIR);
        for (const item of items) {
            if (item.endsWith('.json')) {
                try {
                    const data = fs.readFileSync(path.join(FILES_DIR, item), 'utf8');
                    fileListing.push(JSON.parse(data));
                } catch {}
            }
        }
        res.json({ object: 'list', data: fileListing });
    } catch (e) {
        res.status(500).json({ error: { message: e.message } });
    }
});

// GET /v1/files/:fileId - Retrieve metadata for a specific file ID
router.get('/files/:fileId', (req, res) => {
    try {
        const { fileId } = req.params;
        const metaPath = path.join(FILES_DIR, `${fileId}.json`);
        if (!fs.existsSync(metaPath)) {
            return res.status(404).json({ error: { message: `File ID ${fileId} not found` } });
        }
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        res.json(meta);
    } catch (e) {
        res.status(500).json({ error: { message: e.message } });
    }
});

// GET /v1/files/:fileId/content - Retrieves file binary data stream
router.get('/files/:fileId/content', (req, res) => {
    try {
        const { fileId } = req.params;
        const metaPath = path.join(FILES_DIR, `${fileId}.json`);
        const dataPath = path.join(FILES_DIR, `${fileId}.data`);

        if (!fs.existsSync(metaPath) || !fs.existsSync(dataPath)) {
            return res.status(404).json({ error: { message: `File ID ${fileId} binary download missing` } });
        }

        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        res.setHeader('Content-Type', metadata.mimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${metadata.filename}"`);
        fs.createReadStream(dataPath).pipe(res);
    } catch (e) {
        res.status(500).json({ error: { message: e.message } });
    }
});

// DELETE /v1/files/:fileId - Deletes files off disk
router.delete('/files/:fileId', (req, res) => {
    try {
        const { fileId } = req.params;
        const metaPath = path.join(FILES_DIR, `${fileId}.json`);
        const dataPath = path.join(FILES_DIR, `${fileId}.data`);
        let deleted = false;

        if (fs.existsSync(metaPath)) {
            fs.unlinkSync(metaPath);
            deleted = true;
        }
        if (fs.existsSync(dataPath)) {
            fs.unlinkSync(dataPath);
            deleted = true;
        }

        if (!deleted) {
            return res.status(404).json({ error: { message: "File ID can't be resolved or is already deleted" } });
        }

        res.json({ id: fileId, object: 'file', deleted: true });
    } catch (e) {
        res.status(500).json({ error: { message: e.message } });
    }
});


// ============================================================================
// OPENAI RESPONSES API ENDPOINT: /v1/responses
// ============================================================================

// HELPER: Sanitize JSON Schema for Gemini (strips unsupported keys like $schema, exclusiveMinimum)
function sanitizeSchema (schema) {
    if (!schema || typeof schema !== 'object') return schema;
    const allowedKeys = ['type', 'properties', 'required', 'items', 'description', 'enum', 'format'];
    const result = {};
    for (const key of allowedKeys) {
        if (schema[key] !== undefined) {
            if (key === 'properties' && schema.properties && typeof schema.properties === 'object') {
                result.properties = {};
                for (const prop in schema.properties) {
                    result.properties[prop] = sanitizeSchema(schema.properties[prop]);
                }
            } else if (key === 'items' && schema.items) {
                result.items = sanitizeSchema(schema.items);
            } else {
                result[key] = schema[key];
            }
        }
    }
    if (!result.type && result.properties) result.type = 'object';
    return result;
}

router.post('/responses', async (req, res) => {
    try {
        const { model: requestedModel, instructions, input, tools, temperature = 0.9, max_output_tokens, stream } = req.body;

        const model = resolveVertexModel(requestedModel);

        const messages = [];
        if (instructions) messages.push({ role: 'system', content: instructions });

        if (typeof input === 'string') {
            messages.push({ role: 'user', content: input });
        } else if (Array.isArray(input)) {
            for (const item of input) {
                if (item.role === 'user' || item.role === 'system' || item.role === 'developer') {
                    const role = item.role === 'developer' ? 'system' : item.role;
                    if (typeof item.content === 'string') {
                        messages.push({ role, content: item.content });
                    } else if (Array.isArray(item.content)) {
                        const parts = [];
                        for (const part of item.content) {
                            if (part.type === 'input_text') parts.push({ type: 'text', text: part.text });
                            else if (part.type === 'input_image') {
                                const url = (part.image_url && typeof part.image_url === 'object') ? part.image_url.url : (part.image_url || part.url || '');
                                if (url) parts.push({ type: 'image_url', image_url: { url } });
                            } else if (part.type === 'input_file' && part.file_data) {
                                parts.push({ type: 'image_url', image_url: { url: part.file_data } });
                            }
                        }
                        messages.push({ role, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
                    }
                } else if (item.type === 'message' && item.role === 'assistant') {
                    let text = '';
                    if (Array.isArray(item.content)) {
                        text = item.content.filter(c => c.type === 'output_text').map(c => c.text).join('');
                    }
                    messages.push({ role: 'assistant', content: text || '' });
                } else if (item.type === 'function_call') {
                    messages.push({
                        role: 'assistant', content: null,
                        tool_calls: [{
                            id: item.call_id || ('call_' + Math.random().toString(36).substr(2, 9)),
                            type: 'function',
                            function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) }
                        }]
                    });
                } else if (item.type === 'function_call_output') {
                    messages.push({ role: 'tool', tool_call_id: item.call_id, name: item.name || 'unknown_function', content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output || '') });
                }
            }
        }

        const finalMessages = messages.length > 0 ? messages : (req.body.messages || input || []);
        console.log(`[V1/RESP] Stream: ${!!stream}, Messages: ${finalMessages.length}`);

        const generateId = (prefix) => {
            const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
            let r = ''; for (let i = 0; i < 24; i++) r += chars.charAt(Math.floor(Math.random() * chars.length));
            return prefix + r;
        };

        const respId = generateId('resp_');
        const msgId = generateId('msg_');

        if (stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'X-Accel-Buffering': 'no'
            });
            if (res.flushHeaders) res.flushHeaders();

            const sendEvent = (event, data) => {
                const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
                console.log(`[V1/RESP] -> ${event}:`, JSON.stringify(data).substring(0, 80) + (JSON.stringify(data).length > 80 ? '...' : ''));
                safeWrite(res, payload);
            };

            sendEvent('response.created', {
                type: 'response.created',
                response: {
                    id: respId,
                    created_at: Math.floor(Date.now() / 1000),
                    model: requestedModel || 'kilo-code-gemini'
                }
            });

            let proxyReq = null;
            res.on('close', () => { if (proxyReq) proxyReq.destroy(); });

            (async () => {
                try {
                    const vertex = await getVertexCredentials(req.user.id);

                    const accessToken = vertex.accessToken;
                    const projectId = vertex.projectId;
                    const location = vertex.location;
                    const model = vertex.model;
                    const { contents, systemInstructionText, imageLoadError, inlinedImagesInPayload } = await openAiMessagesToGeminiContents(finalMessages);

                    if (imageLoadError) {
                        sendEvent('error', { type: 'error', code: 'image_error', message: imageLoadError, sequence_number: 0 });
                        return safeEnd(res);
                    }

                    if (!contents || contents.length === 0) {
                        sendEvent('error', { type: 'error', code: 'empty_prompt', message: 'No messages provided', sequence_number: 0 });
                        return safeEnd(res);
                    }

                    const body = {
                        contents,
                        generationConfig: {
                            temperature: temperature || 0.7,
                            maxOutputTokens: max_output_tokens || 32768,
                            thinkingConfig: (inlinedImagesInPayload ? undefined : { thinkingLevel: "high" })
                        },
                        safetySettings: SAFETY_SETTINGS
                    };

                    if (tools && Array.isArray(tools) && tools.length > 0) {
                        body.tools = [{
                            function_declarations: tools.map(t => {
                                // FIX: Exclude schema parameters like "strict" from /responses api endpoints
                                const baseFunc = t.function || t;
                                const func = {
                                    name: baseFunc.name,
                                    description: baseFunc.description || ''
                                };
                                if (baseFunc.parameters) {
                                    func.parameters = sanitizeSchema(baseFunc.parameters);
                                }
                                return func;
                            })
                        }];
                    }

                    if (systemInstructionText) body.systemInstruction = { role: 'system', parts: [{ text: systemInstructionText }] };

                    const EFFECTIVE_location = "global";
                    const apiPath = `/v1/projects/${projectId}/locations/global/publishers/google/models/${model}:streamGenerateContent?alt=sse`;
                    const postData = JSON.stringify(body);

                    proxyReq = https.request({
                        hostname: 'aiplatform.googleapis.com', port: 443, path: apiPath, method: 'POST',
                        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
                        timeout: 90000
                    }, (proxyRes) => {
                        if (proxyRes.statusCode !== 200) {
                            let errBody = '';
                            proxyRes.on('data', d => errBody += d);
                            proxyRes.on('end', () => {
                                if (proxyRes.statusCode === 401) {
                                    console.log('[AUTH] Token expired during stream (401). Clearing cache for next request.');
                                    cachedAccessToken = null;
                                    cachedTokenExpiresAt = 0;
                                }
                                console.error('[V1/RESP] Gemini Error:', proxyRes.statusCode, errBody);
                                sendEvent('error', { type: 'error', code: 'gemini_error', message: `Gemini Token/API Error (${proxyRes.statusCode}): ${errBody.substring(0, 100)}`, sequence_number: 999 });
                                safeEnd(res);
                            });
                            return;
                        }

                        proxyRes.setEncoding('utf8');
                        let dataBuffer = ''; let fullText = '';
                        let hasStartedText = false;
                        let outputIndexCounter = 0;

                        proxyRes.on('data', chunk => {
                            dataBuffer += chunk;
                            while (dataBuffer.includes('\n\n')) {
                                const eventEndIndex = dataBuffer.indexOf('\n\n');
                                const rawEvent = dataBuffer.substring(0, eventEndIndex);
                                dataBuffer = dataBuffer.substring(eventEndIndex + 2);

                                const lines = rawEvent.split('\n');
                                let jsonStr = '';
                                for (const line of lines) {
                                    if (line.startsWith(':')) continue;
                                    if (line.startsWith('data: ')) jsonStr += line.substring(6);
                                    else if (line.startsWith('data:')) jsonStr += line.substring(5);
                                    else if (line.trim() !== '') jsonStr += line;
                                }
                                if (!jsonStr || jsonStr.trim() === '[DONE]') continue;

                                try {
                                    const parsed = JSON.parse(jsonStr);
                                    const parts = parsed.candidates?.[0]?.content?.parts || [];
                                    parts.forEach(p => {
                                        if (p.thought) return;

                                        const sig = p.thought_signature || p.thoughtSignature || null;
                                        if (p.text) {
                                            if (!hasStartedText) {
                                                hasStartedText = true;
                                                sendEvent('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: msgId, type: 'message' } });
                                                outputIndexCounter++;
                                            }
                                            fullText += p.text;
                                            sendEvent('response.output_text.delta', { type: 'response.output_text.delta', item_id: msgId, delta: p.text });
                                        }

                                        if (p.functionCall) {
                                            const callId = generateId('call_');
                                            const args = typeof p.functionCall.args === 'string' ? p.functionCall.args : JSON.stringify(p.functionCall.args || {});
                                            const currentIndex = outputIndexCounter++;

                                            toolCallData.set(callId, { name: p.functionCall.name, signature: sig });

                                            sendEvent('response.output_item.added', { type: 'response.output_item.added', output_index: currentIndex, item: { id: callId, type: 'function_call', call_id: callId, name: p.functionCall.name, arguments: '' } });
                                            sendEvent('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: callId, output_index: currentIndex, delta: args });
                                            sendEvent('response.output_item.done', { type: 'response.output_item.done', output_index: currentIndex, item: { id: callId, type: 'function_call', call_id: callId, name: p.functionCall.name, arguments: args, status: 'completed' } });
                                        }
                                    });
                                } catch (e) {
                                    console.error('[V1/RESP] Failed to parse SSE event:', e.message, rawEvent);
                                }
                            }
                        });

                        proxyRes.on('end', () => {
                            if (hasStartedText) {
                                sendEvent('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: msgId, type: 'message' } });
                            }
                            sendEvent('response.completed', { type: 'response.completed', response: { usage: { input_tokens: 0, output_tokens: 0 } } });
                            safeEnd(res);
                        });

                        proxyRes.on('error', (e) => {
                            sendEvent('error', { type: 'error', code: 'stream_error', message: e.message, sequence_number: 999 });
                            safeEnd(res);
                        });
                    });

                    proxyReq.on('error', (e) => {
                        sendEvent('error', { type: 'error', code: 'req_error', message: e.message, sequence_number: 999 });
                        safeEnd(res);
                    });

                    proxyReq.write(postData); proxyReq.end();
                } catch (err) {
                    sendEvent('error', { type: 'error', code: 'internal_error', message: err.message, sequence_number: 999 });
                    safeEnd(res);
                }
            })();
        } else {
            const vertex = await getVertexCredentials(req.user.id);

            const accessToken = vertex.accessToken;
            const projectId = vertex.projectId;
            const location = vertex.location;
            const model = vertex.model;
            const { contents, systemInstructionText, imageLoadError, inlinedImagesInPayload } = await openAiMessagesToGeminiContents(finalMessages);
            if (imageLoadError) return res.status(400).json({ error: imageLoadError });
            const genConfigResp = {
                temperature: temperature || 0.7,
                maxOutputTokens: max_output_tokens || 32768
            };
            if (req.body.thinkingConfig) {
                genConfigResp.thinkingConfig = req.body.thinkingConfig;
            } else if (req.body.reasoning_effort) {
                genConfigResp.thinkingConfig = { thinkingLevel: req.body.reasoning_effort };
            } else if (model.includes('thinking') || model.includes('reasoning')) {
                if (!inlinedImagesInPayload) genConfigResp.thinkingConfig = { thinkingLevel: "high" };
            }

            const body = {
                contents,
                generationConfig: genConfigResp,
                safetySettings: SAFETY_SETTINGS
            };
            if (systemInstructionText) body.systemInstruction = { role: 'system', parts: [{ text: systemInstructionText }] };

            if (tools && Array.isArray(tools) && tools.length > 0) {
                body.tools = [{
                    function_declarations: tools.map(t => {
                        // FIX: Exclude schema parameters like "strict" from /responses api endpoints
                        const baseFunc = t.function || t;
                        const func = {
                            name: baseFunc.name,
                            description: baseFunc.description || ''
                        };
                        if (baseFunc.parameters) {
                            func.parameters = sanitizeSchema(baseFunc.parameters);
                        }
                        return func;
                    })
                }];
            }
            const rawResponseObj = await callGeminiAPIWithRetry(body, false, model, "global", req.user?.id);

            if (rawResponseObj.statusCode !== 200) {
                return res.status(rawResponseObj.statusCode).json({
                    error: {
                        message: `Gemini API Error: ${JSON.stringify(rawResponseObj.data)}`,
                        type: 'api_error',
                        param: null,
                        code: rawResponseObj.statusCode
                    }
                });
            }

            const rawResponse = rawResponseObj.data;
            let reply = ''; const outputItems = [];
            const resultChunks = Array.isArray(rawResponse) ? rawResponse : [rawResponse];
            resultChunks.forEach(chunk => {
                const pList = chunk.candidates?.[0]?.content?.parts || [];
                pList.forEach(p => {
                    if (p.text) reply += p.text;
                    if (p.functionCall) {
                        const callId = generateId('call_');
                        const funcArgs = JSON.stringify(p.functionCall.args || {});

                        toolCallData.set(callId, {
                            name: p.functionCall.name,
                            signature: p.thought_signature || p.thoughtSignature || null
                        });

                        outputItems.push({
                            id: generateId('fc_'),
                            type: 'function_call',
                            call_id: callId,
                            name: p.functionCall.name,
                            arguments: funcArgs,
                            status: 'completed'
                        });
                    }
                });
            });
            if (reply) outputItems.unshift({ id: msgId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply }] });
            res.json({
                id: respId,
                model: requestedModel || 'kilo-code-gemini',
                output: outputItems,
                usage: { input_tokens: 0, output_tokens: 0 }
            });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// OPENAI-COMPATIBLE ENDPOINT: /v1/models
// ============================================================================

router.get('/models', (req, res) => {
    const list = [
        { id: "Gemini 3.6 Flash", vision: true, reasoning: true },
        { id: "Gemini 3.5 Flash", vision: true, reasoning: true },
        { id: "Gemini 3.1 Pro", vision: true, reasoning: true },
        { id: "Gemini 2.5 Pro", vision: true, reasoning: true },
        { id: "Gemini 3.5 Flash Lite", vision: true, reasoning: false },
        { id: "Gemini 2.5 Flash", vision: true, reasoning: false },
    ];

    res.json({
        object: "list",
        data: list.map(m => ({
            id: m.id,
            object: "model",
            created: 1715385600,
            owned_by: "system",
            permission: [],
            root: m.id,
            parent: null,
            input_modalities: ["text", "image"],
            capabilities: {
                vision: m.vision,
                reasoning: m.reasoning,
                tool_use: true,
                json_mode: true
            }
        }))
    });
});

module.exports = router;