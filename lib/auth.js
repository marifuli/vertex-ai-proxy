const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./firestore');

const JWT_SECRET = process.env.JWT_SECRET;

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
        JWT_SECRET,
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
    return jwt.verify(token, JWT_SECRET);
}

module.exports = {
    login,
    verify
};