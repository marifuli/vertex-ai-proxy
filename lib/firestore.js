const path = require('path');
const fs = require('fs');
const { Firestore } = require('@google-cloud/firestore');

const options = {};

if (process.env.GOOGLE_CLOUD_PROJECT_ID) {
    options.projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
}

const keyPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
options.keyFilename = keyPath;
const firestore = new Firestore(options);

module.exports = firestore;
