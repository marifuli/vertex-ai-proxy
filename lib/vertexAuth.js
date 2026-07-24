const { GoogleAuth } = require('google-auth-library');
const db = require('./firestore');
const fs = require('fs');
const path = require('path');

let googleAuthClient = null;

async function getServiceAccountCredentials() {
    if (!googleAuthClient) {
        const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
            ? path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS)
            : null;

        const authOptions = {
            scopes: 'https://www.googleapis.com/auth/cloud-platform'
        };

        if (keyPath && fs.existsSync(keyPath)) {
            authOptions.keyFilename = keyPath;
        }

        if (process.env.GOOGLE_CLOUD_PROJECT_ID) {
            authOptions.projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
        }

        googleAuthClient = new GoogleAuth(authOptions);
    }

    const client = await googleAuthClient.getClient();
    const tokenResponse = await client.getAccessToken();

    return {
        accessToken: typeof tokenResponse === 'string' ? tokenResponse : (tokenResponse.token || tokenResponse.res?.data?.access_token),
        projectId: process.env.GOOGLE_CLOUD_PROJECT_ID || (await googleAuthClient.getProjectId()),
        location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
        model: process.env.GOOGLE_CLOUD_MODEL_ID || 'gemini-2.5-pro'
    };
}

async function getActiveAccount(userId) {
    if (!userId) return null;
    try {
        const snapshot = await db
            .collection('oauth_accounts')
            .where('user_id', '==', userId)
            .where('active', '==', true)
            .limit(1)
            .get();

        if (snapshot.empty) {
            return null;
        }

        return {
            id: snapshot.docs[0].id,
            ...snapshot.docs[0].data()
        };
    } catch {
        return null;
    }
}

async function refreshAccessToken(refreshToken) {
    const response = await fetch(
        'https://oauth2.googleapis.com/token',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                refresh_token: refreshToken,
                grant_type: 'refresh_token'
            })
        }
    );

    const json = await response.json();

    if (!response.ok) {
        throw new Error(json.error_description || 'Failed to refresh access token.');
    }

    return json.access_token;
}

async function getVertexCredentials(userId) {
    const account = await getActiveAccount(userId);

    // if (account && account.refresh_token) {
    //     try {
    //         const accessToken = await refreshAccessToken(account.refresh_token);
    //         return {
    //             accessToken,
    //             projectId: account.project_id || process.env.GOOGLE_CLOUD_PROJECT_ID,
    //             location: account.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
    //             model: account.model || process.env.GOOGLE_CLOUD_MODEL_ID || 'gemini-2.5-pro'
    //         };
    //     } catch (e) {
    //         console.warn('[VERTEX_AUTH] OAuth refresh failed, falling back to Service Account:', e.message);
    //     }
    // }

    return await getServiceAccountCredentials();
}

module.exports = {
    getVertexCredentials
};
