const db = require('../lib/firestore');
const { hashKey } = require('../lib/apiKeys');

module.exports = async (req, res, next) => {
    try {
        const header = req.headers.authorization;

        if (!header || !header.startsWith('Bearer ')) {
            return res.status(401).json({
                error: 'Missing API key'
            });
        }

        const apiKey = header.substring(7);
        const keyHash = hashKey(apiKey);

        const snapshot = await db
            .collection('api_keys')
            .where('key_hash', '==', keyHash)
            .where('enabled', '==', true)
            .limit(1)
            .get();

        if (snapshot.empty) {
            return res.status(401).json({
                error: 'Invalid API key'
            });
        }

        const keyDoc = snapshot.docs[0];

        // Update last used
        await keyDoc.ref.update({
            last_used_at: new Date()
        });

        const key = {
            id: keyDoc.id,
            ...keyDoc.data()
        };

        // Load owner
        const userDoc = await db
            .collection('users')
            .doc(key.user_id)
            .get();

        if (!userDoc.exists) {
            return res.status(401).json({
                error: 'User not found'
            });
        }

        req.apiKey = key;
        req.user = {
            id: userDoc.id,
            ...userDoc.data()
        };
        next();

    } catch (err) {
        console.error(err);

        res.status(500).json({
            error: 'Internal server error'
        });
    }
};