require('dotenv').config();

const express = require('express');
const path = require('path');

const adminRoutes = require('./routes/admin');
const openaiRoutes = require('./routes/openai');
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
