const express = require('express');
const auth = require('../lib/auth');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();
const apiKeys = require('../lib/apiKeys');
/*
|--------------------------------------------------------------------------
| POST /admin/login
|--------------------------------------------------------------------------
*/
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                error: 'Email and password are required.'
            });
        }

        const result = await auth.login(email, password);

        if (!result) {
            return res.status(401).json({
                error: 'Invalid email or password.'
            });
        }

        res.json(result);

    } catch (err) {
        console.error(err);

        res.status(500).json({
            error: 'Internal server error.'
        });
    }
});

/*
|--------------------------------------------------------------------------
| GET /admin/me
|--------------------------------------------------------------------------
*/
router.get('/me', adminAuth, async (req, res) => {
    res.json(req.user);
});
/*
|--------------------------------------------------------------------------
| GET /admin/api-keys
|--------------------------------------------------------------------------
*/
router.get('/api-keys', adminAuth, async (req, res) => {
    try {

        const keys = await apiKeys.list(req.user.id);

        res.json(
            keys.map(key => ({
                id: key.id,
                name: key.name,
                enabled: key.enabled,
                created_at: key.created_at,
                last_used_at: key.last_used_at,
                request_count: key.request_count || 0,
                prompt_tokens: key.prompt_tokens || 0,
                completion_tokens: key.completion_tokens || 0
            }))
        );

    } catch (err) {

        console.error(err);

        res.status(500).json({
            error: 'Internal server error.'
        });

    }
});

/*
|--------------------------------------------------------------------------
| POST /admin/api-keys
|--------------------------------------------------------------------------
*/
router.post('/api-keys', adminAuth, async (req, res) => {
    try {
        const { name } = req.body;

        const result = await apiKeys.create(
            req.user.id,
            name || 'New API Key'
        );

        res.json(result);
    } catch (err) {
        console.error(err);

        res.status(500).json({
            error: 'Internal server error.'
        });
    }
});

/*
|--------------------------------------------------------------------------
| DELETE /admin/api-keys/:id
|--------------------------------------------------------------------------
*/
router.delete('/api-keys/:id', adminAuth, async (req, res) => {
    try {
        await apiKeys.remove(req.params.id);

        res.json({
            success: true
        });
    } catch (err) {
        console.error(err);

        res.status(500).json({
            error: 'Internal server error.'
        });
    }
});

module.exports = router;