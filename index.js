const express = require('express');

const adminRoutes = require('./routes/admin');
const googleRoutes = require('./routes/google');
const openaiRoutes = require('./routes/openai');
const path = require('path')
const bootstrap = require('./lib/bootstrap');

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/admin', adminRoutes);
app.use('/v1', openaiRoutes);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

(async () => {
    await bootstrap();

    app.listen(process.env.PORT || 3000, () => {
        console.log('Server started');
    });
})();