require('dotenv').config();

const bcrypt = require('bcrypt');
const db = require('./firestore');

async function bootstrap() {
    console.log('Initializing Firestore...');

    const adminRef = db.collection('users').doc('admin');
    const adminDoc = await adminRef.get();

    if (!adminDoc.exists) {
        const passwordHash = await bcrypt.hash(
            process.env.DEFAULT_ADMIN_PASSWORD,
            10
        );

        await adminRef.set({
            email: process.env.DEFAULT_ADMIN_EMAIL,
            password: passwordHash,
            name: 'Administrator',
            role: 'admin',
            active: true,
            created_at: new Date(),
            updated_at: new Date()
        });

        console.log('✓ Default admin created');
    } else {
        console.log('✓ Admin already exists');
    }

    // Default application settings
    const settingsRef = db.collection('settings').doc('app');

    const settingsDoc = await settingsRef.get();

    if (!settingsDoc.exists) {
        await settingsRef.set({
            initialized: true,
            created_at: new Date()
        });

        console.log('✓ Settings initialized');
    }
}

module.exports = bootstrap;