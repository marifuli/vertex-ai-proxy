const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./firestore');

function getJwtSecret() {
    return process.env.JWT_SECRET || 'default_jwt_secret_fallback_key_32bytes_min';
}

async function login(email, password) {
    const snapshot = await db
        .collection('users')
        .where('email', '==', email)
        .limit(1)
        .get();

    if (snapshot.empty) {
        return null;
    }

    const doc = snapshot.docs[0];
    const user = {
        id: doc.id,
        ...doc.data()
    };

    if (!user.active) {
        return null;
    }

    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
        return null;
    }

    const token = jwt.sign(
        {
            id: user.id,
            role: user.role,
            email: user.email
        },
        getJwtSecret(),
        {
            expiresIn: '30d'
        }
    );

    delete user.password;

    return {
        token,
        user
    };
}

function verify(token) {
    return jwt.verify(token, getJwtSecret());
}

async function changePassword(userId, currentPassword, newPassword) {
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
        return { success: false, error: 'User not found' };
    }

    const user = userDoc.data();

    if (!user.active) {
        return { success: false, error: 'Account is inactive' };
    }

    const valid = await bcrypt.compare(currentPassword, user.password);

    if (!valid) {
        return { success: false, error: 'Current password is incorrect' };
    }

    const hash = await bcrypt.hash(newPassword, 10);

    await db.collection('users').doc(userId).update({
        password: hash,
        updated_at: new Date()
    });

    return { success: true };
}

module.exports = {
    login,
    verify,
    changePassword
};
