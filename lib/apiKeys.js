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

module.exports = {
    create,
    list,
    remove,
    hashKey
};