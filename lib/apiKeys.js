const crypto = require('crypto');
const db = require('./firestore');

function generateKey() {
    return 'sk_' + crypto.randomBytes(32).toString('hex');
}

function hashKey(key) {
    return crypto
        .createHash('sha256')
        .update(key)
        .digest('hex');
}

async function create(userId, name) {
    const key = generateKey();

    const doc = {
        user_id: userId,
        name: name || 'New Key',
        key_hash: hashKey(key),
        enabled: true,
        request_count: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        created_at: new Date(),
        last_used_at: null
    };

    const ref = await db.collection('api_keys').add(doc);

    return {
        id: ref.id,
        key
    };
}

async function list(userId) {
    const snapshot = await db
        .collection('api_keys')
        .where('user_id', '==', userId)
        .get();

    return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
    }));
}

async function remove(id) {
    await db.collection('api_keys').doc(id).delete();
}

async function recordUsage(keyId, promptTokens = 0, completionTokens = 0) {
    if (!keyId) return;
    try {
        const keyRef = db.collection('api_keys').doc(keyId);
        const doc = await keyRef.get();
        if (!doc.exists) return;

        const currentData = doc.data();
        const requestCount = (currentData.request_count || 0) + 1;
        const currentPromptTokens = (currentData.prompt_tokens || 0) + (promptTokens || 0);
        const currentCompletionTokens = (currentData.completion_tokens || 0) + (completionTokens || 0);

        await keyRef.update({
            request_count: requestCount,
            prompt_tokens: currentPromptTokens,
            completion_tokens: currentCompletionTokens,
            last_used_at: new Date()
        });
    } catch (e) {
        console.warn('[API_KEYS] Failed to record usage:', e.message);
    }
}

module.exports = {
    create,
    list,
    remove,
    hashKey,
    recordUsage
};
