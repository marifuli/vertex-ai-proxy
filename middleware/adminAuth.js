const auth = require('../lib/auth');

module.exports = (req, res, next) => {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Unauthorized'
        });
    }

    const token = header.substring(7);

    try {
        const user = auth.verify(token);

        if (user.role !== 'admin') {
            return res.status(403).json({
                error: 'Forbidden'
            });
        }

        req.user = user;

        next();
    } catch (err) {
        return res.status(401).json({
            error: 'Invalid token'
        });
    }
};